@echo off
cd /d "%~dp0"
start "Quiz V1.3.18 Public Launch Supervisor" /min cmd /c "set QUIZ_SITE_PORT=8792&& node server-supervisor.js"
ping 127.0.0.1 -n 4 >nul
start "" "http://127.0.0.1:8792/%E8%B6%A3%E5%91%B3%E5%88%B7%E9%A2%98%E5%B0%8F%E7%AB%99%E7%AC%AC%E4%B8%80%E7%89%88.html"
exit /b 0
