[CmdletBinding()]
param(
  [string]$OutputDirectory,
  [string]$AssetDirectory,
  [string]$RuntimeAssetDirectory,
  [string]$AskpassAssetDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $repositoryRoot 'dist'
}
if ([string]::IsNullOrWhiteSpace($AssetDirectory)) {
  $AssetDirectory = Join-Path $repositoryRoot 'assets\linux-compat'
}
if ([string]::IsNullOrWhiteSpace($RuntimeAssetDirectory)) {
  $RuntimeAssetDirectory = Join-Path $repositoryRoot 'assets\windows-runtime'
}
$buildAskpassFromSource = [string]::IsNullOrWhiteSpace($AskpassAssetDirectory)
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$AssetDirectory = [System.IO.Path]::GetFullPath($AssetDirectory)
$RuntimeAssetDirectory = [System.IO.Path]::GetFullPath($RuntimeAssetDirectory)
if (-not $buildAskpassFromSource) {
  $AskpassAssetDirectory = [System.IO.Path]::GetFullPath($AskpassAssetDirectory)
}

$package = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'package.json') | ConvertFrom-Json
$releaseName = "mirasim-windows-ssh-fix-v$($package.version)-win-x64"
$stageParent = Join-Path $OutputDirectory ".stage-$([System.Guid]::NewGuid().ToString('N'))"
$stageRoot = Join-Path $stageParent $releaseName
$zipPath = Join-Path $OutputDirectory "$releaseName.zip"

