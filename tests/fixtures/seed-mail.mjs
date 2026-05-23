import {
  connectJmap,
  jmapRequest,
  listMailboxes,
  mailboxByRole,
  pickResponse,
  sweepOrphanTestMessages,
} from '../e2e/helpers/jmap-client.js';
import {
  JMAP_BASE_URL,
  OIDC_CLIENT_ID,
  OIDC_ISSUER,
  selfEmail,
  TEST_OIDC_EMAIL,
} from '../e2e/helpers/stack-env.js';

const ARCHIVE_TARGET = Number(process.env.SEED_ARCHIVE_COUNT ?? 1500);
const INBOX_PLAIN_COUNT = Number(process.env.SEED_INBOX_PLAIN ?? 10);
const BATCH = 100;

const TALL_HTML_SUBJECT = 'Seed e2e tall HTML message';
const TALL_HTML_BODY = `<!DOCTYPE html><html><body>${Array.from({ length: 120 }, (_, i) => `<p>Paragraph ${i} — ${'Lorem ipsum dolor sit amet. '.repeat(8)}</p>`).join('')}</body></html>`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('[seed-mail] connecting via', JMAP_BASE_URL);
  const jmap = await connectJmap();
  const fromEmail = selfEmail();
  let mailboxes = await listMailboxes(jmap);
  await ensureIdentity(jmap, fromEmail);
  mailboxes = await ensureUserMailboxes(jmap, mailboxes);

  await sweepOrphanTestMessages(jmap, { subjectPrefix: 'Seed e2e inbox' });
  await sweepOrphanTestMessages(jmap, { subjectPrefix: TALL_HTML_SUBJECT });
  await sweepOrphanTestMessages(jmap, { subjectPrefix: 'Delete e2e' });
  await sweepOrphanTestMessages(jmap, { subjectPrefix: 'Bulk delete e2e' });
  await sweepOrphanTestMessages(jmap, { subjectPrefix: 'Ghost refresh e2e' });
  await sweepOrphanTestMessages(jmap, { subjectPrefix: 'Push delivery e2e' });
  await sweepOrphanTestMessages(jmap, { subjectPrefix: 'Failed to deliver message' });
  await sweepOrphanTestMessages(jmap, { subjectPrefix: 'Raw WS push probe' });
  await sweepOrphanTestMessages(jmap, { subjectPrefix: 'SMTP probe' });
  await sweepOrphanTestMessages(jmap, { subjectPrefix: 'SMTP auth probe' });

  const inbox = mailboxByRole(mailboxes, 'inbox');
  let archive = mailboxByRole(mailboxes, 'archive');
  if (!inbox) throw new Error('No Inbox mailbox found — provision Thundermail first');

  if (!archive) {
    archive = mailboxes.find((m) => /archive/i.test(m.name ?? '')) ?? null;
  }
  if (!archive) {
    console.warn('[seed-mail] No Archive mailbox; creating one');
    const createMb = await jmapRequest(jmap, [[
      'Mailbox/set',
      {
        accountId: jmap.accountId,
        create: {
          mb1: { name: 'Archive', role: 'archive' },
        },
      },
      'ms1',
    ]]);
    const created = pickResponse(createMb, 'Mailbox/set')?.created?.mb1;
    if (!created?.id) throw new Error('Could not create Archive mailbox');
    archive = { id: created.id, name: 'Archive', role: 'archive' };
  }

  console.log(`[seed-mail] seeding tall HTML + ${INBOX_PLAIN_COUNT} inbox messages`);
  const inboxCreate = {
    tall: buildSeedEmail({
      mailboxId: inbox.id,
      fromEmail,
      subject: TALL_HTML_SUBJECT,
      bodyText: 'Plain fallback for tall HTML seed message.',
      htmlBody: TALL_HTML_BODY,
    }),
  };
  for (let i = 0; i < INBOX_PLAIN_COUNT; i += 1) {
    inboxCreate[`i${i}`] = buildSeedEmail({
      mailboxId: inbox.id,
      fromEmail,
      subject: `Seed e2e inbox ${i}`,
      bodyText: `seed inbox message ${i}`,
    });
  }
  const inboxPayload = await jmapRequest(jmap, [[
    'Email/set',
    { accountId: jmap.accountId, create: inboxCreate },
    'inboxSeed',
  ]]);
  const inboxSet = pickResponse(inboxPayload, 'Email/set');
  if (inboxSet?.notCreated && Object.keys(inboxSet.notCreated).length > 0) {
    throw new Error(`Inbox seed failed: ${JSON.stringify(inboxSet.notCreated)}`);
  }

  let existingTotal = await countArchiveMessages(jmap, archive.id);
  if (existingTotal > ARCHIVE_TARGET) {
    await pruneArchiveMessages(jmap, archive.id, existingTotal - ARCHIVE_TARGET);
    existingTotal = await countArchiveMessages(jmap, archive.id);
  }

  const needed = Math.max(0, ARCHIVE_TARGET - existingTotal);
  console.log(`[seed-mail] archive has ${existingTotal}, creating ${needed} more (target ${ARCHIVE_TARGET})`);

  for (let offset = 0; offset < needed; offset += BATCH) {
    const count = Math.min(BATCH, needed - offset);
    const create = {};
    for (let i = 0; i < count; i += 1) {
      const n = existingTotal + offset + i;
      create[`a${n}`] = {
        mailboxIds: { [archive.id]: true },
        keywords: {},
        from: [{ email: fromEmail }],
        to: [{ email: fromEmail }],
        subject: `Seed e2e archive ${n}`,
        bodyStructure: { type: 'text/plain', partId: 'p1' },
        bodyValues: { p1: { value: `archive seed ${n}` } },
      };
    }
    const payload = await jmapRequest(jmap, [[
      'Email/set',
      { accountId: jmap.accountId, create },
      's1',
    ]]);
    const set = pickResponse(payload, 'Email/set');
    if (set?.notCreated && Object.keys(set.notCreated).length > 0) {
      throw new Error(`Archive batch failed: ${JSON.stringify(set.notCreated)}`);
    }
    console.log(`[seed-mail] archive batch ${offset + count}/${needed}`);
    await sleep(250);
  }

  console.log('[seed-mail] done');
  console.log(JSON.stringify({
    jmap: JMAP_BASE_URL,
    oidc: OIDC_ISSUER,
    client: OIDC_CLIENT_ID,
    user: TEST_OIDC_EMAIL,
    thundermail: fromEmail,
    tallHtmlSubject: TALL_HTML_SUBJECT,
    archiveTarget: ARCHIVE_TARGET,
  }, null, 2));
}

