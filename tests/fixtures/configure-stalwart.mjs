#!/usr/bin/env node
import fs from 'node:fs';

import {
  STACK_STALWART_API_AUTH,
  STACK_STALWART_API_URL,
  STACK_STALWART_PRINCIPAL,
} from '../e2e/helpers/stack-env.js';

// Password: admin. This is a local-stack-only app password used by the
// push-delivery e2e to inject mail through Stalwart SMTP.
const SMTP_E2E_SECRET = '$app$e2e$$argon2id$v=19$m=102400,t=2,p=8$YVB5aXpQS285N3dFQnQ5eHI0dklMWQ$5AyShFD8q3xhw8U84OYJiZ1wFCZtmMXjUAwdLxSEve0';

async function fetchPrincipal() {
  const res = await fetch(
    `${STACK_STALWART_API_URL}/api/principal/${encodeURIComponent(STACK_STALWART_PRINCIPAL)}`,
    { headers: { Authorization: STACK_STALWART_API_AUTH, Accept: 'application/json' } },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fetch principal failed: ${res.status} ${text}`);
  }
  return (await res.json()).data;
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

async function ensureSmtpAppPassword() {
  await patchPrincipal([
    { action: 'addItem', field: 'secrets', value: SMTP_E2E_SECRET },
  ]);
  console.log(`[configure-stalwart] SMTP e2e app password ready on ${STACK_STALWART_PRINCIPAL}`);
}

export async function configureStalwart() {
  await fetchPrincipal();
  await ensureSmtpAppPassword();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  configureStalwart().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
