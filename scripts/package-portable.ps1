$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tauriRoot = Join-Path $repo 'apps/desktop/src-tauri'
$config = Get-Content -LiteralPath (Join-Path $tauriRoot 'tauri.conf.json') -Raw | ConvertFrom-Json
$version = $config.version
if ([string]::IsNullOrWhiteSpace($version) -or $version -notmatch '^[0-9A-Za-z.-]+$') {
  throw "Invalid desktop version: $version"
}
$releaseRoot = Join-Path $tauriRoot 'target/release'
$source = Get-Item -LiteralPath (Join-Path $releaseRoot 'storagescope-desktop.exe')
$expectedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source.FullName).Hash.ToLowerInvariant()
$outputDir = Join-Path $releaseRoot 'bundle/portable'
$stageDir = Join-Path $releaseRoot "portable-stage-$version"
$verifyDir = Join-Path $releaseRoot "portable-verify-$version"
foreach ($dir in @($stageDir, $verifyDir)) {
  if (Test-Path -LiteralPath $dir) { Remove-Item -Recurse -Force -LiteralPath $dir }
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
}
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stageDir 'docs') -Force | Out-Null
Copy-Item -LiteralPath $source.FullName -Destination (Join-Path $stageDir 'StorageScope.exe')
Copy-Item -LiteralPath (Join-Path $repo 'THIRD_PARTY_NOTICES.md') -Destination (Join-Path $stageDir 'THIRD_PARTY_NOTICES.md')
foreach ($name in @('USER_GUIDE.md', 'SAFETY_AND_RECOVERY.md', 'TROUBLESHOOTING.md')) {
  Copy-Item -LiteralPath (Join-Path $repo "docs/$name") -Destination (Join-Path $stageDir "docs/$name")
}
$packagePath = Join-Path $outputDir "StorageScope_${version}_x64-portable.zip"
if (Test-Path -LiteralPath $packagePath) { Remove-Item -Force -LiteralPath $packagePath }
Compress-Archive -Path (Join-Path $stageDir '*') -DestinationPath $packagePath -CompressionLevel Optimal
Expand-Archive -LiteralPath $packagePath -DestinationPath $verifyDir
$verifyExe = Join-Path $verifyDir 'StorageScope.exe'
$verifyHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $verifyExe).Hash.ToLowerInvariant()
if ($verifyHash -ne $expectedHash) { throw 'Extracted executable hash differs from the release build.' }
$required = @(
  'StorageScope.exe',
  'THIRD_PARTY_NOTICES.md',
  'docs/USER_GUIDE.md',
  'docs/SAFETY_AND_RECOVERY.md',
  'docs/TROUBLESHOOTING.md'
)
foreach ($relative in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $verifyDir $relative) -PathType Leaf)) {
    throw "Missing portable package entry: $relative"
  }
}
Remove-Item -Recurse -Force -LiteralPath $stageDir, $verifyDir
$package = Get-Item -LiteralPath $packagePath
[pscustomobject]@{
  Version = $version
  Package = $package.FullName
  Bytes = $package.Length
  SHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $package.FullName).Hash.ToLowerInvariant()
  ExecutableSHA256 = $verifyHash
  Entries = $required
} | ConvertTo-Json -Depth 3
