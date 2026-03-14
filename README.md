# 🤖 Crypto Trading Bot

Autonomous Binance Futures trading bot hosted on Vercel, running 24/7.

## How It Works

1. **Every 30 minutes** Vercel Cron triggers `/api/monitor`
2. Bot checks open positions — if holding, reports PnL
3. If no position → scans top 40 coins by volume
4. Scores each coin on: 24h gain, 1h momentum, green candle streak, distance from day high, funding rate
5. Opens best LONG with **20x isolated margin**
6. Sets **Take Profit (+4%)** and **Stop Loss (-1.5%)** automatically
7. Sends **Telegram notification** for every action

## Setup

### 1. Clone & Deploy to Vercel

```bash
git clone https://github.com/YOUR_USERNAME/cryptobot
cd cryptobot
npm install
vercel deploy --prod
```

### 2. Set Environment Variables in Vercel

Go to: Vercel Dashboard → Your Project → Settings → Environment Variables

| Variable | Value |
|----------|-------|
| `BINANCE_API_KEY` | Your Binance API key |
| `BINANCE_API_SECRET` | Your Binance API secret |
| `TELEGRAM_TOKEN` | Your Telegram bot token (from @BotFather) |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID |

### 3. Binance API Key Setup

Create API key at Binance with:
- ✅ Enable Futures Trading
- ✅ Enable Reading  
- ❌ Disable Withdrawals (never enable!)
- Set IP whitelist to your Vercel server IP

### 4. Telegram Bot Setup

1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot` → follow steps → get your `TELEGRAM_TOKEN`
3. Get your chat ID: message [@userinfobot](https://t.me/userinfobot)

## Strategy

| Parameter | Value |
|-----------|-------|
| Leverage | 20x Isolated |
| Take Profit | +4% |
| Stop Loss | -1.5% |
| Risk:Reward | 1:2.67 |
| Trigger | Every 30 min |
| Min volume | $50M/24h |

## Cron Schedule

Edit `vercel.json` to change frequency:
- `*/30 * * * *` = every 30 minutes
- `0 * * * *` = every hour
- `0 */3 * * *` = every 3 hours

## ⚠️ Disclaimer

This bot trades real money. Use at your own risk. Always test with small amounts first.
