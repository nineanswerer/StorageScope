param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$CertificateSubject,
  [string]$TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
$artifact = Get-Item -LiteralPath $Path -ErrorAction Stop
if ($artifact.PSIsContainer) { throw 'Signing target must be a file.' }
$signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
$signtoolPath = $signtool.Source
if ($null -eq $signtool) {
  $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $candidate = Get-ChildItem -LiteralPath $sdkRoot -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if ($null -eq $candidate) { throw 'signtool.exe was not found. Install the Windows SDK signing tools.' }
  $signtoolPath = $candidate.FullName
}

& $signtoolPath sign /fd SHA256 /n $CertificateSubject /tr $TimestampUrl /td SHA256 /v $artifact.FullName
if ($LASTEXITCODE -ne 0) { throw "signtool sign failed with exit code $LASTEXITCODE" }
& $signtoolPath verify /pa /v $artifact.FullName
if ($LASTEXITCODE -ne 0) { throw "signtool verify failed with exit code $LASTEXITCODE" }
Get-FileHash -Algorithm SHA256 -LiteralPath $artifact.FullName
