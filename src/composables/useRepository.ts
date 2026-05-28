/**
 * Repository singleton accessor. The Repository wraps a MessagePort to
 * the SharedWorker; we only ever want one instance per tab.
 *
 * Vite captures the worker entry via `new URL(...)` at build time so the
 * SharedWorker file is bundled correctly under both dev and prod.
 */

import DbSharedWorker from '../db/shared-worker.ts?sharedworker';
import { SHARED_WORKER_NAME } from '../db/protocol.js';
import { createRepository } from '../db/repository.js';

let repoPromise = null;

export function getRepositoryAsync() {
  if (!repoPromise) {
    repoPromise = (async () => {
      const repo = await createRepository({
        worker: new DbSharedWorker({ name: SHARED_WORKER_NAME }),
      });
      // Expose on window in dev/test builds so Playwright (and you in
      // devtools) can poke at the repository directly. No-op in
      // production builds because import.meta.env.DEV is false.
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-undef
        globalThis.__repo = repo;
      }
      return repo;
    })();
  }
  return repoPromise;
}

/**
 * Test seam: lets unit tests inject a fake Repository instance without
 * spinning up a real SharedWorker.
 */
export function __setRepositoryForTests(fake) {
  repoPromise = Promise.resolve(fake);
}

export function __resetRepositoryForTests() {
  repoPromise = null;
}
