/**
 * Staff sign-ins on the production webmail origin are sent to the staff
 * app origin (`STAFF_APP_URL`) instead of connecting locally. The target
 * keeps the current path, query and hash and carries a one-shot flag so
 * the destination signs in through the shared Keycloak SSO session
 * without another click.
 */

export const STAFF_AUTO_LOGIN_PARAM = 'auto-login';

/**
 * URL to send a staff sign-in to, or null when no redirect applies:
 * `staffAppUrl` is empty or unparseable, or the current page already
 * lives on that origin.
 */
export function staffRedirectUrl(staffAppUrl: string, currentHref: string): string | null {
  if (!staffAppUrl) return null;
  let target: URL;
  let current: URL;
  try {
    target = new URL(staffAppUrl);
    current = new URL(currentHref);
  } catch {
    return null;
  }
  if (target.origin === current.origin) return null;
  target.pathname = current.pathname;
  target.search = current.search;
  target.hash = current.hash;
  target.searchParams.set(STAFF_AUTO_LOGIN_PARAM, '1');
  return target.toString();
}

export function hasAutoLoginFlag(search: string): boolean {
  return new URLSearchParams(search).has(STAFF_AUTO_LOGIN_PARAM);
}

/** `href` without the auto-login flag, so a reload does not re-trigger it. */
export function withoutAutoLoginFlag(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(STAFF_AUTO_LOGIN_PARAM);
  return url.toString();
}
