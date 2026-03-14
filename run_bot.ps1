# Crypto Bot Runner — called by Windows Task Scheduler
# Logs output to cryptobot.log

$logFile = "C:\Users\Zen See\.easyclaw\workspace\cryptobot\cryptobot.log"
$botDir  = "C:\Users\Zen See\.easyclaw\workspace\cryptobot"

Add-Content $logFile "[$([datetime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))] Task triggered"

# Check if bot is already running
$existing = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    $_.MainWindowTitle -eq "" -and $_.CommandLine -like "*bot.js*"
}

if ($existing) {
    Add-Content $logFile "[$([datetime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))] Bot already running (PID $($existing.Id)), skipping."
    exit 0
}

# Run the bot cycle once
Set-Location $botDir
$env:PYTHONIOENCODING = "utf-8"
$output = node bot.js 2>&1
Add-Content $logFile "[$([datetime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))] $output"
