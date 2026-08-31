import {
  JMAP_BASE_URL,
  OIDC_ISSUER,
  localStackEnabled,
} from '../e2e/helpers/stack-env';
import {
  acquireLaneLock,
  releaseLaneLock,
} from '../e2e/helpers/lane-lock';

async function requireUrl(label, url, statuses) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(5_000),
  });
  if (!statuses.includes(response.status)) {
    throw new Error(`${label} at ${url} returned ${response.status}`);
  }
}

export async function setup() {
  if (!localStackEnabled) {
    throw new Error('Live integration tests require LOCAL_STACK=1');
  }
  await acquireLaneLock();
  try {
    await requireUrl(
      'Keycloak',
      `${OIDC_ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`,
      [200],
    );
    await requireUrl(
      'Stalwart JMAP',
      `${JMAP_BASE_URL.replace(/\/$/, '')}/.well-known/jmap`,
      [200, 401],
    );
  } catch (error) {
    releaseLaneLock();
    throw error;
  }
}

export function teardown() {
  releaseLaneLock();
}
