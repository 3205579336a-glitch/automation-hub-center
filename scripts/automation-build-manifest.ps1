function Get-AutomationBuildManifest {
  param([Parameter(Mandatory=$true)][string]$ProjectRoot)
  $sourceRoot = Join-Path $ProjectRoot 'resources\rpa'
  $sourceLines = @(Get-ChildItem -LiteralPath $sourceRoot -Filter '*.py' -File | Sort-Object Name | ForEach-Object {
    $_.Name + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  })
  if ($sourceLines.Count -lt 10) { throw 'Automation sources are incomplete.' }
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $digest = [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes(($sourceLines -join "`n")))).Replace('-', '').ToLowerInvariant()
  } finally { $algorithm.Dispose() }
  return [ordered]@{
    version = 1
    appVersion = (Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot 'package.json') | ConvertFrom-Json).version
    sourceDigest = $digest
    sourceFiles = $sourceLines.Count
  }
}
