#!/usr/bin/env node
/**
 * Build a zero-dependency release folder for end users.
 *
 * Separate folders per OS/arch (no cross-contamination):
 *   dist/ASAdventurer-windows-x64/
 *   dist/ASAdventurer-windows-arm64/
 *   dist/ASAdventurer-macos-x64/
 *   dist/ASAdventurer-macos-arm64/   (Apple Silicon)
 *   dist/ASAdventurer-linux-x64/
 *   dist/ASAdventurer-linux-arm64/
 *   dist/ASAdventurer-linux-x64.flatpak   (Flatpak bundle)
 *   dist/ASAdventurer-linux-arm64.flatpak
 *
 * Usage:
 *   node build-exe.js                      # Windows x64
 *   node build-exe.js --target win-x64
 *   node build-exe.js --target win-arm64
 *   node build-exe.js --target mac-x64
 *   node build-exe.js --target mac-arm64   # Apple Silicon
 *   node build-exe.js --target linux-x64
 *   node build-exe.js --target linux-arm64
 *   node build-exe.js --target linux-flatpak        # Flatpak (x64)
 *   node build-exe.js --target linux-flatpak-arm64  # Flatpak (arm64)
 *   node build-exe.js --target all                  # all OS/arch ZIPs (x64 + arm64)
 *   node build-exe.js --target all-flatpak          # all ZIPs + both Flatpaks
 *   node build-exe.js --skip-client-build
 *   node build-exe.js --target linux-flatpak --flatpak-only  # reuse existing linux folder
 *
 * Aliases: win→win-x64, mac→mac-x64, linux→linux-x64,
 *          apple-silicon|as|m1|m2→mac-arm64, flatpak→linux-flatpak,
 *          all|build-all, all-flatpak|all+flatpak
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST_ROOT = path.join(ROOT, 'dist');

const TARGETS = {
  'win-x64': {
    pkg: 'node18-win-x64',
    folder: 'ASAdventurer-windows-x64',
    binary: 'ASAdventurer.exe',
    ffmpegName: 'ffmpeg.exe',
    ffmpegPlatform: 'win32',
    ffmpegArch: 'x64',
    zipName: 'ASAdventurer-windows-x64.zip',
    label: 'Windows x64',
  },
  'win-arm64': {
    // Native ARM64 Node binary via pkg; ffmpeg-static has no win-arm64 asset,
    // so we ship win32-x64 ffmpeg (runs under Windows on ARM x64 emulation).
    pkg: 'node18-win-arm64',
    folder: 'ASAdventurer-windows-arm64',
    binary: 'ASAdventurer.exe',
    ffmpegName: 'ffmpeg.exe',
    ffmpegPlatform: 'win32',
    ffmpegArch: 'x64',
    ffmpegNote: 'x64 ffmpeg (Windows on ARM emulation)',
    zipName: 'ASAdventurer-windows-arm64.zip',
    label: 'Windows ARM64',
  },
  'linux-x64': {
    pkg: 'node18-linux-x64',
    folder: 'ASAdventurer-linux-x64',
    binary: 'ASAdventurer',
    ffmpegName: 'ffmpeg',
    ffmpegPlatform: 'linux',
    ffmpegArch: 'x64',
    zipName: 'ASAdventurer-linux-x64.zip',
    label: 'Linux x64',
  },
  'linux-arm64': {
    pkg: 'node18-linux-arm64',
    folder: 'ASAdventurer-linux-arm64',
    binary: 'ASAdventurer',
    ffmpegName: 'ffmpeg',
    ffmpegPlatform: 'linux',
    ffmpegArch: 'arm64',
    zipName: 'ASAdventurer-linux-arm64.zip',
    label: 'Linux ARM64',
  },
  'mac-x64': {
    pkg: 'node18-macos-x64',
    folder: 'ASAdventurer-macos-x64',
    binary: 'ASAdventurer',
    ffmpegName: 'ffmpeg',
    ffmpegPlatform: 'darwin',
    ffmpegArch: 'x64',
    zipName: 'ASAdventurer-macos-x64.zip',
    label: 'macOS Intel (x64)',
  },
  'mac-arm64': {
    pkg: 'node18-macos-arm64',
    folder: 'ASAdventurer-macos-arm64',
    binary: 'ASAdventurer',
    ffmpegName: 'ffmpeg',
    ffmpegPlatform: 'darwin',
    ffmpegArch: 'arm64',
    zipName: 'ASAdventurer-macos-arm64.zip',
    label: 'macOS Apple Silicon (arm64)',
  },
};

/** Flatpak targets wrap a linux pkg folder into a .flatpak bundle */
const FLATPAK_TARGETS = {
  'linux-flatpak': {
    linuxKey: 'linux-x64',
    appId: 'studio.angelssword.ASAdventurer',
    bundleName: 'ASAdventurer-linux-x64.flatpak',
    label: 'Linux Flatpak (x64)',
    arch: 'x86_64',
  },
  'linux-flatpak-arm64': {
    linuxKey: 'linux-arm64',
    appId: 'studio.angelssword.ASAdventurer',
    bundleName: 'ASAdventurer-linux-arm64.flatpak',
    label: 'Linux Flatpak (arm64)',
    arch: 'aarch64',
  },
};

const FLATPAK_APP_ID = 'studio.angelssword.ASAdventurer';
const FLATPAK_DIR = path.join(ROOT, 'flatpak');
// Current Flatpak docs (first-build) use Freedesktop 25.08 as of 2026.
const FLATPAK_RUNTIME_VERSION = '25.08';

