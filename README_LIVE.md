# 🚀 AI-Trader LIVE Deployment

## Quick Start for Live Trading

### ⚡ 3-Step Live Setup:

1. **Prepare Environment**
   ```bash
   # Run deployment script
   deploy-live.bat
   ```

2. **Edit Configuration**
   - Open `.env` file
   - Replace ALL placeholder values with LIVE credentials
   - Save the file

3. **Start Trading**
   ```bash
   # Start everything
   start-production.bat
   ```

## 📋 What's Ready for Live:

### ✅ New Features Implemented:
1. **Cash Wallet System** - Top-up & commission tracking
2. **10% Capital Trading** - Uses 10% of wallet × leverage
3. **Token-Specific Leverage** - Set per token (20x default, up to 100x)
4. **3-Level Risk Management** - No/Medium/High risk profiles
5. **Referral Commission** - 10% from downline trading profits

### ✅ Production Ready:
- Health monitoring endpoint (`/health`)
- Database connection pooling
- Error handling and logging
- Telegram notifications
- Multiple deployment options

## 🔧 Live Configuration

### MUST EDIT in `.env`:

```bash
# TELEGRAM (Required for alerts)
TELEGRAM_TOKEN=YOUR_LIVE_BOT_TOKEN_HERE
TELEGRAM_CHAT_ID=YOUR_LIVE_CHAT_ID_HERE

# BITUNIX (Required for trading)
BITUNIX_API_KEY=YOUR_LIVE_API_KEY_HERE
BITUNIX_API_SECRET=YOUR_LIVE_API_SECRET_HERE

# DATABASE (Required)
DATABASE_URL=postgresql://user:password@host:5432/dbname

# SECURITY (Required)
JWT_SECRET=generate_strong_random_string_here
```

## 🎯 Trading Parameters

### Default Settings (Adjust if needed):
- **Capital per trade**: 10% of wallet
- **Default leverage**: 20x
- **Take Profit**: 2.25%
- **Stop Loss**: 1.5%
- **Max consecutive losses**: 2

### Risk Levels:
1. **No Risk**: 5% capital, 10x max
2. **Medium Risk**: 10% capital, 20x max ✓ DEFAULT
3. **High Risk**: 20% capital, 50x max

## 📊 Monitoring Live System

### Checkpoints:
1. **Health Status**: http://localhost:3000/health
2. **Telegram Alerts**: Bot should send status messages
3. **Exchange Positions**: Check Bitunix/Binance for open trades
4. **Database**: Verify trades are being recorded

### Key URLs:
- Web Interface: http://localhost:3000
- Health Check: http://localhost:3000/health
- API Status: http://localhost:3000/health/ping

## 🚨 Emergency Procedures

### To Stop Immediately:
1. Press `Ctrl+C` in both command windows
2. Close positions manually on exchange
3. Disable API keys if needed

### Common Issues:
- **No Telegram messages**: Check bot token and chat ID
- **Trades not executing**: Verify API keys and wallet balance
- **Database errors**: Check DATABASE_URL connection

## ⚠️ IMPORTANT WARNINGS

### BEFORE TRADING WITH REAL MONEY:
1. **START SMALL** - Test with minimal amount first
2. **MONITOR** - Watch first few trades closely
3. **VERIFY** - Check all stop losses are set
4. **BACKUP** - Regular database backups

### RISK ACKNOWLEDGEMENT:
- Cryptocurrency trading is high risk
- Only use funds you can afford to lose
- Past performance ≠ future results
- Automated trading doesn't eliminate risk

## 🏁 Ready for Live?

When you've:
1. ✅ Edited `.env` with LIVE credentials
2. ✅ Verified database connection
3. ✅ Tested Telegram notifications
4. ✅ Understood the risks

Run: `start-production.bat`

**Your AI trading bot is ready for live markets!** 🎉

---

*Need help? Check `LIVE_CHECKLIST.md` for detailed setup instructions.*