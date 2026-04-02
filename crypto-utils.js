const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
if (!process.env.ENCRYPTION_KEY) {
  console.warn('[CRYPTO] WARNING: ENCRYPTION_KEY not set — API keys stored with insecure default key. Set ENCRYPTION_KEY env var in production!');
}
const KEY = Buffer.from(process.env.ENCRYPTION_KEY || '0'.repeat(64), 'hex');

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return { encrypted, iv: iv.toString('hex'), authTag };
}

function decrypt(encrypted, ivHex, authTagHex) {
  const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let text = decipher.update(encrypted, 'hex', 'utf8');
  text += decipher.final('utf8');
  return text;
}

module.exports = { encrypt, decrypt };
