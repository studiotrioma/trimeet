@echo off
chcp 65001 >nul
title TriMeet - publicar
cd /d "%~dp0"
echo.
echo   ===============================================
echo     TriMeet - publicar servidor
echo   ===============================================
echo.
where node >nul 2>nul
if errorlevel 1 goto semnode

call npx -y wrangler@4 whoami >nul 2>nul
if errorlevel 1 goto login
goto deploy

:login
echo   Entrando na sua conta Cloudflare - clique em Allow no navegador...
call npx -y wrangler@4 login
if errorlevel 1 goto erro

:deploy
echo   Publicando...
call npx -y wrangler@4 deploy
if errorlevel 1 goto erro
echo.
echo.
choice /c SN /n /t 20 /d N /m "  Criar ou trocar o codigo de convite do site? S ou N: "
if errorlevel 2 goto turn
echo   Digite o codigo de convite que seus amigos vao usar no site e aperte Enter:
call npx -y wrangler@4 secret put INVITE_CODE

:turn
echo.
choice /c SN /n /t 10 /d N /m "  Configurar o retransmissor TURN agora? S ou N: "
if errorlevel 2 goto fim
echo   Cole a Turn Token ID e aperte Enter:
call npx -y wrangler@4 secret put TURN_KEY_ID
echo   Cole o API Token e aperte Enter:
call npx -y wrangler@4 secret put TURN_KEY_API_TOKEN

:fim
echo.
echo   ===============================================
echo     PRONTO! Pode fechar esta janela.
echo   ===============================================
pause
exit /b

:semnode
echo   Falta o Node.js neste PC. Vou abrir o site para baixar.
start https://nodejs.org/pt
pause
exit /b

:erro
echo.
echo   Algo deu errado. Tire um print desta janela e mande pro Claude.
pause
exit /b
