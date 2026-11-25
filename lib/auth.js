'use strict';

// Admin sign-in for a shop that is online: one password (scrypt hash on disk), a signed cookie, and a brake on guessing.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIN_LENGTH = 8;
const SESSION_MS = 14 * 24 * 3600 * 1000; // stay signed in for two weeks
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

class Auth {
  constructor(dir) {
    this.file = path.join(dir, 'auth.json');
    this.fails = new Map(); // ip -> { count, until }
    this._load();
  }

  _load() {
    try {
      this.rec = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.rec = null;
    }
    if (this.rec && !this.rec.secret) this.rec = null;
  }

  _write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.rec), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  hasPassword() {
    return !!(this.rec && this.rec.hash);
  }

  static checkStrength(password) {
    const p = String(password || '');
    if (p.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters.`;
    if (/^(.)\1+$/.test(p) || /^(12345678|password|11111111|qwertyui)/i.test(p)) return 'That password is too easy to guess.';
    return '';
  }

  /** Sets a new password and signs everyone out (the signing secret changes). */
  async setPassword(password) {
    const why = Auth.checkStrength(password);
    if (why) throw Object.assign(new Error(why), { status: 400 });
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt);
    this.rec = { salt: salt.toString('hex'), hash: hash.toString('hex'), secret: crypto.randomBytes(32).toString('hex'), changedAt: new Date().toISOString() };
    this._write();
  }

  async verify(password) {
    if (!this.hasPassword()) return false;
    const hash = await scrypt(password, Buffer.from(this.rec.salt, 'hex'));
    const want = Buffer.from(this.rec.hash, 'hex');
    return hash.length === want.length && crypto.timingSafeEqual(hash, want);
  }

  /** A cookie value: "<expiry>.<signature>". Nothing secret inside; the signature proves we issued it. */
  issue(now = Date.now()) {
    const exp = String(now + SESSION_MS);
    return `${exp}.${this._sign(exp)}`;
  }

  _sign(text) {
    return crypto.createHmac('sha256', this.rec.secret).update(text).digest('hex');
  }

  valid(token, now = Date.now()) {
    if (!this.hasPassword() || typeof token !== 'string') return false;
    const [exp, sig] = token.split('.');
    if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < now) return false;
    const want = Buffer.from(this._sign(exp), 'hex');
    let got;
    try { got = Buffer.from(sig, 'hex'); } catch { return false; }
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  /** Seconds the caller must wait before trying again, 0 when allowed. */
  waitSeconds(ip, now = Date.now()) {
    const f = this.fails.get(ip);
    return f && f.until > now ? Math.ceil((f.until - now) / 1000) : 0;
  }

  failed(ip, now = Date.now()) {
    const f = this.fails.get(ip) || { count: 0, until: 0 };
    f.count++;
    // 5 free tries, then 10 s, 20 s, 40 s ... up to 15 minutes
    if (f.count > 5) f.until = now + Math.min(15 * 60, 10 * 2 ** (f.count - 6)) * 1000;
    this.fails.set(ip, f);
    if (this.fails.size > 5000) this.fails.clear();
  }

  succeeded(ip) {
    this.fails.delete(ip);
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

module.exports = { Auth, parseCookies, MIN_LENGTH, SESSION_MS };
