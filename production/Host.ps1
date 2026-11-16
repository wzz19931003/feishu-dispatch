param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$cliScript = Join-Path $PSScriptRoot 'cli.mjs'
$logRoot = Join-Path $projectRoot 'logs'
$exitCode = 1
try {
    $NodePath = (Resolve-Path -LiteralPath $NodePath).Path
    if ([IO.Path]::GetFileName($NodePath) -ine 'node.exe' -or !(Test-Path -LiteralPath $cliScript -PathType Leaf)) { throw 'Invalid fixed runner or Node executable.' }
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $stem = 'production-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString()
    $stdout = Join-Path $logRoot ($stem + '.log')
    $stderr = Join-Path $logRoot ($stem + '.error.log')
    $child = Start-Process -FilePath $NodePath -ArgumentList @('"' + $cliScript + '"','--run') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $null = $child.Handle
    $child.WaitForExit()
    $child.Refresh()
    $exitCode = $child.ExitCode
} catch { [Console]::Error.WriteLine('Production host failed. Inspect dedicated safe logs. No credentials printed.'); $exitCode = 1 }
exit $exitCode
