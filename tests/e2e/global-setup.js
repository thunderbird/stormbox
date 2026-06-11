import { configureKeycloak } from '../fixtures/configure-keycloak.mjs';
import { configureStalwart } from '../fixtures/configure-stalwart.mjs';
import {
  JMAP_BASE_URL,
  OIDC_ISSUER,
  PLAYWRIGHT_BASE_URL,
  localStackEnabled,
  remoteE2eEnabled,
} from './helpers/stack-env.js';

const WS_PROXY = process.env.WS_PROXY_URL ?? 'http://127.0.0.1:8787';

async function checkUrl(label, url, {
  okStatuses = [200],
  failureHint = '',
} = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'follow' });
    if (!okStatuses.includes(res.status)) {
      throw new Error(`${label} returned ${res.status}`);
    }
  } catch (err) {
    throw new Error(
      `${label} unreachable at ${url}: ${err?.message ?? err}\n`
      + failureHint,
    );
  }
}

export default async function globalSetup() {
  if (remoteE2eEnabled) {
    await checkUrl(
      'Stormbox app',
      PLAYWRIGHT_BASE_URL,
      { failureHint: 'Check PLAYWRIGHT_BASE_URL for the remote public app.\n' },
    );
    await checkUrl(
      'OIDC issuer',
      `${OIDC_ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`,
      { failureHint: 'Check OIDC_ISSUER for the remote auth realm.\n' },
    );
    await checkUrl(
      'JMAP',
      `${JMAP_BASE_URL.replace(/\/$/, '')}/.well-known/jmap`,
      {
        okStatuses: [200, 401],
        failureHint: 'Check JMAP_BASE_URL for the remote JMAP endpoint.\n',
      },
    );
    return;
  }

  if (localStackEnabled) {
    await configureKeycloak();
    await configureStalwart();
  }
  await checkUrl(
    'Keycloak',
    `${OIDC_ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`,
    {
      failureHint:
        'Start the stack: cd thunderbird-accounts && docker compose up --build\n'
        + 'Start WS proxy: node tests/fixtures/ws-proxy/server.mjs\n',
    },
  );
  await checkUrl(
    'Stalwart JMAP',
    `${JMAP_BASE_URL.replace(/\/$/, '')}/.well-known/jmap`,
    {
      okStatuses: [200, 401],
      failureHint:
        'Start the stack: cd thunderbird-accounts && docker compose up --build\n'
        + 'Start WS proxy: node tests/fixtures/ws-proxy/server.mjs\n',
    },
  );
  const wsRes = await fetch(`${WS_PROXY}/jmap/ws`, { signal: AbortSignal.timeout(5_000) });
  if (wsRes.status !== 426) {
    throw new Error(
      `WS proxy at ${WS_PROXY} returned ${wsRes.status}, expected 426 — run: npm run stack:ws-proxy`,
    );
  }
}
