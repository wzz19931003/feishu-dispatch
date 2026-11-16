param([ValidateSet('plan','install','start','status','stop','uninstall')][string]$Action = 'status', [string]$NodePath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$taskName = 'Shiyeji-FeishuDispatch'
$projectRoot = Split-Path -Parent $PSScriptRoot
$hostScript = Join-Path $PSScriptRoot 'Host.ps1'
$controlScript = Join-Path $PSScriptRoot 'control.mjs'
$cliScript = Join-Path $PSScriptRoot 'cli.mjs'
$description = 'Shiyeji production Feishu dispatch; current-user limited interactive task; no saved password; single active host.'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (!$NodePath) { $NodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
if ([IO.Path]::GetFileName($NodePath) -ine 'node.exe' -or !(Test-Path -LiteralPath $hostScript -PathType Leaf)) { throw 'Invalid Node executable or fixed task host.' }
$taskArguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -NodePath "{1}"' -f $hostScript, $NodePath
if ($Action -eq 'plan') {
    [ordered]@{ taskName=$taskName; execute=$psExe; arguments=$taskArguments; workingDirectory=$projectRoot; logonType='Interactive'; runLevel='Limited'; delaySeconds=30; changesMade=$false; automaticallyStartsNow=$false } | ConvertTo-Json
    exit 0
}
Import-Module ScheduledTasks -ErrorAction Stop
function Get-OwnTask { Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue }
function Assert-OwnTask($task) {
    if (!$task) { throw 'Production task is not installed.' }
    $principalMatches = $false
    try {
        $principalText = [string]$task.Principal.UserId
        if ($principalText -match '^S-\d-') { $principalSid = [Security.Principal.SecurityIdentifier]::new($principalText) }
        else { $principalSid = [Security.Principal.NTAccount]::new($principalText).Translate([Security.Principal.SecurityIdentifier]) }
        $principalMatches = $principalSid.Value -eq $identity.User.Value
    } catch { }
    $actions = @($task.Actions)
    if (!$principalMatches -or [string]$task.Principal.RunLevel -ne 'Limited' -or [string]$task.Principal.LogonType -ne 'Interactive' -or $task.Description -cne $description -or $actions.Count -ne 1 -or $actions[0].Execute -ine $psExe -or $actions[0].Arguments -cne $taskArguments -or $actions[0].WorkingDirectory -ine $projectRoot) { throw 'Existing task does not match this project and current user. No task changed.' }
}
function Get-ListenerStatus {
    $output = & $NodePath $controlScript status
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read production status; no credentials were printed.' }
    return ($output -join "`n" | ConvertFrom-Json)
}
function Show-OwnStatus($task) {
    if ($task) { Assert-OwnTask $task }
    [ordered]@{ taskName=$taskName; installed=[bool]$task; taskState=$(if ($task) { [string]$task.State } else { 'NotInstalled' }); listener=(Get-ListenerStatus); note='One active computer only. Task runs after this Windows account logs in.' } | ConvertTo-Json -Depth 10
}
$task = Get-OwnTask
switch ($Action) {
    'install' {
        if ($task) { Assert-OwnTask $task; if ([string]$task.State -eq 'Running') { throw 'Stop the task before reinstalling it.' } }
        & $NodePath $cliScript --check
        if ($LASTEXITCODE -ne 0) { throw 'Offline preflight failed. Task not installed.' }
        $actionSpec = New-ScheduledTaskAction -Execute $psExe -Argument $taskArguments -WorkingDirectory $projectRoot
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
        $trigger.Delay = 'PT30S'
        $principal = New-ScheduledTaskPrincipal -UserId $identity.User.Value -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskPath '\' -TaskName $taskName -Action $actionSpec -Trigger $trigger -Principal $principal -Settings $settings -Description $description -Force | Out-Null
        Disable-ScheduledTask -TaskPath '\' -TaskName $taskName | Out-Null
        Show-OwnStatus (Get-OwnTask)
        Write-Output 'Installed disabled. No dispatch will start until explicit start. Initialize history and review plan first.'
    }
    'start' { Assert-OwnTask $task; Enable-ScheduledTask -TaskPath '\' -TaskName $taskName | Out-Null; Start-ScheduledTask -TaskPath '\' -TaskName $taskName; Start-Sleep -Milliseconds 700; Show-OwnStatus (Get-OwnTask) }
    'status' { Show-OwnStatus $task }
    'stop' {
        Assert-OwnTask $task
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        $stopRequested = $false
        do {
            $current = Get-ListenerStatus
            if (!$stopRequested -and $current.processStatus -eq 'alive') { & $NodePath $controlScript stop; if ($LASTEXITCODE -ne 0) { throw 'Graceful stop request not confirmed.' }; $stopRequested = $true }
            $task = Get-OwnTask
            if ([string]$task.State -ne 'Running' -and $current.processStatus -ne 'alive') { break }
            Start-Sleep -Milliseconds 400
        } while ([DateTime]::UtcNow -lt $deadline)
        if ([string]$task.State -eq 'Running') { throw 'Still draining in-flight work. No process was killed. Check status before copying the database.' }
        Show-OwnStatus $task
    }
    'uninstall' {
        if ($task) { Assert-OwnTask $task; if ([string]$task.State -eq 'Running' -or (Get-ListenerStatus).processStatus -eq 'alive') { throw 'Gracefully stop production before uninstalling its task.' }; Unregister-ScheduledTask -TaskPath '\' -TaskName $taskName -Confirm:$false }
        Show-OwnStatus (Get-OwnTask)
    }
}
