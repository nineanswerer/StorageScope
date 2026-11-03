//! 用户主动触发的 Release 检查。此模块不下载、安装或替换任何文件。

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::time::Duration;

const RELEASES_API: &str =
    "https://api.github.com/repos/nineanswerer/StorageScope/releases?per_page=50";
const RELEASE_URL_PREFIX: &str = "https://github.com/nineanswerer/StorageScope/releases/tag/";

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    draft: bool,
    prerelease: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ReleaseInfo {
    pub version: String,
    pub tag: String,
    pub url: String,
    pub prerelease: bool,
}

#[derive(Debug, Serialize)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub status: &'static str,
    pub release: Option<ReleaseInfo>,
}

#[derive(Debug, Eq, PartialEq)]
struct Version {
    core: [u64; 3],
    prerelease: Vec<String>,
}

impl Version {
    fn parse(input: &str) -> Option<Self> {
        let input = input
            .strip_prefix('v')
            .or_else(|| input.strip_prefix('V'))
            .unwrap_or(input);
        let without_build = input.split_once('+').map_or(input, |(head, _)| head);
        let (core, prerelease) = without_build
            .split_once('-')
            .map_or((without_build, None), |(head, tail)| (head, Some(tail)));
        let core: Vec<_> = core.split('.').collect();
        if core.len() != 3 {
            return None;
        }
        let core = [
            core[0].parse().ok()?,
            core[1].parse().ok()?,
            core[2].parse().ok()?,
        ];
        let prerelease = match prerelease {
            Some(value) if !value.is_empty() => value.split('.').map(str::to_string).collect(),
            Some(_) => return None,
            None => Vec::new(),
        };
        if prerelease.iter().any(|part| {
            part.is_empty()
                || !part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                || (part.len() > 1
                    && part.starts_with('0')
                    && part.bytes().all(|b| b.is_ascii_digit()))
        }) {
            return None;
        }
        Some(Self { core, prerelease })
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.core.cmp(&other.core).then_with(|| {
            match (self.prerelease.is_empty(), other.prerelease.is_empty()) {
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (true, true) => Ordering::Equal,
                (false, false) => self
                    .prerelease
                    .iter()
                    .zip(&other.prerelease)
                    .map(
                        |(left, right)| match (left.parse::<u64>(), right.parse::<u64>()) {
                            (Ok(left), Ok(right)) => left.cmp(&right),
                            (Ok(_), Err(_)) => Ordering::Less,
                            (Err(_), Ok(_)) => Ordering::Greater,
                            (Err(_), Err(_)) => left.cmp(right),
                        },
                    )
                    .find(|ordering| *ordering != Ordering::Equal)
                    .unwrap_or_else(|| self.prerelease.len().cmp(&other.prerelease.len())),
            }
        })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn select_update(body: &str, current: &str) -> Result<UpdateCheckResult, String> {
    let current_version =
        Version::parse(current).ok_or_else(|| "当前应用版本格式无效".to_string())?;
    let releases: Vec<GitHubRelease> =
        serde_json::from_str(body).map_err(|_| "更新服务返回了无法识别的数据".to_string())?;
    let release = releases
        .into_iter()
        .filter(|release| !release.draft && release.html_url.starts_with(RELEASE_URL_PREFIX))
        .filter_map(|release| {
            let version_text = release
                .tag_name
                .strip_prefix(['v', 'V'])
                .unwrap_or(&release.tag_name);
            let version = Version::parse(version_text)?;
            (version > current_version).then_some((
                version,
                ReleaseInfo {
                    version: version_text.to_string(),
                    tag: release.tag_name,
                    url: release.html_url,
                    prerelease: release.prerelease,
                },
            ))
        })
        .max_by(|(left, _), (right, _)| left.cmp(right))
        .map(|(_, release)| release);
    Ok(UpdateCheckResult {
        current_version: current.to_string(),
        status: if release.is_some() {
            "update_available"
        } else {
            "up_to_date"
        },
        release,
    })
}

fn request_error(context: &str, error: reqwest::Error) -> String {
    let mut detail = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        let text = cause.to_string();
        if !detail.contains(&text) {
            detail.push_str(" → ");
            detail.push_str(&text);
        }
        source = cause.source();
    }
    format!("{context}：{detail}")
}

pub fn check(current: &str) -> Result<UpdateCheckResult, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(format!("StorageScope/{current}"))
        .https_only(true)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| request_error("无法初始化更新检查", error))?;
    let response = client
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .map_err(|error| request_error("无法连接更新服务，请检查网络后重试", error))?
        .error_for_status()
        .map_err(|error| request_error("更新服务暂时不可用", error))?;
    let body = response
        .text()
        .map_err(|error| request_error("无法读取更新服务响应", error))?;
    select_update(&body, current)
}

