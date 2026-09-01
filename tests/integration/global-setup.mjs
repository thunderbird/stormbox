import { localStackEnabled } from '../e2e/helpers/stack-env';
import {
  acquireLaneLock,
  releaseLaneLock,
} from '../e2e/helpers/lane-lock';
import { requireStack } from '../e2e/helpers/stack-health';

export async function setup() {
  if (!localStackEnabled) {
    throw new Error('Live integration tests require LOCAL_STACK=1');
  }
  await acquireLaneLock();
  try {
    await requireStack({ wsProxy: false });
  } catch (error) {
    // A setup that throws gets no teardown, and a lock left behind would
    // lock out every later run.
    releaseLaneLock();
    throw error;
  }
}

export function teardown() {
  releaseLaneLock();
}
