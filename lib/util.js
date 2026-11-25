'use strict';

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

function toAsciiDigits(s) {
  return String(s).replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
}

/** URL/file-safe id. Keeps letters, digits and combining marks of any script, so Bangla works. */
function slugify(s) {
  const t = String(s == null ? '' : s)
    .normalize('NFC')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return t || 'item';
}

/**
 * Parse a price typed by a human. Returns null for blank, NaN for invalid, otherwise a number.
 * Accepts "1,250", "৳1250", "Tk 1250", "1250/-", Bangla digits.
 */
function parsePrice(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : NaN;
  let s = toAsciiDigits(v).trim();
  if (s === '') return null;
  s = s.replace(/৳|tk\.?|bdt|taka|\/-/gi, '').trim().replace(/,/g, '');
  // Whitespace left between digits ("12 13") is ambiguous, so reject it instead of guessing 1213.
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100) / 100;
}

function formatBDT(value) {
  const n = Number.isFinite(Number(value)) ? Number(value) : 0;
  const hasFraction = Math.round(n * 100) % 100 !== 0;
  return '৳' + n.toLocaleString('en-IN', { minimumFractionDigits: hasFraction ? 2 : 0, maximumFractionDigits: 2 });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Digits only, with Bangladesh local format (01XXXXXXXXX) converted to international (8801XXXXXXXXX). */
function normalizeWhatsApp(num) {
  let d = toAsciiDigits(num || '').replace(/\D/g, '');
  if (/^01\d{9}$/.test(d)) d = '88' + d;
  return d;
}

function normalizeSiteUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const url = new URL(s);
    return url.origin;
  } catch {
    return '';
  }
}

/** A link typed by the owner: add https:// when missing, keep only http(s) links, otherwise blank. */
function cleanLink(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  try {
    const url = new URL(s);
    return /^https?:$/.test(url.protocol) ? url.href.slice(0, 500) : '';
  } catch {
    return '';
  }
}

function cleanText(v, max = 5000) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim().slice(0, max);
}

module.exports = { toAsciiDigits, slugify, parsePrice, formatBDT, esc, normalizeWhatsApp, normalizeSiteUrl, cleanText, cleanLink };
