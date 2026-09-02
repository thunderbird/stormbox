/**
 * Email domains whose signed-in users count as staff. The match is on
 * the OIDC ID-token `email` claim, never on the username. The RFC 2606
 * reserved domains are included so the local dev stack's accounts
 * (`admin@example.org` carries the email claim `admin@example.com`)
 * qualify without touching Keycloak; no real user can hold them.
 */
export const STAFF_EMAIL_DOMAINS: readonly string[] = Object.freeze([
  'thunderbird.net',
  'example.org',
  'example.com',
]);

export function isStaffEmail(email: string | null | undefined): boolean {
  const normalized = String(email ?? '').trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) return false;
  const domain = normalized.slice(at + 1);
  return STAFF_EMAIL_DOMAINS.includes(domain);
}
