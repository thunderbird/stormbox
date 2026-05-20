import fs from 'node:fs';

/** Shared env for Playwright e2e against the local thunderbird-accounts stack. */

function stackHost() {
  if (process.env.STACK_HOST) return process.env.STACK_HOST;
  const inDocker = process.env.STORMBOX_IN_DOCKER === '1' || fs.existsSync('/.dockerenv');
  return inDocker ? '172.17.0.1' : '127.0.0.1';
}

const host = stackHost();

export const localStackEnabled =
  process.env.LOCAL_STACK === '1' || process.env.LOCAL_STACK === 'true';

export const skipLocalStackMessage =
  'LOCAL_STACK not set; live local-stack e2e skipped (see README test:e2e:local)';

export const JMAP_BASE_URL =
  process.env.JMAP_BASE_URL ?? `http://${host}:8081`;

export const OIDC_ISSUER =
  process.env.OIDC_ISSUER ?? `http://${host}:8999/realms/tbpro`;

export const OIDC_CLIENT_ID =
  process.env.OIDC_CLIENT_ID ?? 'thunderbird-stormbox-test';

export const TEST_OIDC_EMAIL =
  process.env.TEST_OIDC_EMAIL ?? 'admin@example.org';

export const TEST_OIDC_PASSWORD =
  process.env.TEST_OIDC_PASSWORD ?? 'admin';

/** Provisioned primary Thundermail / JMAP From address for fixtures and JMAP helpers. */
export const TEST_THUNDERMAIL =
  process.env.TEST_THUNDERMAIL ?? TEST_OIDC_EMAIL;

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

export const TEST_SMTP_PASSWORD =
  process.env.TEST_SMTP_PASSWORD ?? TEST_OIDC_PASSWORD;

/** Primary RFC-822 address for JMAP create/send in tests. */
export function selfEmail() {
  return TEST_THUNDERMAIL;
}

