#!/usr/bin/env node
/**
 * Ensure a usable, up-to-date ffmpeg binary for transparent WebM export.
 *
 * Thin CLI over lib/ensure-ffmpeg.cjs.
 *
 * Usage:
 *   node scripts/ensure-ffmpeg.js
 *   node scripts/ensure-ffmpeg.js --copy   # refresh app bin/ when possible
 *   node scripts/ensure-ffmpeg.js --json   # print result as JSON
 *   node scripts/ensure-ffmpeg.js --quiet
 */

'use strict';

const path = require('path');
const { ensureFfmpeg } = require('../lib/ensure-ffmpeg.cjs');

const ROOT = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const wantJson = args.has('--json');
const forceCopy = args.has('--copy');
const quiet = args.has('--quiet');

ensureFfmpeg({
  appDir: ROOT,
  quiet: quiet || wantJson,
  forceCopy,
})
  .then((result) => {
    if (wantJson) {
      console.log(JSON.stringify(result));
      return;
    }
    if (result.path) {
      if (!quiet) {
        const ver = result.version ? ` — ${result.version}` : '';
        const tag = result.releaseTag ? ` [${result.releaseTag}]` : '';
        console.log(`  ffmpeg ready (${result.source}): ${result.path}${tag}${ver}`);
      }
    } else {
      console.error('  [ERROR] Could not install ffmpeg. Transparent WebM export will be unavailable.');
      console.error('  Install ffmpeg manually, check your network, or re-run: npm run ensure-ffmpeg');
      process.exitCode = 1;
    }
  })
  .catch((err) => {
    console.error('  [ERROR] ensure-ffmpeg failed:', err.message);
    process.exitCode = 1;
  });