/** Map user-facing aliases → canonical target keys */
const TARGET_ALIASES = {
  win: 'win-x64',
  windows: 'win-x64',
  'win32': 'win-x64',
  'windows-x64': 'win-x64',
  'win-x64': 'win-x64',
  'win-arm': 'win-arm64',
  'win-arm64': 'win-arm64',
  'windows-arm': 'win-arm64',
  'windows-arm64': 'win-arm64',
  linux: 'linux-x64',
  'linux-x64': 'linux-x64',
  'linux-arm': 'linux-arm64',
  'linux-arm64': 'linux-arm64',
  flatpak: 'linux-flatpak',
  'linux-flatpak': 'linux-flatpak',
  'flatpak-x64': 'linux-flatpak',
  'linux-flatpak-x64': 'linux-flatpak',
  'flatpak-arm64': 'linux-flatpak-arm64',
  'linux-flatpak-arm64': 'linux-flatpak-arm64',
  mac: 'mac-x64',
  macos: 'mac-x64',
  darwin: 'mac-x64',
  osx: 'mac-x64',
  'mac-x64': 'mac-x64',
  'macos-x64': 'mac-x64',
  'mac-intel': 'mac-x64',
  'mac-arm': 'mac-arm64',
  'mac-arm64': 'mac-arm64',
  'macos-arm64': 'mac-arm64',
  'apple-silicon': 'mac-arm64',
  as: 'mac-arm64',
  m1: 'mac-arm64',
  m2: 'mac-arm64',
  m3: 'mac-arm64',
  m4: 'mac-arm64',
  all: 'all',
  'build-all': 'all',
  'all-zips': 'all',
  'all-flatpak': 'all-flatpak',
  'all-flatpaks': 'all-flatpak',
  'all+flatpak': 'all-flatpak',
  'all+flatpaks': 'all-flatpak',
};

/** Canonical zip targets in build-all order */
const ALL_ZIP_KEYS = [
  'win-x64',
  'win-arm64',
  'linux-x64',
  'linux-arm64',
  'mac-x64',
  'mac-arm64',
];

/** Optional Flatpak targets (Linux only; requires flatpak-builder) */
const ALL_FLATPAK_KEYS = ['linux-flatpak', 'linux-flatpak-arm64'];

function parseArgs() {
  const argv = process.argv.slice(2);
  let key = 'win-x64';
  let skipClient = false;
  let flatpakOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && argv[i + 1]) {
      const raw = String(argv[++i]).toLowerCase();
      key = TARGET_ALIASES[raw] || raw;
    } else if (argv[i] === '--skip-client-build') {
      skipClient = true;
    } else if (argv[i] === '--flatpak-only') {
      flatpakOnly = true;
    }
  }
  if (key === 'all' || key === 'all-flatpak') {
    return {
      target: null,
      targetKey: key,
      skipClient,
      flatpakOnly,
      flatpak: null,
      buildAll: true,
      withFlatpaks: key === 'all-flatpak',
    };
  }
  if (FLATPAK_TARGETS[key]) {
    return {
      target: null,
      targetKey: key,
      skipClient,
      flatpakOnly,
      flatpak: FLATPAK_TARGETS[key],
      buildAll: false,
      withFlatpaks: false,
    };
  }
  if (!TARGETS[key]) {
    console.error(
      `Unknown --target. Valid options:\n  ${[
        ...Object.keys(TARGETS),
        ...Object.keys(FLATPAK_TARGETS),
        'all',
        'all-flatpak',
      ].join('\n  ')}`
    );
    console.error(
      `\nAliases: win, win-arm64, mac, mac-arm64, linux, linux-arm64, flatpak, flatpak-arm64, apple-silicon, all, all-flatpak, …`
    );
    process.exit(1);
  }
  return {
    target: TARGETS[key],
    targetKey: key,
    skipClient,
    flatpakOnly,
    flatpak: null,
    buildAll: false,
    withFlatpaks: false,
  };
}

function log(msg) {
  console.log(`  ${msg}`);
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function findUiRoot() {
  // Active UI only — legacy/public is reference vanilla, not packaged.
  const candidates = [
    path.join(ROOT, 'client', 'dist', 'client', 'browser'),
    path.join(ROOT, 'client', 'dist', 'browser'),
  ];
  return candidates.find((p) => fs.existsSync(path.join(p, 'index.html'))) || null;
}

function copyFfmpegLicense(binDest) {
  const lic = [
    path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.LICENSE'),
    path.join(ROOT, 'node_modules', 'ffmpeg-static', 'LICENSE'),
  ].find((p) => fs.existsSync(p));
  if (lic) fs.copyFileSync(lic, path.join(binDest, 'ffmpeg.LICENSE'));
}

function bundleFfmpeg(binDest, target) {
  const dest = path.join(binDest, target.ffmpegName);
  fs.mkdirSync(binDest, { recursive: true });

  const localCandidates = [
    path.join(ROOT, 'bin', target.ffmpegName),
    path.join(ROOT, target.ffmpegName),
    path.join(ROOT, 'node_modules', 'ffmpeg-static', target.ffmpegName),
  ];
  const local = localCandidates.find((p) => fs.existsSync(p));
  const hostIsTarget = target.ffmpegPlatform === process.platform;

  if (local && hostIsTarget && path.basename(local) === target.ffmpegName) {
    fs.copyFileSync(local, dest);
    log(`ffmpeg ← ${path.relative(ROOT, local)}`);
    copyFfmpegLicense(binDest);
    return;
  }

  log(
    `Downloading ffmpeg (${target.ffmpegPlatform}-${target.ffmpegArch})${
      target.ffmpegNote ? ` — ${target.ffmpegNote}` : ''
    }…`
  );
  execSync(
    `node "${path.join(ROOT, 'scripts', 'download-ffmpeg.js')}" --platform ${target.ffmpegPlatform} --arch ${target.ffmpegArch} --out "${dest}"`,
    { stdio: 'inherit', cwd: ROOT }
  );
  if (!fs.existsSync(dest) || fs.statSync(dest).size < 1_000_000) {
    throw new Error('ffmpeg download failed or file too small');
  }
  try {
    fs.chmodSync(dest, 0o755);
  } catch {
    /* win */
  }
  copyFfmpegLicense(binDest);
  log(`ffmpeg → bin/${target.ffmpegName}`);
}

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents);
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {
    /* ignore */
  }
}

