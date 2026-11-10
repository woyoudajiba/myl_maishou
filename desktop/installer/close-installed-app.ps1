param(
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [Parameter(Mandatory=$true)][string]$RegistryKey,
  [Parameter(Mandatory=$true)][string]$LogFile
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 is present on supported Windows hosts; do not depend on pwsh.
$targets = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
function Add-InstallPath([string]$Directory) {
  if ([string]::IsNullOrWhiteSpace($Directory) -or -not [IO.Path]::IsPathRooted($Directory)) { return }
  $full = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
  if ($full.Length -le 3) { throw 'Refusing a drive-root installation path' }
  [void]$targets.Add([IO.Path]::Combine($full, 'ProductComparison.exe'))
}
function Write-InstallLog([string]$Message) {
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($LogFile)) | Out-Null
  [IO.File]::AppendAllText($LogFile, "$(Get-Date -Format o) $Message`r`n", [Text.Encoding]::UTF8)
}
function Is-Target($Process) {
  try { return $Process.SessionId -eq [Diagnostics.Process]::GetCurrentProcess().SessionId -and $targets.Contains($Process.Path) } catch { return $false }
}
try {
  if ($RegistryKey -notmatch '^Software\\[a-zA-Z0-9-]{10,100}$') { throw 'Invalid installer registry key' }
  Add-InstallPath $InstallDir
  foreach ($hive in @('HKEY_CURRENT_USER', 'HKEY_LOCAL_MACHINE')) {
    $entry = Get-ItemProperty -LiteralPath "Registry::$hive\$RegistryKey" -ErrorAction SilentlyContinue
    if ($entry) { Add-InstallPath $entry.InstallLocation }
  }
  Write-InstallLog ('Preparing upgrade; native=' + [Environment]::Is64BitProcess + '; session=' + [Diagnostics.Process]::GetCurrentProcess().SessionId + '; executable targets: ' + [string]::Join('; ', $targets))
  $processes = @(Get-Process -Name ProductComparison -ErrorAction SilentlyContinue | Where-Object { Is-Target $_ })
  foreach ($process in $processes) {
    Write-InstallLog "Requesting shutdown pid=$($process.Id) path=$($process.Path)"
    [void]$process.CloseMainWindow()
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  do {
    $remaining = @(Get-Process -Name ProductComparison -ErrorAction SilentlyContinue | Where-Object { Is-Target $_ })
    if (-not $remaining.Count) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  foreach ($process in $remaining) {
    # Revalidate both image path and process creation time to avoid PID reuse.
    $fresh = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
    if ($fresh -and (Is-Target $fresh) -and $fresh.StartTime -eq $process.StartTime) {
      Write-InstallLog "Closing remaining application process pid=$($fresh.Id)"
      $fresh.Kill()
      if (-not $fresh.WaitForExit(5000)) { throw 'Application process did not exit' }
    }
  }
  if (@(Get-Process -Name ProductComparison -ErrorAction SilentlyContinue | Where-Object { Is-Target $_ }).Count) { throw 'Application is still running' }
  Write-InstallLog 'Application processes released; old uninstaller may proceed.'
  exit 0
} catch {
  try { Write-InstallLog ('Upgrade stopped before removing files: ' + $_.Exception.Message) } catch {}
  exit 10
}
