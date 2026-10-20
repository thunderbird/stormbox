/**
 * Full-page navigation used by stores, which must not touch `window`
 * directly (eslint `no-restricted-globals` on `src/stores/`).
 */

export function currentHref(): string {
  return globalThis.location?.href ?? '';
}

/** Navigate away without leaving the current page in history. */
export function replaceLocation(url: string): void {
  globalThis.location?.replace(url);
}

/** Restart browser initialization after an explicit retry. */
export function reloadLocation(): void {
  globalThis.location?.reload();
}
