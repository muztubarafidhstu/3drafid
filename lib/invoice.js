'use strict';

// Professional invoices as PDF (sharp, selectable text) or PNG (for WhatsApp), drawn once and exported both ways.
// Fonts are bundled (Noto Sans + Noto Sans Bengali, SIL Open Font License) so Bangla names and the taka sign
// look the same on every computer and server.

const fs = require('fs');
const path = require('path');
const { formatBDT } = require('./util');

const FONT_DIR = path.join(__dirname, '..', 'fonts');
const W = 595; // A4 in points
const H = 842;
const M = 40;
const FONT = 'InvNoto, InvBn';

let skia = null;
function lib() {
  if (skia) return skia;
  skia = require('skia-canvas');
  skia.FontLibrary.use('InvNoto', [path.join(FONT_DIR, 'NotoSans_400Regular.ttf'), path.join(FONT_DIR, 'NotoSans_700Bold.ttf')]);
  skia.FontLibrary.use('InvBn', [path.join(FONT_DIR, 'NotoSansBengali_400Regular.ttf'), path.join(FONT_DIR, 'NotoSansBengali_700Bold.ttf')]);
  return skia;
}

// ---------- small helpers ----------
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function under100(n) { return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''); }
function under1000(n) { return n >= 100 ? ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + under100(n % 100) : '') : under100(n); }

/** 125000 -> "One Lakh Twenty Five Thousand" (Bangladeshi grouping). */
function numberToWords(n) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push(numberToWords(crore) + ' Crore');
  if (lakh) parts.push(under100(lakh) + ' Lakh');
  if (thousand) parts.push(under100(thousand) + ' Thousand');
  if (n) parts.push(under1000(n));
  return parts.join(' ');
}

function amountInWords(total) {
  const taka = Math.floor(total + 1e-9);
  const paisa = Math.round((total - taka) * 100);
  return `${numberToWords(taka)} Taka${paisa ? ' and ' + numberToWords(paisa) + ' Paisa' : ''} Only`;
}

function dateText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: process.env.SHOP_TZ || 'Asia/Dhaka' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function cleanPrefix(v) {
  const s = String(v == null ? 'INV-' : v).replace(/[^A-Za-z0-9\-_/]/g, '').slice(0, 12);
  return s;
}

function invoiceNumber(settings, order) {
  const prefix = settings.invoicePrefix === undefined ? 'INV-' : cleanPrefix(settings.invoicePrefix);
  return `${prefix}${order.no}`;
}

