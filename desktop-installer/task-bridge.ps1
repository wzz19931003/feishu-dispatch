param(
    [Parameter(Mandatory=$true)][ValidateSet('inspect','suspend','configure','arm','start')][string]$Mode,
    [Parameter(Mandatory=$true)][string]$Project,
    [ValidateSet('preserve','on','off')][string]$Startup = 'preserve'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$taskName = 'Shiyeji-FeishuDispatch-V2'
$taskPath = '\'
$psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
function Fail([string]$code) { throw $code }
function Read-Task { Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop }
try {
    Import-Module (Join-Path $PSHOME 'Modules\ScheduledTasks\ScheduledTasks.psd1') -ErrorAction Stop
    $projectRoot = (Get-Item -LiteralPath $Project -ErrorAction Stop).FullName
    $taskScript = Join-Path $projectRoot 'production-v2\Task.ps1'
    $controlScript = Join-Path $projectRoot 'production\control.mjs'
    $task = Read-Task
    $actions = @($task.Actions)
    if ($actions.Count -ne 1 -or $actions[0].WorkingDirectory -ine $projectRoot) { Fail 'TASK_WRONG_PROJECT' }
    $nodeMatch = [regex]::Match([string]$actions[0].Arguments, ' -NodePath "([^"\r\n]+)"$')
    if (!$nodeMatch.Success) { Fail 'TASK_NODE_UNKNOWN' }
    $nodePath = $nodeMatch.Groups[1].Value
    if (![IO.Path]::IsPathRooted($nodePath) -or [IO.Path]::GetFileName($nodePath) -ine 'node.exe' -or !(Test-Path -LiteralPath $nodePath -PathType Leaf)) { Fail 'TASK_NODE_UNKNOWN' }
    # Task.ps1 binds the original account, action, executable, description and root.
    $status = & $psExe -NoLogo -NoProfile -NonInteractive -File $taskScript -Action status -NodePath $nodePath
    if ($LASTEXITCODE -ne 0) { Fail 'TASK_IDENTITY_MISMATCH' }
    $status = $status -join "`n" | ConvertFrom-Json
    $legacy = Get-ScheduledTask -TaskPath $taskPath -TaskName 'Shiyeji-FeishuDispatch' -ErrorAction SilentlyContinue
    if ($legacy -and ([string]$legacy.State -ne 'Disabled' -or $legacy.Actions.WorkingDirectory -ine $projectRoot)) { Fail 'LEGACY_TASK_CONFLICT' }
    $triggers = @($task.Triggers)
    if ($triggers.Count -ne 1 -or $triggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger') { Fail 'TASK_LOGON_TRIGGER_UNEXPECTED' }
    $logon = $triggers[0]
    switch ($Mode) {
        'inspect' {
            [ordered]@{ok=$true; nodePath=$nodePath; loginEnabled=[bool]$logon.Enabled; taskState=[string]$task.State; listener=$status.listener} | ConvertTo-Json -Depth 10 -Compress
        }
        'suspend' {
            if ($status.listener.processStatus -notin @('absent','alive')) { Fail 'TASK_LISTENER_UNKNOWN' }
            if ($status.listener.processStatus -eq 'alive' -and [string]$task.State -ne 'Running') { Fail 'TASK_LISTENER_NOT_OWNED' }
            Disable-ScheduledTask -TaskPath $taskPath -TaskName $taskName | Out-Null
            # Request normal drainage after disarming future logon/restart triggers.
            $deadline = [DateTime]::UtcNow.AddSeconds(100)
            $requested = $false
            do {
                $raw = & $nodePath $controlScript status
                if ($LASTEXITCODE -ne 0) { Fail 'TASK_STATUS_FAILED' }
                $listener = ($raw -join "`n") | ConvertFrom-Json
                if ($listener.processStatus -eq 'alive' -and !$requested) {
                    & $nodePath $controlScript stop | Out-Null
                    if ($LASTEXITCODE -ne 0) { Fail 'TASK_STOP_NOT_CONFIRMED' }
                    $requested = $true
                }
                $task = Read-Task
                if ($listener.processStatus -eq 'absent' -and [string]$task.State -eq 'Disabled') { break }
                Start-Sleep -Milliseconds 500
            } while ([DateTime]::UtcNow -lt $deadline)
            if ($listener.processStatus -ne 'absent' -or [string]$task.State -ne 'Disabled') { Fail 'TASK_DRAIN_TIMEOUT' }
            [ordered]@{ok=$true; listener=$listener; taskState=[string]$task.State} | ConvertTo-Json -Depth 10 -Compress
        }
        'configure' {
            if ([string]$task.State -ne 'Disabled' -or $status.listener.processStatus -ne 'absent') { Fail 'TASK_STILL_ACTIVE' }
            if ($Startup -ne 'preserve' -and [bool]$logon.Enabled -ne ($Startup -eq 'on')) {
                $logon.Enabled = ($Startup -eq 'on')
                Set-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Trigger @($logon) | Out-Null
            }
            $updated = Read-Task
            if ([string]$updated.State -ne 'Disabled') { Fail 'TASK_DISABLED_STATE_CHANGED' }
            $verified = @($updated.Triggers)
            if ($verified.Count -ne 1 -or ($Startup -ne 'preserve' -and [bool]$verified[0].Enabled -ne ($Startup -eq 'on'))) { Fail 'TASK_STARTUP_VERIFY_FAILED' }
            [ordered]@{ok=$true; loginEnabled=[bool]$verified[0].Enabled; taskState=[string]$updated.State} | ConvertTo-Json -Compress
        }
        'arm' {
            if ([string]$task.State -ne 'Disabled' -or $status.listener.processStatus -ne 'absent') { Fail 'TASK_STILL_ACTIVE' }
            & $nodePath (Join-Path $projectRoot 'production-v2\cli.mjs') --activation-check | Out-Null
            if ($LASTEXITCODE -ne 0) { Fail 'TASK_CONFIGURATION_DISABLED' }
            Enable-ScheduledTask -TaskPath $taskPath -TaskName $taskName | Out-Null
            [ordered]@{ok=$true; loginEnabled=[bool]$logon.Enabled; taskState=[string](Read-Task).State} | ConvertTo-Json -Compress
        }
        'start' {
            if ([string]$task.State -ne 'Disabled' -or $status.listener.processStatus -ne 'absent') { Fail 'TASK_STILL_ACTIVE' }
            & $psExe -NoLogo -NoProfile -NonInteractive -File $taskScript -Action start -NodePath $nodePath | Out-Null
            if ($LASTEXITCODE -ne 0) { Fail 'TASK_START_NOT_CONFIRMED' }
            [ordered]@{ok=$true} | ConvertTo-Json -Compress
        }
    }
} catch {
    $code = [string]$_.Exception.Message
    if ($code -notmatch '^[A-Z][A-Z0-9_]{2,90}$') { $code = 'TASK_BRIDGE_FAILED' }
    [ordered]@{ok=$false; code=$code} | ConvertTo-Json -Compress
    exit 1
}
