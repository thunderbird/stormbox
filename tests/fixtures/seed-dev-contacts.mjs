#!/usr/bin/env node
/**
 * Seed the developer account (admin@example.org) with fake contacts
 * for manual testing and demos of the contacts view.
 *
 * Re-runnable: seeded cards carry the `[dev seed]` marker in their
 * name and a `dev-seed-contact-*` uid; existing seed cards are
 * destroyed before recreating, so the final count is exact.
 *
 * Env overrides:
 *   DEV_OIDC_USERNAME (default admin@example.org)
 *   DEV_OIDC_PASSWORD (default admin)
 *   DEV_OIDC_CLIENT_ID (default thunderbird-stormbox-test)
 *   SEED_CONTACT_COUNT (default 1234)
 */

import https from 'node:https';

import {
  JMAP_BASE_URL,
  OIDC_ISSUER,
} from '../e2e/helpers/stack-env.js';

const DEV_OIDC_USERNAME = process.env.DEV_OIDC_USERNAME ?? 'admin@example.org';
const DEV_OIDC_PASSWORD = process.env.DEV_OIDC_PASSWORD ?? 'admin';
const DEV_OIDC_CLIENT_ID = process.env.DEV_OIDC_CLIENT_ID ?? 'thunderbird-stormbox-test';

const TARGET = Number(process.env.SEED_CONTACT_COUNT ?? 1234);
const SET_BATCH = 250;
const QUERY_PAGE = 500;
const SEED_UID_PREFIX = 'dev-seed-contact-';

const FIRST_NAMES = [
  'Ada', 'Grace', 'Alan', 'Katherine', 'Edsger', 'Barbara', 'Donald',
  'Radia', 'Dennis', 'Margaret', 'Linus', 'Frances', 'Ken', 'Adele',
  'Bjarne', 'Shafi', 'Tim', 'Hedy', 'Vint', 'Annie',
];
const LAST_NAMES = [
  'Lovelace', 'Hopper', 'Turing', 'Johnson', 'Dijkstra', 'Liskov',
  'Knuth', 'Perlman', 'Ritchie', 'Hamilton', 'Torvalds', 'Allen',
  'Thompson', 'Goldberg', 'Stroustrup', 'Goldwasser', 'Berners-Lee',
  'Lamarr', 'Cerf', 'Easley',
];
const ORGS = [
  'Analytical Engines', 'Harbor Systems', 'Bluesky Labs', 'Northwind',
  'Acme Corp', 'Globex', 'Initech', 'Umbrella Research', null, null,
];

const tlsAgent = new https.Agent({ rejectUnauthorized: false });

async function fetchTls(url, options = {}) {
  const fetchOptions = { ...options };
  if (new URL(url).protocol === 'https:') {
    fetchOptions.agent = tlsAgent;
  }
  return fetch(url, fetchOptions);
}

async function getDevToken() {
  const tokenUrl = `${OIDC_ISSUER.replace(/\/$/, '')}/protocol/openid-connect/token`;
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: DEV_OIDC_CLIENT_ID,
    username: DEV_OIDC_USERNAME,
    password: DEV_OIDC_PASSWORD,
  });
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(`OIDC password grant failed for ${DEV_OIDC_USERNAME}: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error(`Token response missing access_token: ${JSON.stringify(payload)}`);
  }
  return payload.access_token;
}

async function connectAsDev() {
  const token = await getDevToken();
  const authHeader = `Bearer ${token}`;
  const jmapBase = JMAP_BASE_URL.replace(/\/$/, '');
  const sessionResponse = await fetchTls(`${jmapBase}/.well-known/jmap`, {
    headers: { Authorization: authHeader },
  });
  if (!sessionResponse.ok) {
    throw new Error(`JMAP session fetch failed: ${sessionResponse.status} ${await sessionResponse.text().catch(() => '')}`);
  }
  const session = await sessionResponse.json();
  const accountId = session.primaryAccounts?.['urn:ietf:params:jmap:contacts']
    ?? session.primaryAccounts?.['urn:ietf:params:jmap:mail'];
  if (!accountId) {
    throw new Error('JMAP session has no contacts/mail primary account — provision the Thundermail address first (http://localhost:8087).');
  }
  const sessionPath = new URL(session.apiUrl).pathname.replace(/\/$/, '');
  return { apiUrl: `${jmapBase}${sessionPath}/`, accountId, authHeader };
}

async function contactsRequest(jmap, methodCalls) {
  const res = await fetchTls(jmap.apiUrl, {
    method: 'POST',
    headers: { Authorization: jmap.authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:contacts'],
      methodCalls,
    }),
  });
  if (!res.ok) {
    throw new Error(`contacts JMAP failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const payload = await res.json();
  const err = payload.methodResponses?.find((r) => r[0] === 'error');
  if (err) throw new Error(`JMAP method error: ${JSON.stringify(err[1])}`);
  return payload;
}

