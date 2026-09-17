$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$buildRoot = Join-Path $projectRoot '.build\automation-engine'
$venvPath = Join-Path $buildRoot 'venv'
$pythonPath = Join-Path $venvPath 'Scripts\python.exe'
$sourceRoot = Join-Path $projectRoot 'resources\rpa'
$launcherPath = Join-Path $sourceRoot 'automation_engine_launcher.py'
$distPath = Join-Path $projectRoot 'resources\rpa-engine'
$workPath = Join-Path $buildRoot 'pyinstaller-work'
$specPath = Join-Path $buildRoot 'spec'

New-Item -ItemType Directory -Force -Path $buildRoot, $distPath | Out-Null

if (-not (Test-Path -LiteralPath $pythonPath)) {
  py -3 -m venv $venvPath
}

& $pythonPath -m pip install --disable-pip-version-check --upgrade pip
& $pythonPath -m pip install --disable-pip-version-check pyinstaller openpyxl pywin32 python-dotenv playwright
& $pythonPath -m PyInstaller `
  --noconfirm `
  --clean `
  --onedir `
  --name automation-engine `
  --paths $sourceRoot `
  --hidden-import rfq_engine `
  --hidden-import me01_source_list `
  --hidden-import me52n_project_ref `
  --hidden-import apqp_plan_closure `
  --hidden-import win32com.client `
  --hidden-import pythoncom `
  --collect-all playwright `
  --distpath $distPath `
  --workpath $workPath `
  --specpath $specPath `
  $launcherPath

$enginePath = Join-Path $distPath 'automation-engine\automation-engine.exe'
& $enginePath --self-test
if ($LASTEXITCODE -ne 0) {
  throw 'The packaged automation engine failed its dependency self-test.'
}
Write-Output "Shared automation engine built: $enginePath"
