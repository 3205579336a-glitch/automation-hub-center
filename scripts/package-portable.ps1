param([switch]$SkipDependencyInstall)
$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseRoot = Join-Path $projectRoot 'release'
$unpackedPath = Join-Path $releaseRoot 'win-unpacked'
$version = (Get-Content -Raw (Join-Path $projectRoot 'package.json') | ConvertFrom-Json).version
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$zipPath = Join-Path $releaseRoot "SAP-Automation-Toolbox-$version-portable-$timestamp.zip"

$engineExecutable = Join-Path $projectRoot 'resources\rpa-engine\automation-engine\automation-engine.exe'
$engineSources = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'resources\rpa') -Filter '*.py' -File
$engineIsStale = -not (Test-Path -LiteralPath $engineExecutable)
if (-not $engineIsStale) {
  $engineTimestamp = (Get-Item -LiteralPath $engineExecutable).LastWriteTimeUtc
  $engineIsStale = $null -ne ($engineSources | Where-Object { $_.LastWriteTimeUtc -gt $engineTimestamp } | Select-Object -First 1)
}
if ($engineIsStale) {
  & (Join-Path $PSScriptRoot 'build-automation-engine.ps1') -SkipDependencyInstall:$SkipDependencyInstall
}
Push-Location $projectRoot
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' }
  npx electron-builder --win dir
  if ($LASTEXITCODE -ne 0) { throw 'Electron package build failed.' }
} finally {
  Pop-Location
}

$packagedEngine = Join-Path $unpackedPath 'resources\rpa-engine\automation-engine\automation-engine.exe'
if (-not (Test-Path -LiteralPath $packagedEngine)) {
  throw 'The shared offline automation engine is missing from the packaged application.'
}
$engineSelfTestOutput = & $packagedEngine --self-test
Write-Output $engineSelfTestOutput
if ($LASTEXITCODE -ne 0) {
  throw 'The packaged offline automation engine failed its self-test.'
}
$engineMetadata = ($engineSelfTestOutput | Select-Object -Last 1) | ConvertFrom-Json
$apqpSource = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'resources\rpa\apqp_plan_closure.py')
$policyMatch = [regex]::Match($apqpSource, '(?m)^APQP_SESSION_POLICY\s*=\s*"([^"]+)"')
if (-not $policyMatch.Success -or $engineMetadata.apqpSessionPolicy -ne $policyMatch.Groups[1].Value) {
  throw 'The packaged APQP engine does not contain the current session-policy hotfix.'
}
$connectionSource = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'resources\rpa\sap_gui_connection.py')
$connectionPolicy = [regex]::Match($connectionSource, "(?m)^SAP_CONNECTION_POLICY\s*=\s*'([^']+)'")
if (-not $connectionPolicy.Success -or $engineMetadata.sapConnectionPolicy -ne $connectionPolicy.Groups[1].Value) {
  throw 'The packaged engine does not contain the RFQ/Source List connection hotfix.'
}
$writebackSource = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'resources\rpa\rfq_source_writeback.py')
$writebackPolicy = [regex]::Match($writebackSource, "(?m)^SOURCE_WRITEBACK_POLICY\s*=\s*'([^']+)'")
if (-not $writebackPolicy.Success -or $engineMetadata.rfqSourceWritebackPolicy -ne $writebackPolicy.Groups[1].Value) {
  throw 'The packaged engine does not contain the verified RFQ original-workbook writeback.'
}

$guidePath = Join-Path $unpackedPath 'README.txt'
Copy-Item -LiteralPath (Join-Path $projectRoot 'resources\PORTABLE-README.txt') -Destination $guidePath -Force

node (Join-Path $PSScriptRoot 'packaged-smoke-test.mjs') (Join-Path $unpackedPath 'SAP Automation Toolbox.exe')
if ($LASTEXITCODE -ne 0) {
  throw 'Packaged application smoke test failed.'
}

$resolvedRelease = (Resolve-Path $releaseRoot).Path
$resolvedUnpacked = (Resolve-Path $unpackedPath).Path
if (-not $resolvedUnpacked.StartsWith($resolvedRelease, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Portable package path validation failed.'
}

Compress-Archive -Path (Join-Path $resolvedUnpacked '*') -DestinationPath $zipPath -CompressionLevel Optimal
Write-Output "Portable ZIP created: $zipPath"
