import fs from 'node:fs';

import { loadE2eEnvFile } from './env-file.js';

/** Shared env for Playwright live e2e against local or remote mail stacks. */

function stackHost() {
  if (process.env.STACK_HOST) return process.env.STACK_HOST;
  const inDocker = process.env.STORMBOX_IN_DOCKER === '1' || fs.existsSync('/.dockerenv');
  return inDocker ? '172.17.0.1' : '127.0.0.1';
}

const host = stackHost();

function envFlag(name) {
  return process.env[name] === '1' || process.env[name] === 'true';
}

loadE2eEnvFile({ remote: envFlag('REMOTE_E2E') });

export const localStackEnabled =
  envFlag('LOCAL_STACK');

export const remoteE2eEnabled =
  envFlag('REMOTE_E2E');

export const liveE2eEnabled =
  localStackEnabled || remoteE2eEnabled;

export const skipLiveE2eMessage =
  'LOCAL_STACK or REMOTE_E2E not set; live e2e skipped (see README E2E docs)';

function requiredRemoteEnv(name) {
  const value = process.env[name];
  if (remoteE2eEnabled && !value) {
    throw new Error(`REMOTE_E2E requires ${name} to be set`);
  }
  return value;
}

export const PLAYWRIGHT_BASE_URL =
  remoteE2eEnabled
    ? requiredRemoteEnv('PLAYWRIGHT_BASE_URL')
    : process.env.PLAYWRIGHT_BASE_URL;

export const JMAP_BASE_URL =
  remoteE2eEnabled
    ? requiredRemoteEnv('JMAP_BASE_URL')
    : process.env.JMAP_BASE_URL ?? `http://${host}:8081`;

export const OIDC_ISSUER =
  remoteE2eEnabled
    ? requiredRemoteEnv('OIDC_ISSUER')
    : process.env.OIDC_ISSUER ?? `http://${host}:8999/realms/tbpro`;

export const OIDC_CLIENT_ID =
  remoteE2eEnabled
    ? requiredRemoteEnv('OIDC_CLIENT_ID')
    : process.env.OIDC_CLIENT_ID ?? 'thunderbird-stormbox-test';

// Live e2e tests run against a dedicated account so developer
// (`admin@example.org`) or user mailboxes do not get polluted with
// seed mail, sweep deletions, or stray test artifacts. Local-stack
// runs provision that account idempotently; remote runs require the
// account to already exist and reuse it across suite runs.
//
// For local-stack runs:
// `tests/fixtures/configure-keycloak.mjs` and
// `tests/fixtures/configure-stalwart.mjs` create this account
// idempotently on first run (and on every re-run, in case the
// stack was wiped). The account is provisioned through the same
// HTTP APIs the accounts service would use (Keycloak admin API +
// Stalwart management API), without touching the
// thunderbird-accounts submodule.

export const TEST_OIDC_EMAIL =
  remoteE2eEnabled
    ? requiredRemoteEnv('TEST_OIDC_EMAIL')
    : process.env.TEST_OIDC_EMAIL ?? 'e2e@example.org';

export const TEST_OIDC_PASSWORD =
  remoteE2eEnabled
    ? requiredRemoteEnv('TEST_OIDC_PASSWORD')
    : process.env.TEST_OIDC_PASSWORD ?? 'e2e';

/** Provisioned primary Thundermail / JMAP From address for fixtures and JMAP helpers. */
export const TEST_THUNDERMAIL =
  remoteE2eEnabled
    ? requiredRemoteEnv('TEST_THUNDERMAIL')
    : process.env.TEST_THUNDERMAIL ?? TEST_OIDC_EMAIL;

function stackHostForStalwartApi() {
  if (process.env.STACK_HOST) return process.env.STACK_HOST;
  const inDocker = process.env.STORMBOX_IN_DOCKER === '1' || fs.existsSync('/.dockerenv');
  return inDocker ? '172.17.0.1' : '127.0.0.1';
}

const stalwartHost = stackHostForStalwartApi();

export const STACK_STALWART_API_URL =
  process.env.STALWART_BASE_API_URL ?? `http://${stalwartHost}:8080`;

export const STACK_STALWART_PRINCIPAL =
  process.env.STACK_STALWART_PRINCIPAL ?? TEST_OIDC_EMAIL;

/** Default Stalwart management API credentials (admin:accounts). */
export const STACK_STALWART_API_AUTH =
  process.env.STALWART_API_AUTH
  ?? `Basic ${Buffer.from('admin:accounts').toString('base64')}`;

export const SMTP_HOST = process.env.SMTP_HOST ?? host;

export const SMTP_TLS_PORT = Number(process.env.SMTP_TLS_PORT ?? 465);

// Pinned literally to `admin` because that's what the argon2id
// hash baked into configure-stalwart.mjs is over. The OIDC
// password and the SMTP app password are intentionally
// different: OIDC auth flows through Keycloak (TEST_OIDC_PASSWORD),
// SMTP auth uses Stalwart's per-principal app-password list.
export const TEST_SMTP_PASSWORD =
  process.env.TEST_SMTP_PASSWORD ?? 'admin';

/** Primary RFC-822 address for JMAP create/send in tests. */
export function selfEmail() {
  return TEST_THUNDERMAIL;
}
