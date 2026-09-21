# Keep the desktop strip up without a manual step: install a Startup-folder
# shortcut so it comes back by itself after a reboot or a sign-out.
#
# The strip is a separate always-on-top window, so it outlives Qoder and keeps
# showing the last archived turn (dimmed past 10 minutes). That is the point:
# it is the readout that is visible without switching to anything.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\overlay-autostart.ps1 -Install
#   powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\overlay-autostart.ps1 -Status
#   powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\overlay-autostart.ps1 -Remove
#
# No watchdog on purpose: the strip's own right-click menu has "close", and a
# watchdog would resurrect it right after the user asked it to go away.
# -Install also starts the strip now, so it is visible before the next logon.
#
# Deliberately ASCII-only: PowerShell 5.1 parses a BOM-less .ps1 as ANSI, which
# would break any CJK literal in here (overlay.ps1 keeps a BOM for that reason).

param(
    [switch]$Install,
    [switch]$Remove,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'

$PSScriptRoot_ = Split-Path -Parent $MyInvocation.MyCommand.Path
$overlay = Join-Path $PSScriptRoot_ 'overlay.ps1'
$startup = [Environment]::GetFolderPath('Startup')
$shortcut = Join-Path $startup 'token-stats overlay.lnk'

function Get-OverlayState {
    $status = & powershell -NoProfile -File $overlay -Status
    return "$status".Trim()
}

if ($Remove) {
    if (Test-Path -LiteralPath $shortcut) {
        Remove-Item -LiteralPath $shortcut -Force
        Write-Output "removed $shortcut"
    } else {
        Write-Output "no shortcut at $shortcut"
    }
    $state = Get-OverlayState
    if ($state -like 'running*') {
        & powershell -NoProfile -File $overlay -Stop | Out-Null
        Write-Output "stopped the running strip too ($state)"
    }
    exit 0
}

if ($Status) {
    Write-Output "shortcut : $(if (Test-Path -LiteralPath $shortcut) { $shortcut } else { 'not installed' })"
    Write-Output "strip    : $(Get-OverlayState)"
    exit 0
}

if (-not $Install) {
    Write-Output 'pass -Install, -Status or -Remove'
    exit 0
}

if (-not (Test-Path -LiteralPath $overlay)) {
    Write-Error "overlay.ps1 not found next to this script ($overlay)"
    exit 1
}

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
$link.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
$link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$overlay`""
$link.WorkingDirectory = $PSScriptRoot_
$link.Description = 'token-stats desktop strip'
# 1 = normal, NOT minimized/hidden: the shell turns a hidden or minimized launch
# into STARTUPINFO(wShowWindow), and Windows then overrides the *first* ShowWindow
# call with it — which is exactly the one WPF uses for the strip, so the strip
# would come up invisible with a live process behind it. PowerShell's own
# -WindowStyle Hidden in the argument list hides the console without poisoning
# the WPF window.
$link.WindowStyle = 1
$link.Save()
[void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)

Write-Output "installed $shortcut"
Write-Output "target   : $($link.TargetPath) $($link.Arguments)"

$state = Get-OverlayState
if ($state -like 'running*') {
    Write-Output "strip    : $state (already up)"
} else {
    # Detached: overlay.ps1 runs a WPF message loop and never returns, so calling
    # it in-process would hang this script forever. No -WindowStyle here for the
    # reason spelled out above the shortcut's WindowStyle.
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$overlay`"")
    Start-Sleep -Seconds 3
    Write-Output "strip    : $(Get-OverlayState)"
}
