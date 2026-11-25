'use strict';

const path = require('path');
const { Store } = require('./store');
const { build } = require('./build');

const root = path.resolve(__dirname, '..');
const store = new Store(process.env.DATA_DIR || path.join(root, 'data'));
const report = build(store, { distDir: process.env.DIST_DIR || path.join(root, 'dist'), assetsDir: path.join(root, 'assets') });
console.log(`Built ${report.published} products into ${report.distDir} (${report.files} files, ${report.imageMB} MB of photos, ${report.ms} ms)`);
for (const w of report.warnings) console.log('  ! ' + w);
