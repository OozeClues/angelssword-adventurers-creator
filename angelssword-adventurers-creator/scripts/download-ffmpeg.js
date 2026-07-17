#!/usr/bin/env node
/**
 * Download a platform-specific static ffmpeg from the ffmpeg-static GitHub release.
 *
 * Usage:
 *   node scripts/download-ffmpeg.js [--platform win32] [--arch x64] [--out bin/ffmpeg.exe]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { createGunzip } = require('zlib');
const { pipeline } = require('stream');

const RELEASE_TAG = process.env.FFMPEG_BINARY_RELEASE || 'b6.1.1';
const DOWNLOADS_BASE =
  process.env.FFMPEG_BINARIES_URL ||
  'https://github.com/eugeneware/ffmpeg-static/releases/download';

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const platform = argValue('--platform', process.env.npm_config_platform || process.platform);
const arch = argValue('--arch', process.env.npm_config_arch || process.arch);
const defaultName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const outPath = path.resolve(
  argValue('--out', path.join(__dirname, '..', 'bin', defaultName))
);

const url = `${DOWNLOADS_BASE}/${RELEASE_TAG}/ffmpeg-${platform}-${arch}.gz`;

function download(u, dest) {
  return new Promise((resolve, reject) => {
    https
      .get(u, { headers: { 'User-Agent': 'as-adventurer-build' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          download(res.headers.location, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        pipeline(res, createGunzip(), fs.createWriteStream(dest), (err) => {
          if (err) reject(err);
          else resolve();
        });
      })
      .on('error', reject);
  });
}

console.log(`  Downloading ffmpeg ${RELEASE_TAG} (${platform}-${arch})`);
console.log(`  → ${outPath}`);

download(url, outPath)
  .then(() => {
    try {
      fs.chmodSync(outPath, 0o755);
    } catch {
      /* windows */
    }
    const sizeMb = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(1);
    console.log(`  OK (${sizeMb} MB)`);
  })
  .catch((err) => {
    console.error('  Download failed:', err.message);
    process.exit(1);
  });
