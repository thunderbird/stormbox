/**
 * Repository singleton accessor. The Repository wraps a MessagePort to
 * the SharedWorker; we only ever want one instance per tab.
 *
 * Vite captures the worker entry via `new URL(...)` at build time so the
 * SharedWorker file is bundled correctly under both dev and prod.
 */

import { createRepository } from '../db/repository.js';

let repoPromise = null;

export function getRepositoryAsync() {
  if (!repoPromise) {
    repoPromise = (async () => {
      const workerUrl = new URL('../db/shared-worker.js', import.meta.url);
      return createRepository({ workerUrl });
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
