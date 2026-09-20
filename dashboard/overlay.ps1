# token-stats desktop overlay: an always-visible tok/s strip.
#
# The chat line depends on the model choosing to print it. This does not: the
# Stop hook rewrites latest.json on every turn, and the strip just renders it.
#
#   start   powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\overlay.ps1
#   status  powershell -NoProfile -File dashboard\overlay.ps1 -Status
#   stop    powershell -NoProfile -File dashboard\overlay.ps1 -Stop
#
# Drag it anywhere; the position is remembered. Right-click for the menu.
#
# Keep the UTF-8 BOM on this file. PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# and the CJK literals below then break the parse.

#Requires -Version 5.1
param(
    [switch]$Stop,
    [switch]$Status,
    [string]$DataDir = (Join-Path $env:USERPROFILE '.qoder-cn\plugins\data\token-stats-local'),
    [string]$ProcessName = 'Qoder CN'
)

$ErrorActionPreference = 'Stop'
$PidFile = Join-Path $env:TEMP 'token-stats.overlay.pid'
$PosFile = Join-Path $env:TEMP 'token-stats.overlay.pos'
$StripW = 700
$StripH = 34

if ($Status) {
    if (Test-Path $PidFile) {
        $old = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
            Write-Output "running (pid $old)"
            exit 0
        }
    }
    Write-Output 'not running'
    exit 0
}

if ($Stop) {
    if (Test-Path $PidFile) {
        $old = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
            Stop-Process -Id $old -Force
            Write-Output "stopped pid $old"
            exit 0
        }
    }
    Write-Output 'not running'
    exit 0
}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public class Win32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@

# Without this, GetWindowRect and WPF coordinates disagree on a scaled display
# and the strip lands outside the window it is supposed to hug.
[void][Win32]::SetProcessDPIAware()

if (Test-Path $PidFile) {
    $old = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
        Write-Output "already running (pid $old) - use -Stop first"
        exit 0
    }
}
Set-Content -Path $PidFile -Value $PID

$Ink = @{
    dark  = @{ main = '#FFE8ECF7'; dim = '#FF8B94AD'; bg = '#D9151A26' }
    light = @{ main = '#FF222A3A'; dim = '#FF6B7488'; bg = '#E6F5F7FB' }
}

function Get-HostLuminance($name) {
    try {
        $proc = Get-Process -Name $name -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if (-not $proc) { return $null }
        $rect = New-Object RECT
        if (-not [Win32]::GetWindowRect($proc.MainWindowHandle, [ref]$rect)) { return $null }
        $x = $rect.Right - 8
        $y = $rect.Top + 60
        $h = [Math]::Max(60, $rect.Bottom - $rect.Top - 160)
        $bmp = New-Object System.Drawing.Bitmap(4, $h)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size(4, $h)))
        $g.Dispose()
        $vals = New-Object System.Collections.ArrayList
        for ($i = 0; $i -lt $h; $i += 8) {
            $c = $bmp.GetPixel(2, $i)
            [void]$vals.Add(($c.R * 0.299 + $c.G * 0.587 + $c.B * 0.114))
        }
        $bmp.Dispose()
        if ($vals.Count -eq 0) { return $null }
        $vals.Sort()
        return $vals[[int]($vals.Count / 2)]
    } catch { return $null }
}

function Read-Stats($dir) {
    try {
        $file = Join-Path $dir 'latest.json'
        $raw = [System.IO.File]::ReadAllText($file)
        return ($raw | ConvertFrom-Json)
    } catch { return $null }
}

$window = New-Object System.Windows.Window
$window.WindowStyle = 'None'
$window.ResizeMode = 'NoResize'
$window.AllowsTransparency = $true
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.Width = $StripW
$window.Height = $StripH
$window.Title = 'token-stats overlay'

$grid = New-Object System.Windows.Controls.Grid
$text = New-Object System.Windows.Controls.TextBlock
$text.FontFamily = New-Object System.Windows.Media.FontFamily('Cascadia Mono, Consolas, Microsoft YaHei UI')
$text.FontSize = 13
$text.VerticalAlignment = 'Center'
$text.HorizontalAlignment = 'Left'
$text.Margin = New-Object System.Windows.Thickness(12, 0, 12, 0)
$text.Text = 'token-stats: 等待第一轮…'
[void]$grid.Children.Add($text)
$window.Content = $grid