function unixStartBody(binaryName) {
  return `#!/usr/bin/env bash
set +e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1
chmod +x "$DIR/${binaryName}" "$DIR/bin/ffmpeg" \\
  "$DIR/Start AS Adventurer.sh" "$DIR/Start AS Adventurer.command" \\
  "$DIR/First Run Setup.sh" "$DIR/First Run Setup.command" 2>/dev/null
echo ""
echo "  AS Adventurer Creator — Angel's Sword Studios"
echo "  Starting... leave this window open. Ctrl+C to stop."
echo ""
if [[ ! -f "$DIR/bin/ffmpeg" ]]; then
  echo "  [WARN] bin/ffmpeg missing — transparent WebM export may fail."
fi
(sleep 1.5; command -v open >/dev/null 2>&1 && open "http://localhost:3001") &
(sleep 1.5; command -v xdg-open >/dev/null 2>&1 && xdg-open "http://localhost:3001") &
exec "$DIR/${binaryName}"
`;
}

function unixSetupBody(binaryName) {
  return `#!/usr/bin/env bash
set +e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1
echo ""
echo "  AS Adventurer — First Run Setup"
echo ""
chmod +x "$DIR/${binaryName}" "$DIR/bin/ffmpeg" \\
  "$DIR/Start AS Adventurer.sh" "$DIR/Start AS Adventurer.command" \\
  "$DIR/First Run Setup.sh" "$DIR/First Run Setup.command" 2>/dev/null
echo "  ✓ Execute permissions set"
if [[ "$(uname -s)" == "Linux" ]] || command -v xdg-open >/dev/null 2>&1; then
  DESKTOP_FILE="$DIR/Start AS Adventurer.desktop"
  cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=AS Adventurer Creator
Comment=VTuber creation pipeline
Exec="$DIR/Start AS Adventurer.sh"
Path=$DIR
Terminal=true
Categories=Graphics;AudioVideo;
StartupNotify=true
EOF
  chmod +x "$DESKTOP_FILE" 2>/dev/null
  echo "  ✓ Desktop launcher: Start AS Adventurer.desktop"
fi
echo ""
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "  Next: double-click Start AS Adventurer.command"
else
  echo "  Next: run Start AS Adventurer.sh (or the .desktop launcher)"
fi
echo ""
read -r -p "  Press Enter to close..." _
`;
}

function writeWinLauncher(dist, binaryName) {
  fs.writeFileSync(
    path.join(dist, 'Start AS Adventurer.bat'),
    `@echo off
title AS Adventurer Creator
cd /d "%~dp0"
echo.
echo  AS Adventurer Creator — Angel's Sword Studios
echo  Starting... leave this window open. Ctrl+C to stop.
echo.
if not exist "bin\\ffmpeg.exe" echo  [WARN] bin\\ffmpeg.exe missing — WebM alpha export may fail.
start "" http://localhost:3001
"${binaryName}"
if errorlevel 1 (
  echo.
  echo  If Windows blocked the app: right-click Properties → Unblock.
  pause
)
`
  );
}

function writeUnixLaunchers(dist, binaryName) {
  const start = unixStartBody(binaryName);
  const setup = unixSetupBody(binaryName);
  writeExecutable(path.join(dist, 'Start AS Adventurer.sh'), start);
  writeExecutable(path.join(dist, 'Start AS Adventurer.command'), start);
  writeExecutable(path.join(dist, 'First Run Setup.sh'), setup);
  writeExecutable(path.join(dist, 'First Run Setup.command'), setup);
  writeExecutable(path.join(dist, 'start.sh'), start);
  writeExecutable(path.join(dist, 'setup.sh'), setup);
}

function writeEndUserReadme(dist, target) {
  const includes = `Includes: ${target.binary}, bin/${target.ffmpegName}, www/\n`;
  let text;
  if (target.ffmpegPlatform === 'win32') {
    text = `AS Adventurer Creator — no install needed

1. Unzip anywhere
2. Double-click Start AS Adventurer.bat
3. Keep the console open while you work

${includes}`;
  } else if (target.ffmpegPlatform === 'darwin') {
    text = `AS Adventurer Creator — no install needed (macOS)

1. Unzip this folder
2. First time: double-click First Run Setup.command
   (if macOS blocks it: right-click → Open → Open)
3. Double-click Start AS Adventurer.command
4. Your browser opens to http://localhost:3001
   (open that URL manually if it does not)

Keep the terminal window open while you work.

${includes}`;
  } else {
    // linux
    text = `AS Adventurer Creator — no install needed (Linux)

1. Unzip this folder
2. First time: run First Run Setup.sh
   (chmod +x if needed: chmod +x First\\ Run\\ Setup.sh)
3. Start with Start AS Adventurer.sh (or the .desktop launcher if present)
4. Your browser opens to http://localhost:3001
   (open that URL manually if it does not)

Keep the terminal open while you work.

${includes}`;
  }
  fs.writeFileSync(path.join(dist, 'README.txt'), text);
}

