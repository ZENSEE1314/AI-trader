// ============================================================
// Email Service — Nodemailer wrapper for MCT transactional email
//
// Required env vars:
//   SMTP_HOST  — e.g. smtp.gmail.com | smtp.sendgrid.net
//   SMTP_PORT  — 587 (STARTTLS) or 465 (SSL)
//   SMTP_USER  — SMTP username / SendGrid use "apikey"
//   SMTP_PASS  — SMTP password / SendGrid API key
//   SMTP_SECURE — "true" for port 465, omit for 587
//   EMAIL_FROM — e.g. "MCT <noreply@millionairecryptotraders.com>"
//
// Falls back gracefully when SMTP_HOST is not configured.
// ============================================================

const nodemailer = require('nodemailer');

let _transporter = null;

const APP_URL = () => process.env.APP_URL || 'https://millionairecryptotraders.up.railway.app';
const FROM    = () => process.env.EMAIL_FROM || 'MCT <noreply@millionairecryptotraders.com>';

// ── Shared HTML shell ───────────────────────────────────────

function emailShell(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
  body{margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e2e8f0;}
  .wrap{max-width:560px;margin:32px auto;background:#1e293b;border-radius:16px;overflow:hidden;border:1px solid #334155;}
  .header{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);padding:36px 32px 28px;text-align:center;}
  .logo{font-size:24px;font-weight:800;color:#f59e0b;letter-spacing:1px;}
  .logo span{color:#fff;}
  .tagline{font-size:12px;color:#94a3b8;margin-top:6px;text-transform:uppercase;letter-spacing:2px;}
  .body{padding:32px;}
  .greeting{font-size:18px;font-weight:600;color:#f1f5f9;margin-bottom:16px;}
  p{margin:0 0 16px;color:#cbd5e1;line-height:1.6;font-size:14px;}
  .btn{display:inline-block;margin:16px 0;padding:14px 32px;background:linear-gradient(135deg,#f59e0b,#d97706);color:#0f172a;font-weight:700;font-size:15px;text-decoration:none;border-radius:10px;}
  .divider{border:none;border-top:1px solid #334155;margin:24px 0;}
  .note{font-size:12px;color:#64748b;line-height:1.5;}
  .footer{background:#0f172a;padding:20px 32px;text-align:center;font-size:11px;color:#475569;}
  .footer a{color:#f59e0b;text-decoration:none;}
  .stat-row{display:flex;gap:12px;margin:20px 0;}
  .stat{flex:1;background:#0f172a;border-radius:10px;padding:14px;text-align:center;border:1px solid #1e3a5f;}
  .stat-val{font-size:20px;font-weight:700;color:#f59e0b;}
  .stat-lbl{font-size:11px;color:#64748b;margin-top:4px;}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="logo">M<span>CT</span></div>
    <div class="tagline">Millionaire Crypto Traders</div>
  </div>
  <div class="body">
    ${bodyHtml}
  </div>
  <div class="footer">
    &copy; ${new Date().getFullYear()} Millionaire Crypto Traders &bull;
    <a href="${APP_URL()}">Dashboard</a> &bull;
    <a href="${APP_URL()}">Support</a><br/>
    <span style="color:#374151;">You're receiving this because you have an MCT account.</span>
  </div>
</div>
</body>
</html>`;
}

// ── Templates ───────────────────────────────────────────────

function buildWelcomeEmail(email, username) {
  const name = username || email.split('@')[0];
  const html = emailShell('Welcome to MCT!', `
    <div class="greeting">Welcome aboard, ${name}! 🚀</div>
    <p>Your AI trading bot is ready and will start scanning the markets for you automatically.</p>

    <div class="stat-row">
      <div class="stat"><div class="stat-val">24/7</div><div class="stat-lbl">AI Scanning</div></div>
      <div class="stat"><div class="stat-val">60%</div><div class="stat-lbl">Your Profit Share</div></div>
      <div class="stat"><div class="stat-val">7 Days</div><div class="stat-lbl">Free Trial</div></div>
    </div>

    <p><strong style="color:#f1f5f9;">What happens next:</strong></p>
    <p>1. Connect your Binance or Bitunix API keys in the dashboard<br/>
    2. The AI bot will begin trading on your behalf<br/>
    3. Track your profits in real-time from the dashboard</p>

    <a href="${APP_URL()}" class="btn">Open Your Dashboard</a>

    <hr class="divider"/>
    <p class="note">⚠️ Crypto trading involves risk. Only trade with funds you can afford to lose. The bot uses Smart Money Concepts with automated stop-loss protection.</p>
  `);

  return {
    to: email,
    subject: 'Welcome to MCT — Your AI Trading Bot is Ready! 🚀',
    html,
    text: `Welcome to MCT, ${name}!\n\nYour AI trading bot is ready. Connect your API keys at ${APP_URL()} to get started.\n\n7-day free trial, 60% profit share. Trade safely!`,
  };
}

function buildPasswordResetEmail(email, resetLink) {
  const html = emailShell('Password Reset', `
    <div class="greeting">Reset your password</div>
    <p>We received a request to reset the password for your MCT account (<strong style="color:#f1f5f9;">${email}</strong>).</p>
    <p>Click the button below to choose a new password. This link expires in <strong style="color:#f59e0b;">1 hour</strong>.</p>

    <a href="${resetLink}" class="btn">Reset My Password</a>

    <hr class="divider"/>
    <p class="note">If you didn't request this, ignore this email — your account is safe.<br/>Never share this link with anyone.</p>
    <p class="note" style="word-break:break-all;">Direct link: <a href="${resetLink}" style="color:#f59e0b;">${resetLink}</a></p>
  `);

  return {
    to: email,
    subject: 'MCT — Password Reset Request',
    html,
    text: `Password Reset\n\nClick this link to reset your MCT password (expires in 1 hour):\n${resetLink}\n\nIf you didn't request this, ignore this email.`,
  };
}

function buildBroadcastEmail(subject, bodyHtml, bodyText) {
  // bodyHtml is admin-provided raw HTML — wrap it in the shell for consistency
  const wrappedHtml = emailShell(subject, `
    <div class="greeting" style="margin-bottom:20px;">${subject}</div>
    ${bodyHtml}
    <hr class="divider"/>
    <p class="note">This message was sent to all MCT members by the platform admin.</p>
  `);
  return { subject, html: wrappedHtml, text: bodyText };
}

// ── Core send function ──────────────────────────────────────

function getTransporter() {
  if (_transporter) return _transporter;

  const host = process.env.SMTP_HOST;
  if (!host) return null;

  _transporter = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return _transporter;
}

async function sendMail({ to, subject, html, text }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[Email] No SMTP configured — skipping "${subject}" to ${to}`);
    return { ok: false, reason: 'no_smtp' };
  }
  try {
    await transporter.sendMail({ from: FROM(), to, subject, html, text });
    console.log(`[Email] Sent "${subject}" → ${to}`);
    return { ok: true };
  } catch (err) {
    console.error(`[Email] Failed to send to ${to}:`, err.message);
    return { ok: false, reason: err.message };
  }
}

// ── Public helpers ──────────────────────────────────────────

async function sendWelcome(email, username) {
  return sendMail(buildWelcomeEmail(email, username));
}

async function sendPasswordReset(email, resetLink) {
  return sendMail(buildPasswordResetEmail(email, resetLink));
}

/**
 * Broadcast a custom email to a list of addresses.
 * Sends in batches of 10 with 1-second delay between batches.
 */
async function broadcastToAll(subject, bodyHtml, bodyText, userEmails) {
  const template = buildBroadcastEmail(subject, bodyHtml, bodyText);
  const BATCH_SIZE = 10;
  const results = { sent: 0, failed: 0, errors: [] };

  for (let i = 0; i < userEmails.length; i += BATCH_SIZE) {
    const batch = userEmails.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (email) => {
      const result = await sendMail({ to: email, ...template });
      if (result.ok) {
        results.sent++;
      } else {
        results.failed++;
        results.errors.push({ email, reason: result.reason });
      }
    }));
    // Throttle between batches to respect SMTP rate limits
    if (i + BATCH_SIZE < userEmails.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  console.log(`[Email] Broadcast complete — sent: ${results.sent}, failed: ${results.failed}`);
  return results;
}

function isConfigured() {
  return !!process.env.SMTP_HOST;
}

module.exports = { sendWelcome, sendPasswordReset, broadcastToAll, sendMail, isConfigured };
