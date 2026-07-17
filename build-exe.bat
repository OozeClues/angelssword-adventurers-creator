@echo off
REM AS Adventurer release builder
REM   build-exe.bat                 → Windows x64
REM   build-exe.bat win-arm64       → Windows ARM64
REM   build-exe.bat linux-x64       → Linux x64
REM   build-exe.bat all             → all OS/arch ZIPs
REM   build-exe.bat all-flatpak     → all ZIPs + Flatpaks (needs Linux + flatpak-builder)
set TARGET=%~1
if "%TARGET%"=="" set TARGET=win-x64
echo Building AS Adventurer (%TARGET%)...
node build-exe.js --target %TARGET%
if errorlevel 1 pause
pause
