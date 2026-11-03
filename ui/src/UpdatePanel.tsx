import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type ReleaseInfo = {
  version: string;
  tag: string;
  url: string;
  prerelease: boolean;
};

type UpdateCheckResult = {
  current_version: string;
  status: "update_available" | "up_to_date";
  release: ReleaseInfo | null;
};

export default function UpdatePanel() {
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [error, setError] = useState("");

  async function checkForUpdates() {
    setChecking(true);
    setError("");
    try {
      setResult(await invoke<UpdateCheckResult>("check_for_updates"));
    } catch (reason) {
      setResult(null);
      setError(String(reason));
    } finally {
      setChecking(false);
    }
  }

  async function openRelease() {
    if (!result?.release) return;
    setOpening(true);
    setError("");
    try {
      await invoke("open_release_page", { url: result.release.url });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setOpening(false);
    }
  }

  return (
    <section className="update-panel" aria-label="应用版本与更新">
      <div className="update-copy">
        <strong>版本与更新</strong>
        <span>
          {result
            ? `当前 v${result.current_version}`
            : "手动查询 GitHub Release；更新由你下载并安装。"}
        </span>
      </div>
      <div className="update-actions">
        {result?.release ? (
          <>
            <span className="update-available" role="status">
              发现 v{result.release.version}{result.release.prerelease ? " · Beta" : ""}
            </span>
            <button className="primary" onClick={openRelease} disabled={opening}>
              {opening ? "正在打开…" : "打开发布页"}
            </button>
          </>
        ) : result?.status === "up_to_date" ? (
          <span className="status-safe" role="status">已是最新发布版本</span>
        ) : null}
        <button onClick={checkForUpdates} disabled={checking || opening}>
          {checking ? "正在检查…" : result ? "重新检查" : "检查更新"}
        </button>
      </div>
      {checking && <span className="sr-only" role="status">正在连接更新服务，请稍候。</span>}
      {error && <p className="update-error" role="alert">{error}</p>}
    </section>
  );
}
