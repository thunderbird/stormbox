import https from 'node:https';

import {
  JMAP_BASE_URL,
  OIDC_CLIENT_ID,
  OIDC_ISSUER,
  TEST_OIDC_EMAIL,
  TEST_OIDC_PASSWORD,
} from './stack-env.js';

const tlsAgent = new https.Agent({ rejectUnauthorized: false });
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTls(url, options = {}) {
  const parsed = new URL(url);
  const attempts = options.attempts ?? 8;
  const fetchOptions = { ...options };
  delete fetchOptions.attempts;
  if (parsed.protocol === 'https:') {
    fetchOptions.agent = tlsAgent;
  }
  let response = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    response = await fetch(url, fetchOptions);
    if (!RETRYABLE_HTTP_STATUSES.has(response.status) || attempt === attempts) {
      return response;
    }
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfter = retryAfterHeader == null ? NaN : Number(retryAfterHeader);
    const delay = Number.isFinite(retryAfter)
      ? retryAfter * 1000
      : 1_000 * (2 ** (attempt - 1));
    await sleep(delay);
  }
  return response;
}

let cachedToken = null;
let cachedTokenExpiresAt = 0;

export async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedTokenExpiresAt > now + 30_000) {
    return cachedToken;
  }

  const tokenUrl = `${OIDC_ISSUER.replace(/\/$/, '')}/protocol/openid-connect/token`;
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: OIDC_CLIENT_ID,
    username: TEST_OIDC_EMAIL,
    password: TEST_OIDC_PASSWORD,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token request failed: ${response.status} ${text}`);
  }
  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error(`Token response missing access_token: ${JSON.stringify(payload)}`);
  }
  cachedToken = payload.access_token;
  cachedTokenExpiresAt = now + (payload.expires_in ?? 300) * 1000;
  return cachedToken;
}

export async function connectJmap() {
  const token = await getAccessToken();
  const authHeader = `Bearer ${token}`;
  const jmapBase = JMAP_BASE_URL.replace(/\/$/, '');
  const sessionResponse = await fetchWithTls(
    `${jmapBase}/.well-known/jmap`,
    { headers: { Authorization: authHeader } },
  );
  if (!sessionResponse.ok) {
    throw new Error(`Session fetch failed: ${sessionResponse.status} ${sessionResponse.statusText}`);
  }
  const session = await sessionResponse.json();
  const mailAccountId = session.primaryAccounts?.['urn:ietf:params:jmap:mail'];
  if (!mailAccountId) {
    throw new Error('JMAP session has no primary mail account');
  }
  // Stalwart may advertise an internal Docker hostname; always call via JMAP_BASE_URL.
  const sessionPath = new URL(session.apiUrl).pathname.replace(/\/$/, '');
  return {
    apiUrl: `${jmapBase}${sessionPath}/`,
    accountId: mailAccountId,
    authHeader,
  };
}

export async function jmapRequest(jmap, methodCalls) {
  const response = await fetchWithTls(jmap.apiUrl, {
    method: 'POST',
    headers: {
      Authorization: jmap.authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      using: [
        'urn:ietf:params:jmap:core',
        'urn:ietf:params:jmap:mail',
        'urn:ietf:params:jmap:submission',
      ],
      methodCalls,
    }),
  });
  if (!response.ok) {
    throw new Error(`JMAP request failed: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  const errorResponse = payload.methodResponses?.find((r) => r[0] === 'error');
  if (errorResponse) {
    throw new Error(`JMAP method error: ${JSON.stringify(errorResponse[1])}`);
  }
  return payload;
}

export function pickResponse(payload, name) {
  const found = payload.methodResponses?.find((r) => r[0] === name);
  return found?.[1] ?? null;
}

export async function listMailboxes(jmap) {
  const payload = await jmapRequest(jmap, [[
    'Mailbox/get',
    {
      accountId: jmap.accountId,
      properties: ['id', 'name', 'role'],
    },
    'm1',
  ]]);
  return pickResponse(payload, 'Mailbox/get')?.list ?? [];
}

export function mailboxByRole(mailboxes, role) {
  return mailboxes.find((m) => m.role === role) ?? null;
}

