#!/usr/bin/env node

import {
  SHARED_TEST_OIDC_EMAIL,
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
const DEV_STALWART_PRINCIPAL = process.env.DEV_STALWART_PRINCIPAL ?? 'admin@example.org';
const LOCAL_ACCOUNT_QUOTA_BYTES = 10 * 1024 ** 3;

const LOCAL_ACCOUNTS = [
  {
    id: STACK_STALWART_PRINCIPAL,
    description: 'Stormbox e2e (do not use for dev)',
    permissions: ['unlimited-requests'],
    secrets: [SMTP_E2E_SECRET],
  },
  {
    id: DEV_STALWART_PRINCIPAL,
    description: 'Stormbox developer account',
  },
  {
    id: SHARED_TEST_OIDC_EMAIL,
    description: 'Stormbox shared-folder e2e owner',
    permissions: ['unlimited-requests'],
  },
];

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

async function patchPrincipal(id, actions) {
  const res = await fetch(
    `${STACK_STALWART_API_URL}/api/principal/${encodeURIComponent(id)}`,
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
    throw new Error(`Patch principal ${id} failed: ${res.status} ${text}`);
  }
  const body = await res.json();
  if (body?.error) {
    throw new Error(`Patch principal ${id} Stalwart error: ${JSON.stringify(body)}`);
  }
}

// Idempotent. Mirrors what `MailClient.create_account` in the
// accounts repo does (POST /api/principal/deploy with type
// individual + emails + roles=user) so local principals look
// the same as one provisioned through the accounts UI. We only
// run this if the principal isn't already there, e.g. on a fresh
// stack or after a tmpfs wipe.
//
// The e2e account gets `unlimited-requests` for bulk-move's JMAP churn.
// This only works post-0.16; local dev only.
async function ensureIndividualPrincipal(account) {
  const existing = await fetchPrincipalById(account.id);
  if (existing) {
    await patchExistingIndividualPrincipal(account, existing);
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
      name: account.id,
      description: account.description,
      emails: [account.id],
      roles: ['user'],
      quota: LOCAL_ACCOUNT_QUOTA_BYTES,
      ...(account.permissions?.length ? { enabledPermissions: account.permissions } : {}),
      ...(account.secrets?.length ? { secrets: account.secrets } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Create principal ${account.id} failed: ${res.status} ${text}`);
  }
  const body = await res.json();
  if (body?.error) {
    throw new Error(`Create principal ${account.id} Stalwart error: ${JSON.stringify(body)}`);
  }
  console.log(`[configure-stalwart] created principal ${account.id}`);
}

async function patchExistingIndividualPrincipal(account, existing) {
  const actions = [];
  const permissions = existing.enabledPermissions ?? [];
  for (const permission of account.permissions ?? []) {
    if (!permissions.includes(permission)) {
      actions.push({ action: 'addItem', field: 'enabledPermissions', value: permission });
    }
  }

  const secrets = existing.secrets ?? [];
  for (const secret of account.secrets ?? []) {
    if (!secrets.includes(secret)) {
      actions.push({ action: 'addItem', field: 'secrets', value: secret });
    }
  }

  if (Number(existing.quota) !== LOCAL_ACCOUNT_QUOTA_BYTES) {
    actions.push({ action: 'set', field: 'quota', value: LOCAL_ACCOUNT_QUOTA_BYTES });
  }

  if (!actions.length) return;
  await patchPrincipal(account.id, actions);
  console.log(`[configure-stalwart] updated principal ${account.id}`);
}

function domainForPrincipal(id) {
  const domain = id.split('@')[1];
  if (!domain) {
    throw new Error(`Stalwart principal ${id} has no domain part`);
  }
  return domain;
}

export async function configureStalwart() {
  for (const domain of new Set(LOCAL_ACCOUNTS.map((account) => domainForPrincipal(account.id)))) {
    await ensureDomainPrincipal(domain);
  }
  for (const account of LOCAL_ACCOUNTS) {
    await ensureIndividualPrincipal(account);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  configureStalwart().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
