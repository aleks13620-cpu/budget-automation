@echo off
chcp 65001 >nul
rem Price-search worker (variant A). Double-click on the WORK machine: the Yandex Search
rem key and the "home" IP live here, so the search itself runs here.
rem Keep this window open: while it is closed, the button in the system keeps queueing
rem jobs, but nobody runs them.
rem Text is ASCII on purpose - cmd garbles a UTF-8 .bat (checked 26.08.2026).
set PYTHONUTF8=1
if "%BUDGET_API_URL%"=="" set BUDGET_API_URL=http://109.73.206.178:3001/api
rem Prod secret (only if API_SECRET is set on the server): one line in secrets\prod_api.txt,
rem the secrets\ folder is gitignored and never leaves this machine.
if exist "%~dp0secrets\prod_api.txt" set /p BUDGET_API_SECRET=<"%~dp0secrets\prod_api.txt"
cd /d "%~dp0"
python worker.py
echo.
echo Worker stopped. You can close this window.
pause
