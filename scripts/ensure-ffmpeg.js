#!/usr/bin/env node
/**
 * Ensure a usable ffmpeg binary is available for transparent WebM export.
 *
 * Resolution order (first hit wins):
 *  1. FFMPEG_PATH env
 *  2. ./bin/ffmpeg(.exe) next to the project / app
 *  3. ffmpeg-static npm package (downloads on npm install)
 *  4. Re-run ffmpeg-static install.js if the package is present but binary missing
 *  5. Direct download from the ffmpeg-static GitHub release for this platform
 *
 * Optionally copies the resolved binary into ./bin/ so pkg / EXE builds and
 * path-based discovery stay consistent.
 *
 * Usage:
 *   node scripts/ensure-ffmpeg.js
 *   node scripts/ensure-ffmpeg.js --copy   # always refresh ./bin/
 *   node scripts/ensure-ffmpeg.js --json   # print { path, source } as JSON
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { createGunzip } = require('zlib');
const { pipeline } = require('stream');
const { promisify } = require('util');
const { execFileSync } = require('child_process');

const pipelineAsync = promisify(pipeline);

const ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'bin');
const BIN_NAME = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const BIN_PATH = path.join(BIN_DIR, BIN_NAME);

// Must match node_modules/ffmpeg-static/package.json → ffmpeg-static.binary-release-tag
const RELEASE_TAG = process.env.FFMPEG_BINARY_RELEASE || 'b6.1.1';
const DOWNLOADS_BASE =
  process.env.FFMPEG_BINARIES_URL ||
  'https://github.com/eugeneware/ffmpeg-static/releases/download';

const args = new Set(process.argv.slice(2));
const wantJson = args.has('--json');
const forceCopy = args.has('--copy');
const quiet = args.has('--quiet');

function log(msg) {
  if (!quiet && !wantJson) console.log(`  ${msg}`);
}

function existsExecutable(p) {
  if (!p || !fs.existsSync(p)) return false;
  try {
    fs.accessSync(p, fs.constants.X_OK);
  } catch {
    // On Windows X_OK is unreliable; file presence is enough.
    if (process.platform !== 'win32') return false;
  }
  return true;
}

function probeWorks(p) {
  if (!existsExecutable(p) && !(process.platform === 'win32' && fs.existsSync(p))) {
    return false;
  }
  try {
    execFileSync(p, ['-version'], { stdio: 'pipe', timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

function tryFfmpegStatic() {
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* not installed */
  }
  return null;
}

function reinstallFfmpegStatic() {
  const installJs = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'install.js');
  if (!fs.existsSync(installJs)) return null;
  log('Downloading ffmpeg via ffmpeg-static…');
  try {
    execFileSync(process.execPath, [installJs], {
      cwd: path.join(ROOT, 'node_modules', 'ffmpeg-static'),
      stdio: quiet ? 'pipe' : 'inherit',
      env: process.env,
    });
  } catch (err) {
    log(`ffmpeg-static install failed: ${err.message}`);
    return null;
  }
  return tryFfmpegStatic();
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith('https') ? https : http;
    const req = getter.get(url, { headers: { 'User-Agent': 'as-adventurer' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(res.headers.location, destPath).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const out = fs.createWriteStream(destPath);
      const isGz = url.endsWith('.gz') || (res.headers['content-type'] || '').includes('gzip');
      const src = isGz ? res.pipe(createGunzip()) : res;
      pipeline(src, out, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error('Download timed out'));
    });
  });
}

async function downloadReleaseBinary(destPath) {
  const platform = process.env.npm_config_platform || process.platform;
  const arch = process.env.npm_config_arch || process.arch;
  const url = `${DOWNLOADS_BASE}/${RELEASE_TAG}/ffmpeg-${platform}-${arch}.gz`;
  log(`Downloading ffmpeg ${RELEASE_TAG} (${platform}-${arch})…`);
  const tmp = destPath + '.download';
  try {
    await download(url, tmp);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.renameSync(tmp, destPath);
    try {
      fs.chmodSync(destPath, 0o755);
    } catch {
      /* windows */
    }
    return destPath;
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function copyToBin(src) {
  if (!src || !fs.existsSync(src)) return null;
  if (path.resolve(src) === path.resolve(BIN_PATH)) return BIN_PATH;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.copyFileSync(src, BIN_PATH);
  try {
    fs.chmodSync(BIN_PATH, 0o755);
  } catch {
    /* windows */
  }
  // GPL license text from ffmpeg-static when available
  const licSrc = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.LICENSE');
  if (fs.existsSync(licSrc)) {
    fs.copyFileSync(licSrc, path.join(BIN_DIR, 'ffmpeg.LICENSE'));
  }
  return BIN_PATH;
}

async function ensure() {
  // 1. Explicit env
  if (process.env.FFMPEG_PATH && probeWorks(process.env.FFMPEG_PATH)) {
    const p = process.env.FFMPEG_PATH;
    if (forceCopy) copyToBin(p);
    return { path: forceCopy ? BIN_PATH : p, source: 'env' };
  }

  // 2. Project bin/
  if (probeWorks(BIN_PATH)) {
    return { path: BIN_PATH, source: 'bin' };
  }

  // 3. ffmpeg-static package
  let staticPath = tryFfmpegStatic();
  if (staticPath && probeWorks(staticPath)) {
    const p = forceCopy || !probeWorks(BIN_PATH) ? copyToBin(staticPath) || staticPath : staticPath;
    return { path: p, source: 'ffmpeg-static' };
  }

  // 4. Re-run package install script
  staticPath = reinstallFfmpegStatic();
  if (staticPath && probeWorks(staticPath)) {
    const p = copyToBin(staticPath) || staticPath;
    return { path: p, source: 'ffmpeg-static-install' };
  }

  // 5. Direct GitHub release download into bin/
  try {
    await downloadReleaseBinary(BIN_PATH);
    if (probeWorks(BIN_PATH)) {
      return { path: BIN_PATH, source: 'download' };
    }
  } catch (err) {
    log(`Direct download failed: ${err.message}`);
  }

  // 6. System PATH (last resort — may not support alpha the same way, but try)
  if (probeWorks('ffmpeg')) {
    return { path: 'ffmpeg', source: 'path' };
  }

  return { path: null, source: 'missing' };
}

ensure()
  .then((result) => {
    if (wantJson) {
      console.log(JSON.stringify(result));
    } else if (result.path) {
      log(`ffmpeg ready (${result.source}): ${result.path}`);
    } else {
      console.error('  [ERROR] Could not install ffmpeg. Transparent WebM export will be unavailable.');
      console.error('  Install ffmpeg manually or re-run: npm install');
      process.exitCode = 1;
    }
  })
  .catch((err) => {
    console.error('  [ERROR] ensure-ffmpeg failed:', err.message);
    process.exitCode = 1;
  });
