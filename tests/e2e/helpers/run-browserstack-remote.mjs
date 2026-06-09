/**
 * When running in REMOTE_E2E mode, our Playwright config loads env vars from
 * tests/e2e/.env.remote; but browserstack-node-sdk starts before Playwright config runs.
 * BrowserStack needs BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY exported into the
 * shell environment before npx browserstack-node-sdk ... starts.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

import { loadE2eEnvFile } from './env-file.js';

process.env.REMOTE_E2E = process.env.REMOTE_E2E ?? '1';
loadE2eEnvFile({ remote: true });

const requiredEnv = ['BROWSERSTACK_USERNAME', 'BROWSERSTACK_ACCESS_KEY'];
const missing = requiredEnv.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(
    `BrowserStack remote e2e requires ${missing.join(', ')} in tests/e2e/.env.remote or the shell environment.`,
  );
  process.exit(1);
}

const bin = path.resolve(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'browserstack-node-sdk.cmd' : 'browserstack-node-sdk',
);
const args = ['playwright', 'test', ...process.argv.slice(2)];

const child = spawn(bin, args, {
  env: process.env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
