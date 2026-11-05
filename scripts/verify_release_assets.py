"""Download a release's NSIS and portable assets and compare them with local builds."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen


def sha256_and_size(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True, help="Release tag, for example v0.3.0-beta.2")
    parser.add_argument("--repository", default="nineanswerer/StorageScope")
    parser.add_argument(
        "--local-root",
        type=Path,
        default=repo_root / "apps/desktop/src-tauri/target/release/bundle",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=repo_root / "apps/desktop/src-tauri/target/release-verification",
    )
    args = parser.parse_args()
    version = args.tag.removeprefix("v")
    if not version or any(char not in "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-" for char in version):
        parser.error(f"Invalid release tag: {args.tag}")

    expected = [
        (f"StorageScope_{version}_x64-setup.exe", args.local_root / "nsis"),
        (f"StorageScope_{version}_x64-portable.zip", args.local_root / "portable"),
    ]
    download_dir = args.output_dir / args.tag
    download_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for name, local_dir in expected:
        local_path = local_dir / name
        if not local_path.is_file():
            raise FileNotFoundError(f"Build the local release asset first: {local_path}")
        local_size, local_hash = sha256_and_size(local_path)
        url = f"https://github.com/{args.repository}/releases/download/{args.tag}/{name}"
        remote_path = download_dir / name
        request = Request(url, headers={"User-Agent": "StorageScope-release-verification"})
        with urlopen(request, timeout=90) as response, remote_path.open("wb") as target:
            if response.status != 200:
                raise RuntimeError(f"Unexpected HTTP status {response.status}: {url}")
            while chunk := response.read(1024 * 1024):
                target.write(chunk)
        remote_size, remote_hash = sha256_and_size(remote_path)
        if (remote_size, remote_hash) != (local_size, local_hash):
            raise RuntimeError(
                f"Remote asset mismatch: {name}; local={local_size}/{local_hash}, "
                f"remote={remote_size}/{remote_hash}"
            )
        results.append(
            {
                "tag": args.tag,
                "name": name,
                "url": url,
                "bytes": remote_size,
                "sha256": remote_hash,
                "matches_local_build": True,
            }
        )
        print(f"PASS: {name} | {remote_size} B | {remote_hash}")

    report = download_dir / "verification.json"
    report.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Verified {len(results)} remote assets. Report: {report}")


if __name__ == "__main__":
    main()