async function countArchiveMessages(jmap, mailboxId) {
  const payload = await jmapRequest(jmap, [[
    'Email/query',
    {
      accountId: jmap.accountId,
      filter: { inMailbox: mailboxId },
      limit: 1,
      calculateTotal: true,
    },
    'archiveCount',
  ]]);
  return pickResponse(payload, 'Email/query')?.total ?? 0;
}

async function pruneArchiveMessages(jmap, mailboxId, excess) {
  console.log(`[seed-mail] pruning ${excess} excess archive messages`);
  let remaining = excess;
  while (remaining > 0) {
    const queryPayload = await jmapRequest(jmap, [[
      'Email/query',
      {
        accountId: jmap.accountId,
        filter: { inMailbox: mailboxId },
        sort: [{ property: 'receivedAt', isAscending: false }],
        position: ARCHIVE_TARGET,
        limit: Math.min(BATCH, remaining),
      },
      'archivePruneQuery',
    ]]);
    const ids = pickResponse(queryPayload, 'Email/query')?.ids ?? [];
    if (ids.length === 0) {
      return;
    }
    const destroyPayload = await jmapRequest(jmap, [[
      'Email/set',
      { accountId: jmap.accountId, destroy: ids },
      'archivePruneDestroy',
    ]]);
    const set = pickResponse(destroyPayload, 'Email/set');
    if (set?.notDestroyed && Object.keys(set.notDestroyed).length > 0) {
      throw new Error(`Archive prune failed: ${JSON.stringify(set.notDestroyed)}`);
    }
    remaining -= ids.length;
    console.log(`[seed-mail] pruned archive batch ${excess - remaining}/${excess}`);
    await sleep(750);
  }
}

function buildSeedEmail({
  mailboxId,
  fromEmail,
  subject,
  bodyText = 'e2e disposable message',
  htmlBody = null,
}) {
  const email = {
    mailboxIds: { [mailboxId]: true },
    keywords: {},
    from: [{ email: fromEmail }],
    to: [{ email: fromEmail }],
    subject,
  };
  if (htmlBody) {
    email.bodyStructure = {
      type: 'multipart/alternative',
      subParts: [
        { type: 'text/plain', partId: 'p1' },
        { type: 'text/html', partId: 'p2' },
      ],
    };
    email.bodyValues = {
      p1: { value: bodyText },
      p2: { value: htmlBody },
    };
  } else {
    email.bodyStructure = { type: 'text/plain', partId: 'p1' };
    email.bodyValues = { p1: { value: bodyText } };
  }
  return email;
}

