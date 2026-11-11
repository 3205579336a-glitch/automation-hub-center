param([switch]$SkipDependencyInstall)
$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseRoot = Join-Path $projectRoot 'release'
$version = (Get-Content -Raw (Join-Path $projectRoot 'package.json') | ConvertFrom-Json).version
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageRoot = Join-Path $releaseRoot "SAP-Automation-Toolbox-$version-portable-$timestamp"
$unpackedPath = Join-Path $packageRoot 'win-unpacked'
$zipPath = Join-Path $releaseRoot "SAP-Automation-Toolbox-$version-portable-$timestamp.zip"
. (Join-Path $PSScriptRoot 'automation-build-manifest.ps1')
$expectedManifest = Get-AutomationBuildManifest -ProjectRoot $projectRoot
if (Test-Path -LiteralPath $packageRoot) { throw 'The release folder already exists; no package will be overwritten.' }

$engineExecutable = Join-Path $projectRoot 'resources\rpa-engine\automation-engine\automation-engine.exe'
$engineSources = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'resources\rpa') -Filter '*.py' -File
$engineIsStale = -not (Test-Path -LiteralPath $engineExecutable)
if (-not $engineIsStale) {
  $engineTimestamp = (Get-Item -LiteralPath $engineExecutable).LastWriteTimeUtc
  $engineIsStale = $null -ne ($engineSources | Where-Object { $_.LastWriteTimeUtc -gt $engineTimestamp } | Select-Object -First 1)
  if (-not $engineIsStale) {
    try {
      $existingMetadata = (& $engineExecutable --self-test | Select-Object -Last 1) | ConvertFrom-Json
      $engineIsStale = $LASTEXITCODE -ne 0 -or $existingMetadata.buildManifest.sourceDigest -ne $expectedManifest.sourceDigest -or $existingMetadata.buildManifest.appVersion -ne $version
    } catch {
      $engineIsStale = $true
    }
  }
}
if ($engineIsStale) {
  & (Join-Path $PSScriptRoot 'build-automation-engine.ps1') -SkipDependencyInstall:$SkipDependencyInstall
}
Push-Location $projectRoot
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' }
  npx electron-builder --win dir --config.directories.output="$packageRoot"
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
if ($engineMetadata.engines -notcontains 'mm02' -or -not (Test-Path -LiteralPath (Join-Path $unpackedPath 'resources\templates\MM02_Sub_commodity_Template.xlsx') -PathType Leaf)) {
  throw 'The packaged MM02 engine or its Sub-commodity Excel template is missing.'
}
if ($engineMetadata.buildManifest.sourceDigest -ne $expectedManifest.sourceDigest -or $engineMetadata.buildManifest.appVersion -ne $version) {
  throw 'The packaged automation engine does not match the current source files/version.'
}
if ($engineMetadata.apqpDatePolicy -ne 'FGHM_PROD_VERIFIED_SAVE_FIELD_COUNTS_V2' -or $engineMetadata.apqpDateStageOnly -ne $false -or $engineMetadata.apqpDateSchema -ne 'APQP_PLANNED_FGHM_V1' -or ($engineMetadata.apqpDateFields -join ',') -ne 'GS_ITAB-F_PLNDAT,GS_ITAB-G_PLNDAT,GS_ITAB-H_PLNDAT,GS_ITAB-M_PLNDAT') {
  throw 'The packaged APQP date workflow is missing its verified planned-date Save policy.'
}
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
$docsPath = Join-Path $unpackedPath 'docs'
New-Item -ItemType Directory -Path $docsPath | Out-Null
foreach ($doc in @("USER_GUIDE_${version}_EN.md", "USER_GUIDE_${version}_ZH.md", "RELEASE_${version}.md")) {
  $sourceGuide = Join-Path (Join-Path $projectRoot 'docs') $doc
  Copy-Item -LiteralPath $sourceGuide -Destination $docsPath
}

node (Join-Path $PSScriptRoot 'packaged-smoke-test.mjs') (Join-Path $unpackedPath 'SAP Automation Toolbox.exe')
if ($LASTEXITCODE -ne 0) {
  throw 'Packaged application smoke test failed.'
}

$resolvedRelease = (Resolve-Path $releaseRoot).Path
$resolvedUnpacked = (Resolve-Path $unpackedPath).Path
if (-not $resolvedUnpacked.StartsWith($resolvedRelease.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Portable package path validation failed.'
}

$tar = Join-Path ([Environment]::GetFolderPath('System')) 'tar.exe'
if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) {
  throw 'Windows tar.exe is required to archive the portable runtime with long paths.'
}
# Windows PowerShell Compress-Archive truncates or fails on deep embedded engine paths.
# Keep incomplete output separate from the distributable ZIP.
$workingZip = "$zipPath.pending.zip"
if ((Test-Path -LiteralPath $workingZip) -or (Test-Path -LiteralPath $zipPath)) {
  throw 'The archive path already exists; no archive will be overwritten.'
}
& $tar -a -cf $workingZip -C $resolvedUnpacked .
if ($LASTEXITCODE -ne 0) { throw 'Windows tar failed to create the portable ZIP.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($workingZip)
try {
  $members = @($archive.Entries | ForEach-Object { $_.FullName -replace '^\./', '' })
  foreach ($required in @('SAP Automation Toolbox.exe', 'resources/app.asar', 'resources/rpa-engine/automation-engine/automation-engine.exe', "docs/USER_GUIDE_${version}_ZH.md", "docs/USER_GUIDE_${version}_EN.md")) {
    if ($members -notcontains $required) { throw "Portable ZIP is missing $required." }
  }
  if ($members -match '(^|/)\.local-data(/|$)') { throw 'Local user data must not be distributed in the portable ZIP.' }
} finally { $archive.Dispose() }
Move-Item -LiteralPath $workingZip -Destination $zipPath
Write-Output "Portable ZIP created: $zipPath"
Write-Output ("SHA256: " + (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash)
