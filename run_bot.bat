@echo off
title CryptoBot - Running
cd /d "C:\Users\Zen See\.easyclaw\workspace\cryptobot"
:loop
echo [%date% %time%] Running cycle...
node cycle.js >> cryptobot.log 2>&1
echo [%date% %time%] Sleeping 30 minutes...
timeout /t 1800 /nobreak > nul
goto loop
