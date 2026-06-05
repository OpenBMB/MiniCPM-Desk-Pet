@echo off
:: run.cmd — local-minicpm-pet-openvino 入口脚本
:: 双击即可运行，无需关心 PowerShell 执行策略
:: 所有参数原样传递给 run.ps1（如 --china、--status、--stop、--debug、--device GPU）
powershell -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
if %ERRORLEVEL% neq 0 (
    echo.
    echo 部署过程中出现错误，错误码: %ERRORLEVEL%
    echo 请尝试执行: scripts\run.ps1 --debug 查看详细诊断信息
)
pause
