# 🚀 LIVE DEPLOYMENT CHECKLIST

## ⚠️ CRITICAL - BEFORE GOING LIVE

### 1. **API Keys & Security**
- [ ] **Telegram Bot Token**: Replace with live bot token
- [ ] **Telegram Chat ID**: Your actual chat/channel ID
- [ ] **Bitunix API Key**: LIVE trading API key (not testnet)
- [ ] **Bitunix API Secret**: LIVE trading secret key
- [ ] **Binance API Key** (if used): LIVE Futures API
- [ ] **JWT Secret**: Strong random string (min 32 chars)
- [ ] **Database Password**: Strong password for production DB

### 2. **Database Setup**
- [ ] **Production Database**: Use cloud PostgreSQL (Render, Railway, AWS RDS)
- [ ] **Backup Strategy**: Enable automated backups
- [ ] **Connection Pooling**: Configure for high traffic
- [ ] **Database Migrations**: Run `node setup-new-features.js`

### 3. **Financial Settings**
- [ ] **Wallet Amounts**: Set realistic starting balances
- [ ] **Risk Parameters**: Review TP/SL percentages
- [ ] **Leverage Settings**: Confirm token-specific leverages
- [ ] **Capital Percentage**: Default 10% (adjust if needed)
- [ ] **Commission Rates**: 10% from downline profits

### 4. **Monitoring & Alerts**
- [ ] **Telegram Notifications**: Test alert system
- [ ] **Error Logging**: Set up error tracking
- [ ] **Performance Monitoring**: Monitor response times
- [ ] **Trade Logs**: Ensure all trades are recorded

## 🚀 DEPLOYMENT STEPS

### Step 1: Environment Setup
```bash
# 1. Install dependencies
npm install --only=production

# 2. Configure environment
cp .env.example .env
# EDIT .env with LIVE values

# 3. Initialize database
node setup-new-features.js
```

### Step 2: Configuration Review
Edit `.env` file with these LIVE values:

```bash
# TELEGRAM (REQUIRED)
TELEGRAM_TOKEN=YOUR_LIVE_BOT_TOKEN
TELEGRAM_CHAT_ID=YOUR_LIVE_CHAT_ID

# BITUNIX (REQUIRED - REAL MONEY!)
BITUNIX_API_KEY=YOUR_LIVE_BITUNIX_API_KEY
BITUNIX_API_SECRET=YOUR_LIVE_BITUNIX_SECRET

# DATABASE (REQUIRED)
DATABASE_URL=postgresql://user:password@host:5432/dbname

# SECURITY (REQUIRED)
JWT_SECRET=strong_random_string_32_chars_min

# OPTIONAL (if using)
BINANCE_API_KEY=YOUR_LIVE_BINANCE_API_KEY
BINANCE_API_SECRET=YOUR_LIVE_BINANCE_SECRET
PROXY_URL=your_proxy_url_if_needed
```

### Step 3: Start Application
```bash
# Option A: Web Interface + API
npm run dev

# Option B: Trading Bot Only
npm start

# Option C: Both (separate terminals)
# Terminal 1: npm run dev
# Terminal 2: npm start
```

### Step 4: Verification
1. **Health Check**: http://localhost:3000/health
2. **API Test**: Login and check dashboard
3. **Bot Status**: Check Telegram for bot status messages
4. **Database**: Verify tables created and data accessible

## ☁️ CLOUD DEPLOYMENT

### Render (Recommended)
1. Push code to GitHub
2. Connect repo to Render
3. Set environment variables in Render dashboard
4. Deploy as Worker service

### Railway
1. Push code to GitHub  
2. Connect via Railway CLI or dashboard
3. Set environment variables
4. Deploy from Dockerfile

### Fly.io
```bash
# Install flyctl
flyctl auth login
flyctl launch
flyctl deploy
```

### Vercel (Frontend only)
For web interface deployment

## 📊 LIVE TRADING PARAMETERS

### Default Settings (Review These!)
- **Capital Usage**: 10% of wallet per trade
- **Default Leverage**: 20x (configurable per token)
- **Take Profit**: 2.25% (45% at 20x)
- **Stop Loss**: 1.5% (30% at 20x)
- **Max Consecutive Losses**: 2
- **Top Coins**: 50

### Risk Levels Available:
1. **No Risk**: 5% capital, 10x max leverage
2. **Medium Risk**: 10% capital, 20x max leverage (DEFAULT)
3. **High Risk**: 20% capital, 50x max leverage

## 🔧 TROUBLESHOOTING LIVE ISSUES

### Common Live Issues:
1. **API Connection Failed**
   - Check API keys are correct
   - Verify exchange account has funds
   - Check IP restrictions/whitelisting

2. **Database Connection Issues**
   - Verify DATABASE_URL is correct
   - Check firewall settings
   - Ensure database is running

3. **Telegram Not Working**
   - Verify bot token is valid
   - Check chat ID is correct
   - Bot must be added to chat/channel

4. **Trades Not Executing**
   - Check wallet balance
   - Verify API key permissions (Futures trading enabled)
   - Check for exchange maintenance

## 🚨 EMERGENCY PROCEDURES

### Immediate Stop:
1. **Stop Bot**: `Ctrl+C` in terminal
2. **Close Positions**: Manually on exchange
3. **Disable API Keys**: Temporarily disable in exchange settings

### Data Recovery:
1. **Database Backup**: Regular backups enabled
2. **Trade Logs**: All trades logged to database
3. **Error Tracking**: Monitor error logs

### Rollback Procedure:
1. Stop all services
2. Restore database from backup
3. Deploy previous stable version
4. Verify functionality

## 📈 MONITORING & MAINTENANCE

### Daily Checks:
- [ ] Bot status (Telegram notifications)
- [ ] Trade performance
- [ ] Error logs
- [ ] Database health
- [ ] Wallet balances

### Weekly Tasks:
- [ ] Review trading performance
- [ ] Backup verification
- [ ] Update dependencies
- [ ] Security audit

### Monthly Tasks:
- [ ] API key rotation
- [ ] Database optimization
- [ ] Performance review
- [ ] Feature updates

## ⚠️ FINAL WARNINGS

### BEFORE STARTING LIVE TRADING:
1. **START SMALL**: Begin with minimal funds
2. **MONITOR CLOSELY**: Watch first trades carefully
3. **HAVE STOP LOSSES**: Always use stop losses
4. **KEEP BACKUPS**: Regular database backups
5. **TEST ALERTS**: Ensure notification system works

### RISK ACKNOWLEDGEMENT:
- Cryptocurrency trading involves significant risk
- Past performance does not guarantee future results
- Only trade with funds you can afford to lose
- The bot automates trading but doesn't eliminate risk

## 🏁 READY FOR LIVE TRADING

When all checks are complete:

1. **Final Verification**: Run health check
2. **Start Bot**: `npm start`
3. **Monitor**: Watch Telegram for first trade signals
4. **Verify**: Check exchange for executed trades
5. **Celebrate**: Your AI trader is live! 🎉

**Remember**: Start with small amounts and gradually increase as you gain confidence in the system's performance.