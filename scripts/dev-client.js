#!/usr/bin/env node
/**
 * Angular dev stack: ensure ffmpeg, start API (export / proxy backends), then ng serve.
 *
 *   UI  → http://127.0.0.1:3001  (ng serve)
 *   API → http://127.0.0.1:3002  (server.js; proxied as /api from the UI)
 *
 * Usage (from repo root or client/):
 *   node scripts/dev-client.js
 *   npm start --prefix client
 */
'use strict';

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const CLIENT = path.join(ROOT, 'client');
const UI_HOST = process.env.DEV_UI_HOST || '127.0.0.1';
const UI_PORT = process.env.DEV_UI_PORT || '3001';
const API_PORT = process.env.DEV_API_PORT || process.env.PORT || '3002';

const children = [];
let shuttingDown = false;

function log(msg) {
  console.log(`  ${msg}`);
}

function runEnsureFfmpeg() {
  const script = path.join(ROOT, 'scripts', 'ensure-ffmpeg.js');
  log('Ensuring ffmpeg is available (transparent WebM export)…');
  try {
    execFileSync(process.execPath, [script, '--quiet'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
  } catch (err) {
    console.error('  [WARN] ffmpeg could not be installed automatically.');
    console.error('  Transparent WebM export may be unavailable. Re-run: npm run ensure-ffmpeg');
  }
}

/**
 * Free a TCP port so a leftover server.js / ng serve from a previous run
 * does not cause EADDRINUSE and take down the whole dev stack.
 */
function freePort(port) {
  try {
    if (process.platform === 'win32') {
      // Best-effort: find PIDs listening on the port and taskkill them
      const out = execFileSync(
        'cmd.exe',
        ['/c', `netstat -ano | findstr :${port}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
      }
      for (const pid of pids) {
        try {
          execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
          log(`Freed port ${port} (killed PID ${pid})`);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    // Linux / macOS
    try {
      execFileSync('fuser', ['-k', `${port}/tcp`], {
        stdio: 'ignore',
        timeout: 3000,
      });
      log(`Freed port ${port} (if it was in use)`);
    } catch {
      // fuser exits non-zero when nothing is using the port — fine
    }
  } catch {
    /* ignore — bind will still report a clear error if port stays busy */
  }
}

function spawnChild(label, command, args, opts) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: opts.env || process.env,
    cwd: opts.cwd,
    shell: opts.shell || false,
  });
  child.label = label;
  children.push(child);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`  [ERROR] ${label} exited (${reason})`);
    shutdown(code && code !== 0 ? code : 1);
  });
  child.on('error', (err) => {
    console.error(`  [ERROR] Failed to start ${label}: ${err.message}`);
    shutdown(1);
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed && child.exitCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  }
  // Force-kill stragglers shortly after
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed && child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
    process.exit(code);
  }, 1500).unref?.();
}

function main() {
  if (!fs.existsSync(path.join(CLIENT, 'package.json'))) {
    console.error('  [ERROR] client/package.json not found. Run from the AS Adventurer repo.');
    process.exit(1);
  }

  runEnsureFfmpeg();

  // Clear stale listeners from prior crashed / orphaned dev sessions
  freePort(API_PORT);
  freePort(UI_PORT);

  log(`API server on port ${API_PORT} (SKIP_BROWSER)…`);
  spawnChild('API server', process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      SKIP_BROWSER: '1',
    },
  });

  log(`Angular dev server at http://${UI_HOST}:${UI_PORT}/ …`);
  // Prefer local ng binary so we don't depend on a global install
  const ngJs = path.join(CLIENT, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');
  const ngCmd = fs.existsSync(ngJs)
    ? process.execPath
    : process.platform === 'win32'
      ? 'npx.cmd'
      : 'npx';
  const ngArgs = fs.existsSync(ngJs)
    ? [ngJs, 'serve', '--host', UI_HOST, '--port', String(UI_PORT)]
    : ['ng', 'serve', '--host', UI_HOST, '--port', String(UI_PORT)];

  spawnChild('ng serve', ngCmd, ngArgs, {
    cwd: CLIENT,
    env: process.env,
    shell: !fs.existsSync(ngJs) && process.platform === 'win32',
  });

  const stop = () => shutdown(0);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