#[cfg(target_os = "windows")]
pub fn open_release(url: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;

    if !url.starts_with(RELEASE_URL_PREFIX) || url.chars().any(char::is_control) {
        return Err("发布页地址无效".into());
    }
    let wide_url: Vec<u16> = std::ffi::OsStr::new(url)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let wide_verb: Vec<u16> = std::ffi::OsStr::new("open")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: both strings are NUL-terminated and remain alive for the synchronous call.
    // A null window handle asks the shell to use its normal association for HTTPS URLs.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            wide_verb.as_ptr(),
            wide_url.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result as usize <= 32 {
        Err(format!("无法打开浏览器，请手动访问 {url}"))
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
pub fn open_release(_url: &str) -> Result<(), String> {
    Err("当前构建只支持 Windows 桌面端".into())
}

#[cfg(test)]
mod tests {
    use super::{select_update, Version};

    #[test]
    fn semantic_version_comparison_handles_prerelease_ordering() {
        let ordered = [
            "0.3.0-beta.2",
            "0.3.0-beta.10",
            "0.3.0-rc.1",
            "0.3.0",
            "0.3.1-beta.1",
        ];
        for pair in ordered.windows(2) {
            assert!(Version::parse(pair[0]).unwrap() < Version::parse(pair[1]).unwrap());
        }
        assert_eq!(Version::parse("v1.2.3+local"), Version::parse("1.2.3"));
        for invalid in ["", "1.2", "1.2.x", "v1.2.3-", "v1.2.3-beta..1"] {
            assert!(Version::parse(invalid).is_none(), "accepted {invalid}");
        }
    }

    #[test]
    fn selects_highest_newer_release_and_skips_drafts_or_invalid_tags() {
        let body = r#"[
          {"tag_name":"v0.3.0-beta.2","html_url":"https://github.com/nineanswerer/StorageScope/releases/tag/v0.3.0-beta.2","draft":false,"prerelease":true},
          {"tag_name":"v9.0.0","html_url":"https://github.com/nineanswerer/StorageScope/releases/tag/v9.0.0","draft":true,"prerelease":false},
          {"tag_name":"nightly","html_url":"https://github.com/nineanswerer/StorageScope/releases/tag/nightly","draft":false,"prerelease":true},
          {"tag_name":"v0.3.0-beta.10","html_url":"https://github.com/nineanswerer/StorageScope/releases/tag/v0.3.0-beta.10","draft":false,"prerelease":true},
          {"tag_name":"v0.2.0","html_url":"https://github.com/nineanswerer/StorageScope/releases/tag/v0.2.0","draft":false,"prerelease":false}
        ]"#;
        let result = select_update(body, "0.3.0-beta.1").unwrap();
        assert_eq!(result.status, "update_available");
        let release = result.release.unwrap();
        assert_eq!(release.version, "0.3.0-beta.10");
        assert!(release.prerelease);
    }

    #[test]
    fn reports_up_to_date_and_rejects_malformed_service_data() {
        let body = r#"[{"tag_name":"v0.3.0-beta.1","html_url":"https://github.com/nineanswerer/StorageScope/releases/tag/v0.3.0-beta.1","draft":false,"prerelease":true}]"#;
        let result = select_update(body, "0.3.0-beta.1").unwrap();
        assert_eq!(result.status, "up_to_date");
        assert!(result.release.is_none());
        assert!(select_update("{}", "0.3.0-beta.1").is_err());
    }
}