function hexOk(c) { return /^#[0-9a-f]{6}$/i.test(String(c || '')); }
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function mix(hex, other, t) {
  const a = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const b = [1, 3, 5].map((i) => parseInt(other.slice(i, i + 2), 16));
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

const STATUS_TEXT = { pending: 'Awaiting approval', approved: 'Approved', cancelled: 'Cancelled' };
const STATUS_TITLE = { pending: 'PROFORMA INVOICE', approved: 'INVOICE', cancelled: 'INVOICE' };
const PAY_LABEL = { cod: 'Cash on delivery', bkash: 'bKash', bank: 'Bank transfer' };
const stripProto = (u) => String(u || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');

/** Everything the drawing needs, from the store and one order. */
function buildModel(store, order, totals) {
  const s = store.data.settings;
  const accent = hexOk(s.accentColor) ? s.accentColor : '#6d28d9';
  const light = luminance(accent) > 0.55;
  const onAccent = light ? '#111827' : '#ffffff';
  const digits = (v) => String(v || '').replace(/\D/g, '').replace(/^880/, '0');
  const waShown = s.whatsapp && digits(s.whatsapp) !== digits(s.phone) ? (/^880\d{10}$/.test(String(s.whatsapp)) ? '+' + s.whatsapp : s.whatsapp) : '';
  const phones = [s.phone, waShown].filter(Boolean).join(' / ');
  const contact = [
    ['Address', s.address],
    ['Mobile / WhatsApp', phones],
    ['Facebook', stripProto(s.facebook)],
    ['Instagram', stripProto(s.instagram)],
    ['E-mail', s.email],
    ['Website', stripProto(s.siteUrl)],
    ['BIN / VAT', s.taxId],
  ].filter(([, v]) => v);
  const when = order.approvedAt || order.createdAt;
  const total = totals.total;
  const paid = totals.paid || 0;
  const due = totals.due === undefined ? Math.max(0, total - paid) : totals.due;
  const paidInFull = order.status !== 'cancelled' && total > 0 && due === 0;
  let statusText = STATUS_TEXT[order.status] || '';
  if (order.status === 'approved') statusText = paidInFull ? 'Paid in full' : paid > 0 ? 'Partly paid' : 'Payment due';
  const payLabel = PAY_LABEL[order.payMethod] || '';
  const payTo = [];
  if (due > 0 && order.status !== 'cancelled') {
    if (s.bkashNumber && (!order.payMethod || order.payMethod === 'bkash')) payTo.push(`bKash: ${s.bkashNumber}`);
    if (s.bankInfo && (!order.payMethod || order.payMethod === 'bank')) payTo.push(s.bankInfo);
  }
  return {
    accent, onAccent, light, tint: mix(accent, '#ffffff', 0.92), soft: mix(accent, '#ffffff', 0.78),
    accentDark: mix(accent, '#000000', light ? 0.12 : 0.42),
    company: s.businessName || 'My Shop',
    tagline: s.tagline || '',
    logoPath: s.logo ? path.join(store.imgDir, s.logo) : null,
    stampPath: s.stamp ? path.join(store.imgDir, s.stamp) : null,
    contact,
    status: order.status,
    title: STATUS_TITLE[order.status] || 'INVOICE',
    statusText,
    number: invoiceNumber(s, order),
    orderNo: order.no,
    date: dateText(when),
    orderDate: dateText(order.createdAt),
    customer: { name: order.customer.name || 'Customer', phone: order.customer.phone || '', address: order.customer.address || '' },
    lines: order.items.map((l) => ({ name: l.name, sku: l.sku, qty: l.qty, price: l.price === null || l.price === undefined ? null : l.price })),
    // only what is printed: the buying cost and profit never go anywhere near the invoice
    totals: { subtotal: totals.subtotal, discount: totals.discount, deliveryFee: totals.deliveryFee, total, unpriced: totals.unpriced, paid, due },
    paidInFull,
    payLabel,
    trxId: order.trxId || '',
    payTo,
    note: order.note || '',
    terms: s.invoiceTerms || '',
    footerLine: [s.businessName, s.phone || s.whatsapp, s.email].filter(Boolean).join('   |   '),
  };
}

// ---------- drawing ----------
const set = (ctx, size, weight = 'normal') => { ctx.font = `${weight} ${size}px ${FONT}`; };

function wrap(ctx, text, width) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width <= width) { line = test; continue; }
      if (line) out.push(line);
      line = word;
      // a single very long word: break it by characters
      while (ctx.measureText(line).width > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > width) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out;
}

function fit(ctx, text, width) {
  let t = String(text);
  if (ctx.measureText(t).width <= width) return t;
  while (t.length > 1 && ctx.measureText(t + '…').width > width) t = t.slice(0, -1);
  return t + '…';
}

const money = (v) => formatBDT(v);

const BAND_COL = [M, 312];
const BAND_W = 243;

/** Splits the work into pages first (needs text measuring), then draws each page. */
function layout(ctx, m, logo) {
  // header band: brand row + contact grid
  const logoBox = logo ? (() => { const k = Math.min(150 / logo.width, 44 / logo.height); return { w: logo.width * k, h: logo.height * k }; })() : { w: 44, h: 44 };
  const plateW = logoBox.w + 16;
  const nameX = M + plateW + 14;
  const nameW = W - M - 170 - nameX;
  set(ctx, 16, 'bold');
  const nameLines = wrap(ctx, m.company, nameW).slice(0, 2);
  set(ctx, 9);
  const tagLines = m.tagline ? wrap(ctx, m.tagline, nameW).slice(0, 2) : [];
  // contact items, two columns, label then value
  const items = m.contact.map(([label, value]) => {
    set(ctx, 8.5, 'bold');
    const lw = ctx.measureText(label + ': ').width;
    set(ctx, 9);
    const lines = wrap(ctx, value, BAND_W - lw).slice(0, 2);
    return { label, lw, lines, h: Math.max(1, lines.length) * 12 + 2 };
  });
  const half = Math.ceil(items.length / 2);
  const cols = [items.slice(0, half), items.slice(half)];
  const colH = Math.max(0, ...cols.map((c) => c.reduce((a, i) => a + i.h, 0)));
  const brandH = Math.max(62, 24 + nameLines.length * 19 + tagLines.length * 12);
  const bandH = 22 + brandH + (colH ? 12 + colH : 0) + 16;

  const colX = { no: M + 12, name: M + 36, qty: 392, unit: 470, amt: W - M - 8 };
  const nameColW = 392 - 36 - M - 30;
  const rows = m.lines.map((l, i) => {
    set(ctx, 10, 'bold');
    const rowName = wrap(ctx, l.name, nameColW);
    const h = Math.max(28, rowName.length * 13 + (l.sku ? 11 : 0) + 11);
    return { l, i, nameLines: rowName, h };
  });

  set(ctx, 9);
  const wordsLines = wrap(ctx, amountInWords(m.totals.total), 270);
  const noteLines = m.note ? wrap(ctx, m.note, 270) : [];
  const payLines = [];
  if (m.payLabel) payLines.push(`Method: ${m.payLabel}${m.trxId ? `  (${m.payLabel === 'Bank transfer' ? 'Ref' : 'TrxID'}: ${m.trxId})` : ''}`);
  for (const t of m.payTo) payLines.push(...wrap(ctx, t, 235));
  const termLines = m.terms ? wrap(ctx, m.terms, 235) : [];
  const leftH = 22 + wordsLines.length * 12 + (noteLines.length ? 26 + noteLines.length * 12 : 0);
  const totalRows = 2 + (m.totals.discount ? 1 : 0) + (m.totals.deliveryFee ? 1 : 0) + (m.totals.paid ? 1 : 0);
  const rightH = totalRows * 20 + 44 + (m.totals.unpriced ? 12 : 0);
  const infoH = payLines.length || termLines.length ? 32 + Math.max(payLines.length, termLines.length) * 12 : 0;
  const stampH = m.stampPath ? 92 : 0;
  const bottomH = Math.max(leftH, rightH) + (infoH ? infoH + 14 : 0) + Math.max(58, stampH + 26);
  const limit = H - 58;

  const cardsY = bandH + 16;
  const cardsH = 104;
  const tableHead = cardsY + cardsH + 14;
  const pages = [];
  let cur = { first: true, y: tableHead + 24, rows: [] };
  for (const r of rows) {
    if (cur.y + r.h > limit) { pages.push(cur); cur = { first: false, y: 96, rows: [] }; }
    cur.rows.push(r);
    cur.y += r.h;
  }
  if (cur.y + bottomH > limit) { pages.push(cur); cur = { first: false, y: 96, rows: [] }; }
  cur.bottom = true;
  pages.push(cur);
  return {
    pages, colX, wordsLines, noteLines, payLines, termLines, leftH, rightH, infoH, stampH,
    band: { h: bandH, plateW, logoBox, nameX, nameLines, tagLines, brandH, cols },
    cardsY, cardsH, tableHead,
  };
}

function drawBand(ctx, m, L, logo) {
  const b = L.band;
  const g = ctx.createLinearGradient(0, 0, W, b.h);
  g.addColorStop(0, m.accent);
  g.addColorStop(1, m.accentDark);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, b.h);
  // soft shapes
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, W, b.h); ctx.clip();
  ctx.fillStyle = m.light ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.07)';
  ctx.beginPath(); ctx.arc(W - 30, 8, 96, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(W - 120, b.h + 6, 58, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  const top = 22;
  // logo on a white plate so it shows on any colour
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.roundRect(M, top, b.plateW, 62, 12); ctx.fill();
  if (logo) {
    ctx.drawImage(logo, M + 8, top + (62 - b.logoBox.h) / 2, b.logoBox.w, b.logoBox.h);
  } else {
    ctx.fillStyle = m.accent; set(ctx, 26, 'bold'); ctx.textAlign = 'center';
    const ch = Array.from(m.company.trim())[0];
    ctx.fillText(ch ? ch.toUpperCase() : 'S', M + b.plateW / 2, top + 40);
    ctx.textAlign = 'left';
  }
  // name and tagline
  ctx.fillStyle = m.onAccent;
  set(ctx, 16, 'bold');
  b.nameLines.forEach((t, i) => ctx.fillText(t, b.nameX, top + 20 + i * 19));
  if (b.tagLines.length) {
    ctx.globalAlpha = 0.88; set(ctx, 9);
    b.tagLines.forEach((t, i) => ctx.fillText(t, b.nameX, top + 20 + b.nameLines.length * 19 - 2 + i * 12));
    ctx.globalAlpha = 1;
  }
  // title
  ctx.textAlign = 'right';
  set(ctx, m.title.length > 8 ? 19 : 28, 'bold');
  ctx.fillText(m.title, W - M, top + 26);
  ctx.globalAlpha = 0.9; set(ctx, 10);
  ctx.fillText(m.number, W - M, top + 44);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';

  // company details, like the top of a printed invoice
  const gy = top + b.brandH + 12;
  b.cols.forEach((items, ci) => {
    let y = gy;
    for (const it of items) {
      ctx.fillStyle = m.onAccent; set(ctx, 8.5, 'bold');
      ctx.fillText(it.label + ':', BAND_COL[ci], y + 9);
      ctx.globalAlpha = 0.95; set(ctx, 9);
      it.lines.forEach((t, k) => ctx.fillText(t, BAND_COL[ci] + it.lw, y + 9 + k * 12));
      ctx.globalAlpha = 1;
      y += it.h;
    }
  });
}

function drawPage(ctx, m, L, page, pageNo, pageCount, logo, stamp) {
  const { colX } = L;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  let head;
  if (page.first) {
    drawBand(ctx, m, L, logo);
    // --- bill to / invoice details ---
    const by = L.cardsY, bh = L.cardsH;
    ctx.fillStyle = m.tint;
    ctx.beginPath(); ctx.roundRect(M, by, 266, bh, 10); ctx.fill();
    ctx.beginPath(); ctx.roundRect(M + 282, by, W - 2 * M - 282, bh, 10); ctx.fill();
    ctx.fillStyle = m.accent; set(ctx, 8.5, 'bold'); ctx.letterSpacing = '1px';
    ctx.fillText('BILLED AND DELIVERED TO', M + 14, by + 20);
    ctx.fillText('INVOICE DETAILS', M + 296, by + 20);
    ctx.letterSpacing = '0px';
    ctx.fillStyle = '#111827'; set(ctx, 12, 'bold');
    ctx.fillText(fit(ctx, m.customer.name, 238), M + 14, by + 40);
    set(ctx, 9.5); ctx.fillStyle = '#374151';
    let cy = by + 56;
    if (m.customer.phone) { ctx.fillText(`Mobile: ${m.customer.phone}`, M + 14, cy); cy += 14; }
    if (m.customer.address) {
      for (const t of wrap(ctx, `Address: ${m.customer.address}`, 238).slice(0, 3)) { ctx.fillText(t, M + 14, cy); cy += 13; }
    }
    const meta = [['Invoice no.', m.number], ['Date', m.date], ['Order', `#${m.orderNo}, ${m.orderDate}`], ['Payment', m.payLabel || '—'], ['Status', m.statusText || '—']];
    meta.forEach(([k, v], i) => {
      const y = by + 40 + i * 14.5;
      ctx.textAlign = 'left'; ctx.fillStyle = '#6b7280'; set(ctx, 9);
      ctx.fillText(k, M + 296, y);
      ctx.textAlign = 'right'; ctx.fillStyle = k === 'Status' && m.paidInFull ? '#15803d' : '#111827'; set(ctx, 9.5, 'bold');
      ctx.fillText(fit(ctx, v, 150), W - M - 14, y);
    });
    ctx.textAlign = 'left';
    head = L.tableHead;
  } else {
    ctx.fillStyle = m.accent;
    ctx.fillRect(0, 0, W, 7);
    ctx.fillStyle = '#111827'; set(ctx, 12, 'bold');
    ctx.fillText(fit(ctx, m.company, 300), M, 48);
    ctx.textAlign = 'right'; ctx.fillStyle = '#6b7280'; set(ctx, 10);
    ctx.fillText(`${m.number} (continued)`, W - M, 48);
    ctx.textAlign = 'left';
    head = 74;
  }

  // --- table header ---
  ctx.fillStyle = m.accent;
  ctx.beginPath(); ctx.roundRect(M, head, W - 2 * M, 24, 6); ctx.fill();
  ctx.fillStyle = m.onAccent; set(ctx, 9, 'bold');
  ctx.textAlign = 'left'; ctx.fillText('SL', colX.no - 2, head + 16); ctx.fillText('Particulars', colX.name, head + 16);
  ctx.textAlign = 'right';
  ctx.fillText('Qty', colX.qty, head + 16); ctx.fillText('Unit price', colX.unit, head + 16); ctx.fillText('Total', colX.amt, head + 16);
  ctx.textAlign = 'left';

  // --- rows ---
  let y = head + 24;
  page.rows.forEach((r, n) => {
    if (n % 2 === 1) { ctx.fillStyle = '#f8fafc'; ctx.fillRect(M, y, W - 2 * M, r.h); }
    ctx.fillStyle = '#9ca3af'; set(ctx, 9); ctx.textAlign = 'left';
    ctx.fillText(String(r.i + 1), colX.no - 2, y + 19);
    ctx.fillStyle = '#111827'; set(ctx, 10, 'bold');
    r.nameLines.forEach((t, k) => ctx.fillText(t, colX.name, y + 19 + k * 13));
    if (r.l.sku) { ctx.fillStyle = '#6b7280'; set(ctx, 8.5); ctx.fillText(`SKU: ${r.l.sku}`, colX.name, y + 19 + r.nameLines.length * 13 - 1); }
    ctx.textAlign = 'right'; ctx.fillStyle = '#111827'; set(ctx, 10);
    ctx.fillText(String(r.l.qty), colX.qty, y + 19);
    if (r.l.price === null) {
      ctx.fillStyle = '#9ca3af'; ctx.fillText('On request', colX.unit, y + 19); ctx.fillText('—', colX.amt, y + 19);
    } else {
      ctx.fillText(money(r.l.price), colX.unit, y + 19);
      set(ctx, 10, 'bold'); ctx.fillText(money(r.l.price * r.l.qty), colX.amt, y + 19);
    }
    ctx.textAlign = 'left';
    ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(M, y + r.h); ctx.lineTo(W - M, y + r.h); ctx.stroke();
    y += r.h;
  });

  if (page.bottom) {
    y += 14;
    const t = m.totals;
    const x0 = W - M - 230;
    // left: in words, note
    let ly = y + 8;
    ctx.fillStyle = '#6b7280'; set(ctx, 8.5, 'bold'); ctx.letterSpacing = '1px';
    ctx.fillText('AMOUNT IN WORDS', M, ly); ctx.letterSpacing = '0px';
    ctx.fillStyle = '#111827'; set(ctx, 9);
    L.wordsLines.forEach((s, i) => ctx.fillText(s, M, ly + 15 + i * 12));
    ly += 15 + L.wordsLines.length * 12 + 12;
    if (L.noteLines.length) {
      ctx.fillStyle = '#6b7280'; set(ctx, 8.5, 'bold'); ctx.letterSpacing = '1px';
      ctx.fillText('ORDER NOTE', M, ly); ctx.letterSpacing = '0px';
      ctx.fillStyle = '#111827'; set(ctx, 9);
      L.noteLines.forEach((s, i) => ctx.fillText(s, M, ly + 14 + i * 12));
    }
    // right: subtotal, discount, delivery, total, paid, then due
    const rowsT = [['Subtotal', money(t.subtotal)]];
    if (t.discount) rowsT.push(['Discount', '− ' + money(t.discount)]);
    if (t.deliveryFee) rowsT.push(['Delivery', money(t.deliveryFee)]);
    rowsT.push(['Total', money(t.total), true]);
    if (t.paid) rowsT.push(['Paid', '− ' + money(t.paid)]);
    let ty = y + 8;
    rowsT.forEach(([k, v, strong]) => {
      if (strong) { ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(x0, ty - 8); ctx.lineTo(W - M, ty - 8); ctx.stroke(); }
      ctx.textAlign = 'left'; ctx.fillStyle = '#4b5563'; set(ctx, 10, strong ? 'bold' : 'normal');
      ctx.fillText(k, x0 + 8, ty + 4);
      ctx.textAlign = 'right'; ctx.fillStyle = '#111827'; set(ctx, 10, 'bold');
      ctx.fillText(v, W - M - 8, ty + 4);
      ty += 20;
    });
    const settled = m.paidInFull;
    ctx.fillStyle = settled ? '#15803d' : m.accent;
    ctx.beginPath(); ctx.roundRect(x0, ty - 4, 230, 34, 8); ctx.fill();
    ctx.fillStyle = settled ? '#ffffff' : m.onAccent; ctx.textAlign = 'left'; set(ctx, 10.5, 'bold');
    ctx.fillText(m.status === 'cancelled' ? 'Total (cancelled)' : settled ? 'Paid in full' : 'Due', x0 + 12, ty + 17);
    ctx.textAlign = 'right'; set(ctx, 14, 'bold');
    ctx.fillText(m.status === 'cancelled' ? money(t.total) : money(t.due), W - M - 12, ty + 18);
    ctx.textAlign = 'left';
    if (t.unpriced) {
      ctx.fillStyle = '#b45309'; set(ctx, 8.5);
      ctx.textAlign = 'right';
      ctx.fillText(`${t.unpriced} item${t.unpriced === 1 ? '' : 's'} priced on request, not included`, W - M, ty + 46);
      ctx.textAlign = 'left';
    }
    y += Math.max(L.leftH, L.rightH) + 14;

    // payment + terms
    if (L.infoH) {
      ctx.fillStyle = '#f9fafb';
      ctx.beginPath(); ctx.roundRect(M, y, W - 2 * M, L.infoH, 8); ctx.fill();
      ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.roundRect(M, y, W - 2 * M, L.infoH, 8); ctx.stroke();
      const cols = [['PAYMENT', L.payLines, M + 14], ['TERMS', L.termLines, M + 267]];
      for (const [label, lines, x] of cols) {
        if (!lines.length) continue;
        ctx.fillStyle = m.accent; set(ctx, 8.5, 'bold'); ctx.letterSpacing = '1px';
        ctx.fillText(label, x, y + 20); ctx.letterSpacing = '0px';
        ctx.fillStyle = '#374151'; set(ctx, 9);
        lines.forEach((s, i) => ctx.fillText(s, x, y + 36 + i * 12));
      }
      y += L.infoH + 14;
    }
    // stamp, signature line and thanks
    const base = Math.max(y + 30 + L.stampH, H - 104);
    ctx.fillStyle = '#111827'; set(ctx, 10.5, 'bold');
    ctx.fillText('Thank you for your business.', M, base);
    if (stamp) {
      const k = Math.min(110 / stamp.width, 88 / stamp.height);
      const sw = stamp.width * k, sh = stamp.height * k;
      ctx.drawImage(stamp, W - M - 75 - sw / 2, base - 8 - sh, sw, sh);
    }
    ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 0.7;
    ctx.beginPath(); ctx.moveTo(W - M - 150, base); ctx.lineTo(W - M, base); ctx.stroke();
    ctx.fillStyle = '#6b7280'; set(ctx, 8.5); ctx.textAlign = 'right';
    ctx.fillText('Authorised signature', W - M, base + 12);
    ctx.textAlign = 'left';
  }

  const mark = m.status === 'cancelled' ? ['CANCELLED', 'rgba(220,38,38,0.13)'] : m.paidInFull ? ['PAID', 'rgba(21,128,61,0.12)'] : null;
  if (mark) {
    ctx.save();
    ctx.translate(W / 2, H / 2 + 40); ctx.rotate(-Math.PI / 6);
    ctx.fillStyle = mark[1]; set(ctx, mark[0] === 'PAID' ? 120 : 84, 'bold'); ctx.textAlign = 'center';
    ctx.fillText(mark[0], 0, 0);
    ctx.restore();
    ctx.textAlign = 'left';
  }

  // footer
  ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 0.6;
  ctx.beginPath(); ctx.moveTo(M, H - 40); ctx.lineTo(W - M, H - 40); ctx.stroke();
  ctx.fillStyle = '#9ca3af'; set(ctx, 8);
  ctx.fillText(fit(ctx, m.footerLine, 400), M, H - 24);
  ctx.textAlign = 'right';
  ctx.fillText(`Page ${pageNo} of ${pageCount}`, W - M, H - 24);
  ctx.textAlign = 'left';
}

/** Draws the invoice and returns the file bytes. format: 'pdf' | 'png'. */
async function renderInvoice(store, order, totals, format = 'pdf') {
  const { Canvas, loadImage } = lib();
  const m = buildModel(store, order, totals);
  const load = async (p) => {
    if (!p || !fs.existsSync(p)) return null;
    try { return await loadImage(p); } catch { return null; }
  };
  const logo = await load(m.logoPath);
  const stamp = await load(m.stampPath);
  const probe = new Canvas(W, H).getContext('2d');
  const L = layout(probe, m, logo);
  const n = L.pages.length;
  if (format === 'png') {
    const canvas = new Canvas(W, H * n);
    const ctx = canvas.getContext('2d');
    L.pages.forEach((page, i) => {
      ctx.save();
      ctx.translate(0, H * i);
      ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
      drawPage(ctx, m, L, page, i + 1, n, logo, stamp);
      ctx.restore();
    });
    return canvas.toBuffer('png', { density: 3 });
  }
  const canvas = new Canvas(W, H);
  let ctx = canvas.getContext('2d');
  L.pages.forEach((page, i) => {
    if (i > 0) ctx = canvas.newPage(W, H);
    drawPage(ctx, m, L, page, i + 1, n, logo, stamp);
  });
  return canvas.toBuffer('pdf');
}

function invoiceFileName(settings, order, ext) {
  return `Invoice-${invoiceNumber(settings, order)}.${ext}`.replace(/[^A-Za-z0-9._-]/g, '_');
}

module.exports = { renderInvoice, invoiceNumber, invoiceFileName, numberToWords, amountInWords, cleanPrefix, buildModel };