function commandExists(cmd) {
  try {
    execSync(
      process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`,
      { stdio: 'pipe' }
    );
    return true;
  } catch {
    return false;
  }
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

/** Host CPU as Node process.arch (x64, arm64, …). */
function hostNodeArch() {
  return process.arch;
}

/**
 * Flatpak arch id for this host.
 * Flatpak uses x86_64 / aarch64 (not Node's x64 / arm64).
 */
function hostFlatpakArch() {
  if (process.arch === 'arm64') return 'aarch64';
  if (process.arch === 'x64' || process.arch === 'ia32') return 'x86_64';
  try {
    const u = execSync('uname -m', { encoding: 'utf8' }).trim();
    if (u === 'aarch64' || u === 'arm64') return 'aarch64';
    if (u === 'x86_64' || u === 'amd64') return 'x86_64';
  } catch {
    /* ignore */
  }
  return 'x86_64';
}

/**
 * pkg target triple → Node-style arch (x64 | arm64).
 * e.g. node18-linux-arm64 → arm64, node18-win-x64 → x64
 */
function pkgTripleArch(pkgTriple) {
  if (/-arm64$/i.test(pkgTriple)) return 'arm64';
  if (/-x64$/i.test(pkgTriple)) return 'x64';
  if (/-armv7$/i.test(pkgTriple)) return 'arm';
  return null;
}

/** True when pkg is compiling for a CPU different from the build host. */
function isPkgCrossArch(target) {
  const want = pkgTripleArch(target.pkg);
  if (!want) return false;
  // Node reports x64 on Intel/AMD; arm64 on Apple Silicon / Linux aarch64.
  return want !== hostNodeArch();
}

/**
 * Run pkg, surfacing real errors. Cross-arch builds often print many
 * "Failed to make bytecode node18-arm64 for file C:\snapshot\..." lines —
 * those use pkg's *virtual* snapshot FS (not your Windows C: drive), and are
 * expected when packaging arm64 from an x86_64 host (and vice versa). The
 * binary still works; only V8 bytecode precompilation is skipped.
 */
function runPkg(pkgArgs, target) {
  const cross = isPkgCrossArch(target);
  if (cross) {
    log(
      `Cross-arch pkg (${target.pkg} on ${hostNodeArch()}): bytecode warnings are expected and safe to ignore.`
    );
    log('  Paths like C:\\snapshot\\… are inside pkg’s virtual filesystem, not your host drive.');
  }

  const cmd = pkgArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  // Stream stdout/stderr live, but summarize bytecode noise so build-all logs stay readable.
  const { spawnSync } = require('child_process');
  const result = spawnSync(cmd, {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const out = `${result.stdout || ''}${result.stderr || ''}`;
  const lines = out.split(/\r?\n/);
  let bytecodeFails = 0;
  for (const line of lines) {
    if (/Failed to make bytecode\b/i.test(line)) {
      bytecodeFails += 1;
      continue;
    }
    if (line.length) console.log(line);
  }
  if (bytecodeFails > 0) {
    log(
      `pkg: skipped V8 bytecode for ${bytecodeFails} module(s) (cross-arch or missing target Node). Binary is still usable.`
    );
  }

  if (result.status !== 0) {
    throw new Error(`pkg exited with code ${result.status}`);
  }
}

/**
 * Write a Flatpak manifest that points at the staged linux release folder.
 * Paths are absolute so flatpak-builder can be invoked from any cwd.
 */
function writeFlatpakManifest(manifestPath, linuxDist, flatpakMeta) {
  const sources = {
    linuxDir: path.resolve(linuxDist),
    wrapper: path.resolve(FLATPAK_DIR, 'as-adventurer.sh'),
    desktop: path.resolve(FLATPAK_DIR, `${FLATPAK_APP_ID}.desktop`),
    metainfo: path.resolve(FLATPAK_DIR, `${FLATPAK_APP_ID}.metainfo.xml`),
    icon: path.resolve(ROOT, 'icon.png'),
  };
  for (const [name, p] of Object.entries(sources)) {
    if (!fs.existsSync(p)) {
      throw new Error(`Flatpak source missing (${name}): ${p}`);
    }
  }

  // YAML is hand-written for readability / stable diffs.
  // Prefer `id` (current docs); `app-id` remains accepted as an alias.
  const yaml = `# Generated by build-exe.js — do not edit by hand
id: ${FLATPAK_APP_ID}
runtime: org.freedesktop.Platform
runtime-version: '${FLATPAK_RUNTIME_VERSION}'
sdk: org.freedesktop.Sdk
command: as-adventurer

finish-args:
  - --share=network
  - --share=ipc
  - --socket=fallback-x11
  - --socket=wayland
  - --device=dri
  - --talk-name=org.freedesktop.portal.Desktop

modules:
  - name: as-adventurer
    buildsystem: simple
    build-commands:
      - install -d /app/lib/as-adventurer/bin
      - install -Dm755 ASAdventurer /app/lib/as-adventurer/ASAdventurer
      - install -Dm755 bin/ffmpeg /app/lib/as-adventurer/bin/ffmpeg
      - |
        if [ -f bin/ffmpeg.LICENSE ]; then
          install -Dm644 bin/ffmpeg.LICENSE /app/lib/as-adventurer/bin/ffmpeg.LICENSE
        fi
      - cp -a www /app/lib/as-adventurer/www
      - install -Dm755 as-adventurer.sh /app/bin/as-adventurer
      - install -Dm644 ${FLATPAK_APP_ID}.desktop /app/share/applications/${FLATPAK_APP_ID}.desktop
      - install -Dm644 ${FLATPAK_APP_ID}.metainfo.xml /app/share/metainfo/${FLATPAK_APP_ID}.metainfo.xml
      - install -Dm644 icon.png /app/share/icons/hicolor/256x256/apps/${FLATPAK_APP_ID}.png
    sources:
      - type: dir
        path: ${JSON.stringify(sources.linuxDir)}
      - type: file
        path: ${JSON.stringify(sources.wrapper)}
      - type: file
        path: ${JSON.stringify(sources.desktop)}
      - type: file
        path: ${JSON.stringify(sources.metainfo)}
      - type: file
        path: ${JSON.stringify(sources.icon)}
`;
  fs.writeFileSync(manifestPath, yaml);
  void flatpakMeta;
  return { manifestPath, version: readPackageVersion() };
}

function resolveLinuxDistDir(linuxKey) {
  const linuxTarget = TARGETS[linuxKey];
  const candidates = [path.join(DIST_ROOT, linuxTarget.folder)];
  // Older builds used un-suffixed folder names (e.g. ASAdventurer-linux).
  if (linuxKey === 'linux-x64') candidates.push(path.join(DIST_ROOT, 'ASAdventurer-linux'));
  if (linuxKey === 'linux-arm64') candidates.push(path.join(DIST_ROOT, 'ASAdventurer-linux-arm'));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, linuxTarget.binary))) return dir;
  }
  return candidates[0];
}

function ensureLinuxReleaseForFlatpak(linuxKey, skipClient, flatpakOnly) {
  const linuxTarget = TARGETS[linuxKey];
  const linuxDist = resolveLinuxDistDir(linuxKey);
  const binaryPath = path.join(linuxDist, linuxTarget.binary);
  const hasBinary = fs.existsSync(binaryPath);

  if (flatpakOnly) {
    if (!hasBinary) {
      console.error(
        `\n  ❌ --flatpak-only requires an existing build at dist/${linuxTarget.folder}/\n` +
          `     Run: node build-exe.js --target ${linuxKey}\n`
      );
      process.exit(1);
    }
    log(`Reusing existing linux package: ${path.relative(ROOT, linuxDist)}/`);
    return linuxDist;
  }

  log(`Building base package first: ${linuxKey}…`);
  const args = [process.execPath, path.join(ROOT, 'build-exe.js'), '--target', linuxKey];
  if (skipClient) args.push('--skip-client-build');
  execSync(args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), {
    stdio: 'inherit',
    cwd: ROOT,
    shell: true,
  });
  const built = resolveLinuxDistDir(linuxKey);
  if (!fs.existsSync(path.join(built, linuxTarget.binary))) {
    console.error(`\n  ❌ Expected binary missing after linux build: dist/${linuxTarget.folder}/\n`);
    process.exit(1);
  }
  return built;
}

/**
 * Whether this host can run flatpak-builder for the given Flatpak arch.
 * flatpak-builder requires a host-compatible arch unless multiarch/QEMU is set up.
 * Set FLATPAK_ALLOW_CROSS=1 to attempt non-native builds anyway.
 */
function canBuildFlatpakArch(flatpakArch, { allowCross = false } = {}) {
  const host = hostFlatpakArch();
  if (flatpakArch === host) return { ok: true, host, cross: false };
  if (allowCross || process.env.FLATPAK_ALLOW_CROSS === '1') {
    return { ok: true, host, cross: true };
  }
  return { ok: false, host, cross: true };
}

/** List arches present under repo/refs/heads/app/<id>/ */
function listRepoAppArches(repoDir, appId) {
  const base = path.join(repoDir, 'refs', 'heads', 'app', appId);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * Build a Flatpak bundle.
 * @returns {{ ok: boolean, skipped?: boolean, reason?: string }}
 */
function buildFlatpakBundle(flatpak, skipClient, flatpakOnly, opts = {}) {
  const softFail = !!opts.softFail;
  const linuxKey = flatpak.linuxKey;
  const linuxTarget = TARGETS[linuxKey];

  console.log();
  console.log('  ============================================');
  console.log('   ⚔️  AS Adventurer — Flatpak Builder');
  console.log('  ============================================');
  console.log();
  log(`Target: ${flatpak.label}`);
  log(`Base:   dist/${linuxTarget.folder}/`);
  log(`Bundle: dist/${flatpak.bundleName}`);
  log(`App ID: ${FLATPAK_APP_ID}`);
  log(`Arch:   ${flatpak.arch} (host: ${hostFlatpakArch()})`);

  if (process.platform === 'win32') {
    const msg = 'Flatpak packaging must run on Linux (flatpak-builder).';
    if (softFail) {
      log(`⚠️  Skipping: ${msg}`);
      return { ok: false, skipped: true, reason: msg };
    }
    console.error(`\n  ❌ ${msg}\n`);
    process.exit(1);
  }

  const archCheck = canBuildFlatpakArch(flatpak.arch);
  if (!archCheck.ok) {
    const msg =
      `Cannot build Flatpak arch ${flatpak.arch} on host ${archCheck.host}. ` +
      `flatpak-builder only supports host-compatible arches without multiarch/QEMU.`;
    log(`⚠️  Skipping ${flatpak.bundleName}`);
    log(`  ${msg}`);
    log(`  Build this bundle on a ${flatpak.arch} machine, or set up cross builds:`);
    log(
      `    flatpak install --user flathub org.freedesktop.Platform/${flatpak.arch}/${FLATPAK_RUNTIME_VERSION} org.freedesktop.Sdk/${flatpak.arch}/${FLATPAK_RUNTIME_VERSION}`
    );
    log('    # plus qemu-user-static / binfmt for your distro, then:');
    log('    FLATPAK_ALLOW_CROSS=1 npm run build:linux:flatpak:arm64');
    if (softFail) return { ok: false, skipped: true, reason: msg };
    console.error(`\n  ❌ ${msg}\n`);
    process.exit(1);
  }
  if (archCheck.cross) {
    log(
      `Cross-arch Flatpak (${flatpak.arch} on ${archCheck.host}) — requires matching runtime/SDK + QEMU.`
    );
  }

  const requiredMeta = [
    path.join(FLATPAK_DIR, 'as-adventurer.sh'),
    path.join(FLATPAK_DIR, `${FLATPAK_APP_ID}.desktop`),
    path.join(FLATPAK_DIR, `${FLATPAK_APP_ID}.metainfo.xml`),
    path.join(ROOT, 'icon.png'),
  ];
  for (const p of requiredMeta) {
    if (!fs.existsSync(p)) {
      const msg = `Missing Flatpak asset: ${path.relative(ROOT, p)}`;
      if (softFail) {
        log(`⚠️  ${msg}`);
        return { ok: false, skipped: true, reason: msg };
      }
      console.error(`\n  ❌ ${msg}\n`);
      process.exit(1);
    }
  }

  const linuxDist = ensureLinuxReleaseForFlatpak(linuxKey, skipClient, flatpakOnly);

  // Stage work dirs under dist/
  const workRoot = path.join(DIST_ROOT, `flatpak-work-${linuxKey}`);
  const buildDir = path.join(workRoot, 'build');
  const repoDir = path.join(workRoot, 'repo');
  const stateDir = path.join(workRoot, 'state');
  const manifestPath = path.join(workRoot, `${FLATPAK_APP_ID}.yml`);

  if (fs.existsSync(workRoot)) fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(workRoot, { recursive: true });

  writeFlatpakManifest(manifestPath, linuxDist, flatpak);
  log(`Manifest → ${path.relative(ROOT, manifestPath)}`);

  const bundlePath = path.join(DIST_ROOT, flatpak.bundleName);
  const hasBuilder = commandExists('flatpak-builder');
  const hasFlatpak = commandExists('flatpak');

  if (!hasBuilder || !hasFlatpak) {
    log('');
    log('flatpak-builder not fully available — wrote staging assets only.');
    log('Install on the build host, then re-run with --flatpak-only:');
    log('  sudo apt install flatpak flatpak-builder');
    log('  flatpak remote-add --if-not-exists --user flathub https://dl.flathub.org/repo/flathub.flatpakrepo');
    log('');
    log('Or build manually:');
    log(
      `  flatpak-builder --arch=${flatpak.arch} --user --install-deps-from=flathub --force-clean --repo="${repoDir}" "${buildDir}" "${manifestPath}"`
    );
    log(
      `  flatpak build-bundle --arch=${flatpak.arch} "${repoDir}" "${bundlePath}" ${FLATPAK_APP_ID}`
    );
    writeFlatpakReadme(workRoot, flatpak, linuxTarget, manifestPath, bundlePath);
    console.log();
    log('✅ Flatpak staging ready (bundle not built — install flatpak-builder)');
    log(`Work dir: ${workRoot}`);
    console.log();
    return { ok: false, skipped: true, reason: 'flatpak-builder not installed' };
  }

  // Ensure Flathub so Platform/Sdk can be pulled
  try {
    execSync(
      'flatpak remote-add --if-not-exists --user flathub https://dl.flathub.org/repo/flathub.flatpakrepo',
      { stdio: 'pipe' }
    );
  } catch (e) {
    log('Note: could not ensure flathub remote (may already exist): ' + e.message);
  }

  // Pull runtime/SDK for the *target* arch (critical for aarch64 on x86_64 hosts).
  try {
    log(
      `Ensuring Platform/Sdk ${FLATPAK_RUNTIME_VERSION} for ${flatpak.arch} (may download on first use)…`
    );
    execSync(
      [
        'flatpak',
        'install',
        '--user',
        '-y',
        'flathub',
        `org.freedesktop.Platform/${flatpak.arch}/${FLATPAK_RUNTIME_VERSION}`,
        `org.freedesktop.Sdk/${flatpak.arch}/${FLATPAK_RUNTIME_VERSION}`,
      ]
        .map((a) => (/\s/.test(a) ? `"${a}"` : a))
        .join(' '),
      { stdio: 'inherit', cwd: ROOT, shell: true }
    );
  } catch (e) {
    log(
      'Note: could not auto-install Platform/Sdk (flatpak-builder may still pull them): ' +
        (e.message || e)
    );
  }

  // IMPORTANT: --arch must match on builder *and* build-bundle. Without it,
  // builder exports app/…/x86_64/master on Intel hosts even when packaging an
  // arm64 binary, then build-bundle --arch=aarch64 fails with "Refspec … not found".
  log(
    `Running flatpak-builder --arch=${flatpak.arch} (Freedesktop ${FLATPAK_RUNTIME_VERSION})…`
  );
  try {
    execSync(
      [
        'flatpak-builder',
        `--arch=${flatpak.arch}`,
        '--force-clean',
        '--user',
        '--install-deps-from=flathub',
        `--state-dir=${stateDir}`,
        `--repo=${repoDir}`,
        buildDir,
        manifestPath,
      ]
        .map((a) => (/\s/.test(a) ? `"${a}"` : a))
        .join(' '),
      { stdio: 'inherit', cwd: ROOT, shell: true }
    );
  } catch {
    const msg = 'flatpak-builder failed';
    console.error(`\n  ❌ ${msg}.\n`);
    console.error(
      '  Tip: install deps manually, then re-run with --flatpak-only:\n' +
        `    flatpak install --user flathub org.freedesktop.Platform/${flatpak.arch}/${FLATPAK_RUNTIME_VERSION} org.freedesktop.Sdk/${flatpak.arch}/${FLATPAK_RUNTIME_VERSION}\n` +
        '  Or use the Flathub builder app:\n' +
        '    flatpak install --user flathub org.flatpak.Builder\n' +
        '  Cross-arch note: aarch64 Flatpaks need an aarch64 host (or QEMU + FLATPAK_ALLOW_CROSS=1).\n'
    );
    if (softFail) return { ok: false, skipped: false, reason: msg };
    process.exit(1);
  }

  // Safety: confirm the repo actually has the arch we asked for.
  const arches = listRepoAppArches(repoDir, FLATPAK_APP_ID);
  if (arches.length && !arches.includes(flatpak.arch)) {
    const msg =
      `Repo has app arch [${arches.join(', ')}] but expected ${flatpak.arch}. ` +
      `Refusing build-bundle (would fail with Refspec not found).`;
    console.error(`\n  ❌ ${msg}\n`);
    if (softFail) return { ok: false, skipped: false, reason: msg };
    process.exit(1);
  }

  log(`Bundling → ${flatpak.bundleName}…`);
  try {
    if (fs.existsSync(bundlePath)) fs.unlinkSync(bundlePath);
    execSync(
      [
        'flatpak',
        'build-bundle',
        `--arch=${flatpak.arch}`,
        repoDir,
        bundlePath,
        FLATPAK_APP_ID,
      ]
        .map((a) => (/\s/.test(a) ? `"${a}"` : a))
        .join(' '),
      { stdio: 'inherit', cwd: ROOT, shell: true }
    );
  } catch {
    const msg = 'flatpak build-bundle failed';
    console.error(`\n  ❌ ${msg}.\n`);
    console.error(
      `  Expected ref: app/${FLATPAK_APP_ID}/${flatpak.arch}/master\n` +
        `  Repo arches:  ${arches.join(', ') || '(none)'}\n`
    );
    if (softFail) return { ok: false, skipped: false, reason: msg };
    process.exit(1);
  }

  writeFlatpakReadme(workRoot, flatpak, linuxTarget, manifestPath, bundlePath);

  console.log();
  log('✅ Flatpak bundle ready');
  if (fs.existsSync(bundlePath)) {
    log(`  ${bundlePath}  (${(fs.statSync(bundlePath).size / (1024 * 1024)).toFixed(1)} MB)`);
  }
  log('Install:  flatpak install --user dist/' + flatpak.bundleName);
  log('Run:      flatpak run ' + FLATPAK_APP_ID);
  console.log();
  return { ok: true };
}

function writeFlatpakReadme(workRoot, flatpak, linuxTarget, manifestPath, bundlePath) {
  const text = `AS Adventurer Creator — Flatpak package

App ID:  ${FLATPAK_APP_ID}
Base:    dist/${linuxTarget.folder}/
Bundle:  ${path.basename(bundlePath)}

Install (user):
  flatpak install --user ${path.basename(bundlePath)}
  flatpak run ${FLATPAK_APP_ID}

Rebuild:
  node build-exe.js --target ${
    flatpak.linuxKey === 'linux-arm64' ? 'linux-flatpak-arm64' : 'linux-flatpak'
  }
  node build-exe.js --target ${
    flatpak.linuxKey === 'linux-arm64' ? 'linux-flatpak-arm64' : 'linux-flatpak'
  } --flatpak-only

Manifest: ${manifestPath}
`;
  fs.writeFileSync(path.join(workRoot, 'README.txt'), text);
  const distReadme = path.join(DIST_ROOT, path.basename(bundlePath).replace(/\.flatpak$/i, '') + '-FLATPAK.txt');
  fs.writeFileSync(distReadme, text);
}

// ── Build one OS/arch ZIP package ────────────────
function ensureClientBuilt(skipClient) {
  if (!skipClient && fs.existsSync(path.join(ROOT, 'client', 'package.json'))) {
    log('Building Angular client…');
    try {
      execSync('npm run build --prefix client', { stdio: 'inherit', cwd: ROOT });
    } catch {
      log('Client build failed — will try existing client/dist if present');
    }
  } else if (skipClient) {
    log('Skipping client build (--skip-client-build)');
  }
}

function ensurePkg() {
  log('Checking pkg…');
  try {
    execSync('npx --yes pkg --version', { stdio: 'pipe' });
  } catch {
    log('Installing pkg…');
    execSync('npm install -g pkg', { stdio: 'inherit' });
  }
}

/**
 * Build a single platform release into dist/<folder>/ + ZIP.
 * @param {object} target - TARGETS entry
 * @param {string} targetKey
 * @param {{ skipClient?: boolean, quietFooter?: boolean }} opts
 */
function buildZipRelease(target, targetKey, opts = {}) {
  const skipClient = !!opts.skipClient;
  const DIST = path.join(DIST_ROOT, target.folder);

  console.log();
  console.log('  ============================================');
  console.log('   ⚔️  AS Adventurer — Release Builder');
  console.log('  ============================================');
  console.log();
  log(`Target: ${target.label || targetKey} (${target.pkg})`);
  log(`Output: dist/${target.folder}/`);

  if (!opts.clientAlreadyBuilt) {
    ensureClientBuilt(skipClient);
  }

  const uiRoot = findUiRoot();
  if (!uiRoot) {
    console.error(
      '\n  ❌ No UI found. Build the Angular client first:\n' +
        '     npm run build --prefix client\n' +
        '     (legacy/public is reference-only and is not packaged)\n'
    );
    process.exit(1);
  }
  log(`UI: ${path.relative(ROOT, uiRoot)}`);

  ensurePkg();

  if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  const outBinary = path.join(DIST, target.binary);
  const ICON = path.join(ROOT, 'icon.ico');
  log(`Compiling ${target.binary}…`);

  const pkgArgs = [
    'npx',
    '--yes',
    'pkg',
    path.join(ROOT, 'server.js'),
    '--targets',
    target.pkg,
    '--output',
    outBinary,
    '--compress',
    'GZip',
  ];
  if (target.ffmpegPlatform === 'win32' && fs.existsSync(ICON)) {
    pkgArgs.push('--icon', ICON);
  }

  try {
    runPkg(pkgArgs, target);
  } catch (e) {
    console.error('\n  ❌ pkg failed. Run: npm install\n');
    if (e && e.message) console.error('  ', e.message);
    process.exit(1);
  }

  try {
    fs.chmodSync(outBinary, 0o755);
  } catch {
    /* win */
  }

  // 3. UI → www/
  log('Copying UI → www/…');
  copyDirSync(uiRoot, path.join(DIST, 'www'));

  // 4. ffmpeg
  log('Bundling ffmpeg…');
  try {
    bundleFfmpeg(path.join(DIST, 'bin'), target);
  } catch (e) {
    console.error('  ❌ ffmpeg bundle failed:', e.message);
    process.exit(1);
  }

  // 5. Launchers
  if (target.ffmpegPlatform === 'win32') {
    writeWinLauncher(DIST, target.binary);
    if (fs.existsSync(ICON)) fs.copyFileSync(ICON, path.join(DIST, 'icon.ico'));
  } else {
    writeUnixLaunchers(DIST, target.binary);
  }
  writeEndUserReadme(DIST, target);

  // 6. ZIP
  const zipPath = path.join(DIST_ROOT, target.zipName);
  log(`Zipping → ${target.zipName}…`);
  try {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "Compress-Archive -Path '${DIST}' -DestinationPath '${zipPath}' -Force"`,
        { stdio: 'pipe' }
      );
    } else {
      try {
        execSync(`cd "${DIST_ROOT}" && zip -r -q "${target.zipName}" "${target.folder}"`, {
          stdio: 'pipe',
        });
      } catch {
        const archiveBase = zipPath.replace(/\.zip$/i, '');
        const pyFile = path.join(DIST_ROOT, '.make_zip.py');
        fs.writeFileSync(
          pyFile,
          `import shutil\nshutil.make_archive(${JSON.stringify(archiveBase)}, "zip", ${JSON.stringify(DIST_ROOT)}, ${JSON.stringify(target.folder)})\n`
        );
        try {
          execSync(`python3 "${pyFile}"`, { stdio: 'pipe' });
        } finally {
          try {
            fs.unlinkSync(pyFile);
          } catch {
            /* ignore */
          }
        }
      }
    }
    if (fs.existsSync(zipPath)) {
      log(`ZIP ${(fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1)} MB`);
    }
  } catch (e) {
    log('ZIP skipped: ' + e.message);
  }

  console.log();
  log('✅ Release ready (no Node/npm required for end users)');
  console.log();
  log(`Folder: ${DIST}`);
  log(`  ${target.binary}`);
  log(`  bin/${target.ffmpegName}`);
  log('  www/');
  log(
    target.ffmpegPlatform === 'win32'
      ? '  Start AS Adventurer.bat'
      : '  First Run Setup.* / Start AS Adventurer.*'
  );
  log('  README.txt');
  console.log();

  if (!opts.quietFooter) {
    log('Other targets:');
    log('  npm run build:windows       / build:windows:arm64');
    log('  npm run build:mac           / build:mac:arm64   (Apple Silicon)');
    log('  npm run build:linux         / build:linux:arm64');
    log('  npm run build:linux:flatpak / build:linux:flatpak:arm64');
    log('  npm run build:all           / build:all:flatpak');
    log(
      '  node build-exe.js --target win-x64|win-arm64|mac-x64|mac-arm64|linux-x64|linux-arm64|linux-flatpak|linux-flatpak-arm64|all|all-flatpak'
    );
    console.log();
  }
}