New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
try {
  if ($buildAskpassFromSource) {
    $AskpassAssetDirectory = Join-Path $stageParent 'askpass-build'
    & (Join-Path $repositoryRoot 'scripts\build-windows-askpass.ps1') -OutputDirectory $AskpassAssetDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Windows askpass build failed.' }
  }
  $assetJson = & node (Join-Path $repositoryRoot 'scripts\verify-release-assets.cjs') --asset-dir $AssetDirectory --json
  if ($LASTEXITCODE -ne 0) { throw 'Release asset verification failed.' }
  $verifiedAssets = $assetJson | ConvertFrom-Json
  $runtimeManifest = Join-Path $repositoryRoot 'assets\windows-runtime\manifest.json'
  $runtimeJson = & node (Join-Path $repositoryRoot 'scripts\verify-release-assets.cjs') --asset-dir $RuntimeAssetDirectory --manifest $runtimeManifest --json
  if ($LASTEXITCODE -ne 0) { throw 'Windows runtime verification failed.' }
  $verifiedRuntime = $runtimeJson | ConvertFrom-Json
  if (@($verifiedRuntime.files).Count -ne 1) { throw 'Expected exactly one pinned Windows runtime archive.' }
  $askpassManifest = Join-Path $repositoryRoot 'assets\windows-askpass\manifest.json'
  $askpassJson = & node (Join-Path $repositoryRoot 'scripts\verify-release-assets.cjs') --asset-dir $AskpassAssetDirectory --manifest $askpassManifest --json
  if ($LASTEXITCODE -ne 0) { throw 'Windows askpass verification failed.' }
  $verifiedAskpass = $askpassJson | ConvertFrom-Json
  if (@($verifiedAskpass.files).Count -ne 1 -or $verifiedAskpass.files[0].name -ne 'windows-askpass.exe') {
    throw 'Expected exactly the pinned windows-askpass.exe asset.'
  }

  $requiredFiles = @('package.json', 'package-lock.json', 'Mirasim-SSH-Fix.cmd')
  foreach ($relativePath in $requiredFiles) {
    Copy-Item -LiteralPath (Join-Path $repositoryRoot $relativePath) -Destination (Join-Path $stageRoot $relativePath)
  }
  foreach ($relativePath in @('README.md', 'LICENSE', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md')) {
    $source = Join-Path $repositoryRoot $relativePath
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination (Join-Path $stageRoot $relativePath)
    }
  }
  Copy-Item -Recurse -LiteralPath (Join-Path $repositoryRoot 'src') -Destination (Join-Path $stageRoot 'src')
  Copy-Item -Recurse -LiteralPath (Join-Path $repositoryRoot 'native') -Destination (Join-Path $stageRoot 'native')
  Copy-Item -Recurse -LiteralPath (Join-Path $repositoryRoot 'scripts') -Destination (Join-Path $stageRoot 'scripts')
  Copy-Item -Recurse -LiteralPath (Join-Path $repositoryRoot 'test') -Destination (Join-Path $stageRoot 'test')

  $assetStage = Join-Path $stageRoot 'assets\linux-compat'
  New-Item -ItemType Directory -Force -Path $assetStage | Out-Null
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'assets\linux-compat\manifest.json') -Destination $assetStage
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'assets\linux-compat\build-node-pty.sh') -Destination $assetStage
  foreach ($asset in $verifiedAssets.files) {
    Copy-Item -LiteralPath $asset.path -Destination (Join-Path $assetStage $asset.name)
  }

  $askpassStage = Join-Path $stageRoot 'assets\windows-askpass'
  New-Item -ItemType Directory -Force -Path $askpassStage | Out-Null
  Copy-Item -LiteralPath $askpassManifest -Destination $askpassStage
  Copy-Item -LiteralPath $verifiedAskpass.files[0].path -Destination (Join-Path $askpassStage 'windows-askpass.exe')

  $runtimeExtract = Join-Path $stageParent 'runtime-extract'
  Expand-Archive -LiteralPath $verifiedRuntime.files[0].path -DestinationPath $runtimeExtract
  $runtimeSource = Join-Path $runtimeExtract $verifiedRuntime.runtime
  $runtimeStage = Join-Path $stageRoot 'runtime'
  New-Item -ItemType Directory -Force -Path $runtimeStage | Out-Null
  Copy-Item -LiteralPath (Join-Path $runtimeSource 'node.exe') -Destination (Join-Path $runtimeStage 'node.exe')
  Copy-Item -LiteralPath (Join-Path $runtimeSource 'LICENSE') -Destination (Join-Path $runtimeStage 'NODE_LICENSE.txt')
  Copy-Item -LiteralPath $runtimeManifest -Destination (Join-Path $runtimeStage 'manifest.json')

  & npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix $stageRoot
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed while assembling the release.' }

  & node (Join-Path $repositoryRoot 'scripts\verify-release-assets.cjs') --asset-dir $assetStage | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Staged release asset verification failed.' }
  & node (Join-Path $repositoryRoot 'scripts\verify-release-assets.cjs') --asset-dir $askpassStage --manifest (Join-Path $askpassStage 'manifest.json') | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Staged Windows askpass verification failed.' }

  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -Force -LiteralPath $zipPath }
  Compress-Archive -LiteralPath $stageRoot -DestinationPath $zipPath -CompressionLevel Optimal
  $zipStream = [System.IO.File]::OpenRead($zipPath)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $zipHash = ([System.BitConverter]::ToString($sha256.ComputeHash($zipStream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $zipStream.Dispose()
  }
  $checksumPath = Join-Path $OutputDirectory 'SHA256SUMS.txt'
  [System.IO.File]::WriteAllText(
    $checksumPath,
    "$zipHash  $([System.IO.Path]::GetFileName($zipPath))`n",
    [System.Text.Encoding]::ASCII
  )
  Write-Output "Created $zipPath"
  Write-Output "SHA-256 $zipHash"
} finally {
  if (Test-Path -LiteralPath $stageParent) {
    $resolvedStage = [System.IO.Path]::GetFullPath($stageParent)
    $resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\') + '\'
    if (-not $resolvedStage.StartsWith($resolvedOutput, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove unexpected staging path: $resolvedStage"
    }
    Remove-Item -Recurse -Force -LiteralPath $resolvedStage
  }
}
