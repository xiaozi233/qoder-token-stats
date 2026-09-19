# Launch Qoder with QODERCN_EXPOSE_TOKEN_USAGE set in *its* own environment.
#
# setx writes HKCU\Environment but only *tells* running processes via
# WM_SETTINGCHANGE, and the process that launches Qoder frequently does not
# re-read it (its own launcher had already exited when this was observed). A
# variable that must be in the parent's env needs an explicit launcher.
#
#   1. Quit Qoder completely.
#   2. powershell -NoProfile -ExecutionPolicy Bypass -File launch-with-usage.ps1
#
# Verify afterwards: the token-stats line loses its "~" prefix, or
#   node runtime/token-stats.mjs --session <id> <cwd> --json | grep tokenSource
# reads "reported" instead of "estimated".

param(
    [string]$Exe,
    [switch]$CheckOnly
)

$VarName = 'QODERCN_EXPOSE_TOKEN_USAGE'

# The install is versioned (D:\Qoder CN\.qoder-versions\0.3.4\), so resolve the
# newest one instead of pinning a path that breaks on every Qoder update.
function Resolve-QoderExe {
    $root = 'D:\Qoder CN\.qoder-versions'
    if (-not (Test-Path -LiteralPath $root)) { return $null }
    $candidate = Get-ChildItem -LiteralPath $root -Directory |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'Qoder CN.exe') } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($candidate) { return (Join-Path $candidate.FullName 'Qoder CN.exe') }
    if (Test-Path -LiteralPath 'D:\Qoder CN\Qoder CN.exe') { return 'D:\Qoder CN\Qoder CN.exe' }
    $null
}

if (-not $Exe) {
    $Exe = Resolve-QoderExe
    if (-not $Exe) {
        Write-Error "Could not find 'Qoder CN.exe' under 'D:\Qoder CN\.qoder-versions' - pass -Exe explicitly."
        exit 1
    }
}

if ($CheckOnly) {
    $running = Get-Process -Name 'Qoder CN' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $running) { Write-Output ("Qoder is not running. Would launch: {0}" -f $Exe); exit 0 }
    $stored = (Get-ItemProperty -Path 'HKCU:\Environment' -Name $VarName -ErrorAction SilentlyContinue).$VarName
    $storedText = if ($stored) { $stored } else { '<unset>' }
    Write-Output ("Qoder PID {0} started {1}; HKCU\Environment\{2} = {3}" -f $running.Id, $running.StartTime, $VarName, $storedText)
    Write-Output ("Would launch: {0}" -f $Exe)
    exit 0
}

if (-not (Test-Path -LiteralPath $Exe)) {
    Write-Error "Not found: $Exe -- point -Exe at the current version under 'D:\Qoder CN\.qoder-versions\'."
    exit 1
}
if (Get-Process -Name 'Qoder CN' -ErrorAction SilentlyContinue) {
    Write-Error 'Qoder is still running - quit it first, or the new process just hands off to the old one and inherits nothing.'
    exit 1
}

Set-Item -Path ("Env:{0}" -f $VarName) -Value '1'
Start-Process -FilePath $Exe
Write-Output ("Launched {0} with {1}=1 in its environment." -f $Exe, $VarName)
