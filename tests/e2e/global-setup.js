import { acquireLaneLock, releaseLaneLock } from './helpers/lane-lock.js';
import { requireStack } from './helpers/stack-health.js';

export default async function globalSetup() {
  // Taken before this lane starts. The lock is only for the shared
  // mailbox; setup must not rewrite Keycloak or Stalwart.
  await acquireLaneLock();
  try {
    await requireStack({ wsProxy: true });
  } catch (err) {
    // A setup that throws gets no teardown, and a lock left behind would
    // lock out every later run.
    releaseLaneLock();
    throw err;
  }
}
