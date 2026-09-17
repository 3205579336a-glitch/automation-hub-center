$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$buildRoot = Join-Path $projectRoot '.build\rfq-engine'
$venvPath = Join-Path $buildRoot 'venv'
$pythonPath = Join-Path $venvPath 'Scripts\python.exe'
$sourcePath = Join-Path $projectRoot 'resources\rpa\rfq_engine.py'
$distPath = Join-Path $projectRoot 'resources\rpa-engine'
$workPath = Join-Path $buildRoot 'pyinstaller-work'
$specPath = Join-Path $buildRoot 'spec'

New-Item -ItemType Directory -Force -Path $buildRoot, $distPath | Out-Null

if (-not (Test-Path -LiteralPath $pythonPath)) {
  py -3 -m venv $venvPath
}

& $pythonPath -m pip install --disable-pip-version-check --upgrade pip
& $pythonPath -m pip install --disable-pip-version-check pyinstaller openpyxl pywin32 python-dotenv
& $pythonPath -m PyInstaller `
  --noconfirm `
  --onedir `
  --name sap-rfq-engine `
  --hidden-import win32com.client `
  --hidden-import pythoncom `
  --distpath $distPath `
  --workpath $workPath `
  --specpath $specPath `
  $sourcePath

Write-Output "RFQ engine built: $(Join-Path $distPath 'sap-rfq-engine\sap-rfq-engine.exe')"
