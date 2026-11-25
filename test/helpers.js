'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const sharp = require('sharp');

function tmpDir(prefix = 'shop-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** A solid-colour test photo. Default is a large landscape JPEG like a phone camera would make. */
async function testImage({ width = 3000, height = 2000, color = { r: 200, g: 40, b: 40 }, format = 'jpeg' } = {}) {
  return sharp({ create: { width, height, channels: 3, background: color } })[format]().toBuffer();
}

module.exports = { tmpDir, freePort, testImage };
