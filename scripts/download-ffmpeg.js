#!/usr/bin/env node
/**
 * Download a platform-specific static ffmpeg (build-time / cross-compile helper).
 *
 * Usage:
 *   node scripts/download-ffmpeg.js [--platform win32] [--arch x64] [--out bin/ffmpeg.exe]
 *   node scripts/download-ffmpeg.js [--tag b6.1.1]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  downloadReleaseBinary,
  resolveDesiredReleaseTag,
  downloadTarget,
  DEFAULT_RELEASE_TAG,
} = require('../lib/ensure-ffmpeg.cjs');

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const platform = argValue('--platform', process.env.npm_config_platform || process.platform);
const arch = argValue('--arch', process.env.npm_config_arch || process.arch);
const tagArg = argValue('--tag', process.env.FFMPEG_BINARY_RELEASE || null);
const { platform: p, arch: a } = downloadTarget(platform, arch);
const defaultName = p === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const outPath = path.resolve(argValue('--out', path.join(__dirname, '..', 'bin', defaultName)));

const log = (msg) => console.log(`  ${msg}`);

(async () => {
  const releaseTag = tagArg || (await resolveDesiredReleaseTag()) || DEFAULT_RELEASE_TAG;
  console.log(`  Downloading ffmpeg ${releaseTag} (${p}-${a})`);
  console.log(`  → ${outPath}`);
  await downloadReleaseBinary(outPath, releaseTag, p, a, log);
  try {
    fs.chmodSync(outPath, 0o755);
  } catch {
    /* windows */
  }
  const sizeMb = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(1);
  console.log(`  OK (${sizeMb} MB)`);
})().catch((err) => {
  console.error('  Download failed:', err.message);
  process.exit(1);
});
