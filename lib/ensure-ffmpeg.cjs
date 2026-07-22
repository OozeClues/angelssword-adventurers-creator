/**
 * Ensure a current ffmpeg binary for transparent WebM export.
 *
 * Resolution order:
 *  1. FFMPEG_PATH env (never auto-replaced)
 *  2. Managed install next to the app: {appDir}/bin/ffmpeg(.exe)
 *  3. Managed install in user cache (~/.cache/as-adventurer/bin, etc.)
 *  4. ffmpeg-static npm package (dev / non-pkg only)
 *  5. System PATH (used as-is if version is new enough; never overwritten)
 *  6. Download latest/LTS static build into a writable managed location
 *
 * Managed binaries are upgraded in place when stale: download → verify →
 * atomic swap → delete previous binary.
 *
 * Source: eugeneware/ffmpeg-static GitHub releases (same as the npm package).
 * Default pin: b6.1.1 (FFmpeg 6.1.1 LTS-style static). Override with
 * FFMPEG_BINARY_RELEASE, or leave unset to resolve "latest" via GitHub API.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { createGunzip } = require('zlib');
const { pipeline } = require('stream');
const { execFileSync } = require('child_process');

/** Fallback when GitHub is unreachable and env is unset. */
const DEFAULT_RELEASE_TAG = 'b6.1.1';

const DOWNLOADS_BASE =
  process.env.FFMPEG_BINARIES_URL ||
  'https://github.com/eugeneware/ffmpeg-static/releases/download';

const GITHUB_LATEST_API =
  'https://api.github.com/repos/eugeneware/ffmpeg-static/releases/latest';

const LICENSE_STUB = `This is a static build of FFmpeg from the eugeneware/ffmpeg-static project.
FFmpeg is licensed under the GNU General Public License version 3 (or later)
and/or the GNU Lesser General Public License, depending on configure options.
See https://ffmpeg.org/legal.html and https://github.com/eugeneware/ffmpeg-static
`;

/** @type {string|null} */
let _resolvedReleaseTag = null;
/** @type {Promise<string>|null} */
let _resolveReleasePromise = null;

function binName() {
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

/**
 * Map host OS/arch to ffmpeg-static asset ids.
 * Windows ARM64 has no native asset — use x64 (WoA emulation).
 */
function downloadTarget(platform, arch) {
  let p = platform || process.env.npm_config_platform || process.platform;
  let a = arch || process.env.npm_config_arch || process.arch;
  if (p === 'win32' && a === 'arm64') {
    a = 'x64';
  }
  return { platform: p, arch: a };
}

function userCacheBinDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'as-adventurer', 'bin');
  }
  const xdg = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(xdg, 'as-adventurer', 'bin');
}

function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe-' + process.pid);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function preferredManagedBinDir(appDir) {
  const appBin = path.join(appDir, 'bin');
  if (isWritableDir(appBin)) return appBin;
  const cache = userCacheBinDir();
  if (isWritableDir(cache)) return cache;
  return null;
}

function managedBinPaths(appDir) {
  return [
    path.join(appDir, 'bin', binName()),
    path.join(userCacheBinDir(), binName()),
  ];
}

function versionSidecar(binPath) {
  return binPath + '.version';
}

