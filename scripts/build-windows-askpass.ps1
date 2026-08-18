[CmdletBinding()]
param(
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$sourcePath = Join-Path $repositoryRoot 'native\windows-askpass\Program.cs'
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
  throw 'Microsoft .NET Framework csc.exe was not found. Install or enable .NET Framework 4.x.'
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$outputPath = Join-Path $OutputDirectory 'windows-askpass.exe'

& $compilerPath /nologo /target:winexe /optimize+ /platform:x64 "/out:$outputPath" $sourcePath
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outputPath)) {
  throw "Windows askpass compilation failed with exit code $LASTEXITCODE."
}

Write-Output "Built $outputPath"
