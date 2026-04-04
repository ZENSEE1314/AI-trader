# Railway Auto-Deployment Guide

## 🚀 Automatic Deployment Setup

Your AI-trader is now configured for **automatic Railway deployment**. No clicking needed!

## How It Works Now:

1. **Push to GitHub** → Railway automatically detects changes
2. **Auto-build** → Railway builds Docker image
3. **Auto-deploy** → Deploys to production
4. **Auto-restart** → If health check fails

## ✅ What's Configured:

### 1. **Railway Configuration** (`railway.toml`)
- Auto-restart on failure
- Health check endpoint (`/health`)
- Production environment variables
- Docker-based deployment

### 2. **Docker Optimization**
- Alpine Linux for smaller image
- Non-root user for security
- Health check integration
- Production-only dependencies

### 3. **Startup Script** (`railway-start.js`)
- Starts both web server AND trading bot
- Validates environment variables
- Proper process management
- Graceful shutdown handling

## 📋 Railway Dashboard Setup

### Step 1: Connect GitHub (One-time)
1. Go to [Railway.app](https://railway.app)
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `ZENSEE1314/AI-trader` repository
4. Railway will auto-detect the `railway.toml`

### Step 2: Set Environment Variables
In Railway dashboard → **Variables** tab, add:

**REQUIRED:**
```
TELEGRAM_TOKEN=your_live_telegram_bot_token
TELEGRAM_CHAT_ID=your_live_telegram_chat_id
BITUNIX_API_KEY=your_live_bitunix_api_key
BITUNIX_API_SECRET=your_live_bitunix_api_secret
JWT_SECRET=strong_random_string_min_32_chars
```

**OPTIONAL (Railway provides these):**
```
DATABASE_URL=railway_auto_provided
PORT=3000
NODE_ENV=production
```

### Step 3: Add Database (Optional but Recommended)
1. In Railway dashboard → **New** → **Database**
2. Choose **PostgreSQL**
3. Railway will auto-set `DATABASE_URL`

## 🔄 Auto-Deployment Flow

```
GitHub Push → Railway Detects → Builds Docker → 
Deploys → Health Check → Live Trading
```

### What Happens on Push:
1. You push code to GitHub
2. Railway detects the push
3. Builds new Docker image
4. Deploys to production
5. Runs health check
6. If healthy, traffic switches to new version
7. Old version is stopped

## 🏗️ Project Structure for Railway

```
AI-trader/
├── railway.toml          # Railway configuration
├── Dockerfile           # Docker build instructions
├── railway-start.js     # Railway startup script
├── package.json        # Updated for Railway
├── server.js          # Web server
├── bot.js            # Trading bot
├── health.js         # Health endpoints
└── .env              # Local development only
```

## 🚨 Important Notes

### 1. **`.env` File is LOCAL ONLY**
- Railway uses **dashboard variables**
- Never commit `.env` to GitHub
- `.gitignore` already excludes `.env`

### 2. **GitHub Token Usage**
Your token (`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`) is:
- In `.env` for local development
- **NOT** needed in Railway (uses GitHub app)
- Can be added as `GITHUB_TOKEN` variable if needed for API calls

### 3. **Database on Railway**
- Railway provides PostgreSQL automatically
- `DATABASE_URL` is auto-set when you add database
- No manual configuration needed

## 🧪 Testing Auto-Deployment

### Test 1: Push a Change
```bash
git add .
git commit -m "Test Railway auto-deploy"
git push origin main
```

### Test 2: Check Railway Dashboard
1. Go to Railway project
2. Click **Deployments**
3. See new deployment building
4. Wait for ✅ status

### Test 3: Verify Live
1. Get your Railway URL
2. Visit: `https://your-project.up.railway.app/health`
3. Should show: `{"status":"healthy",...}`

## 🔧 Troubleshooting

### Issue: Deployment Failing
**Check:**
1. Railway dashboard → Deployments → Logs
2. Missing environment variables
3. Build errors in Docker

### Issue: Health Check Failing
**Check:**
1. `DATABASE_URL` is set
2. All required variables are present
3. Port 3000 is exposed

### Issue: No Auto-Deploy
**Check:**
1. GitHub repo is connected
2. `railway.toml` exists in root
3. Main branch is set for auto-deploy

## 📊 Monitoring

### Railway Dashboard Shows:
- ✅ Deployment status
- 📈 Resource usage
- 🔄 Recent deployments
- ⚠️ Any errors

### Health Endpoints:
- `GET /health` - Full system status
- `GET /health/ping` - Simple alive check
- `GET /health/version` - Version info

## 🎯 Ready for Auto-Deployment?

### To Start Auto-Deployment NOW:
1. **Push your code to GitHub**
   ```bash
   git add .
   git commit -m "Ready for Railway auto-deploy"
   git push origin main
   ```

2. **Railway will automatically:**
   - Detect the push
   - Build and deploy
   - Start your trading bot
   - Begin live trading

### No clicking needed! 🚀

## ⚠️ Final Warning Before Live

**BEFORE pushing to Railway:**
1. Edit `BITUNIX_API_KEY` and `BITUNIX_API_SECRET` in Railway variables
2. Use **LIVE** exchange keys (not testnet)
3. Start with small trading amounts
4. Monitor first trades closely

**Your AI-trader will begin LIVE TRADING immediately after deployment!**