function readInstalledTag(binPath) {
  try {
    const t = fs.readFileSync(versionSidecar(binPath), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

function writeInstalledTag(binPath, tag) {
  try {
    fs.writeFileSync(versionSidecar(binPath), String(tag).trim() + '\n', 'utf8');
  } catch {
    /* non-fatal */
  }
}

/** Parse "ffmpeg version N.N.N..." or release tag "b6.1.1" → [6,1,1] */
function parseVersionParts(str) {
  if (!str) return null;
  const s = String(str).trim();
  const fromFfmpeg = s.match(/ffmpeg\s+version\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (fromFfmpeg) {
    return [
      parseInt(fromFfmpeg[1], 10),
      parseInt(fromFfmpeg[2], 10),
      parseInt(fromFfmpeg[3] || '0', 10),
    ];
  }
  const fromTag = s.match(/^b?(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (fromTag) {
    return [
      parseInt(fromTag[1], 10),
      parseInt(fromTag[2], 10),
      parseInt(fromTag[3] || '0', 10),
    ];
  }
  return null;
}

/** @returns {number} negative if a<b, 0 if equal, positive if a>b; null if incomparable */
function compareVersions(a, b) {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function probeVersionLine(binPath) {
  if (!binPath) return null;
  try {
    if (binPath !== 'ffmpeg' && binPath !== 'ffmpeg.exe' && !fs.existsSync(binPath)) {
      return null;
    }
    const out = execFileSync(binPath, ['-version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
    });
    return String(out).split('\n')[0].trim() || null;
  } catch {
    return null;
  }
}

function probeWorks(binPath) {
  return !!probeVersionLine(binPath);
}

function makeLogger(quiet) {
  return (msg) => {
    if (!quiet) console.log(`  ${msg}`);
  };
}

function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith('https') ? https : http;
    const req = getter.get(
      url,
      {
        headers: {
          'User-Agent': 'as-adventurer',
          Accept: 'application/octet-stream, application/json, */*',
          ...(options.headers || {}),
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          httpGet(res.headers.location, options).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        resolve(res);
      }
    );
    req.on('error', reject);
    req.setTimeout(options.timeoutMs || 120000, () => {
      req.destroy(new Error('Request timed out'));
    });
  });
}

function readResponseText(res, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    res.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        res.destroy();
        reject(new Error('Response too large'));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

/**
 * Resolve the release tag to install.
 * - FFMPEG_BINARY_RELEASE env wins (pin / offline builds)
 * - else GitHub "latest" (once per process)
 * - else DEFAULT_RELEASE_TAG
 */
async function resolveDesiredReleaseTag(opts = {}) {
  if (process.env.FFMPEG_BINARY_RELEASE) {
    return process.env.FFMPEG_BINARY_RELEASE;
  }
  if (opts.releaseTag) return opts.releaseTag;
  if (_resolvedReleaseTag) return _resolvedReleaseTag;
  if (_resolveReleasePromise) return _resolveReleasePromise;

  _resolveReleasePromise = (async () => {
    try {
      const res = await httpGet(GITHUB_LATEST_API, {
        timeoutMs: 15000,
        headers: { Accept: 'application/vnd.github+json' },
      });
      const text = await readResponseText(res);
      const json = JSON.parse(text);
      const tag = json && json.tag_name;
      if (tag && /^b?\d+\.\d+/.test(tag)) {
        _resolvedReleaseTag = tag;
        return tag;
      }
    } catch {
      /* offline / rate limit */
    }
    _resolvedReleaseTag = DEFAULT_RELEASE_TAG;
    return DEFAULT_RELEASE_TAG;
  })();

  return _resolveReleasePromise;
}

async function downloadToFile(url, destPath) {
  const res = await httpGet(url, { timeoutMs: 180000 });
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const out = fs.createWriteStream(destPath);
  const isGz =
    url.endsWith('.gz') || (res.headers['content-type'] || '').includes('gzip');
  const src = isGz ? res.pipe(createGunzip()) : res;
  await new Promise((resolve, reject) => {
    pipeline(src, out, (err) => (err ? reject(err) : resolve()));
  });
}

async function downloadReleaseBinary(destPath, releaseTag, platform, arch, log) {
  const { platform: p, arch: a } = downloadTarget(platform, arch);
  const url = `${DOWNLOADS_BASE}/${releaseTag}/ffmpeg-${p}-${a}.gz`;
  log(`Downloading ffmpeg ${releaseTag} (${p}-${a})…`);
  const tmp = destPath + '.download';
  try {
    await downloadToFile(url, tmp);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    if (fs.existsSync(destPath)) {
      try {
        fs.unlinkSync(destPath);
      } catch {
        /* windows lock — swap path handles this */
      }
    }
    fs.renameSync(tmp, destPath);
    try {
      fs.chmodSync(destPath, 0o755);
    } catch {
      /* win */
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

function writeLicense(binDir) {
  const dest = path.join(binDir, 'ffmpeg.LICENSE');
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.LICENSE'),
    path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'LICENSE'),
  ];
  for (const src of candidates) {
    if (fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, dest);
        return;
      } catch {
        /* try next */
      }
    }
  }
  try {
    fs.writeFileSync(dest, LICENSE_STUB, 'utf8');
  } catch {
    /* ignore */
  }
}

/**
 * Download into destPath with atomic swap if a previous binary exists.
 * Stale binary is renamed then deleted after the new one is verified.
 */
async function installOrSwap(destPath, releaseTag, log) {
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });
  const staging = destPath + '.new';
  const stale = destPath + '.old';

  // Clean leftovers from a previous interrupted upgrade
  for (const p of [staging, stale, destPath + '.download']) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }

  await downloadReleaseBinary(staging, releaseTag, null, null, log);

  if (!probeWorks(staging)) {
    try {
      fs.unlinkSync(staging);
    } catch {
      /* ignore */
    }
    throw new Error('Downloaded ffmpeg failed -version probe');
  }

  const hadPrevious = fs.existsSync(destPath);
  if (hadPrevious) {
    log(`Upgrading managed ffmpeg → ${releaseTag} (replacing stale binary)…`);
    try {
      if (fs.existsSync(stale)) fs.unlinkSync(stale);
    } catch {
      /* ignore */
    }
    try {
      fs.renameSync(destPath, stale);
    } catch {
      // Windows: rename may fail if in use — try copy+unlink later
      try {
        fs.copyFileSync(destPath, stale);
        fs.unlinkSync(destPath);
      } catch (e) {
        try {
          fs.unlinkSync(staging);
        } catch {
          /* ignore */
        }
        throw new Error(`Could not replace in-use ffmpeg: ${e.message}`);
      }
    }
  }

  try {
    fs.renameSync(staging, destPath);
  } catch {
    fs.copyFileSync(staging, destPath);
    try {
      fs.unlinkSync(staging);
    } catch {
      /* ignore */
    }
  }

  try {
    fs.chmodSync(destPath, 0o755);
  } catch {
    /* win */
  }

  if (fs.existsSync(stale)) {
    try {
      fs.unlinkSync(stale);
      log('Removed previous (stale) ffmpeg binary');
    } catch {
      // Leave .old for next run if Windows still has a handle
      log('Could not delete stale ffmpeg yet (file may be locked); left as .old');
    }
  }

  writeInstalledTag(destPath, releaseTag);
  writeLicense(dir);

  if (!probeWorks(destPath)) {
    throw new Error('ffmpeg after install failed -version probe');
  }
  return destPath;
}

function tryFfmpegStatic() {
  if (process.pkg) return null;
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* not installed */
  }
  return null;
}

function reinstallFfmpegStatic(log, quiet) {
  if (process.pkg) return null;
  const root = path.join(__dirname, '..');
  const installJs = path.join(root, 'node_modules', 'ffmpeg-static', 'install.js');
  if (!fs.existsSync(installJs)) return null;
  log('Downloading ffmpeg via ffmpeg-static…');
  try {
    execFileSync(process.execPath, [installJs], {
      cwd: path.join(root, 'node_modules', 'ffmpeg-static'),
      stdio: quiet ? 'pipe' : 'inherit',
      env: process.env,
    });
  } catch (err) {
    log(`ffmpeg-static install failed: ${err.message}`);
    return null;
  }
  return tryFfmpegStatic();
}

function copyToDir(src, destDir, releaseTag) {
  if (!src || !fs.existsSync(src)) return null;
  const dest = path.join(destDir, binName());
  if (path.resolve(src) === path.resolve(dest)) {
    if (releaseTag) writeInstalledTag(dest, releaseTag);
    return dest;
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  try {
    fs.chmodSync(dest, 0o755);
  } catch {
    /* win */
  }
  writeLicense(destDir);
  if (releaseTag) writeInstalledTag(dest, releaseTag);
  return dest;
}

/**
 * True if existing binary is already at least as new as desired release.
 * Prefer parsing `ffmpeg -version`; fall back to the .version sidecar tag.
 */
function isCurrentEnough(binPath, desiredTag) {
  if (!probeWorks(binPath)) return false;
  const line = probeVersionLine(binPath);
  const cmp = compareVersions(line, desiredTag);
  if (cmp !== null) return cmp >= 0;
  const tag = readInstalledTag(binPath);
  if (tag && desiredTag && tag === desiredTag) return true;
  return false;
}

/**
 * Ensure ffmpeg is available and reasonably up to date.
 *
 * @param {object} [options]
 * @param {string} [options.appDir] - App root (pkg: next to EXE; dev: repo root)
 * @param {boolean} [options.quiet]
 * @param {boolean} [options.forceCopy] - CLI --copy: refresh appDir/bin from resolved path
 * @param {boolean} [options.skipUpgrade] - only install if missing, do not upgrade
 * @param {string} [options.releaseTag] - pin a specific release tag
 * @returns {Promise<{ path: string|null, source: string, version?: string|null, releaseTag?: string }>}
 */
async function ensureFfmpeg(options = {}) {
  const appDir = options.appDir || path.join(__dirname, '..');
  const quiet = !!options.quiet;
  const forceCopy = !!options.forceCopy;
  const skipUpgrade = !!options.skipUpgrade;
  const log = makeLogger(quiet);

  const desiredTag = await resolveDesiredReleaseTag({ releaseTag: options.releaseTag });

  // 1. Explicit env — never auto-replace
  if (process.env.FFMPEG_PATH && probeWorks(process.env.FFMPEG_PATH)) {
    const p = process.env.FFMPEG_PATH;
    if (forceCopy) {
      const dir = preferredManagedBinDir(appDir);
      if (dir) {
        const copied = copyToDir(p, dir, desiredTag);
        return {
          path: copied || p,
          source: 'env',
          version: probeVersionLine(copied || p),
          releaseTag: desiredTag,
        };
      }
    }
    return {
      path: p,
      source: 'env',
      version: probeVersionLine(p),
      releaseTag: desiredTag,
    };
  }

  // 2–3. Managed installs (upgrade if stale)
  for (const mp of managedBinPaths(appDir)) {
    if (!fs.existsSync(mp)) continue;
    if (isCurrentEnough(mp, desiredTag)) {
      const existingTag = readInstalledTag(mp);
      if (forceCopy) {
        const prefer = preferredManagedBinDir(appDir);
        if (prefer && path.dirname(mp) !== prefer) {
          const copied = copyToDir(mp, prefer, existingTag || desiredTag);
          if (copied) {
            return {
              path: copied,
              source: 'bin',
              version: probeVersionLine(copied),
              releaseTag: existingTag || null,
            };
          }
        }
      }
      return {
        path: mp,
        source: path.dirname(mp) === path.join(appDir, 'bin') ? 'bin' : 'cache',
        version: probeVersionLine(mp),
        releaseTag: existingTag || null,
      };
    }
    // Stale managed binary → upgrade in place when writable
    if (!skipUpgrade && isWritableDir(path.dirname(mp))) {
      try {
        const installed = await installOrSwap(mp, desiredTag, log);
        return {
          path: installed,
          source: 'upgrade',
          version: probeVersionLine(installed),
          releaseTag: desiredTag,
        };
      } catch (err) {
        log(`Upgrade of ${mp} failed: ${err.message}`);
        // Fall through; may still use stale if it probes OK
        if (probeWorks(mp)) {
          log(`Keeping existing ffmpeg (upgrade failed): ${mp}`);
          return {
            path: mp,
            source: 'bin-stale',
            version: probeVersionLine(mp),
            releaseTag: readInstalledTag(mp) || null,
          };
        }
      }
    } else if (probeWorks(mp)) {
      return {
        path: mp,
        source: 'bin',
        version: probeVersionLine(mp),
        releaseTag: readInstalledTag(mp) || null,
      };
    }
  }

  // 4. ffmpeg-static (dev)
  let staticPath = tryFfmpegStatic();
  if (staticPath && probeWorks(staticPath)) {
    if (isCurrentEnough(staticPath, desiredTag) || skipUpgrade) {
      if (forceCopy || !managedBinPaths(appDir).some((p) => probeWorks(p))) {
        const dir = preferredManagedBinDir(appDir);
        if (dir) {
          const copied = copyToDir(staticPath, dir, desiredTag);
          if (copied) {
            return {
              path: copied,
              source: 'ffmpeg-static',
              version: probeVersionLine(copied),
              releaseTag: desiredTag,
            };
          }
        }
      }
      return {
        path: staticPath,
        source: 'ffmpeg-static',
        version: probeVersionLine(staticPath),
        releaseTag: desiredTag,
      };
    }
  }

  staticPath = reinstallFfmpegStatic(log, quiet);
  if (staticPath && probeWorks(staticPath) && isCurrentEnough(staticPath, desiredTag)) {
    const dir = preferredManagedBinDir(appDir);
    const p = dir ? copyToDir(staticPath, dir, desiredTag) || staticPath : staticPath;
    return {
      path: p,
      source: 'ffmpeg-static-install',
      version: probeVersionLine(p),
      releaseTag: desiredTag,
    };
  }

  // 5. System PATH — use if new enough; do not overwrite system binary
  if (probeWorks('ffmpeg')) {
    if (isCurrentEnough('ffmpeg', desiredTag)) {
      return {
        path: 'ffmpeg',
        source: 'path',
        version: probeVersionLine('ffmpeg'),
        releaseTag: null,
      };
    }
    log(
      `System ffmpeg is older than ${desiredTag}; downloading a managed ${desiredTag} build…`
    );
  }

  // 6. Fresh managed download
  const destDir = preferredManagedBinDir(appDir);
  if (!destDir) {
    return { path: null, source: 'missing', releaseTag: desiredTag };
  }
  const dest = path.join(destDir, binName());
  try {
    const installed = await installOrSwap(dest, desiredTag, log);
    return {
      path: installed,
      source: 'download',
      version: probeVersionLine(installed),
      releaseTag: desiredTag,
    };
  } catch (err) {
    log(`Direct download failed: ${err.message}`);
  }

  // Last resort: any working system binary even if older
  if (probeWorks('ffmpeg')) {
    return {
      path: 'ffmpeg',
      source: 'path',
      version: probeVersionLine('ffmpeg'),
      releaseTag: null,
    };
  }

  return { path: null, source: 'missing', releaseTag: desiredTag };
}

/**
 * Synchronous-ish path lookup without network (for resolveFfmpegPath).
 * Prefer managed + env + static + PATH; does not download.
 */
function resolveFfmpegPathSync(appDir) {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  for (const p of managedBinPaths(appDir || path.join(__dirname, '..'))) {
    if (fs.existsSync(p)) return p;
  }
  // Do not look for ./ffmpeg in the project root — that path was a footgun
  // (relative writes land there) and is not a supported install location.
  if (!process.pkg) {
    const s = tryFfmpegStatic();
    if (s) return s;
  }
  return 'ffmpeg';
}

module.exports = {
  ensureFfmpeg,
  resolveFfmpegPathSync,
  resolveDesiredReleaseTag,
  downloadReleaseBinary,
  downloadTarget,
  probeVersionLine,
  DEFAULT_RELEASE_TAG,
};
