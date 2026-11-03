param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$SampleRoot,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class StorageScopeMemoryProbe {
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_MEMORY_COUNTERS {
        public uint cb;
        public uint PageFaultCount;
        public UIntPtr PeakWorkingSetSize;
        public UIntPtr WorkingSetSize;
        public UIntPtr QuotaPeakPagedPoolUsage;
        public UIntPtr QuotaPagedPoolUsage;
        public UIntPtr QuotaPeakNonPagedPoolUsage;
        public UIntPtr QuotaNonPagedPoolUsage;
        public UIntPtr PagefileUsage;
        public UIntPtr PeakPagefileUsage;
    }
    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool GetProcessMemoryInfo(IntPtr process, out PROCESS_MEMORY_COUNTERS counters, uint size);
    public static ulong PeakWorkingSet(IntPtr process) {
        PROCESS_MEMORY_COUNTERS counters;
        if (!GetProcessMemoryInfo(process, out counters, (uint)Marshal.SizeOf(typeof(PROCESS_MEMORY_COUNTERS)))) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return counters.PeakWorkingSetSize.ToUInt64();
    }
}
"@
$exe = (Resolve-Path $Executable).Path
$sample = (Resolve-Path $SampleRoot).Path
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$out = (Resolve-Path $OutputDirectory).Path
$db = Join-Path $out "benchmark-snapshots.db"

function Invoke-Measured {
    param([string]$Name, [string]$Arguments)
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $exe
    $startInfo.Arguments = $Arguments
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        [void]$process.Start()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $watch.Stop()
        $stdout = $stdoutTask.Result
        $stderr = $stderrTask.Result
        [IO.File]::WriteAllText((Join-Path $out "$Name.stdout.txt"), $stdout, [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $out "$Name.stderr.txt"), $stderr, [Text.UTF8Encoding]::new($false))
        if ($process.ExitCode -ne 0) {
            throw "$Name exited with $($process.ExitCode): $stderr"
        }
        return [ordered]@{
            elapsed_ms = $watch.ElapsedMilliseconds
            peak_working_set_bytes = [StorageScopeMemoryProbe]::PeakWorkingSet($process.Handle)
            exit_code = $process.ExitCode
            stdout_file = "$Name.stdout.txt"
        }
    }
    finally {
        if (-not $process.HasExited) { $process.Kill() }
        $process.Dispose()
    }
}

# Reset only the three synthetic changes so a retry has the same baseline and snapshot IDs.
[IO.File]::WriteAllBytes((Join-Path $sample "bench0000/f0000.dat"), [byte[]](0..15))
[IO.File]::WriteAllBytes((Join-Path $sample "bench0000/f0001.dat"), [byte[]](0..28))
$addedFile = Join-Path $sample "bench0000/added-by-benchmark.txt"
if (Test-Path -LiteralPath $addedFile) { Remove-Item -LiteralPath $addedFile -Force }
foreach ($suffix in @("", "-wal", "-shm")) {
    if (Test-Path -LiteralPath ($db + $suffix)) { Remove-Item -LiteralPath ($db + $suffix) -Force }
}

$quotedSample = '"' + $sample + '"'
$quotedDb = '"' + $db + '"'
$results = [ordered]@{}
$results.scan = Invoke-Measured -Name "scan" -Arguments "scan $quotedSample --json"
$scanReport = Get-Content -Raw -Encoding UTF8 (Join-Path $out "scan.stdout.txt") | ConvertFrom-Json
$results.cancel = Invoke-Measured -Name "cancel" -Arguments "scan $quotedSample --cancel-after 10000 --json"
$cancelReport = Get-Content -Raw -Encoding UTF8 (Join-Path $out "cancel.stdout.txt") | ConvertFrom-Json
if (-not $cancelReport.cancelled) { throw "Cancellation benchmark did not cancel" }

$results.snapshot_1 = Invoke-Measured -Name "snapshot-1" -Arguments "snap save $quotedSample --db $quotedDb"
$changedFile = Join-Path $sample "bench0000/f0000.dat"
$bytes = [IO.File]::ReadAllBytes($changedFile)
[IO.File]::WriteAllBytes($changedFile, ($bytes + $bytes))
[IO.File]::WriteAllText($addedFile, "synthetic benchmark change", [Text.UTF8Encoding]::new($false))
Remove-Item -LiteralPath (Join-Path $sample "bench0000/f0001.dat") -Force
$results.snapshot_2 = Invoke-Measured -Name "snapshot-2" -Arguments "snap save $quotedSample --db $quotedDb"
$results.diff = Invoke-Measured -Name "diff" -Arguments "diff --db $quotedDb 1 2 --json"
$diffReport = Get-Content -Raw -Encoding UTF8 (Join-Path $out "diff.stdout.txt") | ConvertFrom-Json

$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$report = [ordered]@{
    schema = "storagescope-performance-v1"
    recorded_at = (Get-Date).ToString("o")
    executable = "release ss-cli"
    environment = [ordered]@{
        windows_caption = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion").ProductName
        windows_version = $os.Version
        cpu = $cpu.Name
        logical_processors = $cpu.NumberOfLogicalProcessors
        memory_bytes = [uint64]$os.TotalVisibleMemorySize * 1024
        note = "Single-run synthetic benchmark on this machine; disk cache and background load affect results."
    }
    sample = [ordered]@{
        kind = "200 directories x 500 deterministic small files; three changes before second snapshot"
        file_count = $scanReport.file_count
        total_bytes = $scanReport.total_bytes
        root_is_synthetic = $true
    }
    results = $results
    observed = [ordered]@{
        scan_internal_duration_ms = $scanReport.duration_ms
        cancel_reported_file_count = $cancelReport.file_count
        cancel_internal_duration_ms = $cancelReport.duration_ms
        diff_added_files = $diffReport.summary.added_files
        diff_removed_files = $diffReport.summary.removed_files
        diff_grown_files = $diffReport.summary.grown_files
    }
    desktop_ui_responsiveness = "not measured by this CLI benchmark"
}
$json = $report | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText((Join-Path $out "performance.json"), $json, [Text.UTF8Encoding]::new($false))
$json
