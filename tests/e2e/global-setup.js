import fs from 'node:fs';

import { STATUS_PATH } from '../fixtures/ws-proxy/inject.mjs';
import { acquireLaneLock, releaseLaneLock } from './helpers/lane-lock.js';

function stackHost() {
  if (process.env.STACK_HOST) return process.env.STACK_HOST;
  const inDocker = process.env.STORMBOX_IN_DOCKER === '1' || fs.existsSync('/.dockerenv');
  return inDocker ? '172.17.0.1' : '127.0.0.1';
}

const host = stackHost();
const JMAP_BASE = process.env.JMAP_BASE_URL ?? `http://${host}:8081`;
const OIDC_ISSUER = process.env.OIDC_ISSUER ?? `http://${host}:8999/realms/tbpro`;
const WS_PROXY = process.env.WS_PROXY_URL ?? 'http://127.0.0.1:8787';

async function checkUrl(label, url, { okStatuses = [200] } = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'follow' });
    if (!okStatuses.includes(res.status)) {
      throw new Error(`${label} returned ${res.status}`);
    }
  } catch (err) {
    throw new Error(
      `${label} unreachable at ${url}: ${err?.message ?? err}\n`
      + 'Start the stack: cd thunderbird-accounts && docker compose up --build\n'
      + 'Provision accounts: npm run stack:configure\n'
      + 'Start WS proxy: node tests/fixtures/ws-proxy/server.mjs',
    );
  }
}

export default async function globalSetup() {
  // Taken before this lane starts. The lock is only for the shared
  // mailbox; setup must not rewrite Keycloak or Stalwart.
  await acquireLaneLock();
  try {
    await prepareStack();
  } catch (err) {
    // A setup that throws gets no teardown, and a lock left behind would
    // lock out every later run.
    releaseLaneLock();
    throw err;
  }
}

async function prepareStack() {
  await checkUrl(
    'Keycloak',
    `${OIDC_ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`,
  );
  await checkUrl(
    'Stalwart JMAP',
    `${JMAP_BASE.replace(/\/$/, '')}/.well-known/jmap`,
    { okStatuses: [200, 401] },
  );
  const wsRes = await fetch(`${WS_PROXY}/jmap/ws`, { signal: AbortSignal.timeout(5_000) });
  if (wsRes.status !== 426) {
    throw new Error(
      `WS proxy at ${WS_PROXY} returned ${wsRes.status}, expected 426 — run: npm run stack:ws-proxy`,
    );
  }
  // The proxy outlives any one run, so a long-lived one can predate the
  // code in the tree. That matters more than it sounds: the fault
  // injection specs depend on it, and an old proxy does not fail them — it
  // forwards everything untouched, so the send under test succeeds and the
  // case reports the client's correct behaviour as a defect.
  const statusRes = await fetch(`${WS_PROXY}${STATUS_PATH}`, { signal: AbortSignal.timeout(5_000) });
  if (!statusRes.ok) {
    throw new Error(
      `WS proxy at ${WS_PROXY} does not serve ${STATUS_PATH}, so it is running older `
      + 'code than this tree. Restart it: npm run stack:ws-proxy',
    );
  }
}
