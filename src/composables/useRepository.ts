/**
 * Repository singleton accessor. The Repository wraps a MessagePort to
 * the SharedWorker; we only ever want one instance per tab.
 *
 * Vite captures the worker entry via `new URL(...)` at build time so the
 * SharedWorker file is bundled correctly under both dev and prod.
 */

import workerUrl from '../db/shared-worker.ts?sharedworker&url';
import { assertSupportedBrowser } from '../db/availability';
import { connectRepository } from '../db/repository';

let repoPromise = null;

export function getRepositoryAsync() {
  if (!repoPromise) {
    repoPromise = (async () => {
      assertSupportedBrowser();
      const repo = await connectRepository({
        workerUrl,
        onWorkerRestart: () => window.location.reload(),
      });
      // Expose on window in dev/test builds so Playwright (and you in
      // devtools) can poke at the repository directly. No-op in
      // production builds because import.meta.env.DEV is false.
      if (import.meta.env.DEV) {
        globalThis.__repo = repo;
      }
      return repo;
    })().catch((error) => {
      repoPromise = null;
      throw error;
    });
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