/**
 * Build every OS/arch ZIP (and optionally both Flatpaks).
 * Client SPA is built once; subsequent targets reuse it.
 */
function buildAllReleases(skipClient, withFlatpaks) {
  console.log();
  console.log('  ============================================');
  console.log('   ⚔️  AS Adventurer — Build ALL Releases');
  console.log('  ============================================');
  console.log();
  log(
    `ZIP targets: ${ALL_ZIP_KEYS.join(', ')}` +
      (withFlatpaks ? ` + Flatpaks: ${ALL_FLATPAK_KEYS.join(', ')}` : ' (Flatpaks skipped — use all-flatpak)')
  );

  ensureClientBuilt(skipClient);
  const uiRoot = findUiRoot();
  if (!uiRoot) {
    console.error(
      '\n  ❌ No UI found. Build the Angular client first:\n' +
        '     npm run build --prefix client\n' +
        '     (legacy/public is reference-only and is not packaged)\n'
    );
    process.exit(1);
  }

  for (const key of ALL_ZIP_KEYS) {
    buildZipRelease(TARGETS[key], key, {
      skipClient: true,
      clientAlreadyBuilt: true,
      quietFooter: true,
    });
  }

  const flatpakResults = {};
  if (withFlatpaks) {
    for (const key of ALL_FLATPAK_KEYS) {
      // Linux zip already built above; only package Flatpak.
      // softFail: non-native arch (e.g. aarch64 Flatpak on x86_64 WSL) is skipped,
      // not a hard failure of the whole build-all run.
      flatpakResults[key] = buildFlatpakBundle(FLATPAK_TARGETS[key], true, true, {
        softFail: true,
      });
    }
  }

  console.log();
  log('✅ Build-all complete');
  log('  ZIPs under dist/:');
  for (const key of ALL_ZIP_KEYS) {
    const z = path.join(DIST_ROOT, TARGETS[key].zipName);
    if (fs.existsSync(z)) {
      log(`    ${TARGETS[key].zipName}  (${(fs.statSync(z).size / (1024 * 1024)).toFixed(1)} MB)`);
    } else {
      log(`    ${TARGETS[key].zipName}  (missing)`);
    }
  }
  if (withFlatpaks) {
    log('  Flatpaks:');
    for (const key of ALL_FLATPAK_KEYS) {
      const b = path.join(DIST_ROOT, FLATPAK_TARGETS[key].bundleName);
      const r = flatpakResults[key] || {};
      if (fs.existsSync(b) && r.ok) {
        log(
          `    ${FLATPAK_TARGETS[key].bundleName}  (${(fs.statSync(b).size / (1024 * 1024)).toFixed(1)} MB)`
        );
      } else if (r.skipped) {
        log(`    ${FLATPAK_TARGETS[key].bundleName}  (skipped — ${r.reason || 'host arch'})`);
      } else {
        log(
          `    ${FLATPAK_TARGETS[key].bundleName}  (not built${r.reason ? ' — ' + r.reason : ''})`
        );
      }
    }
  }
  console.log();
}

// ── Main ─────────────────────────────────────────
const { target, targetKey, skipClient, flatpakOnly, flatpak, buildAll, withFlatpaks } = parseArgs();

if (buildAll) {
  buildAllReleases(skipClient, withFlatpaks);
  process.exit(0);
}

if (flatpak) {
  buildFlatpakBundle(flatpak, skipClient, flatpakOnly);
  process.exit(0);
}

buildZipRelease(target, targetKey, { skipClient });
