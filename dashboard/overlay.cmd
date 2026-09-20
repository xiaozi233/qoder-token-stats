@echo off
rem Double-click to show the tok/s strip. Same as:
rem   powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\overlay.ps1
rem It stays in the background once started, so closing this window is fine.
start "token-stats overlay" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0overlay.ps1" %*
