@echo off
if exist "%~dp0..\runtime\node\node.exe" ("%~dp0..\runtime\node\node.exe" "%~dp0qobuzify.js" %*) else (node "%~dp0qobuzify.js" %*)
