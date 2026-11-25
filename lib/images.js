'use strict';

const sharp = require('sharp');
const crypto = require('crypto');

sharp.cache({ memory: 64, files: 0, items: 0 });

const SUPPORTED = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'tif', 'tiff', 'jfif']);

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name));
  return m ? m[1].toLowerCase() : '';
}

function checkSupported(filename) {
  const ext = extOf(filename);
  if (ext === 'heic' || ext === 'heif') {
    return 'HEIC/HEIF photos are not supported. Save or export them as JPG first.';
  }
  if (!SUPPORTED.has(ext)) return `Unsupported file type ".${ext || '?'}". Use JPG, PNG or WebP.`;
  return null;
}

/**
 * Turn an original photo (often 5 MB) into:
 *   full  - WebP, max 1600px on the long edge
 *   thumb - WebP, 400x400 square crop for grids
 *   share - JPEG 800px for Facebook/WhatsApp link previews (only when asked)
 * The original is never kept.
 */
async function processPhoto(buffer, { share = false } = {}) {
  const base = sharp(buffer, { failOn: 'none' }).rotate();
  const full = await base
    .clone()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  const thumb = await base.clone().resize({ width: 400, height: 400, fit: 'cover' }).webp({ quality: 75 }).toBuffer();
  const shareBuf = share
    ? await base
        .clone()
        .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 78, mozjpeg: true })
        .toBuffer()
    : null;
  return { full, thumb, share: shareBuf };
}

async function processLogo(buffer) {
  return sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize({ width: 480, height: 160, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();
}

/** A stamp or signature for invoices: keeps transparency, small. */
async function processStamp(buffer) {
  return sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 90, alphaQuality: 95 })
    .toBuffer();
}

function shortHash(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
}

module.exports = { processPhoto, processLogo, processStamp, shortHash, checkSupported, extOf };
