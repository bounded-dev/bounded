$ErrorActionPreference = 'Stop'
$job = $args[0]
if (-not $job) { throw 'Native Windows job directory is required' }
$assets = (Resolve-Path $job).Path
$global:BOUNDED_TEST_ASSETS = $assets
$oldPath = $env:PATH
$oldLocalAppData = $env:LOCALAPPDATA
$testRoot = Join-Path $env:RUNNER_TEMP 'bounded-native-install'
try {
  $scripts = Join-Path $testRoot 'scripts'
  New-Item -ItemType Directory -Force $scripts | Out-Null
  bun scripts/release/render-native-installer.ts $job $scripts
  if ($LASTEXITCODE -ne 0) { throw 'installer rendering failed' }
  New-Item -ItemType Directory -Force $testRoot | Out-Null
  $env:LOCALAPPDATA = $testRoot
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
  if (Get-Command node,bun,npm -ErrorAction SilentlyContinue) { throw 'without runtimes test still exposes node, bun or npm' }
  function global:curl.exe {
    $arguments = @($args)
    $outputIndex = [Array]::IndexOf($arguments, '--output')
    if ($outputIndex -lt 0) { throw 'curl output was not specified' }
    $destination = $arguments[$outputIndex + 1]
    $url = $arguments[-1]
    $asset = Split-Path $url -Leaf
    Copy-Item (Join-Path $global:BOUNDED_TEST_ASSETS $asset) $destination -ErrorAction Stop
    $global:LASTEXITCODE = 0
  }
  & (Join-Path $scripts 'install.ps1')
  $launcher = Join-Path $testRoot 'Bounded/bin/bounded.cmd'
  if (-not (Test-Path $launcher)) { throw 'bounded.cmd launcher was not installed' }
  & $launcher --version
  if ($LASTEXITCODE -ne 0) { throw 'installed launcher failed' }
  '{not json' | & $launcher hook claude-code | Set-Content (Join-Path $testRoot 'hook.json')
  if ($LASTEXITCODE -ne 0 -or -not ((Get-Content (Join-Path $testRoot 'hook.json') -Raw) -match 'deny')) { throw 'installed hook did not fail closed' }
  $oldReceipt = Get-ChildItem (Join-Path $testRoot 'Bounded/receipts') -Filter receipt-v1.json -Recurse | Select-Object -First 1
  $receiptBytes = [IO.File]::ReadAllBytes($oldReceipt.FullName)
  # A failed install must preserve the working launcher and receipt (rollback).
  $manifest = Get-ChildItem $assets -Filter '*manifest-v1.json' | Select-Object -First 1
  $manifestBytes = [IO.File]::ReadAllBytes($manifest.FullName)
  try {
    [IO.File]::WriteAllText($manifest.FullName, 'failed install manifest')
    $failed = $false
    try { & (Join-Path $scripts 'install.ps1') } catch { $failed = $true }
    if (-not $failed) { throw 'failed install unexpectedly succeeded' }
    & $launcher --version
    if ($LASTEXITCODE -ne 0) { throw 'failed install changed working launcher' }
    if ([Convert]::ToHexString([IO.File]::ReadAllBytes($oldReceipt.FullName)) -ne [Convert]::ToHexString($receiptBytes)) { throw 'failed install changed receipt' }
  } finally {
    [IO.File]::WriteAllBytes($manifest.FullName, $manifestBytes)
  }
} finally {
  Remove-Item Function:curl.exe -ErrorAction SilentlyContinue
  $env:PATH = $oldPath
  $env:LOCALAPPDATA = $oldLocalAppData
}
