import { STATUS_PATH } from '../../fixtures/ws-proxy/inject.mjs';
import { JMAP_BASE_URL, OIDC_ISSUER, WS_PROXY_URL } from './stack-env.js';

/**
 * Health probes a live lane runs before its first test, shared by the
 * Playwright and Vitest global setups. Probes only read; setup must not
 * rewrite Keycloak or Stalwart.
 */

const PROBE_TIMEOUT_MS = 5_000;

async function checkUrl(label, url, { okStatuses = [200] } = {}) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'follow',
    });
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

async function probeWsProxy(url) {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(
      `WS proxy unreachable at ${url}: ${err?.message ?? err} — run: npm run stack:ws-proxy`,
    );
  }
}

/** Keycloak and Stalwart answer on their well-known endpoints. */
export async function requireCoreStack() {
  await checkUrl(
    'Keycloak',
    `${OIDC_ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`,
  );
  await checkUrl(
    'Stalwart JMAP',
    `${JMAP_BASE_URL.replace(/\/$/, '')}/.well-known/jmap`,
    { okStatuses: [200, 401] },
  );
}

/** The WS proxy is listening and built from this tree. */
export async function requireWsProxy() {
  const wsRes = await probeWsProxy(`${WS_PROXY_URL}/jmap/ws`);
  if (wsRes.status !== 426) {
    throw new Error(
      `WS proxy at ${WS_PROXY_URL} returned ${wsRes.status}, expected 426 — run: npm run stack:ws-proxy`,
    );
  }
  // The proxy outlives any one run, so a long-lived one can predate the
  // code in the tree. That matters more than it sounds: the fault
  // injection specs depend on it, and an old proxy does not fail them — it
  // forwards everything untouched, so the send under test succeeds and the
  // case reports the client's correct behaviour as a defect.
  const statusRes = await probeWsProxy(`${WS_PROXY_URL}${STATUS_PATH}`);
  if (!statusRes.ok) {
    throw new Error(
      `WS proxy at ${WS_PROXY_URL} does not serve ${STATUS_PATH}, so it is running older `
      + 'code than this tree. Restart it: npm run stack:ws-proxy',
    );
  }
}

/**
 * Every probe a lane needs before it starts. Only lanes whose client
 * reaches Stalwart through the fault-injecting proxy set `wsProxy`; the
 * integration suites use HTTP directly and must not fail on its absence.
 */
export async function requireStack({ wsProxy }) {
  await requireCoreStack();
  if (wsProxy) await requireWsProxy();
}