// Example arbitrary-name folders that demonstrate the "Folders" section in
// the sidebar. Nested entries become children of the parent name. Names are
// matched case-insensitively against existing mailboxes so re-running this
// seed is idempotent.
const USER_MAILBOXES = [
  { name: 'Archives' },
  { name: 'Bugzilla-Bugs' },
  { name: 'business' },
  {
    name: 'bug-components',
    children: [{ name: 'calendar' }],
  },
  { name: 'media' },
  { name: 'My-Bugs' },
  { name: 'orders' },
  { name: 'tb-election' },
  { name: 'tripthings' },
];

async function ensureUserMailboxes(jmap, mailboxes) {
  const full = await fetchMailboxesWithParent(jmap);
  const byKey = new Map(
    full.map((m) => [mailboxKey(m.name, m.parentId ?? null), m]),
  );

  const create = {};
  const pending = [];

  function planCreate(name, parentId, ref) {
    const key = mailboxKey(name, parentId);
    if (byKey.has(key)) {
      pending.push({ ref, mailbox: byKey.get(key) });
      return;
    }
    create[ref] = parentId
      ? { name, parentId }
      : { name };
    pending.push({ ref, mailbox: null, name, parentId });
  }

  USER_MAILBOXES.forEach((entry, i) => {
    planCreate(entry.name, null, `u${i}`);
  });
  if (Object.keys(create).length > 0) {
    const payload = await jmapRequest(jmap, [[
      'Mailbox/set',
      { accountId: jmap.accountId, create },
      'usMb',
    ]]);
    const set = pickResponse(payload, 'Mailbox/set');
    if (set?.notCreated && Object.keys(set.notCreated).length > 0) {
      throw new Error(`User mailbox seed failed: ${JSON.stringify(set.notCreated)}`);
    }
    for (const entry of pending) {
      if (entry.mailbox) continue;
      const created = set?.created?.[entry.ref];
      if (created?.id) {
        const next = { id: created.id, name: entry.name, parentId: entry.parentId, role: null };
        mailboxes = [...mailboxes, next];
        byKey.set(mailboxKey(next.name, next.parentId), next);
      }
    }
  }

  // Second pass for any children of just-created parents.
  const childCreate = {};
  const childPending = [];
  USER_MAILBOXES.forEach((entry, i) => {
    if (!entry.children) return;
    const parent = byKey.get(mailboxKey(entry.name, null));
    if (!parent) return;
    entry.children.forEach((child, j) => {
      const key = mailboxKey(child.name, parent.id);
      if (byKey.has(key)) return;
      const ref = `u${i}c${j}`;
      childCreate[ref] = { name: child.name, parentId: parent.id };
      childPending.push({ ref, name: child.name, parentId: parent.id });
    });
  });
  if (Object.keys(childCreate).length > 0) {
    const payload = await jmapRequest(jmap, [[
      'Mailbox/set',
      { accountId: jmap.accountId, create: childCreate },
      'usMbChildren',
    ]]);
    const set = pickResponse(payload, 'Mailbox/set');
    if (set?.notCreated && Object.keys(set.notCreated).length > 0) {
      throw new Error(`User mailbox child seed failed: ${JSON.stringify(set.notCreated)}`);
    }
    for (const entry of childPending) {
      const created = set?.created?.[entry.ref];
      if (created?.id) {
        const next = { id: created.id, name: entry.name, parentId: entry.parentId, role: null };
        mailboxes = [...mailboxes, next];
        byKey.set(mailboxKey(next.name, next.parentId), next);
      }
    }
  }

  return mailboxes;
}

function mailboxKey(name, parentId) {
  return `${parentId ?? ''}::${String(name ?? '').toLowerCase()}`;
}

async function fetchMailboxesWithParent(jmap) {
  const payload = await jmapRequest(jmap, [[
    'Mailbox/get',
    {
      accountId: jmap.accountId,
      properties: ['id', 'name', 'role', 'parentId'],
    },
    'mbFull',
  ]]);
  return pickResponse(payload, 'Mailbox/get')?.list ?? [];
}

async function ensureIdentity(jmap, fromEmail) {
  const payload = await jmapRequest(jmap, [[
    'Identity/get',
    { accountId: jmap.accountId },
    'i0',
  ]]);
  const list = pickResponse(payload, 'Identity/get')?.list ?? [];
  if (list.some((identity) => identity.email === fromEmail)) {
    return;
  }
  console.log(`[seed-mail] creating JMAP identity for ${fromEmail}`);
  const createPayload = await jmapRequest(jmap, [[
    'Identity/set',
    {
      accountId: jmap.accountId,
      create: {
        i1: {
          name: fromEmail,
          email: fromEmail,
        },
      },
    },
    'i1',
  ]]);
  const set = pickResponse(createPayload, 'Identity/set');
  if (set?.notCreated && Object.keys(set.notCreated).length > 0) {
    throw new Error(`Identity create failed: ${JSON.stringify(set.notCreated)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
