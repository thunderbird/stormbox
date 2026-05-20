/**
 * Boot-time browser feature check. Stormbox hard-requires SharedWorker,
 * BroadcastChannel, and IndexedDB to function. We fail loudly with a
 * clear message rather than degrading silently.
 *
 * IndexedDB backs the SQLite database via wa-sqlite's
 * IDBBatchAtomicVFS (see src/db/bootstrap-idb.ts). OPFS used to be
 * required when we used an OPFS-backed VFS; the switch to
 * IDBBatchAtomicVFS dropped that dependency.
 */

const SUPPORTED_BROWSERS = 'Use Chrome 109+, Edge 109+, Firefox 116+, or Safari 16+.';

export class UnsupportedBrowserError extends Error {
  missing: string[];

  constructor(missing: string[]) {
    super(`Stormbox cannot run in this browser. Missing: ${missing.join(', ')}. ${SUPPORTED_BROWSERS}`);
    this.name = 'UnsupportedBrowserError';
    this.missing = missing;
  }
}

/**
 * Return null when the runtime supports everything we need; otherwise
 * return a structured description of what is missing. Callers usually
 * want to throw via assertSupportedBrowser() instead.
 */
export function checkBrowserSupport() {
  const missing = [];
  if (typeof globalThis.SharedWorker === 'undefined') {
    missing.push('SharedWorker');
  }
  if (typeof globalThis.BroadcastChannel === 'undefined') {
    missing.push('BroadcastChannel');
  }
  if (typeof globalThis.MessageChannel === 'undefined') {
    missing.push('MessageChannel');
  }
  if (typeof globalThis.indexedDB === 'undefined') {
    missing.push('IndexedDB');
  }
  return missing.length > 0 ? missing : null;
}

export function assertSupportedBrowser() {
  const missing = checkBrowserSupport();
  if (missing) {
    throw new UnsupportedBrowserError(missing);
  }
}