export async function createDraft(jmap, { draftsId, fromEmail, subject }) {
  const payload = await jmapRequest(jmap, [[
    'Email/set',
    {
      accountId: jmap.accountId,
      create: {
        c1: {
          mailboxIds: { [draftsId]: true },
          keywords: { $draft: true },
          from: [{ email: fromEmail }],
          to: [{ email: fromEmail }],
          subject,
          bodyStructure: { type: 'text/plain', partId: 'p1' },
          bodyValues: {
            p1: { value: 'delete e2e disposable draft' },
          },
        },
      },
    },
    's1',
  ]]);
  const set = pickResponse(payload, 'Email/set');
  if (set?.notCreated?.c1) {
    throw new Error(`Could not create test draft: ${JSON.stringify(set.notCreated.c1)}`);
  }
  const id = set?.created?.c1?.id;
  if (!id) throw new Error(`Email/set create returned no id: ${JSON.stringify(set)}`);
  return id;
}

export async function createEmailInMailbox(jmap, {
  mailboxId,
  fromEmail,
  subject,
  bodyText = 'e2e disposable message',
  htmlBody = null,
}) {
  const create = {
    mailboxIds: { [mailboxId]: true },
    keywords: {},
    from: [{ email: fromEmail }],
    to: [{ email: fromEmail }],
    subject,
  };

  if (htmlBody) {
    create.bodyStructure = {
      type: 'multipart/alternative',
      subParts: [
        { type: 'text/plain', partId: 'p1' },
        { type: 'text/html', partId: 'p2' },
      ],
    };
    create.bodyValues = {
      p1: { value: bodyText },
      p2: { value: htmlBody },
    };
  } else {
    create.bodyStructure = { type: 'text/plain', partId: 'p1' };
    create.bodyValues = { p1: { value: bodyText } };
  }

  const payload = await jmapRequest(jmap, [[
    'Email/set',
    { accountId: jmap.accountId, create: { c1: create } },
    's1',
  ]]);
  const set = pickResponse(payload, 'Email/set');
  if (set?.notCreated?.c1) {
    throw new Error(`Could not create test email: ${JSON.stringify(set.notCreated.c1)}`);
  }
  const id = set?.created?.c1?.id;
  if (!id) throw new Error(`Email/set create returned no id: ${JSON.stringify(set)}`);
  return id;
}

export async function createEmailsInMailbox(jmap, {
  mailboxId,
  fromEmail,
  subjectPrefix,
  count,
  batchSize = 500,
}) {
  let created = 0;
  const ids = [];
  for (let offset = 0; offset < count; offset += batchSize) {
    const create = {};
    const batchCount = Math.min(batchSize, count - offset);
    for (let i = 0; i < batchCount; i += 1) {
      const n = offset + i;
      create[`c${n}`] = {
        mailboxIds: { [mailboxId]: true },
        keywords: {},
        from: [{ email: fromEmail }],
        to: [{ email: fromEmail }],
        subject: `${subjectPrefix} ${String(n).padStart(5, '0')}`,
        bodyStructure: { type: 'text/plain', partId: 'p1' },
        bodyValues: { p1: { value: `large move e2e ${n}` } },
      };
    }
    const payload = await jmapRequest(jmap, [[
      'Email/set',
      { accountId: jmap.accountId, create },
      'bulkCreate',
    ]]);
    const set = pickResponse(payload, 'Email/set');
    if (set?.notCreated && Object.keys(set.notCreated).length > 0) {
      throw new Error(`Could not create bulk test email batch ${offset}: ${JSON.stringify(set.notCreated)}`);
    }
    const createdEntries = Object.entries(set?.created ?? {})
      .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)));
    for (const [, value] of createdEntries) {
      if (value?.id) ids.push(value.id);
    }
    created += createdEntries.length;
  }
  if (created !== count) {
    throw new Error(`Bulk create expected ${count} messages, created ${created}`);
  }
  return ids;
}

export async function ensureMailbox(jmap, { name }) {
  const fullPayload = await jmapRequest(jmap, [[
    'Mailbox/get',
    {
      accountId: jmap.accountId,
      properties: ['id', 'name', 'role', 'parentId'],
    },
    'mbFull',
  ]]);
  const existing = pickResponse(fullPayload, 'Mailbox/get')?.list
    ?.find((m) => (m.name ?? '').toLowerCase() === name.toLowerCase() && !m.parentId);
  if (existing) return existing;

  const createPayload = await jmapRequest(jmap, [[
    'Mailbox/set',
    {
      accountId: jmap.accountId,
      create: { mb1: { name } },
    },
    'mbSet',
  ]]);
  const set = pickResponse(createPayload, 'Mailbox/set');
  if (set?.notCreated?.mb1) {
    throw new Error(`Could not create mailbox "${name}": ${JSON.stringify(set.notCreated.mb1)}`);
  }
  const created = set?.created?.mb1;
  if (!created?.id) throw new Error(`Mailbox/set returned no id for "${name}": ${JSON.stringify(set)}`);
  return { id: created.id, name, role: null, parentId: null };
}