$menu = New-Object System.Windows.Controls.ContextMenu
$closeItem = New-Object System.Windows.Controls.MenuItem
$closeItem.Header = '关闭监控条'
$closeItem.Add_Click({ $window.Close() })
[void]$menu.Items.Add($closeItem)
$window.ContextMenu = $menu

$script:Dragged = $false
$window.Add_MouseLeftButtonDown({
    $window.DragMove()
    $script:Dragged = $true
})

function Get-SavedPosition {
    try {
        $p = Get-Content $PosFile -ErrorAction Stop
        $xy = $p.Split(',')
        return @{ x = [double]$xy[0]; y = [double]$xy[1] }
    } catch { return $null }
}

function Set-Anchor($w) {
    $saved = Get-SavedPosition
    if ($saved) {
        $w.Left = $saved.x
        $w.Top = $saved.y
        Clamp-ToWorkArea $w
        return
    }
    $proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($proc) {
        $rect = New-Object RECT
        if ([Win32]::GetWindowRect($proc.MainWindowHandle, [ref]$rect)) {
            $w.Left = $rect.Right - $StripW - 24
            $w.Top = $rect.Bottom - 150
            Clamp-ToWorkArea $w
            return
        }
    }
    $area = [System.Windows.SystemParameters]::WorkArea
    $w.Left = $area.Right - $StripW - 40
    $w.Top = $area.Bottom - $StripH - 40
}

# Before Show() WPF reports Left/Top as -32000 in device pixels (about -21845
# DIPs on a scaled display). Restoring that value parks the strip off-screen,
# so every position gets pulled back inside the work area.
function Clamp-ToWorkArea($w) {
    $area = [System.Windows.SystemParameters]::WorkArea
    $minX = $area.X - $StripW + 80
    $minY = $area.Y - $StripH + 40
    $maxX = $area.X + $area.Width - 80
    $maxY = $area.Y + $area.Height - 24
    if ($w.Left -lt $minX -or $w.Left -gt $maxX) {
        $w.Left = $area.Right - $StripW - 40
    }
    if ($w.Top -lt $minY -or $w.Top -gt $maxY) {
        $w.Top = $area.Bottom - $StripH - 40
    }
}

Set-Anchor $window

$script:App = New-Object System.Windows.Application
$script:App.ShutdownMode = 'OnExplicitShutdown'

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(1)

$timer.Add_Tick({
    if ($script:Dragged) {
        $script:Dragged = $false
        Clamp-ToWorkArea $window
        try { Set-Content -Path $PosFile -Value ("{0},{1}" -f $window.Left, $window.Top) } catch { }
    }

    $luminance = Get-HostLuminance $ProcessName
    $theme = if ($null -eq $luminance) { 'dark' } elseif ($luminance -gt 140) { 'light' } else { 'dark' }
    $palette = $Ink[$theme]
    $window.Background = New-Object System.Windows.Media.SolidColorBrush(
        [System.Windows.Media.ColorConverter]::ConvertFromString($palette.bg))

    $stats = Read-Stats $DataDir
    if (-not $stats) {
        $text.Text = 'token-stats: 还没有归档数据（等一轮回答结束）'
        $text.Foreground = New-Object System.Windows.Media.SolidColorBrush(
            [System.Windows.Media.ColorConverter]::ConvertFromString($palette.dim))
        return
    }

    $age = ((Get-Date) - [DateTime]::Parse($stats.at)).TotalSeconds
    # latest.json is written by the Stop hook, so while a turn is in flight the
    # strip still shows the one that just finished. "(本轮)" would be a lie there.
    $text.Text = ([string]$stats.line).Replace('(本轮)', '(上一轮)')
    $text.Foreground = New-Object System.Windows.Media.SolidColorBrush(
        [System.Windows.Media.ColorConverter]::ConvertFromString($(if ($age -gt 600) { $palette.dim } else { $palette.main })))
})
$timer.Start()

$window.Add_Closed({
    $timer.Stop()
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    $script:App.Dispatcher.Invoke([Action]{ [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown() }, 'Normal')
})

$window.Show()
[System.Windows.Threading.Dispatcher]::Run()
