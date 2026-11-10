param([Parameter(Mandatory=$true)][string]$BaselineInstaller,[Parameter(Mandatory=$true)][string]$FixedInstaller,[string]$QaGuid='')
$ErrorActionPreference='Stop'
$root=Join-Path $PSScriptRoot '../output/qa/installer-upgrade'
$root=[IO.Path]::GetFullPath($root)
$install=Join-Path $root '中文 路径/ProductComparison'
if(-not $QaGuid){throw 'Supply the isolated QA registry GUID; do not target a real installation'}
if($QaGuid -eq 'e56d35f5-3787-5dba-8819-95aeeed2efa6'){throw 'Production installer GUID is not allowed'}
$uninstallKey="HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$QaGuid"
$installKey="HKCU:\Software\$QaGuid"
if(Test-Path -LiteralPath $uninstallKey){
  if((Get-ItemProperty -LiteralPath $installKey).InstallLocation -ne $install){throw 'Existing QA registry entry points outside the isolated installation'}
}
$BaselineInstaller=(Resolve-Path -LiteralPath $BaselineInstaller).Path
$FixedInstaller=(Resolve-Path -LiteralPath $FixedInstaller).Path
$previousElectronRunAsNode=$env:ELECTRON_RUN_AS_NODE
$env:ELECTRON_RUN_AS_NODE=$null
function Run-Installer([string]$File){
  # NSIS /D must be last and unquoted even when it contains spaces.
  $p=Start-Process -FilePath $File -ArgumentList "/S /currentuser /D=$install" -WindowStyle Hidden -PassThru
  if(-not $p.WaitForExit(90000)){throw "Installer still running: $($p.Id)"}
  $p.Refresh();return $p.ExitCode
}
[IO.Directory]::CreateDirectory($root)|Out-Null
$exit=Run-Installer $BaselineInstaller
if($exit -ne 0){throw "Baseline installation failed: $exit"}
if((Get-ItemProperty -LiteralPath $installKey).InstallLocation -ne $install){throw 'Wrong QA registry target'}
# Launch the real installed app with an isolated data directory. The installer must
# close this exact executable, while any other checkout/test app stays running.
$profile=Join-Path $root 'profile'
$sentinel=Join-Path $profile 'user-data-must-survive.txt'
[IO.Directory]::CreateDirectory($profile)|Out-Null
[IO.File]::WriteAllText($sentinel,'keep-account-and-product-data')
$app=Start-Process -FilePath (Join-Path $install 'ProductComparison.exe') -ArgumentList "--user-data-dir=$profile" -WindowStyle Hidden -PassThru
$other=Start-Process -FilePath (Join-Path $PSScriptRoot '../desktop/release/win-unpacked/ProductComparison.exe') -ArgumentList "--user-data-dir=$(Join-Path $root 'unrelated-profile')" -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2
$before=@($other.Id) # Chromium utility/renderer child PIDs may exit naturally.
if($app.HasExited -or $other.HasExited){throw 'QA application exited before the installer test'}
$exit=Run-Installer $FixedInstaller
if($exit -ne 0){throw "Upgrade while running failed: $exit"}
if([IO.File]::ReadAllText($sentinel) -ne 'keep-account-and-product-data'){throw 'Profile sentinel changed'}
if(@(Get-Process -Name ProductComparison -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq (Join-Path $install 'ProductComparison.exe')}).Count){throw 'Installed app still running after upgrade'}
$beforeHash=(Get-FileHash -LiteralPath (Join-Path $install 'resources/app.asar') -Algorithm SHA256).Hash
$locked=Join-Path $install 'resources/app.asar'
$stream=[IO.File]::Open($locked,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try{$lockedExit=Run-Installer $FixedInstaller}finally{$stream.Dispose()}
if($lockedExit -eq 0){throw 'Locked file upgrade incorrectly returned success'}
if((Get-FileHash -LiteralPath $locked -Algorithm SHA256).Hash -ne $beforeHash){throw 'Failed upgrade changed installed application'}
$retry=Run-Installer $FixedInstaller
if($retry -ne 0){throw "Upgrade retry after unlock failed: $retry"}
$unrelatedGone=@($before|Where-Object {-not (Get-Process -Id $_ -ErrorAction SilentlyContinue)})
$unrelatedRemaining=@($before|Where-Object {Get-Process -Id $_ -ErrorAction SilentlyContinue})
$result=[ordered]@{baselineExit=0;runningApplicationUpgradePassed=$true;lockedFileExit=$lockedExit;oldApplicationPreserved=$true;retryExit=$retry;userDataPreserved=$true;unrelatedApplicationPidsBefore=$before;unrelatedPidsGoneNaturally=$unrelatedGone;unrelatedPidsRemaining=$unrelatedRemaining;installPath=$install;qaRegistryGuid=$QaGuid}
$result|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'smoke-result.json') -Encoding utf8
$result|ConvertTo-Json
if(-not $other.HasExited){[void]$other.CloseMainWindow();[void]$other.WaitForExit(5000)}
$env:ELECTRON_RUN_AS_NODE=$previousElectronRunAsNode