function pick(payload, name) {
  return payload.methodResponses?.find((r) => r[0] === name)?.[1] ?? null;
}

async function defaultBookId(jmap) {
  const payload = await contactsRequest(jmap, [[
    'AddressBook/get',
    { accountId: jmap.accountId, properties: ['id', 'name', 'isDefault'] },
    'ab',
  ]]);
  const list = pick(payload, 'AddressBook/get')?.list ?? [];
  const chosen = list.find((b) => b.isDefault) ?? list[0];
  if (!chosen) throw new Error('Account has no address book');
  return chosen.id;
}

/** All ContactCard ids in the account, paged. */
async function allCardIds(jmap) {
  const ids = [];
  let position = 0;
  for (;;) {
    const payload = await contactsRequest(jmap, [[
      'ContactCard/query',
      { accountId: jmap.accountId, position, limit: QUERY_PAGE, calculateTotal: true },
      'q',
    ]]);
    const page = pick(payload, 'ContactCard/query');
    const pageIds = page?.ids ?? [];
    ids.push(...pageIds);
    position += pageIds.length;
    if (pageIds.length < QUERY_PAGE) break;
  }
  return ids;
}

async function destroyPreviousSeed(jmap) {
  const ids = await allCardIds(jmap);
  const seedIds = [];
  for (let offset = 0; offset < ids.length; offset += QUERY_PAGE) {
    const chunk = ids.slice(offset, offset + QUERY_PAGE);
    const payload = await contactsRequest(jmap, [[
      'ContactCard/get',
      { accountId: jmap.accountId, ids: chunk, properties: ['id', 'uid'] },
      'g',
    ]]);
    for (const card of pick(payload, 'ContactCard/get')?.list ?? []) {
      if ((card.uid ?? '').startsWith(SEED_UID_PREFIX)) seedIds.push(card.id);
    }
  }
  for (let offset = 0; offset < seedIds.length; offset += SET_BATCH) {
    await contactsRequest(jmap, [[
      'ContactCard/set',
      { accountId: jmap.accountId, destroy: seedIds.slice(offset, offset + SET_BATCH) },
      'd',
    ]]);
  }
  return seedIds.length;
}

function seedCard(n, bookId) {
  const first = FIRST_NAMES[n % FIRST_NAMES.length];
  const last = LAST_NAMES[Math.floor(n / FIRST_NAMES.length) % LAST_NAMES.length];
  const org = ORGS[n % ORGS.length];
  const num = String(n + 1).padStart(4, '0');
  return {
    '@type': 'Card',
    version: '1.0',
    kind: 'individual',
    uid: `${SEED_UID_PREFIX}${num}`,
    name: { full: `${first} ${last} ${num}` },
    emails: {
      e1: { '@type': 'EmailAddress', address: `${first}.${last}.${num}@seed.example`.toLowerCase() },
    },
    ...(org ? { organizations: { o1: { name: org } } } : {}),
    addressBookIds: { [bookId]: true },
  };
}

async function main() {
  console.log(`Seeding ${TARGET} contacts for ${DEV_OIDC_USERNAME} ...`);
  const jmap = await connectAsDev();
  const bookId = await defaultBookId(jmap);

  const removed = await destroyPreviousSeed(jmap);
  if (removed > 0) console.log(`Removed ${removed} previous seed contacts.`);

  let created = 0;
  for (let offset = 0; offset < TARGET; offset += SET_BATCH) {
    const create = {};
    for (let i = offset; i < Math.min(offset + SET_BATCH, TARGET); i += 1) {
      create[`c${i}`] = seedCard(i, bookId);
    }
    const payload = await contactsRequest(jmap, [[
      'ContactCard/set',
      { accountId: jmap.accountId, create },
      `s${offset}`,
    ]]);
    const set = pick(payload, 'ContactCard/set');
    const notCreated = set?.notCreated ? Object.values(set.notCreated) : [];
    if (notCreated.length > 0) {
      throw new Error(`Batch at ${offset} failed: ${JSON.stringify(notCreated[0])}`);
    }
    created += Object.keys(set?.created ?? {}).length;
    process.stdout.write(`  created ${created}/${TARGET}\r`);
  }
  console.log(`\nDone. Server now holds ${(await allCardIds(jmap)).length} contact cards total.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
