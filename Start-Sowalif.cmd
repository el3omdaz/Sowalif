@echo off
cd /d "%~dp0"
node server/local-agent/start.mjs
if errorlevel 1 pause
