@echo off
setlocal EnableExtensions

rem GoLiveBypass - atalho para quem nao quer mexer no PowerShell.
rem Basta dar dois cliques neste arquivo.
rem
rem O caminho nunca e embutido: %~dp0 e resolvido na hora, entao funciona em pastas com
rem espaco e com acento no nome de usuario.

set "GLB_SCRIPT=%~dp0GoLiveBypass-Installer.ps1"
set "GLB_URL=https://raw.githubusercontent.com/bezumiya/GoLiveBypass/main/installer/GoLiveBypass-Installer.ps1"
set "GLB_TMP=%GLB_SCRIPT%.download-%RANDOM%-%RANDOM%.tmp"

echo.
echo   Baixando o instalador atual...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $tmp = $env:GLB_TMP; $dest = $env:GLB_SCRIPT; try { Invoke-WebRequest -UseBasicParsing -Uri $env:GLB_URL -OutFile $tmp; if (-not (Test-Path -LiteralPath $tmp -PathType Leaf) -or (Get-Item -LiteralPath $tmp).Length -lt 1024) { throw 'download vazio ou curto' }; $content = [IO.File]::ReadAllText($tmp, [Text.Encoding]::UTF8); foreach ($marker in @('[CmdletBinding()]', 'param(', '$PluginFiles = @(')) { if (-not $content.Contains($marker)) { throw ('sentinela ausente: ' + $marker) } }; $tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile($tmp, [ref]$tokens, [ref]$errors) | Out-Null; if ($null -eq $errors -or $errors.Count -gt 0) { throw 'PS1 baixado com erro de sintaxe' }; if (Test-Path -LiteralPath $dest -PathType Leaf) { [IO.File]::Replace($tmp, $dest, $null, $true) } else { [IO.File]::Move($tmp, $dest) } } catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
if errorlevel 1 goto :download_failed
if not exist "%GLB_SCRIPT%" goto :download_failed

powershell -NoProfile -ExecutionPolicy Bypass -File "%GLB_SCRIPT%" %*
set "GLB_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %GLB_EXIT%

:download_failed
del /q "%GLB_TMP%" >nul 2>&1
echo.
echo   Nao consegui atualizar o instalador. A copia anterior nao sera executada.
echo   Verifique sua conexao e tente novamente.
echo.
pause
exit /b 1
