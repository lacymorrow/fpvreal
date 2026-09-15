@echo off
rem run-scene.cmd <youtube id or video path> <scene name> [extra fpvreal-scene args]
rem A YouTube id, not a URL: cmd splits arguments at the = sign.
setlocal
for /d %%d in (D:\tools\ffmpeg-*) do set FFBIN=%%d\bin
set PATH=D:\tools\bin;D:\tools;%FFBIN%;C:\Users\io\.local\bin;%PATH%
cd /d D:\repo\fpvreal\pipeline
set SRC=%~1
set NAME=%~2
if not exist "%SRC%" set SRC=https://www.youtube.com/watch?v=%SRC%
shift
shift
set EXTRA=
:loop
if "%~1"=="" goto run
set EXTRA=%EXTRA% %~1
shift
goto loop
:run
if not exist D:\repo\fpvreal\scenes mkdir D:\repo\fpvreal\scenes
uv run fpvreal-scene "%SRC%" --out D:\repo\fpvreal\scenes\%NAME% %EXTRA% > D:\repo\fpvreal\scenes\%NAME%.log 2>&1
