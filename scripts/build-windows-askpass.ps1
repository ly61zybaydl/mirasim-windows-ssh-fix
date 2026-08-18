[CmdletBinding()]
param(
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-Sha256Hex([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifestPath = Join-Path $repositoryRoot 'assets\windows-askpass\manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json

if ($manifest.schemaVersion -ne 1) { throw 'Unsupported Windows askpass manifest schema.' }
if ($manifest.target -ne 'windows-x64') { throw 'The Windows askpass manifest has an unexpected target.' }
if ($manifest.source.path -ne 'native/windows-askpass/Program.cs') {
  throw 'The Windows askpass manifest has an unexpected source path.'
}
if (@($manifest.files.PSObject.Properties).Count -ne 1) {
  throw 'The Windows askpass manifest must contain exactly one output file.'
}
$fileEntry = $manifest.files.'windows-askpass.exe'
if ($null -eq $fileEntry -or $fileEntry.releaseAsset -ne $true) {
  throw 'The Windows askpass manifest must declare windows-askpass.exe as a release asset.'
}
$shaPattern = '^[a-f0-9]{64}$'
if ($manifest.source.sha256 -notmatch $shaPattern -or $fileEntry.sha256 -notmatch $shaPattern) {
  throw 'The Windows askpass manifest contains an invalid SHA-256 value.'
}

$sourcePath = Join-Path $repositoryRoot ($manifest.source.path -replace '/', '\')
$actualSourceHash = Get-Sha256Hex $sourcePath
if ($actualSourceHash -ne $manifest.source.sha256) {
  throw "Windows askpass source hash mismatch: expected $($manifest.source.sha256), got $actualSourceHash"
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $repositoryRoot 'assets\windows-askpass'
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)

$compilerCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compilerPath = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($compilerPath)) {
  throw 'Microsoft .NET Framework csc.exe was not found. Install/enable .NET Framework 4.x.'
}

$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$temporaryRoot = Join-Path $temporaryBase "mirasim-askpass-build-$([System.Guid]::NewGuid().ToString('N'))"
$temporaryExecutable = Join-Path $temporaryRoot 'windows-askpass.exe'
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null

try {
  & $compilerPath /nologo /target:winexe /optimize+ /platform:x64 "/out:$temporaryExecutable" $sourcePath
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $temporaryExecutable)) {
    throw "Windows askpass compilation failed with exit code $LASTEXITCODE."
  }

  # The inbox .NET Framework compiler emits a wall-clock PE timestamp and a
  # random module version ID. Normalize only those two fields so identical
  # reviewed source produces identical release bytes on the same toolchain.
  # Read the MVID in a short-lived child process. Loading a .NET Framework
  # assembly in this process would lock the temporary EXE until PowerShell exits.
  $metadataReader = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $metadataReader)) {
    throw 'Windows PowerShell is required to inspect the compiled .NET Framework assembly.'
  }
  $readerSource = @'
$path = $env:MIRASIM_ASKPASS_BUILD_INPUT
$assembly = [Reflection.Assembly]::LoadFile([IO.Path]::GetFullPath($path))
[Console]::Out.Write($assembly.ManifestModule.ModuleVersionId.ToString("D"))
'@
  $readerCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($readerSource))
  $previousReaderInput = [Environment]::GetEnvironmentVariable('MIRASIM_ASKPASS_BUILD_INPUT', 'Process')
  try {
    [Environment]::SetEnvironmentVariable('MIRASIM_ASKPASS_BUILD_INPUT', $temporaryExecutable, 'Process')
    $mvidText = & $metadataReader -NoProfile -NonInteractive -EncodedCommand $readerCommand
    if ($LASTEXITCODE -ne 0) { throw 'Failed to inspect the compiled Windows askpass assembly.' }
  } finally {
    [Environment]::SetEnvironmentVariable('MIRASIM_ASKPASS_BUILD_INPUT', $previousReaderInput, 'Process')
  }
  $mvidBytes = ([System.Guid]::Parse(([string]$mvidText).Trim())).ToByteArray()
  $bytes = [System.IO.File]::ReadAllBytes($temporaryExecutable)
  $matches = [System.Collections.Generic.List[int]]::new()
  for ($offset = 0; $offset -le $bytes.Length - $mvidBytes.Length; $offset += 1) {
    $same = $true
    for ($index = 0; $index -lt $mvidBytes.Length; $index += 1) {
      if ($bytes[$offset + $index] -ne $mvidBytes[$index]) {
        $same = $false
        break
      }
    }
    if ($same) { $matches.Add($offset) }
  }
  if ($matches.Count -ne 1) {
    throw "Expected exactly one compiled MVID byte sequence, found $($matches.Count)."
  }

  if ($bytes.Length -lt 64) { throw 'Compiled Windows askpass PE file is too small.' }
  $peOffset = [System.BitConverter]::ToInt32($bytes, 0x3c)
  if ($peOffset -lt 0x40 -or $peOffset + 12 -gt $bytes.Length) {
    throw 'Compiled Windows askpass PE header offset is invalid.'
  }
  if ($bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45 -or
      $bytes[$peOffset + 2] -ne 0 -or $bytes[$peOffset + 3] -ne 0) {
    throw 'Compiled Windows askpass output does not contain a valid PE signature.'
  }
  for ($index = 0; $index -lt 4; $index += 1) { $bytes[$peOffset + 8 + $index] = 0 }
  for ($index = 0; $index -lt 16; $index += 1) {
    $bytes[$matches[0] + $index] = [System.Convert]::ToByte(
      $actualSourceHash.Substring($index * 2, 2),
      16
    )
  }

  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
  $outputPath = Join-Path $OutputDirectory 'windows-askpass.exe'
  $outputSha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $actualOutputHash = ([System.BitConverter]::ToString($outputSha256.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $outputSha256.Dispose()
  }
  if ($actualOutputHash -ne $fileEntry.sha256) {
    throw "Windows askpass output hash mismatch: expected $($fileEntry.sha256), got $actualOutputHash"
  }
  [System.IO.File]::WriteAllBytes($outputPath, $bytes)

  Write-Output "Built $outputPath"
  Write-Output "SHA-256 $actualOutputHash"
} finally {
  $resolvedTemporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
  if (-not $resolvedTemporaryRoot.StartsWith($temporaryBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove unexpected temporary path: $resolvedTemporaryRoot"
  }
  if (Test-Path -LiteralPath $resolvedTemporaryRoot) {
    Remove-Item -Recurse -Force -LiteralPath $resolvedTemporaryRoot
  }
}
