import { LocalizedError, sourceText } from '../i18n/messages';
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



export const DATABASE_UNAVAILABLE_MESSAGE = sourceText('availability.databaseUnavailable');

export class DatabaseUnavailableError extends LocalizedError {
  constructor(cause?: unknown) {
    super('availability.databaseUnavailable', {}, { cause });
    this.name = 'DatabaseUnavailableError';
  }
}

export class UnsupportedBrowserError extends LocalizedError {
  missing: string[];

  constructor(missing: string[]) {
    super('availability.unsupportedBrowser', { missing: missing.join(', ') });
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
