const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  return crypto.createHash('sha256').update(process.env.SESSION_SECRET).digest();
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const tag = cipher.getAuthTag();
  return iv.toString('base64') + ':' + tag.toString('base64') + ':' + encrypted;
}

function decrypt(stored) {
  if (!stored) return null;
  try {
    const key = getKey();
    const [ivB64, tagB64, ciphertext] = stored.split(':');
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt };
