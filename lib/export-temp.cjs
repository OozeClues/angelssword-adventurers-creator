/**
 * Disk-backed temp dirs for export.
 *
 * On WSL, os.tmpdir() is often a small tmpfs (/tmp ~ half of RAM). A 241-frame
 * 720p RGBA export needs ~1–2+ GB and easily hits ENOSPC while the host still
 * has hundreds of GB free on the ext4 root or /mnt/c.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function freeBytes(dir) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(dir);
      // Node 18.15+ / 20+: bavail * bsize
      const avail = Number(s.bavail ?? s.bfree ?? 0);
      const bsize = Number(s.bsize ?? s.frsize ?? 0);
      if (avail > 0 && bsize > 0) return avail * bsize;
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

function isTmpfs(dir) {
  try {
    const mounts = fs.readFileSync('/proc/mounts', 'utf8');
    // Find the longest mount point that is a prefix of dir
    let best = '';
    let fsType = '';
    for (const line of mounts.split('\n')) {
      const parts = line.split(/\s+/);
      if (parts.length < 3) continue;
      const mountPoint = parts[1];
      const type = parts[2];
      if (
        (dir === mountPoint || dir.startsWith(mountPoint.endsWith('/') ? mountPoint : mountPoint + '/')) &&
        mountPoint.length >= best.length
      ) {
        best = mountPoint;
        fsType = type;
      }
    }
    return fsType === 'tmpfs' || fsType === 'ramfs';
  } catch (_) {
    return false;
  }
}

/**
 * @param {string} appDir project or package root
 * @returns {string} absolute path to a writable directory on disk (not tiny tmpfs when possible)
 */
function getExportTempRoot(appDir) {
  const candidates = [];

  if (process.env.AS_EXPORT_TMP) {
    candidates.push(path.resolve(process.env.AS_EXPORT_TMP));
  }

  // Prefer app-local or home cache (ext4 on WSL /), never rely solely on /tmp
  if (appDir) {
    candidates.push(path.join(appDir, 'tmp-export'));
  }
  candidates.push(path.join(os.homedir(), '.cache', 'as-adventurer', 'export-tmp'));
  candidates.push(path.join(os.homedir(), '.as-adventurer-export-tmp'));

  // Last resort: system temp (may be tmpfs)
  candidates.push(os.tmpdir());

  for (const c of candidates) {
    try {
      fs.mkdirSync(c, { recursive: true });
      // Write probe
      const probe = path.join(c, `.write-probe-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);

      const free = freeBytes(c);
      const tmpfs = isTmpfs(c);
      // Skip tiny tmpfs (< 4GB free) if we have other options later — try prefer non-tmpfs
      if (tmpfs && free != null && free < 4 * 1024 * 1024 * 1024) {
        continue;
      }
      return c;
    } catch (_) {
      /* try next */
    }
  }

  // Absolute fallback
  const fallback = os.tmpdir();
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

function mkExportTemp(appDir, prefix = 'as-export-') {
  const root = getExportTempRoot(appDir);
  const dir = fs.mkdtempSync(path.join(root, prefix));
  const free = freeBytes(dir);
  return {
    dir,
    root,
    freeBytes: free,
    isTmpfs: isTmpfs(dir),
  };
}

/**
 * Rough bytes needed for server export (unique frames + headroom).
 * We no longer double-store a full sequence.rgba copy.
 */
function estimateServerExportBytes(width, height, uniqueFrames, videoFileBytes = 0) {
  const frame = Math.max(1, width) * Math.max(1, height) * 4;
  // unique RGBA files + keyed overwrite in place + webm output + video upload + 20% slack
  return Math.ceil(uniqueFrames * frame * 1.15 + videoFileBytes + 64 * 1024 * 1024);
}

function assertSpaceForExport(dir, needBytes) {
  const free = freeBytes(dir);
  if (free == null) return; // unknown — don't block
  if (free >= needBytes) return;
  const needMb = (needBytes / (1024 * 1024)).toFixed(0);
  const freeMb = (free / (1024 * 1024)).toFixed(0);
  const tip = isTmpfs(dir)
    ? ' Export temp is on a RAM-backed filesystem (common for /tmp in WSL). Set AS_EXPORT_TMP to a path on your Linux disk (e.g. ~/as-export-tmp) or free space under ~/.cache.'
    : ' Free disk space or set AS_EXPORT_TMP to a larger volume.';
  const err = new Error(
    `Not enough free space for export (need ~${needMb} MB, have ~${freeMb} MB in ${dir}).${tip}`
  );
  err.code = 'ENOSPC';
  throw err;
}

module.exports = {
  getExportTempRoot,
  mkExportTemp,
  freeBytes,
  isTmpfs,
  estimateServerExportBytes,
  assertSpaceForExport,
};
