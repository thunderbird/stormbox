/**
 * Boot-time browser feature check. Stormbox hard-requires SharedWorker,
 * BroadcastChannel, and the OPFS access-handle API to function. We fail
 * loudly with a clear message rather than degrading silently.
 *
 * See WEBMAIL_SQLITE_STORAGE_SPEC.md > Architecture Plan > Worker
 * topology and VFS for the rationale.
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
  // OPFS root is optional at boot - the SharedWorker is the only consumer
  // and the failure mode there is a clearer message - but we can detect
  // cases where the caller is running in a context with no storage at all.
  if (typeof navigator !== 'undefined' && !navigator.storage?.getDirectory) {
    missing.push('Origin Private File System');
  }
  return missing.length > 0 ? missing : null;
}

export function assertSupportedBrowser() {
  const missing = checkBrowserSupport();
  if (missing) {
    throw new UnsupportedBrowserError(missing);
  }
}
