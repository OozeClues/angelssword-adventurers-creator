#!/usr/bin/env node
/**
 * Build script: Compiles AS Adventurer into a standalone EXE.
 * 
 * Usage: node build-exe.js
 * Or just double-click: build-exe.bat
 * 
 * Output goes to: dist/ASAdventurer/
 *   ├── ASAdventurer.exe
 *   ├── public/          (UI files: sprite-prep, video-prep, model-exporter)
 *   └── Start AS Adventurer.bat
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist', 'ASAdventurer');
const PUBLIC_SRC = path.join(ROOT, 'public');
const PUBLIC_DEST = path.join(DIST, 'public');

// ── Helpers ──────────────────────────────────────
function log(msg) { console.log(`  ${msg}`); }

function copyDirSync(src, dest, exclude = []) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (exclude.includes(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath, []);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── Main ─────────────────────────────────────────
console.log();
console.log('  ============================================');
console.log('   ⚔️  AS Adventurer — EXE Builder');
console.log('  ============================================');
console.log();

// 1. Check for pkg
log('Checking for pkg...');
try {
  execSync('npx --yes pkg --version', { stdio: 'pipe' });
} catch (e) {
  log('Installing pkg globally...');
  execSync('npm install -g pkg', { stdio: 'inherit' });
}

// 2. Clean dist
log('Cleaning dist folder...');
if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true, force: true });
}
fs.mkdirSync(DIST, { recursive: true });

// 3. Compile EXE with pkg
log('Compiling server.js → ASAdventurer.exe ...');
const ICON = path.join(ROOT, 'icon.ico');
const pkgCmd = [
  'npx --yes pkg',
  `"${path.join(ROOT, 'server.js')}"`,
  '--targets node18-win-x64',
  '--output', `"${path.join(DIST, 'ASAdventurer.exe')}"`,
  '--compress GZip',
  fs.existsSync(ICON) ? `--icon "${ICON}"` : ''
].filter(Boolean).join(' ');

try {
  execSync(pkgCmd, { stdio: 'inherit', cwd: ROOT });
} catch (e) {
  console.error('\n  ❌ pkg compilation failed! Make sure you have run: npm install');
  process.exit(1);
}

// 4. Copy public/ folder
log('Copying public/ files...');
copyDirSync(PUBLIC_SRC, PUBLIC_DEST, []);




// 6. Create a launcher bat
fs.writeFileSync(path.join(DIST, 'Start AS Adventurer.bat'),
`@echo off
echo.
echo  ============================================
echo   AS Adventurer - Starting...
echo  ============================================
echo.
echo  Open your browser to: http://localhost:3001
echo.
cd /d "%~dp0"
start http://localhost:3001
ASAdventurer.exe
pause
`);

// 7. Copy icon alongside exe for reference
if (fs.existsSync(ICON)) {
  fs.copyFileSync(ICON, path.join(DIST, 'icon.ico'));
}

// 8. Copy README
const README = path.join(ROOT, 'README.md');
if (fs.existsSync(README)) {
  fs.copyFileSync(README, path.join(DIST, 'README.md'));
  log('Included README.md');
}

// 9. Create distributable ZIP
const ZIP_PATH = path.join(ROOT, 'dist', 'ASAdventurer.zip');
log('Creating distributable ZIP...');
try {
  if (fs.existsSync(ZIP_PATH)) fs.unlinkSync(ZIP_PATH);
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${DIST}' -DestinationPath '${ZIP_PATH}' -Force"`, { stdio: 'pipe' });
  const zipSize = (fs.statSync(ZIP_PATH).size / (1024 * 1024)).toFixed(1);
  log(`Created ASAdventurer.zip (${zipSize} MB)`);
} catch (e) {
  log('⚠️  ZIP creation failed — you can zip manually');
  console.error(e.message);
}

// 10. Summary
console.log();
log('✅ Build complete!');
console.log();
log(`Output: ${DIST}`);
log(`   ZIP: ${ZIP_PATH}`);
log('');
log('Contents:');
log('  ASAdventurer.exe             — Double-click to run');
log('  Start AS Adventurer.bat      — Launcher (opens browser automatically)');
log('  README.md                    — Documentation');
log('  public/                      — UI files');
console.log();
log('Send ASAdventurer.zip to distribute!');
console.log();
