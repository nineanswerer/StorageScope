use crate::model::*;
use crate::scanner::parent_of;
use std::collections::{BTreeMap, HashMap};

fn content_type(ext: Option<&str>) -> &'static str {
    match ext.unwrap_or("") {
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "svg" | "ico" | "avif" | "heic" | "heif" => "images",
        "mp4" | "mov" | "mkv" | "avi" | "webm" | "flv" | "wmv" | "m4v" => "video",
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" | "wma" => "audio",
        "rs" | "ts" | "tsx" | "js" | "jsx" | "json" | "html" | "css" | "scss" | "py" | "java" | "c" | "h" | "cpp" | "hpp" | "cs" | "go" | "rb" | "php" | "sql" | "sh" | "ps1" | "bat" | "yaml" | "yml" | "toml" | "xml" | "vue" => "code",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "md" | "rtf" | "csv" | "epub" => "documents",
        "zip" | "7z" | "rar" | "tar" | "gz" | "bz2" | "xz" | "zst" => "archives",
        "exe" | "msi" | "msix" | "appx" | "dmg" | "pkg" | "deb" | "rpm" | "apk" => "installers",
        _ => "other",
    }
}

/// 由文件节点自底向上聚合目录统计。
/// 目录大小 = 本次成功扫描到的所有后代文件的逻辑大小之和。
pub fn aggregate(outcome: &ScanOutcome) -> DirStat {
    // 1. 建立目录集合：扫描到的目录 + 文件路径隐含的所有祖先目录。
    let mut dir_set: HashMap<String, String> = HashMap::new(); // rel_path -> name
    for d in &outcome.dirs {
        // 根目录条目（rel_path 为 "."）由树构建逻辑单独处理，不进入集合，
        // 否则 parent_of(".") == "." 会造成自引用递归。
        if d.rel_path != "." {
            dir_set.insert(d.rel_path.clone(), d.name.clone());
        }
    }
    for f in &outcome.files {
        let mut p = parent_of(&f.rel_path).to_string();
        while p != "." {
            if !dir_set.contains_key(&p) {
                let name = p.rsplit('/').next().unwrap_or(&p).to_string();
                dir_set.insert(p.clone(), name);
            }
            p = parent_of(&p).to_string();
        }
    }

    // 2. 初始化每个目录的自身统计（仅直接文件）。
    let mut own_size: HashMap<String, u64> = HashMap::new();
    let mut own_files: HashMap<String, u64> = HashMap::new();
    let mut own_types: HashMap<String, BTreeMap<String, u64>> = HashMap::new();
    for f in &outcome.files {
        let parent = parent_of(&f.rel_path).to_string();
        *own_size.entry(parent.clone()).or_insert(0) += f.size;
        *own_files.entry(parent.clone()).or_insert(0) += 1;
        *own_types
            .entry(parent)
            .or_default()
            .entry(content_type(f.ext.as_deref()).to_string())
            .or_insert(0) += f.size;
    }

    // 3. 错误路径归一化为相对路径；并把每个错误路径及其全部祖先目录
    //    记入受影响集合（O(错误数 × 深度)，替代逐节点前缀扫描）。
    let root_display = &outcome.root;
    let mut error_dirs: std::collections::HashSet<String> = std::collections::HashSet::new();
    for e in &outcome.errors {
        let rel = std::path::Path::new(&e.path)
            .strip_prefix(root_display)
            .map(|r| {
                r.components()
                    .map(|c| c.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .unwrap_or_else(|_| e.path.clone());
        // 标记错误路径本身及其目录链上的每一级
        let mut p = rel.clone();
        loop {
            error_dirs.insert(p.clone());
            if p == "." {
                break;
            }
            p = parent_of(&p).to_string();
        }
    }

    // 4. 自底向上聚合：按深度倒序处理，把子目录累计进父目录。
    let mut total_size: HashMap<String, u64> = own_size.clone();
    let mut total_files: HashMap<String, u64> = own_files.clone();
    let mut total_types = own_types.clone();

    let mut dirs_by_depth: Vec<&String> = dir_set.keys().collect();
    dirs_by_depth.sort_by_key(|p| std::cmp::Reverse(p.matches('/').count()));
    for d in dirs_by_depth {
        let parent = parent_of(d).to_string();
        let s = *total_size.get(d).unwrap_or(&0);
        let c = *total_files.get(d).unwrap_or(&0);
        *total_size.entry(parent.clone()).or_insert(0) += s;
        *total_files.entry(parent.clone()).or_insert(0) += c;
        if let Some(types) = total_types.get(d).cloned() {
            let parent_types = total_types.entry(parent).or_default();
            for (kind, bytes) in types {
                *parent_types.entry(kind).or_insert(0) += bytes;
            }
        }
    }

    // 5. 递归构建 DirStat 树。先一次性建父子邻接表（O(目录数)），
    //    避免每个节点都全表扫描（39k 目录时全表扫描 ≈ 8 亿次比较）。
    let mut children_of: HashMap<&str, Vec<(&String, &String)>> = HashMap::new();
    for (p, n) in &dir_set {
        children_of.entry(parent_of(p)).or_default().push((p, n));
    }

    fn build<'a>(
        rel: &'a str,
        name: &str,
        children_of: &HashMap<&'a str, Vec<(&'a String, &'a String)>>,
        total_size: &HashMap<String, u64>,
        total_files: &HashMap<String, u64>,
        total_types: &HashMap<String, BTreeMap<String, u64>>,
        error_dirs: &std::collections::HashSet<String>,
    ) -> DirStat {
        let mut children: Vec<DirStat> = children_of
            .get(rel)
            .map(|v| {
                v.iter()
                    .map(|(p, n)| {
                        build(p, n, children_of, total_size, total_files, total_types, error_dirs)
                    })
                    .collect()
            })
            .unwrap_or_default();
        children.sort_by(|a, b| b.total_size.cmp(&a.total_size).then(a.name.cmp(&b.name)));

        DirStat {
            rel_path: rel.to_string(),
            name: name.to_string(),
            total_size: *total_size.get(rel).unwrap_or(&0),
            file_count: *total_files.get(rel).unwrap_or(&0),
            subdir_count: children.len() as u64,
            has_errors: error_dirs.contains(rel),
            type_sizes: total_types.get(rel).cloned().unwrap_or_default(),
            children,
        }
    }

    let root_name = std::path::Path::new(&outcome.root)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| outcome.root.clone());

    build(
        ".",
        &root_name,
        &children_of,
        &total_size,
        &total_files,
        &total_types,
        &error_dirs,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(rel_path: &str, size: u64, ext: &str) -> FileEntry {
        FileEntry {
            rel_path: rel_path.to_string(),
            name: rel_path.rsplit('/').next().unwrap().to_string(),
            size,
            modified: None,
            ext: Some(ext.to_string()),
        }
    }

    #[test]
    fn classifies_visualized_content_types() {
        assert_eq!(content_type(Some("jpg")), "images");
        assert_eq!(content_type(Some("mp4")), "video");
        assert_eq!(content_type(Some("tsx")), "code");
        assert_eq!(content_type(Some("pdf")), "documents");
        assert_eq!(content_type(Some("7z")), "archives");
        assert_eq!(content_type(Some("msi")), "installers");
        assert_eq!(content_type(None), "other");
    }

    #[test]
    fn aggregates_type_sizes_from_descendants() {
        let outcome = ScanOutcome {
            root: "/root".to_string(),
            dirs: vec![
                DirEntry { rel_path: "media".to_string(), name: "media".to_string() },
                DirEntry { rel_path: "media/photos".to_string(), name: "photos".to_string() },
            ],
            files: vec![
                file("media/photos/a.jpg", 10, "jpg"),
                file("media/b.mp4", 20, "mp4"),
                file("main.rs", 5, "rs"),
            ],
            errors: vec![],
            cancelled: false,
            duration_ms: 0,
        };
        let root = aggregate(&outcome);
        assert_eq!(root.type_sizes.get("images"), Some(&10));
        assert_eq!(root.type_sizes.get("video"), Some(&20));
        assert_eq!(root.type_sizes.get("code"), Some(&5));
        let media = root.children.iter().find(|d| d.name == "media").unwrap();
        assert_eq!(media.type_sizes.get("images"), Some(&10));
        assert_eq!(media.type_sizes.get("video"), Some(&20));
        assert!(!media.type_sizes.contains_key("code"));
    }
}
