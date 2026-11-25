'use strict';

// Keeps the customer website in step with the admin. Any change schedules a rebuild a moment later;
// a burst of changes (for example 200 photo uploads) becomes a few rebuilds, never one per change.

const { build } = require('./build');

class Publisher {
  constructor({ store, distDir, assetsDir, delay = 1200, maxWait = 8000, log = () => {} }) {
    Object.assign(this, { store, distDir, assetsDir, delay, maxWait, log });
    this.timer = null;
    this.firstDirty = 0;
    this.running = false;
    this.again = false;
    this.last = null; // last successful result
    this.error = '';
    this.builtAt = null;
    this.version = 0;
    this._waiters = [];
  }

  /** Something changed: rebuild soon. */
  schedule() {
    const now = Date.now();
    if (!this.firstDirty) this.firstDirty = now;
    clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.delay, this.firstDirty + this.maxWait - now));
    this.timer = setTimeout(() => this.run(), wait);
    if (this.timer.unref) this.timer.unref();
  }

  /** Rebuild right now (used at start-up and by tests). Resolves when the site is up to date. */
  async run() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.running) { this.again = true; return this.whenIdle(); }
    this.running = true;
    this.firstDirty = 0;
    // let the response that triggered us go out first
    await new Promise((r) => setImmediate(r));
    try {
      const result = build(this.store, { distDir: this.distDir, assetsDir: this.assetsDir });
      this.last = result;
      this.error = '';
      this.builtAt = new Date().toISOString();
      this.version++;
      this.log(`Website updated: ${result.published} products, ${result.files} files, ${result.ms} ms`);
    } catch (e) {
      this.error = e && e.message ? e.message : String(e);
      this.log('Website update failed: ' + this.error);
    }
    this.running = false;
    if (this.again) { this.again = false; return this.run(); }
    const waiters = this._waiters.splice(0);
    for (const w of waiters) w();
    return this.status();
  }

  /** Resolves when nothing is scheduled or running. */
  whenIdle() {
    if (!this.running && !this.timer) return Promise.resolve(this.status());
    return new Promise((resolve) => this._waiters.push(() => resolve(this.status())));
  }

  status() {
    const state = this.running ? 'building' : this.timer ? 'waiting' : this.error ? 'error' : this.builtAt ? 'live' : 'starting';
    const l = this.last;
    return {
      state,
      builtAt: this.builtAt,
      version: this.version,
      error: this.error,
      published: l ? l.published : 0,
      files: l ? l.files : 0,
      warnings: l ? l.warnings : [],
    };
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = { Publisher };
