$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseRoot = Join-Path $projectRoot 'release'
$unpackedPath = Join-Path $releaseRoot 'win-unpacked'
$version = (Get-Content -Raw (Join-Path $projectRoot 'package.json') | ConvertFrom-Json).version
$timestamp = Get-Date -Format 'yyyyMMdd-HHmm'
$zipPath = Join-Path $releaseRoot "SAP-Automation-Toolbox-$version-portable-$timestamp.zip"

$engineExecutable = Join-Path $projectRoot 'resources\rpa-engine\automation-engine\automation-engine.exe'
$engineSources = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'resources\rpa') -Filter '*.py' -File
$engineIsStale = -not (Test-Path -LiteralPath $engineExecutable)
if (-not $engineIsStale) {
  $engineTimestamp = (Get-Item -LiteralPath $engineExecutable).LastWriteTimeUtc
  $engineIsStale = $null -ne ($engineSources | Where-Object { $_.LastWriteTimeUtc -gt $engineTimestamp } | Select-Object -First 1)
}
if ($engineIsStale) {
  & (Join-Path $PSScriptRoot 'build-automation-engine.ps1')
}
Push-Location $projectRoot
try {
  npm run build
  npx electron-builder --win dir
} finally {
  Pop-Location
}

$packagedEngine = Join-Path $unpackedPath 'resources\rpa-engine\automation-engine\automation-engine.exe'
if (-not (Test-Path -LiteralPath $packagedEngine)) {
  throw 'The shared offline automation engine is missing from the packaged application.'
}
& $packagedEngine --self-test
if ($LASTEXITCODE -ne 0) {
  throw 'The packaged offline automation engine failed its self-test.'
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
