import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VITE_ENTRY = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const WS_PROXY_ENTRY = fileURLToPath(
  new URL('../tests/fixtures/ws-proxy/server.mjs', import.meta.url),
);
const WS_PROXY_STATUS_URL =
  process.env.WS_PROXY_STATUS_URL ?? 'http://127.0.0.1:8787/__status';
const LOCAL_STACK =
  process.env.VITE_LOCAL_STACK === '1' || process.env.VITE_LOCAL_STACK === 'true';

let viteProcess = null;
let ownedProxyProcess = null;
let healthTimer = null;
let shuttingDown = false;
let proxyFailed = false;

async function wsProxyIsHealthy() {
  try {
    const response = await fetch(WS_PROXY_STATUS_URL, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const status = await response.json();
    return Number.isInteger(status.liveSockets) && Array.isArray(status.modes);
  } catch {
    return false;
  }
}

async function ensureWsProxy() {
  if (await wsProxyIsHealthy()) {
    console.log(`[dev] reusing JMAP WebSocket proxy at ${WS_PROXY_STATUS_URL}`);
    return null;
  }

  const child = spawn(process.execPath, [WS_PROXY_ENTRY], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode != null) {
      throw new Error(`JMAP WebSocket proxy exited with code ${child.exitCode}`);
    }
    if (await wsProxyIsHealthy()) {
      console.log(`[dev] JMAP WebSocket proxy ready at ${WS_PROXY_STATUS_URL}`);
      return child;
    }
    await sleep(100);
  }

  child.kill('SIGTERM');
  throw new Error(`JMAP WebSocket proxy did not become ready at ${WS_PROXY_STATUS_URL}`);
}

function stopChild(child, signal) {
  if (child && child.exitCode == null && !child.killed) child.kill(signal);
}

function stop(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopChild(viteProcess, signal);
  stopChild(ownedProxyProcess, signal);
}

async function main() {
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  try {
    if (LOCAL_STACK) ownedProxyProcess = await ensureWsProxy();

    viteProcess = spawn(process.execPath, [VITE_ENTRY, ...process.argv.slice(2)], {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    });

    if (LOCAL_STACK) {
      let consecutiveMisses = 0;
      let checking = false;
      healthTimer = setInterval(async () => {
        if (checking || shuttingDown) return;
        checking = true;
        const healthy = await wsProxyIsHealthy();
        checking = false;
        consecutiveMisses = healthy ? 0 : consecutiveMisses + 1;
        if (consecutiveMisses < 3) return;
        proxyFailed = true;
        console.error('[dev] JMAP WebSocket proxy became unavailable; stopping Vite.');
        stop('SIGTERM');
      }, 2_000);
    }

    const { code, signal } = await new Promise((resolve) => {
      viteProcess.once('exit', (exitCode, exitSignal) => {
        resolve({ code: exitCode, signal: exitSignal });
      });
    });
    if (proxyFailed) process.exitCode = 1;
    else if (typeof code === 'number') process.exitCode = code;
    else process.exitCode = signal ? 0 : 1;
  } catch (error) {
    console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    shuttingDown = true;
    if (healthTimer) clearInterval(healthTimer);
    stopChild(viteProcess, 'SIGTERM');
    stopChild(ownedProxyProcess, 'SIGTERM');
  }
}

await main();