export async function countMessagesInMailboxBySubjectPrefix(jmap, { mailboxId, subjectPrefix }) {
  const payload = await jmapRequest(jmap, [[
    'Email/query',
    {
      accountId: jmap.accountId,
      filter: {
        operator: 'AND',
        conditions: [
          { inMailbox: mailboxId },
          { subject: subjectPrefix },
        ],
      },
      limit: 1,
      calculateTotal: true,
    },
    'countBySubject',
  ]]);
  return pickResponse(payload, 'Email/query')?.total ?? 0;
}

export async function getEmailMailboxIds(jmap, emailId) {
  const payload = await jmapRequest(jmap, [[
    'Email/get',
    {
      accountId: jmap.accountId,
      ids: [emailId],
      properties: ['mailboxIds'],
    },
    'g1',
  ]]);
  const row = pickResponse(payload, 'Email/get')?.list?.[0] ?? null;
  return row?.mailboxIds ?? null;
}

export async function destroyEmail(jmap, emailId) {
  const payload = await jmapRequest(jmap, [[
    'Email/set',
    { accountId: jmap.accountId, destroy: [emailId] },
    'd1',
  ]]);
  const set = pickResponse(payload, 'Email/set');
  if (set?.notDestroyed?.[emailId]) {
    throw new Error(`Could not destroy cleanup email ${emailId}: ${JSON.stringify(set.notDestroyed[emailId])}`);
  }
}

export async function cleanupEmail(jmap, emailId, trashId) {
  const mailboxIds = await getEmailMailboxIds(jmap, emailId);
  if (!mailboxIds) return;
  if (mailboxIds[trashId] !== true) {
    const update = { [`mailboxIds/${trashId}`]: true };
    for (const mailboxId of Object.keys(mailboxIds)) {
      if (mailboxId !== trashId) update[`mailboxIds/${mailboxId}`] = null;
    }
    const payload = await jmapRequest(jmap, [[
      'Email/set',
      { accountId: jmap.accountId, update: { [emailId]: update } },
      'u1',
    ]]);
    const set = pickResponse(payload, 'Email/set');
    if (set?.notUpdated?.[emailId]) {
      throw new Error(`Could not move cleanup email ${emailId} to Trash: ${JSON.stringify(set.notUpdated[emailId])}`);
    }
  }
  await destroyEmail(jmap, emailId);
}

export async function sweepOrphanTestMessages(jmap, {
  subjectPrefix = 'Delete e2e',
  throwOnError = false,
} = {}) {
  try {
    const mailboxes = await listMailboxes(jmap);
    const sent = mailboxes.find((m) => m.role === 'sent');
    const filter = sent
      ? {
        operator: 'AND',
        conditions: [
          { subject: subjectPrefix },
          { operator: 'NOT', conditions: [{ inMailbox: sent.id }] },
        ],
      }
      : { subject: subjectPrefix };

    for (;;) {
      const payload = await jmapRequest(jmap, [[
        'Email/query',
        { accountId: jmap.accountId, filter, limit: 100 },
        'q1',
      ]]);
      const ids = pickResponse(payload, 'Email/query')?.ids ?? [];
      if (ids.length === 0) return;
      await jmapRequest(jmap, [[
        'Email/set',
        { accountId: jmap.accountId, destroy: ids },
        's1',
      ]]);
    }
  } catch (err) {
    if (throwOnError) throw err;
    console.warn('[jmap-client] sweepOrphanTestMessages failed:', err?.message ?? err);
  }
}

export function classifyMailboxState(mailboxIds, { source, trash }) {
  if (!mailboxIds) return 'missing';
  const inSource = mailboxIds[source.id] === true;
  const inTrash = mailboxIds[trash.id] === true;
  if (inTrash && !inSource) return 'trash';
  if (inSource) return 'source';
  return JSON.stringify(mailboxIds);
}
