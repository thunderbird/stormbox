import https from 'node:https';

import {
  JMAP_BASE_URL,
  OIDC_CLIENT_ID,
  OIDC_ISSUER,
  TEST_OIDC_EMAIL,
  TEST_OIDC_PASSWORD,
} from './stack-env.js';

const tlsAgent = new https.Agent({ rejectUnauthorized: false });
// 429 is intentionally NOT retried. The local-stack stalwart is
// configured to make rate-limit hits effectively unreachable
// (see thunderbird-accounts/mail/etc/config.toml `[http.rate-limit]`),
// so a 429 here means a real regression.
const RETRYABLE_HTTP_STATUSES = new Set([502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTls(url, options = {}) {
  const parsed = new URL(url);
  const attempts = options.attempts ?? 4;
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
    const retryAfter = sessionResponse.headers.get('retry-after') ?? '';
    const body = await sessionResponse.text().catch(() => '');
    throw new Error(
      `Session fetch failed: ${sessionResponse.status} ${sessionResponse.statusText}`
      + (retryAfter ? ` retry-after=${retryAfter}` : '')
      + (body ? ` body=${body.slice(0, 200)}` : ''),
    );
  }
  const session = await sessionResponse.json();
  const mailAccountId = session.primaryAccounts?.['urn:ietf:params:jmap:mail'];
  if (!mailAccountId) {
    throw new Error('JMAP session has no primary mail account');
  }
  // Stalwart may advertise an internal Docker hostname; always call via JMAP_BASE_URL.
  const sessionPath = new URL(session.apiUrl).pathname.replace(/\/$/, '');
  // The download URL is a template (RFC 8620 §6.2) whose origin may also
  // be the internal Docker host; rewrite its origin to JMAP_BASE_URL the
  // same way, leaving the {accountId}/{blobId}/{name}/{type} placeholders.
  let downloadUrlTemplate = null;
  if (session.downloadUrl) {
    const advertisedOrigin = new URL(session.downloadUrl).origin;
    downloadUrlTemplate = session.downloadUrl.replace(advertisedOrigin, new URL(jmapBase).origin);
  }
  return {
    apiUrl: `${jmapBase}${sessionPath}/`,
    accountId: mailAccountId,
    authHeader,
    downloadUrlTemplate,
  };
}

// Download a blob via the account's JMAP download endpoint. Returns the
// raw bytes as a Buffer. Used to prove an uploaded inline-image blob is
// actually retrievable from the server.
export async function downloadBlob(jmap, { blobId, type = 'application/octet-stream', name = 'blob' }) {
  if (!jmap.downloadUrlTemplate) {
    throw new Error('JMAP session did not advertise a downloadUrl');
  }
  const url = jmap.downloadUrlTemplate
    .replace('{accountId}', encodeURIComponent(jmap.accountId))
    .replace('{blobId}', encodeURIComponent(blobId))
    .replace('{name}', encodeURIComponent(name))
    .replace('{type}', encodeURIComponent(type));
  const response = await fetchWithTls(url, { headers: { Authorization: jmap.authHeader } });
  if (!response.ok) {
    throw new Error(`Blob download failed: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
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
    // Surface the JMAP method names + retry-after so a hidden
    // rate-limit regression is visible at the failing assertion
    // rather than buried in a vague "JMAP request failed: 429".
    const methodNames = methodCalls.map((c) => c?.[0]).filter(Boolean).join(',');
    const retryAfter = response.headers.get('retry-after') ?? '';
    const body = await response.text().catch(() => '');
    throw new Error(
      `JMAP request failed: ${response.status} ${response.statusText} `
      + `methods=[${methodNames}]`
      + (retryAfter ? ` retry-after=${retryAfter}` : '')
      + (body ? ` body=${body.slice(0, 200)}` : ''),
    );
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
  keywords = {},
  // Wait for the just-created message to be visible via Email/query
  // before returning. Stalwart's index can lag the Email/set commit
  // by hundreds of ms to several seconds under load; without this
  // wait the test's UI poll for the new row can outrun the server's
  // own queryability and either time out (if push lags too) or
  // succeed only after a slow refresh fallback. Disable for
  // tests that explicitly want to see pre-index behavior.
  awaitIndexed = true,
}) {
  const create = {
    mailboxIds: { [mailboxId]: true },
    keywords,
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

  if (awaitIndexed) {
    await waitForEmailQueryable(jmap, { mailboxId, subject });
  }
  return id;
}

// Poll Email/query until the just-created message is visible. We
// match by inMailbox + subject because that's how the e2e tests
// later look it up too. Subject is unique per test (always carries
// a timestamp), so this is a precise match. Soft barrier: a
// timeout doesn't throw, just logs — downstream polls (e.g.
// expectRowSoon) carry the real budget for index lag.
async function waitForEmailQueryable(jmap, {
  mailboxId, subject, timeoutMs = 3_000, intervalMs = 25,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await jmapRequest(jmap, [[
      'Email/query',
      {
        accountId: jmap.accountId,
        filter: {
          operator: 'AND',
          conditions: [{ inMailbox: mailboxId }, { subject }],
        },
        limit: 1,
        calculateTotal: false,
      },
      'qIdx',
    ]]);
    const ids = pickResponse(payload, 'Email/query')?.ids ?? [];
    if (ids.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  // Don't throw — the caller may handle missing messages, and this
  // is a soft barrier. Just log so a regression is visible.
  console.warn(`[jmap-client] waitForEmailQueryable timed out for "${subject}" in mailbox ${mailboxId}`);
}

// Run an array of async tasks with a bounded concurrency. Used by the
// bulk JMAP helpers to overlap Stalwart-bound round trips without
// flooding the server with N concurrent requests.
async function runWithConcurrency(tasks, concurrency) {
  const results = new Array(tasks.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < tasks.length) {
      const idx = nextIndex;
      nextIndex += 1;
      results[idx] = await tasks[idx]();
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

// Idempotent: tops the Inbox up to `target` baseline messages.
// Several specs (multi-select, mail-flow, push-delivery,
// message-view-iframe-height) assume a non-empty Inbox at start
// of test — historically supplied by `npm run stack:seed`. Calling
// this from a worker-scoped fixture (or the spec's own beforeAll)
// makes those tests self-sufficient on a fresh account, no manual
// seed step needed. Subject prefix uses the distinctive
// `Baseline e2e inbox` token so the FTS-style sweeps in
// shared-session.js don't accidentally wipe it.
export async function ensureInboxBaseline(jmap, {
  inboxMailboxId,
  fromEmail,
  target = 12,
  subjectPrefix = 'Baseline e2e inbox',
} = {}) {
  if (!inboxMailboxId) throw new Error('ensureInboxBaseline requires inboxMailboxId');
  if (!fromEmail) throw new Error('ensureInboxBaseline requires fromEmail');

  const countPayload = await jmapRequest(jmap, [[
    'Email/query',
    {
      accountId: jmap.accountId,
      filter: {
        operator: 'AND',
        conditions: [
          { inMailbox: inboxMailboxId },
          { subject: subjectPrefix },
        ],
      },
      limit: 1,
      calculateTotal: true,
    },
    'baselineCount',
  ]]);
  const existing = pickResponse(countPayload, 'Email/query')?.total ?? 0;
  if (existing >= target) return existing;

  const needed = target - existing;
  const create = {};
  for (let i = 0; i < needed; i += 1) {
    const n = existing + i;
    create[`b${n}`] = {
      mailboxIds: { [inboxMailboxId]: true },
      keywords: { $seen: true },
      from: [{ email: fromEmail }],
      to: [{ email: fromEmail }],
      subject: `${subjectPrefix} ${n}`,
      bodyStructure: { type: 'text/plain', partId: 'p1' },
      bodyValues: { p1: { value: `inbox baseline ${n}` } },
    };
  }
  const payload = await jmapRequest(jmap, [[
    'Email/set',
    { accountId: jmap.accountId, create },
    'baselineSeed',
  ]]);
  const set = pickResponse(payload, 'Email/set');
  if (set?.notCreated && Object.keys(set.notCreated).length > 0) {
    throw new Error(`Inbox baseline seed failed: ${JSON.stringify(set.notCreated)}`);
  }
  return target;
}

// Idempotent: ensures the role-bearing Archive mailbox exists for
// the current account. Stalwart auto-creates the standard role
// mailboxes (Inbox/Drafts/Sent/Archive/...) on first JMAP session
// for a principal, but we don't want tests to depend on that
// timing or implementation detail. If the lookup misses, create
// one explicitly.
export async function ensureArchiveMailbox(jmap) {
  const mailboxes = await listMailboxes(jmap);
  const archive = mailboxByRole(mailboxes, 'archive');
  if (archive) return archive;
  const payload = await jmapRequest(jmap, [[
    'Mailbox/set',
    {
      accountId: jmap.accountId,
      create: { mb1: { name: 'Archive', role: 'archive' } },
    },
    'mb1',
  ]]);
  const set = pickResponse(payload, 'Mailbox/set');
  if (set?.notCreated?.mb1) {
    throw new Error(`Could not create Archive mailbox: ${JSON.stringify(set.notCreated.mb1)}`);
  }
  const created = set?.created?.mb1;
  if (!created?.id) throw new Error(`Mailbox/set returned no id for Archive: ${JSON.stringify(set)}`);
  return { id: created.id, name: 'Archive', role: 'archive' };
}

// Idempotent. Counts messages currently in `archiveMailboxId`,
// fills the gap up to `target` in batches, and returns the final
// total. Tests that need a "large folder" scroll target (e.g.
// list-scroll, mail-flow) call this from their describe-level
// `beforeAll` so they're self-sufficient on a fresh account
// (no separate `npm run stack:seed` step required), and a no-op
// on an account that's already populated. Subjects use the
// `Seed e2e archive N` shape; sweeps in shared-session.js are
// careful not to FTS-match this prefix.
export async function ensureArchivePopulated(jmap, {
  archiveMailboxId,
  fromEmail,
  target = 1500,
  batchSize = 500,
  concurrency = 4,
  subjectPrefix = 'Seed e2e archive',
} = {}) {
  if (!archiveMailboxId) throw new Error('ensureArchivePopulated requires archiveMailboxId');
  if (!fromEmail) throw new Error('ensureArchivePopulated requires fromEmail');

  const countPayload = await jmapRequest(jmap, [[
    'Email/query',
    {
      accountId: jmap.accountId,
      filter: { inMailbox: archiveMailboxId },
      limit: 1,
      calculateTotal: true,
    },
    'archiveCount',
  ]]);
  const existing = pickResponse(countPayload, 'Email/query')?.total ?? 0;
  if (existing >= target) return existing;

  const needed = target - existing;
  const batchTasks = [];
  for (let offset = 0; offset < needed; offset += batchSize) {
    const batchOffset = offset;
    const batchCount = Math.min(batchSize, needed - offset);
    batchTasks.push(async () => {
      const create = {};
      for (let i = 0; i < batchCount; i += 1) {
        const n = existing + batchOffset + i;
        create[`a${n}`] = {
          mailboxIds: { [archiveMailboxId]: true },
          keywords: {},
          from: [{ email: fromEmail }],
          to: [{ email: fromEmail }],
          subject: `${subjectPrefix} ${n}`,
          bodyStructure: { type: 'text/plain', partId: 'p1' },
          bodyValues: { p1: { value: `archive seed ${n}` } },
        };
      }
      const payload = await jmapRequest(jmap, [[
        'Email/set',
        { accountId: jmap.accountId, create },
        `archiveSeed${batchOffset}`,
      ]]);
      const set = pickResponse(payload, 'Email/set');
      if (set?.notCreated && Object.keys(set.notCreated).length > 0) {
        throw new Error(`Archive seed batch ${batchOffset} failed: ${JSON.stringify(set.notCreated)}`);
      }
    });
  }
  await runWithConcurrency(batchTasks, concurrency);
  return target;
}

export async function createEmailsInMailbox(jmap, {
  mailboxId,
  fromEmail,
  subjectPrefix,
  count,
  batchSize = 500,
  concurrency = 4,
}) {
  const batchTasks = [];
  for (let offset = 0; offset < count; offset += batchSize) {
    const batchOffset = offset;
    const batchCount = Math.min(batchSize, count - offset);
    batchTasks.push(async () => {
      const create = {};
      for (let i = 0; i < batchCount; i += 1) {
        const n = batchOffset + i;
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
        throw new Error(`Could not create bulk test email batch ${batchOffset}: ${JSON.stringify(set.notCreated)}`);
      }
      const createdEntries = Object.entries(set?.created ?? {})
        .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)));
      const batchIds = [];
      for (const [, value] of createdEntries) {
        if (value?.id) batchIds.push(value.id);
      }
      return { offset: batchOffset, count: createdEntries.length, ids: batchIds };
    });
  }
  const batchResults = await runWithConcurrency(batchTasks, concurrency);
  batchResults.sort((a, b) => a.offset - b.offset);
  const ids = [];
  let created = 0;
  for (const result of batchResults) {
    ids.push(...result.ids);
    created += result.count;
  }
  if (created !== count) {
    throw new Error(`Bulk create expected ${count} messages, created ${created}`);
  }
  return ids;
}

// Destroy a known set of email ids in chunked, concurrent Email/set
// requests. Skips the Email/query phase that sweepOrphanTestMessages
// pays. Tests that already track the ids they created should call
// this from their finally block before falling back to the sweep.
export async function destroyEmails(jmap, ids, {
  chunkSize = 500,
  concurrency = 4,
} = {}) {
  if (!ids || ids.length === 0) return;
  const chunks = [];
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    chunks.push(ids.slice(offset, offset + chunkSize));
  }
  const tasks = chunks.map((chunk, idx) => async () => {
    const payload = await jmapRequest(jmap, [[
      'Email/set',
      { accountId: jmap.accountId, destroy: chunk },
      `bulkDestroy${idx}`,
    ]]);
    const set = pickResponse(payload, 'Email/set');
    if (set?.notDestroyed && Object.keys(set.notDestroyed).length > 0) {
      // Some ids may be already-destroyed from an earlier sweep; those
      // are expected. Surface unexpected failures so the test fails
      // loudly rather than leaking mail into the next run.
      const errors = Object.entries(set.notDestroyed).filter(
        ([, err]) => (err?.type ?? '') !== 'notFound',
      );
      if (errors.length > 0) {
        throw new Error(`destroyEmails failed: ${JSON.stringify(errors)}`);
      }
    }
  });
  await runWithConcurrency(tasks, concurrency);
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

// Sweep test messages with a given subject prefix (or set of
// prefixes). Tests should call this at suite-orphan-cleanup time
// (e.g. globalSetup or describe-level beforeAll) rather than per
// test, because the cost is proportional to backlog and we don't
// want every test paying for it.
export async function sweepOrphanTestMessages(jmap, {
  subjectPrefix = 'Delete e2e',
  // Pass `subjectPrefixes` (array) to clear several prefixes in
  // one round trip via an OR'd filter — ~10x faster than calling
  // this helper once per prefix.
  subjectPrefixes = null,
  throwOnError = false,
  budgetMs = 10_000,
  pageSize = 1000,
  maxIterations = 10,
} = {}) {
  try {
    const prefixes = subjectPrefixes ?? [subjectPrefix];
    const mailboxes = await listMailboxes(jmap);
    const sent = mailboxes.find((m) => m.role === 'sent');
    const subjectClause = prefixes.length === 1
      ? { subject: prefixes[0] }
      : { operator: 'OR', conditions: prefixes.map((p) => ({ subject: p })) };
    const filter = sent
      ? {
        operator: 'AND',
        conditions: [
          subjectClause,
          { operator: 'NOT', conditions: [{ inMailbox: sent.id }] },
        ],
      }
      : subjectClause;

    const deadline = Date.now() + budgetMs;
    for (let iter = 0; iter < maxIterations; iter += 1) {
      if (Date.now() > deadline) {
        console.warn(`[jmap-client] sweepOrphanTestMessages budget exceeded after ${iter} iterations; orphans may remain`);
        return;
      }
      const payload = await jmapRequest(jmap, [[
        'Email/query',
        { accountId: jmap.accountId, filter, limit: pageSize },
        'q1',
      ]]);
      const ids = pickResponse(payload, 'Email/query')?.ids ?? [];
      if (ids.length === 0) return;
      await destroyEmails(jmap, ids);
    }
    console.warn(`[jmap-client] sweepOrphanTestMessages hit max iterations (${maxIterations}); orphans may remain`);
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
