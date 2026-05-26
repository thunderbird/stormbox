#!/usr/bin/env node
import fs from 'node:fs';

import {
  STACK_STALWART_API_AUTH,
  STACK_STALWART_API_URL,
  STACK_STALWART_PRINCIPAL,
} from '../e2e/helpers/stack-env.js';

// Stalwart-format app password for the e2e SMTP self-send fixture.
// The `$app$e2e$$` prefix is the app-password label convention
// thunderbird-accounts uses (see `filter_app_passwords` in the
// accounts repo); the argon2id hash is over the literal string
// `admin` (left unchanged to avoid generating a fresh hash here
// — push-delivery.spec.js authenticates with the matching
// `TEST_SMTP_PASSWORD = "admin"`).
const SMTP_E2E_SECRET = '$app$e2e$$argon2id$v=19$m=102400,t=2,p=8$YVB5aXpQS285N3dFQnQ5eHI0dklMWQ$5AyShFD8q3xhw8U84OYJiZ1wFCZtmMXjUAwdLxSEve0';

async function fetchPrincipalById(id) {
  const res = await fetch(
    `${STACK_STALWART_API_URL}/api/principal/${encodeURIComponent(id)}`,
    { headers: { Authorization: STACK_STALWART_API_AUTH, Accept: 'application/json' } },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fetch principal failed: ${res.status} ${text}`);
  }
  const body = await res.json();
  // Stalwart returns 200 with `{ error: 'notFound' }` rather than a
  // real 404 in some configurations; treat both consistently.
  if (body?.error === 'notFound') return null;
  return body.data;
}

async function fetchPrincipal() {
  return fetchPrincipalById(STACK_STALWART_PRINCIPAL);
}

// Idempotent. Mirrors the `_stalwart_check_or_create_domain_entry`
// step the accounts service runs before creating a Thundermail
// principal: Stalwart rejects an individual create with
// `{ error: 'notFound', item: '<domain>' }` if the domain
// principal doesn't already exist. After a tmpfs wipe of the
// Stalwart data directory we need to recreate the domain
// ourselves.
async function ensureDomainPrincipal(domain) {
  const existing = await fetchPrincipalById(domain);
  if (existing) return;
  const res = await fetch(`${STACK_STALWART_API_URL}/api/principal/deploy`, {
    method: 'POST',
    headers: {
      Authorization: STACK_STALWART_API_AUTH,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      type: 'domain',
      name: domain,
      description: 'Stormbox e2e (do not use for dev)',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Create domain principal failed: ${res.status} ${text}`);
  }
  const body = await res.json();
  if (body?.error) {
    throw new Error(`Create domain principal Stalwart error: ${JSON.stringify(body)}`);
  }
  console.log(`[configure-stalwart] created domain ${domain}`);
}

async function patchPrincipal(actions) {
  const res = await fetch(
    `${STACK_STALWART_API_URL}/api/principal/${encodeURIComponent(STACK_STALWART_PRINCIPAL)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: STACK_STALWART_API_AUTH,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(actions),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Patch principal failed: ${res.status} ${text}`);
  }
  const body = await res.json();
  if (body?.error) {
    throw new Error(`Patch principal Stalwart error: ${JSON.stringify(body)}`);
  }
}

// Idempotent. Mirrors what `MailClient.create_account` in the
// accounts repo does (POST /api/principal/deploy with type
// individual + emails + roles=user) so the e2e principal looks
// the same as one provisioned through the accounts UI. We only
// run this if the principal isn't already there, e.g. on a fresh
// stack or after a tmpfs wipe.
//
// Also grants `unlimited-requests`. The default Stalwart
// JMAP rate limit (~1000 req/min per account) trips during
// zz-large-bulk-move's 1000+-message create+destroy phase
// combined with the cumulative request volume of the rest of
// the suite. The Stalwart maintainer's documented escape hatch
// for rate-limited test accounts is the `unlimited-requests`
// permission (see stalwart#2922). Local dev only.
async function ensureE2eIndividualPrincipal() {
  const existing = await fetchPrincipal();
  if (existing) {
    if (!(existing.enabledPermissions ?? []).includes('unlimited-requests')) {
      await patchPrincipal([
        { action: 'addItem', field: 'enabledPermissions', value: 'unlimited-requests' },
      ]);
      console.log(`[configure-stalwart] granted unlimited-requests on ${STACK_STALWART_PRINCIPAL}`);
    }
    return;
  }
  const res = await fetch(`${STACK_STALWART_API_URL}/api/principal/deploy`, {
    method: 'POST',
    headers: {
      Authorization: STACK_STALWART_API_AUTH,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      type: 'individual',
      name: STACK_STALWART_PRINCIPAL,
      description: 'Stormbox e2e (do not use for dev)',
      emails: [STACK_STALWART_PRINCIPAL],
      roles: ['user'],
      enabledPermissions: ['unlimited-requests'],
      quota: 0,
      secrets: [],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Create principal failed: ${res.status} ${text}`);
  }
  const body = await res.json();
  if (body?.error) {
    throw new Error(`Create principal Stalwart error: ${JSON.stringify(body)}`);
  }
  console.log(`[configure-stalwart] created principal ${STACK_STALWART_PRINCIPAL}`);
}

async function ensureSmtpAppPassword() {
  await patchPrincipal([
    { action: 'addItem', field: 'secrets', value: SMTP_E2E_SECRET },
  ]);
  console.log(`[configure-stalwart] SMTP e2e app password ready on ${STACK_STALWART_PRINCIPAL}`);
}

export async function configureStalwart() {
  const domain = STACK_STALWART_PRINCIPAL.split('@')[1];
  if (!domain) {
    throw new Error(`STACK_STALWART_PRINCIPAL ${STACK_STALWART_PRINCIPAL} has no domain part`);
  }
  await ensureDomainPrincipal(domain);
  await ensureE2eIndividualPrincipal();
  await ensureSmtpAppPassword();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  configureStalwart().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
