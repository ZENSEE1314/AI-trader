' Launches the bot loop silently in background (no console window)
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "node.exe ""C:\Users\Zen See\.easyclaw\workspace\cryptobot\loop.js""", 0, False
