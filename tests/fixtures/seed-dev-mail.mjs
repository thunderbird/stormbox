#!/usr/bin/env node
/**
 * Seed the *developer's* Thundermail account (the one signed into
 * via OIDC as admin@example.org by default) with realistic-looking
 * fake mail for screenshots, manual smoke testing, and demos.
 *
 * Distinct from `tests/fixtures/seed-mail.mjs`:
 *
 *   seed-mail.mjs        → e2e@example.org (the e2e Playwright account)
 *   seed-dev-mail.mjs    → admin@example.org (the developer account)
 *
 * Re-runnable: every seeded message carries the literal `[dev seed]`
 * subject prefix; the script pages through Email/query and removes
 * those messages before recreating them. Hand-curated mail in the
 * inbox is left alone.
 *
 * If the developer has not yet provisioned a Thundermail address
 * through http://localhost:8087, the JMAP session will have no
 * primary mail account and the script fails with a clear message.
 *
 * Optional env overrides:
 *   DEV_OIDC_USERNAME (default admin@example.org)
 *   DEV_OIDC_PASSWORD (default admin)
 *   DEV_OIDC_CLIENT_ID (default thunderbird-stormbox-test — the
 *     realm-imported client that has directAccessGrantsEnabled, so
 *     password-grant works without touching the regular SPA client)
 *   SEED_INBOX_COUNT   (default 30)
 *   SEED_ARCHIVE_COUNT (default 1500)
 */

import https from 'node:https';

import {
  JMAP_BASE_URL,
  OIDC_ISSUER,
} from '../e2e/helpers/stack-env.js';
import {
  jmapRequest,
  pickResponse,
  listMailboxes,
  mailboxByRole,
} from '../e2e/helpers/jmap-client.js';

const DEV_OIDC_USERNAME = process.env.DEV_OIDC_USERNAME ?? 'admin@example.org';
const DEV_OIDC_PASSWORD = process.env.DEV_OIDC_PASSWORD ?? 'admin';
const DEV_OIDC_CLIENT_ID = process.env.DEV_OIDC_CLIENT_ID ?? 'thunderbird-stormbox-test';

const INBOX_TARGET = Number(process.env.SEED_INBOX_COUNT ?? 30);
const ARCHIVE_TARGET = Number(process.env.SEED_ARCHIVE_COUNT ?? 1500);
const BATCH = 100;

const SUBJECT_PREFIX = '[dev seed]';

const tlsAgent = new https.Agent({ rejectUnauthorized: false });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
    const text = await response.text();
    throw new Error(
      `OIDC password grant failed for ${DEV_OIDC_USERNAME}: ${response.status} ${text}`,
    );
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
    const text = await sessionResponse.text().catch(() => '');
    throw new Error(
      `JMAP session fetch failed: ${sessionResponse.status} ${sessionResponse.statusText} ${text}`,
    );
  }
  const session = await sessionResponse.json();
  const mailAccountId = session.primaryAccounts?.['urn:ietf:params:jmap:mail'];
  if (!mailAccountId) {
    throw new Error(
      'JMAP session has no primary mail account. '
      + `Sign in to http://localhost:8087 as ${DEV_OIDC_USERNAME} and provision a Thundermail address first.`,
    );
  }
  const sessionPath = new URL(session.apiUrl).pathname.replace(/\/$/, '');
  return {
    apiUrl: `${jmapBase}${sessionPath}/`,
    accountId: mailAccountId,
    authHeader,
    session,
  };
}

async function ensureArchiveMailbox(jmap, mailboxes) {
  let archive = mailboxByRole(mailboxes, 'archive');
  if (archive) return { archive, created: false };

  console.log('[seed-dev-mail] no Archive role mailbox found; creating one');
  const payload = await jmapRequest(jmap, [[
    'Mailbox/set',
    {
      accountId: jmap.accountId,
      create: {
        mb1: { name: 'Archive', role: 'archive' },
      },
    },
    'ms1',
  ]]);
  const set = pickResponse(payload, 'Mailbox/set');
  const created = set?.created?.mb1;
  if (!created?.id) {
    throw new Error(`Could not create Archive mailbox: ${JSON.stringify(set?.notCreated ?? set)}`);
  }
  archive = { id: created.id, name: 'Archive', role: 'archive' };
  return { archive, created: true };
}

async function getDevFromAddress(jmap) {
  const payload = await jmapRequest(jmap, [[
    'Identity/get',
    { accountId: jmap.accountId },
    'i0',
  ]]);
  const list = pickResponse(payload, 'Identity/get')?.list ?? [];
  const primary = list[0];
  if (!primary?.email) {
    throw new Error('No identities found — provision a Thundermail address via the accounts UI first');
  }
  return primary.email;
}

/**
 * Find and destroy our own previous seed messages so re-running the
 * script doesn't accumulate duplicates.
 *
 * Stalwart's `subject` filter requires full-text indexing that the
 * dev stack does not enable, so a server-side filter returns 0 hits.
 * Instead we page through Email/query (no filter) and match the
 * SUBJECT_PREFIX locally on the metadata Email/get response.
 */
async function sweepDevSeeds(jmap) {
  const stale = [];
  let position = 0;
  while (true) {
    const queryPayload = await jmapRequest(jmap, [[
      'Email/query',
      {
        accountId: jmap.accountId,
        position,
        limit: BATCH,
        calculateTotal: true,
      },
      'q1',
    ]]);
    const ids = pickResponse(queryPayload, 'Email/query')?.ids ?? [];
    const total = pickResponse(queryPayload, 'Email/query')?.total ?? 0;
    if (ids.length === 0) break;
    const getPayload = await jmapRequest(jmap, [[
      'Email/get',
      {
        accountId: jmap.accountId,
        ids,
        properties: ['id', 'subject'],
      },
      'g1',
    ]]);
    const list = pickResponse(getPayload, 'Email/get')?.list ?? [];
    for (const email of list) {
      if (typeof email.subject === 'string' && email.subject.startsWith(SUBJECT_PREFIX)) {
        stale.push(email.id);
      }
    }
    position += ids.length;
    if (position >= total) break;
  }
  if (stale.length === 0) return;
  for (let i = 0; i < stale.length; i += BATCH) {
    const chunk = stale.slice(i, i + BATCH);
    const destroyPayload = await jmapRequest(jmap, [[
      'Email/set',
      { accountId: jmap.accountId, destroy: chunk },
      's1',
    ]]);
    const set = pickResponse(destroyPayload, 'Email/set');
    if (set?.notDestroyed && Object.keys(set.notDestroyed).length > 0) {
      throw new Error(`Sweep failed: ${JSON.stringify(set.notDestroyed)}`);
    }
  }
  console.log(`[seed-dev-mail] swept ${stale.length} previous dev-seed messages`);
}

/**
 * Build an Email/set create payload. `receivedAt` lets us spread
 * the seed mail across the last few weeks so the list isn't a wall
 * of identical timestamps. JMAP Email/set accepts receivedAt on
 * create for "imported" messages (RFC 8621 §4.6). `preview` is
 * server-computed and not settable here.
 */
function buildEmail({
  mailboxId,
  fromName, fromEmail,
  toEmail,
  subject,
  receivedAt,
  bodyText,
  htmlBody = null,
  keywords = {},
}) {
  const create = {
    mailboxIds: { [mailboxId]: true },
    keywords,
    from: [{ name: fromName, email: fromEmail }],
    to: [{ email: toEmail }],
    subject: `${SUBJECT_PREFIX} ${subject}`,
    receivedAt: new Date(receivedAt).toISOString(),
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
  return create;
}

// =============================================================
// Provider-themed HTML templates.
//
// Self-contained: every visual is inline CSS or coloured div, no
// external <img> URLs, so the safe-rendering iframe renders fully
// without network access.
// =============================================================

function netflixHtml({ showTitle, episodeTitle, runtime }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#000;color:#fff;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#000;padding:32px 24px">
  <div style="text-align:center;padding-bottom:24px">
    <span style="color:#e50914;font-size:32px;font-weight:900;letter-spacing:-1px">NETFLIX</span>
  </div>
  <h1 style="font-size:28px;margin:0 0 16px;color:#fff">New on Netflix this week</h1>
  <p style="font-size:16px;line-height:24px;color:#b3b3b3;margin:0 0 24px">
    Hand-picked because you watched <em>Stranger Things</em> and <em>Black Mirror</em>.
  </p>
  <div style="background:#141414;border-radius:4px;padding:0;margin-bottom:24px">
    <div style="background:linear-gradient(135deg,#831010 0%,#240505 100%);height:180px;border-radius:4px 4px 0 0"></div>
    <div style="padding:20px">
      <h2 style="margin:0 0 8px;color:#fff;font-size:22px">${showTitle}</h2>
      <p style="margin:0 0 4px;color:#b3b3b3;font-size:14px">Season 1 · Episode 1 · ${runtime}</p>
      <p style="margin:0 0 16px;color:#e6e6e6;font-size:15px;line-height:22px">${episodeTitle}</p>
      <a style="display:inline-block;background:#e50914;color:#fff;padding:12px 24px;text-decoration:none;font-weight:bold;border-radius:4px">▶ Play Now</a>
    </div>
  </div>
  ${['The Substitute', 'Long Bright River', 'Pandemic Diaries', 'Quiet on Set'].map((title, i) => `
  <div style="display:flex;gap:16px;padding:16px 0;border-top:1px solid #232323">
    <div style="width:80px;height:60px;background:linear-gradient(${135 + i * 25}deg,#${(0x331111 + i * 0x222233).toString(16)},#0a0a0a);border-radius:4px;flex-shrink:0"></div>
    <div style="flex:1">
      <p style="margin:0;color:#fff;font-weight:bold">${title}</p>
      <p style="margin:4px 0 0;color:#b3b3b3;font-size:14px">Limited Series · New episodes weekly</p>
    </div>
  </div>`).join('')}
  <p style="font-size:12px;color:#737373;text-align:center;margin:32px 0 0;line-height:18px">
    You're receiving this because you're a Netflix member. <a style="color:#737373;text-decoration:underline">Manage email preferences</a> · <a style="color:#737373;text-decoration:underline">Unsubscribe</a>
  </p>
  <p style="font-size:11px;color:#4d4d4d;text-align:center;margin:16px 0 0">Netflix · 100 Winchester Cir · Los Gatos, CA 95032</p>
</div>
</body></html>`;
}

function amazonHtml({ orderId, items, total, deliveryWindow }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f3f3f3;font-family:Amazon Ember,Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#232f3e;padding:16px 24px">
    <span style="color:#ff9900;font-size:24px;font-weight:bold;font-style:italic">amazon</span>
  </div>
  <div style="padding:24px">
    <h1 style="margin:0 0 8px;font-size:24px;color:#0f1111">Your order has shipped</h1>
    <p style="margin:0 0 24px;color:#565959;font-size:14px">Order #${orderId} · Arriving <strong style="color:#067d62">${deliveryWindow}</strong></p>
    <div style="border:1px solid #d5d9d9;border-radius:8px;overflow:hidden;margin-bottom:24px">
      <div style="background:#f0f2f2;padding:12px 16px;border-bottom:1px solid #d5d9d9">
        <strong style="color:#0f1111">Tracking: 1Z999AA10123456784</strong>
      </div>
      <div style="padding:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <span style="color:#0f1111;font-size:13px">📦 Shipped</span>
          <span style="color:#067d62;font-size:13px">✓ In transit</span>
          <span style="color:#aaa;font-size:13px">○ Out for delivery</span>
          <span style="color:#aaa;font-size:13px">○ Delivered</span>
        </div>
        <div style="height:6px;background:#d5d9d9;border-radius:3px;overflow:hidden">
          <div style="height:100%;width:50%;background:#067d62"></div>
        </div>
      </div>
    </div>
    <h2 style="margin:0 0 16px;font-size:18px;color:#0f1111">Items in this order</h2>
    ${items.map((item) => `
    <div style="display:flex;gap:16px;padding:16px 0;border-top:1px solid #ececec">
      <div style="width:72px;height:72px;background:#f7f7f7;border:1px solid #ececec;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:28px">📦</div>
      <div style="flex:1">
        <a style="color:#007185;font-size:14px;text-decoration:none">${item.title}</a>
        <p style="margin:4px 0 0;color:#565959;font-size:13px">Sold by ${item.seller}</p>
        <p style="margin:4px 0 0;font-size:15px;color:#0f1111"><strong>$${item.price}</strong> · Qty: ${item.qty}</p>
      </div>
    </div>`).join('')}
    <div style="border-top:2px solid #0f1111;margin-top:16px;padding-top:16px;text-align:right">
      <span style="color:#0f1111;font-size:14px">Order total: </span>
      <strong style="color:#b12704;font-size:18px">$${total}</strong>
    </div>
    <div style="margin-top:24px;text-align:center">
      <a style="display:inline-block;background:#ffd814;color:#0f1111;padding:10px 32px;text-decoration:none;border-radius:8px;border:1px solid #fcd200;font-size:14px">Track package</a>
    </div>
  </div>
  <div style="background:#232f3e;padding:16px 24px;color:#ddd;font-size:11px;text-align:center">
    <p style="margin:0">Amazon.com · 410 Terry Ave N · Seattle, WA 98109</p>
    <p style="margin:8px 0 0"><a style="color:#fff">Your Orders</a> · <a style="color:#fff">Contact Us</a> · <a style="color:#fff">Privacy</a></p>
  </div>
</div>
</body></html>`;
}

function linkedinHtml({ recipientName }) {
  const jobs = [
    { title: 'Staff Software Engineer', company: 'Discord', location: 'San Francisco, CA · Remote', salary: '$220K–$300K · Equity', tags: ['Rust', 'Distributed Systems'] },
    { title: 'Principal Engineer, Distributed Systems', company: 'Stripe', location: 'New York, NY · On-site', salary: '$280K–$380K', tags: ['Go', 'Kafka', 'Postgres'] },
    { title: 'Senior Backend Engineer', company: 'Anthropic', location: 'San Francisco, CA · Hybrid', salary: '$240K–$320K · 0.1%–0.5%', tags: ['Python', 'PyTorch'] },
    { title: 'Engineering Manager, Platform', company: 'Vercel', location: 'Remote', salary: '$260K–$340K', tags: ['Leadership', 'Edge'] },
    { title: 'Senior Software Engineer, Browser Platform', company: 'Mozilla', location: 'Remote', salary: '$210K–$270K', tags: ['Rust', 'C++', 'Browser internals'] },
    { title: 'Staff Engineer, Performance', company: 'Figma', location: 'San Francisco, CA · Hybrid', salary: '$260K–$340K', tags: ['Performance', 'WebGL'] },
  ];
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f3f2ef;font-family:Helvetica,Arial,sans-serif;color:#000">
<div style="max-width:580px;margin:0 auto;background:#fff">
  <div style="background:#0a66c2;padding:20px 24px">
    <span style="color:#fff;font-size:28px;font-weight:bold">Linked<span style="background:#fff;color:#0a66c2;padding:0 6px;border-radius:3px;display:inline-block;margin-left:1px">in</span></span>
  </div>
  <div style="padding:24px">
    <h1 style="margin:0 0 8px;font-size:22px">Hi ${recipientName}, your daily picks are ready</h1>
    <p style="margin:0 0 24px;color:#666;font-size:14px">${jobs.length} roles matched to your search · Updated 12 minutes ago</p>
    ${jobs.map((job) => `
    <div style="border:1px solid #e0e0e0;border-radius:8px;padding:16px;margin-bottom:12px">
      <h2 style="margin:0 0 4px;font-size:16px;color:#0a66c2">${job.title}</h2>
      <p style="margin:0;font-size:14px;color:#000"><strong>${job.company}</strong></p>
      <p style="margin:4px 0 0;font-size:13px;color:#666">${job.location}</p>
      <p style="margin:8px 0 8px;font-size:13px;color:#057642"><strong>${job.salary}</strong></p>
      <div style="margin:0 0 12px">
        ${job.tags.map((tag) => `<span style="display:inline-block;background:#f3f2ef;color:#000;padding:2px 8px;border-radius:10px;font-size:11px;margin-right:4px">${tag}</span>`).join('')}
      </div>
      <div style="display:flex;gap:8px">
        <a style="background:#0a66c2;color:#fff;padding:6px 16px;border-radius:16px;text-decoration:none;font-size:13px;font-weight:bold">Easy Apply</a>
        <a style="background:#fff;color:#0a66c2;border:1px solid #0a66c2;padding:6px 16px;border-radius:16px;text-decoration:none;font-size:13px;font-weight:bold">Save</a>
      </div>
    </div>`).join('')}
    <p style="text-align:center;margin:24px 0">
      <a style="color:#0a66c2;font-size:14px;font-weight:bold;text-decoration:none">See all 142 jobs ›</a>
    </p>
    <div style="border-top:1px solid #e0e0e0;padding-top:16px;margin-top:24px">
      <h3 style="margin:0 0 12px;font-size:15px;color:#666;text-transform:uppercase;letter-spacing:0.5px">People you may know</h3>
      ${['Sarah Chen', 'Marcus Lim', 'Priya Patel', 'Mei Tanaka', 'Diego Alvarez'].map((name) => `
      <div style="display:flex;gap:12px;align-items:center;padding:8px 0">
        <div style="width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#0a66c2,#004182);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:bold">${name.split(' ').map((p) => p[0]).join('')}</div>
        <div style="flex:1">
          <p style="margin:0;font-weight:bold;font-size:14px">${name}</p>
          <p style="margin:2px 0 0;font-size:13px;color:#666">Senior Engineer at Notion</p>
        </div>
        <a style="background:#fff;color:#0a66c2;border:1px solid #0a66c2;padding:4px 12px;border-radius:16px;text-decoration:none;font-size:13px;font-weight:bold">+ Connect</a>
      </div>`).join('')}
    </div>
    <div style="border-top:1px solid #e0e0e0;padding-top:16px;margin-top:24px">
      <h3 style="margin:0 0 12px;font-size:15px;color:#666;text-transform:uppercase;letter-spacing:0.5px">Recent activity from your network</h3>
      <div style="padding:8px 0">
        <p style="margin:0 0 4px;font-size:13px;color:#000"><strong>Jamie Liu</strong> shared a post</p>
        <p style="margin:0;font-size:14px;color:#000;line-height:20px">"Thoughts on the Postgres 17 incremental backups, after running them in production for two months. TL;DR: faster than expected on cold restores, with a subtle gotcha around WAL recycling — write-up below."</p>
        <p style="margin:8px 0 0;font-size:12px;color:#666">412 reactions · 28 comments</p>
      </div>
      <div style="padding:16px 0 8px;border-top:1px solid #f3f2ef">
        <p style="margin:0 0 4px;font-size:13px;color:#000"><strong>Anaya Singh</strong> celebrates a new role</p>
        <p style="margin:0;font-size:14px;color:#000;line-height:20px">"Starting Monday at Anthropic as a Senior Research Engineer. Grateful to my old team at Discord for five amazing years — and excited for what comes next."</p>
      </div>
    </div>
  </div>
  <div style="background:#f3f2ef;padding:16px;text-align:center;color:#666;font-size:11px">
    <p style="margin:0">© 2026 LinkedIn Corporation, 1000 W Maude Avenue, Sunnyvale, CA 94085. LinkedIn and the LinkedIn logo are registered trademarks.</p>
    <p style="margin:8px 0 0"><a style="color:#666">Unsubscribe</a> · <a style="color:#666">Help</a></p>
  </div>
</div>
</body></html>`;
}

function githubHtml({ repo, advisoryId, severity, packageName, packageVersion }) {
  const severityColor = severity === 'High' ? '#cf222e' : severity === 'Moderate' ? '#bf8700' : '#1f883d';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto">
  <div style="padding:16px 24px;border-bottom:1px solid #30363d">
    <span style="color:#e6edf3;font-size:14px;font-weight:600">⚙ GitHub</span>
  </div>
  <div style="padding:24px">
    <div style="display:inline-block;padding:4px 12px;border-radius:24px;background:${severityColor};color:#fff;font-size:12px;font-weight:bold;margin-bottom:16px">
      ⚠ ${severity} severity
    </div>
    <h1 style="margin:0 0 8px;font-size:22px;color:#e6edf3">Security advisory: ${advisoryId}</h1>
    <p style="margin:0 0 16px;color:#7d8590;font-size:14px">A vulnerability in a dependency of <a style="color:#2f81f7">${repo}</a> requires your attention.</p>
    <div style="background:#161b22;border:1px solid #30363d;border-radius:6px;padding:16px;margin-bottom:24px">
      <p style="margin:0 0 8px;font-size:13px;color:#7d8590">Vulnerable dependency</p>
      <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:14px">
        <span style="color:#e6edf3">${packageName}</span>
        <span style="color:#7d8590">@</span>
        <span style="color:#ff7b72">${packageVersion}</span>
      </p>
      <p style="margin:12px 0 0;font-size:13px;color:#7d8590">Upgrade path:</p>
      <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:14px;color:#3fb950">
        ${packageName}@${packageVersion.split('.').map((p, i) => i === 1 ? Number(p) + 1 : p).join('.')}
      </p>
    </div>
    <h2 style="font-size:16px;margin:0 0 12px;color:#e6edf3">Impact</h2>
    <p style="margin:0 0 16px;font-size:14px;line-height:22px;color:#c9d1d9">
      A maliciously crafted input could allow remote attackers to bypass the
      input validation routine and execute arbitrary code in the context of the
      affected service. Affects all installations using
      <code style="background:#161b22;padding:1px 6px;border-radius:3px;font-size:13px">${packageName}@&lt;1.5.0</code>.
    </p>
    <h2 style="font-size:16px;margin:0 0 12px;color:#e6edf3">CVSS</h2>
    <p style="margin:0 0 24px;font-size:14px;color:#c9d1d9">
      <strong style="color:${severityColor}">8.1</strong> ·
      AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H
    </p>
    <a style="display:inline-block;background:#238636;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px;border:1px solid rgba(240,246,252,0.1)">Review on GitHub →</a>
  </div>
  <div style="padding:16px 24px;border-top:1px solid #30363d;font-size:12px;color:#7d8590">
    <p style="margin:0">GitHub Inc. · 88 Colin P Kelly Jr St · San Francisco, CA 94107</p>
    <p style="margin:8px 0 0"><a style="color:#7d8590">Notification settings</a></p>
  </div>
</div>
</body></html>`;
}

function spotifyWrappedHtml({ recipientName, year, minutes, topArtist, topGenre }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#000;color:#fff;font-family:Circular,Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto">
  <div style="background:linear-gradient(135deg,#ff6437 0%,#a259ff 50%,#1ed760 100%);padding:48px 24px;text-align:center">
    <p style="margin:0 0 8px;color:rgba(0,0,0,0.7);font-size:14px;font-weight:bold;letter-spacing:2px">SPOTIFY</p>
    <h1 style="margin:0;font-size:64px;font-weight:900;color:#000;letter-spacing:-2px">Wrapped ${year}</h1>
    <p style="margin:16px 0 0;color:#000;font-size:18px">${recipientName}, your year in music is here</p>
  </div>
  <div style="background:#000;padding:32px 24px">
    <div style="background:#1ed760;border-radius:24px;padding:32px;margin-bottom:16px;text-align:center;color:#000">
      <p style="margin:0;font-size:14px;text-transform:uppercase;letter-spacing:2px;font-weight:bold">Listening time</p>
      <p style="margin:8px 0 0;font-size:72px;font-weight:900;letter-spacing:-3px">${minutes.toLocaleString()}</p>
      <p style="margin:0;font-size:18px;font-weight:bold">minutes</p>
      <p style="margin:16px 0 0;font-size:14px">You're in the top <strong>2%</strong> of ${topArtist} listeners.</p>
    </div>
    <div style="background:#a259ff;border-radius:24px;padding:32px;margin-bottom:16px;text-align:center;color:#fff">
      <p style="margin:0;font-size:14px;text-transform:uppercase;letter-spacing:2px;font-weight:bold">Top artist</p>
      <p style="margin:12px 0;font-size:40px;font-weight:900;letter-spacing:-1px">${topArtist}</p>
      <div style="width:120px;height:120px;border-radius:50%;background:#fff;margin:16px auto;display:flex;align-items:center;justify-content:center;color:#a259ff;font-size:48px;font-weight:bold">${topArtist.slice(0, 2)}</div>
    </div>
    <div style="background:#ff6437;border-radius:24px;padding:32px;margin-bottom:16px;text-align:center;color:#000">
      <p style="margin:0;font-size:14px;text-transform:uppercase;letter-spacing:2px;font-weight:bold">Top genre</p>
      <p style="margin:12px 0 0;font-size:40px;font-weight:900;letter-spacing:-1px">${topGenre}</p>
    </div>
    <div style="text-align:center;padding:24px 0">
      <a style="display:inline-block;background:#1ed760;color:#000;padding:14px 32px;border-radius:32px;text-decoration:none;font-weight:bold;font-size:16px">See your story →</a>
    </div>
  </div>
  <div style="background:#000;padding:24px;text-align:center;color:#999;font-size:11px;border-top:1px solid #222">
    <p style="margin:0">Spotify AB · Regeringsgatan 19 · 111 53 Stockholm · Sweden</p>
    <p style="margin:8px 0 0"><a style="color:#999">Privacy</a> · <a style="color:#999">Email preferences</a></p>
  </div>
</div>
</body></html>`;
}

/**
 * Long-form Substack-style newsletter (~7–8 KB HTML). 2× the size of
 * the original short version: more paragraphs, more subheads, a
 * pull-quote, and a footer block with related posts.
 */
function substackLongHtml({ title, author, subscribers }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#fff;font-family:Charter,Georgia,serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:32px 24px">
  <div style="text-align:center;padding-bottom:16px;border-bottom:1px solid #e0e0e0;margin-bottom:32px">
    <p style="margin:0;font-size:11px;color:#737373;letter-spacing:1px;text-transform:uppercase">${title}</p>
    <p style="margin:4px 0 0;font-size:13px;color:#737373">by ${author} · ${subscribers.toLocaleString()} subscribers</p>
  </div>
  <h1 style="margin:0 0 8px;font-size:32px;line-height:1.2;color:#1a1a1a;font-weight:700">The quiet collapse of the open web</h1>
  <p style="margin:0 0 32px;font-size:16px;color:#737373">A reckoning is coming for the platforms that ate the internet. Here's what comes next.</p>
  <p style="margin:0 0 16px;font-size:13px;color:#737373">Nov 18 · 18 min read</p>
  <p style="margin:0 0 24px;font-size:18px;line-height:1.65;color:#1a1a1a;font-style:italic;border-left:3px solid #1a1a1a;padding-left:16px">
    Every generation of the web has been built on top of the assumptions
    of the one before it. The platforms that defined the last decade are
    quietly being replaced by something stranger, smaller, and more
    deliberately weird.
  </p>
  <p style="margin:0 0 16px;font-size:17px;line-height:1.7">
    Twelve months ago, almost every conversation I had with founders, journalists, and product
    people in this industry ended the same way: <em>"so what do you make of LLMs?"</em>
    Today, the question has narrowed. People don't ask whether models will change the shape
    of the web. They ask which parts of the web are going to survive the change, and what's
    going to replace the rest.
  </p>
  <p style="margin:0 0 16px;font-size:17px;line-height:1.7">
    Let me start with a small and very specific observation: the open RSS reader I use every
    morning has been my primary news source for sixteen years. It still works. The protocol
    underneath it (RSS 2.0, lightly extended by Atom) has not meaningfully changed in two
    decades. Most of the publications it indexes have, over that time, moved their primary
    business model from advertising to subscriptions to mailing lists. The pipe stayed the
    same; the water inside it changed three times.
  </p>
  <h2 style="margin:32px 0 12px;font-size:22px">1. The platforms ate the web, and now they're being eaten</h2>
  <p style="margin:0 0 16px;font-size:17px;line-height:1.7">
    The dominant metaphor of the 2010s — "platforms" — was a careful piece of language. It
    sold the idea that a small number of intermediaries could be neutral arbiters between
    creators and audiences. As we know now, they were not. The platforms behaved like utilities
    until they had market power, and then they behaved like landlords.
  </p>
  <p style="margin:0 0 16px;font-size:17px;line-height:1.7">
    Google's enshittification of search, Meta's algorithmic feeds, the slow death of public
    Twitter — these are not separate phenomena. They are all symptoms of the same underlying
    process: the systematic conversion of public goods into private capture. The mechanism is
    always the same: aggregate creators, optimise for engagement, monetise attention, raise
    rents on both sides of the network.
  </p>
  <p style="margin:0 0 16px;font-size:17px;line-height:1.7">
    Once the rents are extractive enough, both sides of the network start to look for an exit.
    Creators are first — they have the most to lose and the most agency. They leave for
    newsletters, Discords, group chats, podcasts, and personal websites. Audiences follow,
    slowly, and largely against their inclination, because the platforms have spent a decade
    making it hard to leave.
  </p>
  <h2 style="margin:32px 0 12px;font-size:22px">2. The cracks that are showing</h2>
  <p style="margin:0 0 16px;font-size:17px;line-height:1.7">
    What's interesting now is that the post-platform web is taking very specific, identifiable
    shapes. Newsletters. Discords. Group chats. Small federated networks. Personal websites
    again, of all things. The forms are not new; what's new is that smart people are choosing
    them over the platforms, on purpose, with their eyes open.
  </p>
  <p style="margin:0 0 16px;font-size:17px;line-height:1.7">
    Every one of these forms has, in its own way, traded scale for control. A newsletter
    cannot grow as quickly as a TikTok account, but the author owns the list and the
    relationship with the reader. A Discord cannot reach a billion people, but its members
    aren't there because an algorithm pushed them — they're there because they made an
    affirmative choice. A personal website cannot be promoted in a feed, but it also cannot
    be demoted by one.
  </p>
  <p style="margin:0 0 16px;font-size:17px;line-height:1.7">
    The trade is consistent and it is deliberate. The new shapes of the web are smaller,
    slower, and harder to monetise — and the people building them are clear-eyed about why.
  </p>
  <h2 style="margin:32px 0 12px;font-size:22px">3. What replaces the platforms</h2>
  <p style="margin:0 0 16px;font-size:17px;line-height:1.7">
    If I had to bet on one specific thing, it would be that the next layer of the consumer
    web is dominated not by new platforms but by <em>tools</em>. The web of the 2010s was a
    web of services: you signed up for an account on a platform run by someone else, and
    you played by their rules. The web of the 2020s is increasingly a web of tools: you
    install a piece of software (often as a webapp, sometimes as a desktop or mobile app)
    that does specific work for you, and the data and audience and brand stay with you.
  </p>
  <p style="margin:0 0 16px;font-size:17px;line-height:1.7">
    Substack, the platform you're reading this on, is somewhere on the spectrum between the
    two. So is GitHub. So is Notion. So is most of the modern productivity stack. They have
    network effects, but the network effects are weaker than the platforms that came before
    them, and the user has more control. Whether this is permanent, or whether the next
    generation of "tools" enshittifies on the same fifteen-year cycle, is the question I keep
    asking myself.
  </p>
  <h2 style="margin:32px 0 12px;font-size:22px">4. The role of small models</h2>
  <p style="margin:0 0 16px;font-size:17px;line-height:1.7">
    The other thing I'm watching closely is the rise of capable small models that you can run
    locally. The default assumption a year ago was that all consumer AI would run in
    someone else's datacenter, and that the platforms that owned the datacenters would own
    the experience. That assumption is starting to break.
  </p>
  <p style="margin:0 0 16px;font-size:17px;line-height:1.7">
    A capable 7B-parameter model running on a M-series Mac is now, for most everyday
    knowledge-work tasks, indistinguishable from a hosted model running on a million-dollar
    cluster. The remaining gap is in cutting-edge research tasks (reasoning, very large
    contexts, multimodal) and in raw speed for very simple tasks where datacenter inference
    is just faster. For the median user, the gap has closed. And the gap that remains is
    closing fast.
  </p>
  <p style="margin:0 0 16px;font-size:17px;line-height:1.7">
    The implication is that the AI-platform thesis — that a small number of intermediaries
    will own the layer between users and models — has a much shorter window than people
    thought. The same forces that pulled the social web back toward newsletters and
    personal sites are going to pull the AI web back toward local-first tools.
  </p>
  <h2 style="margin:32px 0 12px;font-size:22px">5. What to do about it</h2>
  <p style="margin:0 0 16px;font-size:17px;line-height:1.7">
    I think the practical advice for anyone building consumer software in 2026 is simple, if
    uncomfortable. Build tools that work without a platform. Own your distribution. Treat
    the open web as infrastructure, not as competition. Assume that the platforms you build
    on will get worse over time, and design so that you can leave when they do.
  </p>
  <p style="margin:0 0 16px;font-size:17px;line-height:1.7">
    I think this is the most under-reported story of the year. The platforms aren't going
    away — they are still where most attention is, by a wide margin — but the shape of the
    web underneath them is quietly changing, and it's changing in a direction that is hard
    to put back in the bottle. Continue reading on the site →
  </p>
  <div style="text-align:center;margin:48px 0">
    <a style="display:inline-block;background:#ff6719;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px">Read on Substack</a>
  </div>
  <div style="border-top:1px solid #e0e0e0;padding-top:24px">
    <h3 style="margin:0 0 16px;font-size:14px;color:#737373;text-transform:uppercase;letter-spacing:1px">Related posts</h3>
    ${[
      'The collapse of search and the rise of curation',
      'Why every modern app wants to be an inbox',
      'Newsletters are the new homepage',
      'The end of "default" in consumer software',
    ].map((t) => `
    <div style="padding:12px 0;border-top:1px solid #f0f0f0">
      <a style="color:#1a1a1a;font-weight:bold;font-size:15px;text-decoration:none">${t}</a>
      <p style="margin:4px 0 0;font-size:13px;color:#737373">Nov 12 · 8 min read</p>
    </div>`).join('')}
  </div>
  <div style="border-top:1px solid #e0e0e0;padding-top:24px;margin-top:32px;text-align:center;font-size:13px;color:#737373">
    <p style="margin:0">You're receiving this because you subscribe to ${title}.</p>
    <p style="margin:8px 0 0"><a style="color:#737373">Unsubscribe</a> · <a style="color:#737373">Get the app</a></p>
  </div>
</div>
</body></html>`;
}

/**
 * Product-changelog email in the Linear / Vercel / Figma genre.
 * ~10 KB; long because real product updates list a lot of items.
 */
function productChangelogHtml({ productName, version, releaseDate }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;color:#f3f3f3;font-family:Inter,-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">
<div style="max-width:640px;margin:0 auto;background:#0a0a0a">
  <div style="padding:32px 24px;text-align:left;border-bottom:1px solid #1f1f1f">
    <p style="margin:0;font-size:13px;color:#888;letter-spacing:0.5px">${productName.toUpperCase()} · CHANGELOG · ${releaseDate}</p>
    <h1 style="margin:8px 0 0;font-size:36px;font-weight:700;letter-spacing:-1px;color:#fff">v${version}</h1>
    <p style="margin:8px 0 0;color:#bbb;font-size:16px;line-height:24px">
      The biggest release we've shipped this year. Faster, richer, and with a long-requested
      offline mode.
    </p>
  </div>
  <div style="padding:32px 24px">
    <div style="display:inline-block;padding:4px 10px;border-radius:12px;background:#1f3a1f;color:#3fb950;font-size:11px;font-weight:700;letter-spacing:0.5px;margin-bottom:24px">NEW</div>

    <h2 style="margin:0 0 12px;font-size:22px;color:#fff">Offline-first sync</h2>
    <p style="margin:0 0 16px;font-size:15px;color:#c0c0c0;line-height:24px">
      ${productName} now persists every workspace locally, with full read/write support
      when you're offline. Changes queue up in a local outbox and replay when the
      connection returns. We've been running this in beta with a few hundred teams for
      the last quarter — feedback was overwhelmingly positive.
    </p>
    <ul style="margin:0 0 24px;padding:0 0 0 20px;color:#c0c0c0;font-size:15px;line-height:26px">
      <li>Full keyboard navigation works offline</li>
      <li>Comments and reactions queue up and sync when reconnected</li>
      <li>Conflict resolution UI shows you exactly what changed on the server</li>
      <li>Optional encrypted local cache (opt-in per workspace)</li>
    </ul>

    <h2 style="margin:24px 0 12px;font-size:22px;color:#fff">A faster, quieter UI</h2>
    <p style="margin:0 0 16px;font-size:15px;color:#c0c0c0;line-height:24px">
      We rewrote the rendering layer from the ground up. List virtualisation now handles
      mailboxes with over 100k items without breaking a sweat. Initial paint is down 62%
      on cold start and 80% on warm start.
    </p>
    <div style="background:#161616;border:1px solid #282828;border-radius:8px;padding:20px;margin:0 0 24px">
      <p style="margin:0 0 4px;color:#3fb950;font-size:13px;font-weight:600">Benchmark · cold start</p>
      <p style="margin:0 0 12px;color:#888;font-size:12px">100k items, M2 Pro, latest Safari</p>
      <div style="display:flex;align-items:end;gap:8px;height:80px">
        <div style="background:#3fb950;width:60px;height:30%;border-radius:4px 4px 0 0;position:relative">
          <span style="position:absolute;top:-20px;left:0;color:#fff;font-size:11px">320ms</span>
        </div>
        <div style="background:#888;width:60px;height:80%;border-radius:4px 4px 0 0;position:relative">
          <span style="position:absolute;top:-20px;left:0;color:#fff;font-size:11px">840ms</span>
        </div>
      </div>
      <p style="margin:8px 0 0;color:#888;font-size:11px">v${version} (left) vs previous (right)</p>
    </div>

    <h2 style="margin:24px 0 12px;font-size:22px;color:#fff">Improvements</h2>
    <ul style="margin:0 0 24px;padding:0 0 0 20px;color:#c0c0c0;font-size:15px;line-height:28px">
      <li>Search now matches on attachment filenames and (where extracted) PDF contents</li>
      <li>Rich-text editor: bullet-to-number conversion via cmd+shift+7 / cmd+shift+8</li>
      <li>Drag-and-drop reordering on the folder sidebar with snap previews</li>
      <li>Custom shortcuts: rebind any of the 60+ keyboard actions from Settings → Shortcuts</li>
      <li>Better PDF previews with virtualised page rendering for documents over 200 pages</li>
      <li>Reply, reply-all, and forward all preserve the original message's quoted formatting</li>
      <li>You can now pin up to three folders to the top of the sidebar</li>
      <li>Avatar generation is now deterministic from the sender's email — no more rotating colours on every render</li>
      <li>Bulk operations show a progress overlay above 200 items so the page stays interactive</li>
    </ul>

    <h2 style="margin:24px 0 12px;font-size:22px;color:#fff">Bug fixes</h2>
    <ul style="margin:0 0 24px;padding:0 0 0 20px;color:#c0c0c0;font-size:15px;line-height:28px">
      <li>Fixed a long-standing race condition where a fast double-click on a message would
        sometimes open two reading panes</li>
      <li>Fixed an issue where pasting plain text into a draft would lose quoted styles</li>
      <li>Fixed a Firefox-only crash when the message list received an unusually-long subject</li>
      <li>Fixed an issue where the unread counter on the sidebar could lag by one frame</li>
      <li>Fixed an issue where pressing escape during a folder-rename would commit instead of cancelling</li>
      <li>Improved error messages when a server returns 5xx during sync</li>
      <li>Fixed flicker when toggling dark mode quickly</li>
    </ul>

    <h2 style="margin:24px 0 12px;font-size:22px;color:#fff">Under the hood</h2>
    <p style="margin:0 0 16px;font-size:15px;color:#c0c0c0;line-height:24px">
      The codebase is now around 18% smaller after dropping a long-deprecated server adapter.
      We upgraded our worker-side SQLite to wa-sqlite 1.8, which gives us a noticeable boost
      on Firefox's IndexedDB-backed VFS. The Rust workers that handle attachment thumbnailing
      are now compiled with LTO and use 30% less memory.
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#c0c0c0;line-height:24px">
      We also took the opportunity to migrate our build pipeline from Webpack to Vite, which
      cut local-dev rebuild times from 3.4s to 280ms. Worth every minute we spent on it.
    </p>

    <div style="background:#161616;border:1px solid #282828;border-radius:8px;padding:20px;margin:32px 0">
      <h3 style="margin:0 0 8px;font-size:16px;color:#fff">Up next</h3>
      <p style="margin:0;color:#c0c0c0;font-size:14px;line-height:22px">
        We're spending Q1 on a top-to-bottom rewrite of the search backend. Expect dramatic
        improvements to full-text search latency, plus a new query syntax that exposes more
        of the underlying inverted index.
      </p>
    </div>

    <a style="display:inline-block;background:#fff;color:#0a0a0a;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Read full changelog →</a>
  </div>
  <div style="padding:24px;text-align:center;color:#666;font-size:12px;border-top:1px solid #1f1f1f">
    <p style="margin:0">${productName} · Made in San Francisco</p>
    <p style="margin:8px 0 0"><a style="color:#666">Manage notifications</a> · <a style="color:#666">Unsubscribe</a></p>
  </div>
</div>
</body></html>`;
}

/**
 * Long travel itinerary (~8 KB) in an Airbnb-style layout.
 */
function travelItineraryHtml({ city, checkin, checkout, host, propertyType }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f7f7f7;font-family:Circular,-apple-system,Helvetica,Arial,sans-serif;color:#222">
<div style="max-width:600px;margin:0 auto;background:#fff">
  <div style="padding:20px 24px;border-bottom:1px solid #ebebeb">
    <span style="color:#ff5a5f;font-size:24px;font-weight:bold;letter-spacing:-1px">airbnb</span>
  </div>
  <div style="height:200px;background:linear-gradient(135deg,#ff5a5f,#ff385c)"></div>
  <div style="padding:32px 24px">
    <p style="margin:0;color:#717171;font-size:13px;letter-spacing:1px;text-transform:uppercase">Reservation confirmed</p>
    <h1 style="margin:8px 0 16px;font-size:28px;color:#222">You're going to ${city}!</h1>
    <p style="margin:0 0 24px;font-size:16px;line-height:24px;color:#222">
      ${host} is excited to welcome you. Here's everything you need for your trip.
    </p>
    <div style="border:1px solid #ebebeb;border-radius:12px;padding:24px;margin:0 0 24px">
      <h2 style="margin:0 0 16px;font-size:18px">Your stay</h2>
      <p style="margin:0;font-size:15px;color:#222"><strong>${propertyType}</strong> in central ${city}</p>
      <p style="margin:4px 0 16px;color:#717171;font-size:14px">Hosted by ${host} · Superhost</p>
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="padding:8px 0;color:#717171;font-size:13px;width:50%">CHECK-IN</td>
          <td style="padding:8px 0;color:#717171;font-size:13px">CHECKOUT</td>
        </tr>
        <tr>
          <td style="padding:0 0 16px;color:#222;font-size:15px;font-weight:600">${checkin}</td>
          <td style="padding:0 0 16px;color:#222;font-size:15px;font-weight:600">${checkout}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;color:#717171;font-size:13px">GUESTS</td>
          <td style="padding:8px 0;color:#717171;font-size:13px">CONFIRMATION CODE</td>
        </tr>
        <tr>
          <td style="padding:0;color:#222;font-size:15px;font-weight:600">2 adults</td>
          <td style="padding:0;color:#222;font-size:15px;font-weight:600;font-family:monospace">HMUR7P3K</td>
        </tr>
      </table>
    </div>
    <h2 style="margin:32px 0 12px;font-size:20px;color:#222">Getting there</h2>
    <div style="display:flex;gap:16px;align-items:start;margin:0 0 16px">
      <div style="width:32px;height:32px;border-radius:50%;background:#f0f0f0;display:flex;align-items:center;justify-content:center;flex-shrink:0">✈</div>
      <div style="flex:1">
        <p style="margin:0;font-size:15px;color:#222"><strong>From the airport</strong></p>
        <p style="margin:4px 0 0;font-size:14px;color:#717171;line-height:20px">
          The express train runs every 15 minutes from arrivals; it's a 38-minute ride to the
          central station. Take the front exit toward the river — the apartment is a 10-minute
          walk.
        </p>
      </div>
    </div>
    <div style="display:flex;gap:16px;align-items:start;margin:0 0 16px">
      <div style="width:32px;height:32px;border-radius:50%;background:#f0f0f0;display:flex;align-items:center;justify-content:center;flex-shrink:0">🔑</div>
      <div style="flex:1">
        <p style="margin:0;font-size:15px;color:#222"><strong>Self check-in</strong></p>
        <p style="margin:4px 0 0;font-size:14px;color:#717171;line-height:20px">
          The keypad code (5814) will be active from 3pm on the day of check-in. We'll send a
          reminder with the code 48 hours before your stay.
        </p>
      </div>
    </div>
    <div style="display:flex;gap:16px;align-items:start;margin:0 0 16px">
      <div style="width:32px;height:32px;border-radius:50%;background:#f0f0f0;display:flex;align-items:center;justify-content:center;flex-shrink:0">📞</div>
      <div style="flex:1">
        <p style="margin:0;font-size:15px;color:#222"><strong>Reach ${host}</strong></p>
        <p style="margin:4px 0 0;font-size:14px;color:#717171;line-height:20px">
          Message through the Airbnb app — ${host} usually responds within 15 minutes. For
          urgent issues during your stay, call the 24/7 hosting hotline.
        </p>
      </div>
    </div>
    <h2 style="margin:32px 0 12px;font-size:20px;color:#222">Things to do nearby</h2>
    ${[
      { title: 'Brunch at La Petite Maison', detail: '6 min walk · Famous for the brioche French toast' },
      { title: 'Walking tour of the old town', detail: '12 min walk to the meeting point · Saturdays at 10am' },
      { title: 'River cruise', detail: '20 min walk · Departures every hour from the central pier' },
      { title: 'Modern Art Museum', detail: 'Free with city card · Thursdays open until 9pm' },
    ].map((item) => `
    <div style="padding:12px 0;border-top:1px solid #ebebeb">
      <p style="margin:0;font-size:15px;color:#222;font-weight:600">${item.title}</p>
      <p style="margin:4px 0 0;font-size:13px;color:#717171">${item.detail}</p>
    </div>`).join('')}
    <h2 style="margin:32px 0 12px;font-size:20px;color:#222">Payment details</h2>
    <div style="border:1px solid #ebebeb;border-radius:12px;padding:20px">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="padding:4px 0;color:#222;font-size:14px">$248 × 4 nights</td>
          <td style="padding:4px 0;color:#222;font-size:14px;text-align:right">$992.00</td>
        </tr>
        <tr>
          <td style="padding:4px 0;color:#222;font-size:14px">Cleaning fee</td>
          <td style="padding:4px 0;color:#222;font-size:14px;text-align:right">$45.00</td>
        </tr>
        <tr>
          <td style="padding:4px 0;color:#222;font-size:14px">Service fee</td>
          <td style="padding:4px 0;color:#222;font-size:14px;text-align:right">$148.50</td>
        </tr>
        <tr>
          <td style="padding:4px 0;color:#222;font-size:14px">Occupancy taxes</td>
          <td style="padding:4px 0;color:#222;font-size:14px;text-align:right">$59.40</td>
        </tr>
        <tr>
          <td style="padding:12px 0 0;color:#222;font-size:16px;font-weight:600;border-top:1px solid #ebebeb">Total (USD)</td>
          <td style="padding:12px 0 0;color:#222;font-size:16px;font-weight:600;text-align:right;border-top:1px solid #ebebeb">$1,244.90</td>
        </tr>
      </table>
    </div>
    <p style="margin:24px 0 0;font-size:13px;color:#717171;line-height:20px">
      Need to make a change? Free cancellation is available until 2 days before check-in.
      After that, partial refunds apply per the host's cancellation policy.
    </p>
    <div style="margin:24px 0 0;text-align:center">
      <a style="display:inline-block;background:#ff385c;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">View itinerary</a>
    </div>
  </div>
  <div style="padding:24px;background:#f7f7f7;text-align:center;color:#717171;font-size:11px">
    <p style="margin:0">Airbnb, Inc. · 888 Brannan Street · San Francisco, CA 94103</p>
    <p style="margin:8px 0 0"><a style="color:#717171">Help Center</a> · <a style="color:#717171">Privacy</a></p>
  </div>
</div>
</body></html>`;
}

/**
 * Long Stripe-style monthly statement (~7 KB) with revenue summary,
 * top customers, and a "what to do next" CTA.
 */
function stripeRecapHtml({ monthLabel, gross, net, customers, payouts }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f6f9fc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#0a2540">
<div style="max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#635bff;padding:20px 24px">
    <span style="color:#fff;font-size:22px;font-weight:bold">stripe</span>
  </div>
  <div style="padding:32px 24px">
    <p style="margin:0;color:#425466;font-size:13px;letter-spacing:0.5px;text-transform:uppercase">${monthLabel} recap</p>
    <h1 style="margin:8px 0 8px;font-size:28px;color:#0a2540">Your ${monthLabel} numbers are in</h1>
    <p style="margin:0 0 24px;font-size:16px;color:#425466;line-height:24px">
      A summary of payments processed, customers added, and how your account performed this month.
    </p>
    <div style="display:flex;gap:12px;margin:0 0 24px">
      <div style="flex:1;background:#f6f9fc;border-radius:8px;padding:16px">
        <p style="margin:0;font-size:12px;color:#425466;text-transform:uppercase;letter-spacing:0.5px">Gross volume</p>
        <p style="margin:6px 0 0;font-size:24px;color:#0a2540;font-weight:600">$${gross}</p>
        <p style="margin:4px 0 0;font-size:12px;color:#16c98d">+18.2% vs last month</p>
      </div>
      <div style="flex:1;background:#f6f9fc;border-radius:8px;padding:16px">
        <p style="margin:0;font-size:12px;color:#425466;text-transform:uppercase;letter-spacing:0.5px">Net (after fees)</p>
        <p style="margin:6px 0 0;font-size:24px;color:#0a2540;font-weight:600">$${net}</p>
        <p style="margin:4px 0 0;font-size:12px;color:#16c98d">+17.8% vs last month</p>
      </div>
    </div>
    <h2 style="margin:32px 0 12px;font-size:18px;color:#0a2540">Top customers</h2>
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr>
          <th style="text-align:left;padding:8px 0;border-bottom:1px solid #e3e8ee;font-size:12px;color:#425466;text-transform:uppercase;letter-spacing:0.5px">Customer</th>
          <th style="text-align:right;padding:8px 0;border-bottom:1px solid #e3e8ee;font-size:12px;color:#425466;text-transform:uppercase;letter-spacing:0.5px">Spend</th>
          <th style="text-align:right;padding:8px 0;border-bottom:1px solid #e3e8ee;font-size:12px;color:#425466;text-transform:uppercase;letter-spacing:0.5px">Payments</th>
        </tr>
      </thead>
      <tbody>
        ${customers.map((c) => `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #f1f3f7;font-size:14px;color:#0a2540">${c.name}</td>
          <td style="padding:12px 0;border-bottom:1px solid #f1f3f7;font-size:14px;color:#0a2540;text-align:right">$${c.spend}</td>
          <td style="padding:12px 0;border-bottom:1px solid #f1f3f7;font-size:14px;color:#0a2540;text-align:right">${c.payments}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <h2 style="margin:32px 0 12px;font-size:18px;color:#0a2540">Payouts to your bank account</h2>
    <table style="width:100%;border-collapse:collapse">
      ${payouts.map((p) => `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #f1f3f7;font-size:14px;color:#425466">${p.date}</td>
        <td style="padding:12px 0;border-bottom:1px solid #f1f3f7;font-size:14px;color:#0a2540;text-align:right;font-weight:600">$${p.amount}</td>
      </tr>`).join('')}
    </table>
    <h2 style="margin:32px 0 12px;font-size:18px;color:#0a2540">What to do next</h2>
    <ul style="margin:0 0 24px;padding:0 0 0 20px;font-size:14px;color:#425466;line-height:22px">
      <li>Set up <strong>radar rules</strong> to automatically catch suspicious payments</li>
      <li>Enable <strong>3D Secure</strong> for European customers to reduce chargebacks</li>
      <li>Try the new <strong>billing portal</strong> so customers can self-manage subscriptions</li>
      <li>Connect <strong>Stripe Sigma</strong> for SQL access to your transaction history</li>
    </ul>
    <a style="display:inline-block;background:#635bff;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">View full dashboard →</a>
  </div>
  <div style="padding:24px;background:#f6f9fc;text-align:center;color:#425466;font-size:11px;border-top:1px solid #e3e8ee">
    <p style="margin:0">Stripe, Inc. · 510 Townsend St · San Francisco, CA 94103</p>
    <p style="margin:8px 0 0"><a style="color:#425466">Manage email preferences</a></p>
  </div>
</div>
</body></html>`;
}

/**
 * Vercel-style deployment success — short, dense, monospace.
 */
function vercelDeployHtml({ project, branch, commit, durationSec }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#fff">
<div style="max-width:560px;margin:0 auto">
  <div style="padding:24px;border-bottom:1px solid #1a1a1a">
    <span style="color:#fff;font-size:22px;font-weight:700">▲ Vercel</span>
  </div>
  <div style="padding:32px 24px">
    <div style="display:inline-block;padding:4px 10px;border-radius:12px;background:#0d3a18;color:#3fb950;font-size:11px;font-weight:700;margin-bottom:16px">● READY</div>
    <h1 style="margin:0 0 8px;font-size:24px">Deployment successful</h1>
    <p style="margin:0 0 24px;color:#888;font-size:14px">Built and shipped in ${durationSec}s.</p>
    <div style="background:#0a0a0a;border:1px solid #222;border-radius:8px;padding:20px;margin:0 0 24px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px">
      <p style="margin:0 0 8px"><span style="color:#888">project</span> &nbsp; <span style="color:#fff">${project}</span></p>
      <p style="margin:0 0 8px"><span style="color:#888">branch </span> &nbsp; <span style="color:#fff">${branch}</span></p>
      <p style="margin:0 0 8px"><span style="color:#888">commit </span> &nbsp; <span style="color:#fff">${commit.slice(0, 7)}</span></p>
      <p style="margin:0"><span style="color:#888">url    </span> &nbsp; <a style="color:#0ea5e9">https://${project}-${commit.slice(0, 7)}.vercel.app</a></p>
    </div>
    <a style="display:inline-block;background:#fff;color:#000;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">Visit deployment</a>
  </div>
</div>
</body></html>`;
}

/**
 * Stripe-style payment receipt — short.
 */
function paymentReceiptHtml({ merchant, amount, last4 }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f6f9fc;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#0a2540">
<div style="max-width:560px;margin:0 auto;background:#fff;padding:32px 24px;border-radius:8px">
  <p style="margin:0;color:#425466;font-size:13px;text-transform:uppercase;letter-spacing:0.5px">Receipt</p>
  <h1 style="margin:8px 0 24px;font-size:24px">Thanks for your payment</h1>
  <div style="background:#f6f9fc;border-radius:8px;padding:20px;margin:0 0 24px">
    <p style="margin:0 0 8px;font-size:13px;color:#425466">${merchant}</p>
    <p style="margin:0;font-size:36px;font-weight:700;color:#0a2540">$${amount}</p>
    <p style="margin:8px 0 0;font-size:13px;color:#425466">Paid with Visa ending in ${last4}</p>
  </div>
  <p style="margin:0 0 16px;font-size:13px;color:#425466;line-height:20px">
    A copy of this receipt is also available in your account. If you have questions about
    this payment, reply directly to this email and we'll get back to you within one business day.
  </p>
</div>
</body></html>`;
}

/**
 * 1Password-style security alert — short, calm.
 */
function passwordAlertHtml({ siteName, newDevice, location }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#222">
<div style="max-width:520px;margin:0 auto;background:#fff;padding:32px 24px;border-radius:8px">
  <div style="text-align:center;padding:0 0 24px;border-bottom:1px solid #e5e7eb">
    <span style="color:#0572ec;font-size:20px;font-weight:bold">1Password</span>
  </div>
  <div style="padding:24px 0">
    <div style="width:48px;height:48px;border-radius:50%;background:#fef3c7;color:#92400e;display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 16px">!</div>
    <h1 style="margin:0;font-size:20px;color:#222;text-align:center">New sign-in to ${siteName}</h1>
    <p style="margin:16px 0 0;font-size:14px;color:#525f7f;text-align:center;line-height:22px">
      Your 1Password account was used to sign in to ${siteName} on a new device.
    </p>
    <div style="background:#f4f5f7;border-radius:8px;padding:16px;margin:24px 0;text-align:left">
      <p style="margin:0;font-size:13px;color:#525f7f">Device: <strong style="color:#222">${newDevice}</strong></p>
      <p style="margin:8px 0 0;font-size:13px;color:#525f7f">Location: <strong style="color:#222">${location}</strong></p>
      <p style="margin:8px 0 0;font-size:13px;color:#525f7f">Time: <strong style="color:#222">just now</strong></p>
    </div>
    <p style="margin:0;font-size:13px;color:#525f7f;text-align:center;line-height:20px">
      If this was you, no action is needed. If not, change your password and review your account activity.
    </p>
  </div>
</div>
</body></html>`;
}

function upsHtml({ trackingNumber, deliveryDate }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f6f5f1;font-family:Helvetica,Arial,sans-serif;color:#351c15">
<div style="max-width:560px;margin:0 auto;background:#fff">
  <div style="background:#351c15;padding:16px 24px;border-bottom:4px solid #ffb500">
    <span style="color:#ffb500;font-size:22px;font-weight:900;font-style:italic">ups</span>
  </div>
  <div style="padding:24px">
    <h1 style="margin:0 0 16px;font-size:22px">Delivery scheduled for ${deliveryDate}</h1>
    <p style="margin:0 0 24px;color:#555;font-size:14px">Tracking number: <strong>${trackingNumber}</strong></p>
    <div style="background:#fffbe6;border-left:4px solid #ffb500;padding:16px;margin-bottom:24px">
      <p style="margin:0;font-size:14px;line-height:22px">
        Your package is on a UPS vehicle and out for delivery. Someone may need to be available to sign.
      </p>
    </div>
    <a style="display:inline-block;background:#351c15;color:#ffb500;padding:12px 24px;text-decoration:none;font-weight:bold;border-radius:2px">Track package</a>
  </div>
  <div style="padding:16px 24px;background:#f6f5f1;color:#777;font-size:11px">
    <p style="margin:0">© 2026 United Parcel Service of America, Inc.</p>
  </div>
</div>
</body></html>`;
}

// =============================================================
// Inbox seeds — 30 messages, mixed.
// =============================================================

function buildInboxSeeds({ inbox, fromEmail }) {
  const now = Date.now();
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;

  return [
    // Most recent first
    {
      mailboxId: inbox.id,
      fromName: 'UPS',
      fromEmail: 'mcinfo@ups.com',
      subject: 'UPS Update: Out for delivery today',
      bodyText: 'Your UPS package is out for delivery today.',
      htmlBody: upsHtml({
        trackingNumber: '1Z999AA10123456784',
        deliveryDate: 'Tuesday by end of day',
      }),
      receivedAt: now - 18 * min,
    },
    {
      mailboxId: inbox.id,
      fromName: 'Sarah Chen',
      fromEmail: 'sarah@example.org',
      subject: 'Re: Q4 planning doc — couple of comments',
      bodyText: [
        'Hey,',
        '',
        'Skimmed the Q4 planning doc. Two quick notes:',
        '',
        "  1. The capacity math in §3 doesn't add up — looks like the",
        "     migration line item is double-counted in both the platform",
        "     and infra rollups.",
        '  2. Can we move the launch checkpoint up a week? Marketing',
        "     wants to start the email campaign on the 14th and we'd be",
        '     cutting it close.',
        '',
        "Happy to chat tomorrow. Otherwise let's discuss at standup.",
        '',
        'Sarah',
      ].join('\n'),
      receivedAt: now - 47 * min,
    },
    {
      mailboxId: inbox.id,
      fromName: 'Netflix',
      fromEmail: 'info@mailer.netflix.com',
      subject: 'New on Netflix: Three Body Problem and more',
      bodyText: 'See what is new on Netflix this week. Open in a browser for the best experience.',
      htmlBody: netflixHtml({
        showTitle: 'Three Body Problem',
        episodeTitle: 'Countdown — a young physicist begins seeing numbers everywhere, ticking down to a date she cannot identify.',
        runtime: '57m',
      }),
      receivedAt: now - 2 * hr,
    },
    {
      mailboxId: inbox.id,
      fromName: 'Vercel',
      fromEmail: 'notifications@vercel.com',
      subject: 'Deployment succeeded for thundermail-web',
      bodyText: 'thundermail-web @ main · build #4421 · ready in 78s.',
      htmlBody: vercelDeployHtml({
        project: 'thundermail-web',
        branch: 'main',
        commit: 'a4a1f1808bd4534ba226d2614a78730006d55be7',
        durationSec: 78,
      }),
      receivedAt: now - 3 * hr,
      keywords: { $seen: true },
    },
    {
      mailboxId: inbox.id,
      fromName: 'Stripe',
      fromEmail: 'receipts@stripe.com',
      subject: 'Receipt: $19.00 paid to Notion',
      bodyText: 'Receipt for $19.00 paid to Notion with Visa ending in 4242.',
      htmlBody: paymentReceiptHtml({
        merchant: 'Notion Labs, Inc.',
        amount: '19.00',
        last4: '4242',
      }),
      receivedAt: now - 4 * hr,
      keywords: { $seen: true },
    },
    {
      mailboxId: inbox.id,
      fromName: 'Amazon.com',
      fromEmail: 'shipment-tracking@amazon.com',
      subject: 'Shipped: Your order of Coffee Filters and Office Supplies',
      bodyText: 'Your Amazon order has shipped. Tracking number 1Z999AA10123456784. Arriving Tuesday by 9pm.',
      htmlBody: amazonHtml({
        orderId: '114-3782619-4426601',
        deliveryWindow: 'Tuesday by 9pm',
        items: [
          { title: 'Melitta #4 Cone Coffee Filters, Natural Brown (200 ct)', seller: 'Amazon.com', price: '6.99', qty: 2 },
          { title: 'Pilot G2 Premium Gel Pens, Fine Point 0.7mm (12-pack)', seller: 'Pilot', price: '14.49', qty: 1 },
          { title: 'Logitech MX Master 3S Wireless Mouse, Graphite', seller: 'Amazon.com', price: '99.99', qty: 1 },
          { title: 'Sony WH-1000XM5 Wireless Noise-Cancelling Headphones', seller: 'Amazon.com', price: '328.00', qty: 1 },
        ],
        total: '456.46',
      }),
      receivedAt: now - 5 * hr,
    },
    {
      mailboxId: inbox.id,
      fromName: 'Linear',
      fromEmail: 'updates@linear.app',
      subject: 'Linear v3.7 is out: offline mode, faster lists, and 30+ improvements',
      bodyText: 'Linear v3.7 ships with full offline support, a rewritten list view, and dozens of quality-of-life improvements.',
      htmlBody: productChangelogHtml({
        productName: 'Linear',
        version: '3.7',
        releaseDate: 'November 18',
      }),
      receivedAt: now - 7 * hr,
    },
    {
      mailboxId: inbox.id,
      fromName: 'LinkedIn Jobs',
      fromEmail: 'jobs-noreply@linkedin.com',
      subject: 'Senior Engineer roles matched to your search',
      bodyText: 'Your LinkedIn job alerts: 6 new matches today.',
      htmlBody: linkedinHtml({ recipientName: 'Admin' }),
      receivedAt: now - 8 * hr,
    },
    {
      mailboxId: inbox.id,
      fromName: 'Renee Park',
      fromEmail: 'renee@example.org',
      subject: 'PR #4421 — quick question on the StateChange serialization',
      bodyText: [
        'Hey,',
        '',
        "I've been reading through PR #4421 and the StateChange",
        "serialization logic. Wanted to check my understanding before",
        "I leave a review:",
        '',
        "* The pending bucket merges the type-state maps, latest-pushState",
        "  wins. So if two pushes arrive in the same turn we union the types",
        "  and process them in one pass.",
        '',
        "* The trailing iteration of the inflight loop handles frames that",
        "  arrived DURING the previous pass.",
        '',
        "* The await Promise.resolve() at the top of the loop is what",
        "  gives sibling frames a chance to merge before consumption.",
        '',
        "Couple of small things I'll flag inline — nothing blocking.",
        '',
        'Renee',
      ].join('\n'),
      receivedAt: now - 12 * hr,
    },
    {
      mailboxId: inbox.id,
      fromName: 'Airbnb',
      fromEmail: 'automated@airbnb.com',
      subject: 'Your stay in Lisbon is confirmed!',
      bodyText: 'Your stay in Lisbon is confirmed for May 14–18. Confirmation code HMUR7P3K.',
      htmlBody: travelItineraryHtml({
        city: 'Lisbon',
        checkin: 'Sat, May 14',
        checkout: 'Wed, May 18',
        host: 'Inês',
        propertyType: 'Stylish 1-bedroom apartment',
      }),
      receivedAt: now - 14 * hr,
    },
    {
      mailboxId: inbox.id,
      fromName: '1Password',
      fromEmail: 'security@1password.com',
      subject: 'New sign-in to your GitHub account',
      bodyText: 'A new device signed in to your GitHub account using 1Password.',
      htmlBody: passwordAlertHtml({
        siteName: 'GitHub',
        newDevice: 'MacBook Pro · Safari 18.0',
        location: 'Toronto, ON',
      }),
      receivedAt: now - 18 * hr,
      keywords: { $seen: true },
    },
    {
      mailboxId: inbox.id,
      fromName: 'GitHub',
      fromEmail: 'noreply@github.com',
      subject: '[Security] High severity advisory in mozilla/example-svc',
      bodyText: 'Security advisory CVE-2026-4421. Severity: High. Package: lodash@4.17.20. Upgrade to lodash@4.18.0.',
      htmlBody: githubHtml({
        repo: 'mozilla/example-svc',
        advisoryId: 'CVE-2026-4421',
        severity: 'High',
        packageName: 'lodash',
        packageVersion: '4.17.20',
      }),
      receivedAt: now - 1 * day,
      keywords: { $seen: true },
    },
    {
      mailboxId: inbox.id,
      fromName: 'Stripe',
      fromEmail: 'monthly@stripe.com',
      subject: 'Your November Stripe recap is here',
      bodyText: 'November recap: $42,184 in gross volume, 318 new customers, payouts on schedule.',
      htmlBody: stripeRecapHtml({
        monthLabel: 'November',
        gross: '42,184',
        net: '40,891',
        customers: [
          { name: 'Acme Holdings, LLC', spend: '8,420', payments: 14 },
          { name: 'Mountain View School District', spend: '6,180', payments: 6 },
          { name: 'Tristan Industries', spend: '4,950', payments: 22 },
          { name: 'Northwind Logistics', spend: '3,820', payments: 9 },
        ],
        payouts: [
          { date: 'Nov 17', amount: '8,420' },
          { date: 'Nov 10', amount: '10,210' },
          { date: 'Nov 3', amount: '7,890' },
        ],
      }),
      receivedAt: now - 1 * day - 6 * hr,
    },
    {
      mailboxId: inbox.id,
      fromName: 'Calendly',
      fromEmail: 'no-reply@calendly.com',
      subject: 'New meeting: 30 min with Priya Patel · Thu 2:00pm',
      bodyText: 'Priya Patel has booked 30 minutes with you on Thursday at 2:00pm via Calendly. Topic: "Catch-up + Q4 priorities".',
      receivedAt: now - 1 * day - 9 * hr,
      keywords: { $seen: true },
    },
    {
      mailboxId: inbox.id,
      fromName: 'Mom',
      fromEmail: 'mom@example.org',
      subject: 'Pictures from the trip!',
      bodyText: [
        'Hi sweetie,',
        '',
        "Finally got the pictures off Dad's phone. I'll send them in a",
        "few separate emails so the attachments don't get blocked.",
        '',
        'It was so nice to have everyone together. The kids had a blast',
        'at the lake — Maya hardly came out of the water all weekend.',
        '',
        "Let us know when you're coming up next. Dad's planning a",
        "fishing day on the 14th if you want to join.",
        '',
        'Love,',
        'Mom',
      ].join('\n'),
      receivedAt: now - 1 * day - 14 * hr,
    },
    {
      mailboxId: inbox.id,
      fromName: 'Spotify',
      fromEmail: 'no-reply@spotify.com',
      subject: 'Your 2026 Wrapped is here',
      bodyText: 'Your year in music. Listening time: 47,302 minutes. Top artist: Phoebe Bridgers. Top genre: Indie Folk.',
      htmlBody: spotifyWrappedHtml({
        recipientName: 'Admin',
        year: 2026,
        minutes: 47302,
        topArtist: 'Phoebe Bridgers',
        topGenre: 'Indie Folk',
      }),
      receivedAt: now - 2 * day,
    },
    {
      mailboxId: inbox.id,
      fromName: 'Marcus Lim',
      fromEmail: 'marcus@example.org',
      subject: 'Re: Re: Re: dinner this Saturday?',
      bodyText: [
        'Sounds good!',
        '',
        "Let's do Lardo at 7. I'll book under my name. Their pici cacio e",
        "pepe is incredible and they have a decent natural-wine list.",
        '',
        "Bringing my partner if that's cool — she's been wanting to try",
        'the place.',
        '',
        'See you then,',
        'Marcus',
      ].join('\n'),
      receivedAt: now - 2 * day - 4 * hr,
      keywords: { $seen: true },
    },
    {
      mailboxId: inbox.id,
      fromName: 'AWS Billing',
      fromEmail: 'no-reply-aws@amazon.com',
      subject: 'Your AWS bill for November is now available',
      bodyText: [
        'Account: 142081440091',
        'Period: Nov 1 – Nov 30',
        '',
        'Total this period:  $1,284.21',
        'Compared to last:   +$104.03 (8.8%)',
        '',
        'Top services:',
        '  EC2:      $612.40',
        '  RDS:      $284.10',
        '  S3:        $98.50',
        '  CloudFront: $74.20',
        '  Other:    $215.01',
        '',
        'Pay automatically: Dec 5.',
      ].join('\n'),
      receivedAt: now - 2 * day - 8 * hr,
      keywords: { $seen: true },
    },
    {
      mailboxId: inbox.id,
      fromName: 'The Quiet Web',
      fromEmail: 'newsletter@thequietweb.substack.com',
      subject: 'The quiet collapse of the open web',
      bodyText: 'The Quiet Web newsletter, by R. Marsh. The quiet collapse of the open web. 18 min read.',
      htmlBody: substackLongHtml({
        title: 'The Quiet Web',
        author: 'R. Marsh',
        subscribers: 18421,
      }),
      receivedAt: now - 3 * day,
      keywords: { $seen: true },
    },
    {
      mailboxId: inbox.id,
      fromName: 'Anaya Singh',
      fromEmail: 'recruiter@anaya-search.com',
      subject: 'Quick chat about a Staff Engineer role at a Series B startup',
      bodyText: [
        'Hi Admin,',
        '',
        "I'm working with a Series B startup in the dev-tools space",
        "(stealth, no public name yet, $42M raised, ~30 engineers).",
        "They're looking for their next Staff Engineer to anchor the",
        "platform team.",
        '',
        "What I think you'd find interesting:",
        '',
        "  - Real distributed-systems work (consistent hashing, Raft",
        "    for metadata, custom storage layer in Rust)",
        '  - Fully remote, with quarterly on-sites in Vancouver or NYC',
        "  - Comp band $310K–$390K base + 0.4%–0.8% equity, no caps",
        "  - The CTO is someone you'd recognize from a previous public",
        '    project I can share if you reply',
        '',
        "Would you be open to a 20-minute conversation next week?",
        "Tuesday or Thursday afternoon works for me.",
        '',
        'Best,',
        'Anaya',
      ].join('\n'),
      receivedAt: now - 3 * day - 8 * hr,
    },
    {
      mailboxId: inbox.id,
      fromName: 'Slack',
      fromEmail: 'notifications@slack.com',
      subject: 'You have 7 unread mentions in #incidents',
      bodyText: [
        "You haven't visited Slack in a few hours. Here's what you missed:",
        '',
        "#incidents (4 mentions)",
        "  • @mei: still seeing the timeout on the JMAP push WebSocket",
        "  • @anna: I think it's the reconnect supervisor we shipped",
        "  • @diego: rolling back to be safe, want to confirm?",
        "  • @mei: no — found it, was a bad pushState, fix is in main",
        "",
        "#design-review (2 mentions)",
        "  • @priya: can you take a pass on the bulk-overlay variant?",
        "",
        "#random (1 mention)",
        "  • @alex: thanks for the coffee bean recommendation — it's great",
      ].join('\n'),
      receivedAt: now - 3 * day - 13 * hr,
    },
    {
      mailboxId: inbox.id,
      fromName: 'Figma',
      fromEmail: 'notify@figma.com',
      subject: 'Priya commented on "Bulk operation overlay v2"',
      bodyText: [
        'Priya Patel commented on the Bulk operation overlay v2 file:',
        '',
        '"@admin — what do you think about making the progress bar a',
        'subtle solid color instead of striped? The stripes are a bit',
        'distracting at 60fps. I made a variant on frame 14 if you want',
        'to compare."',
        '',
        'View on Figma →',
      ].join('\n'),
      receivedAt: now - 4 * day,
      keywords: { $seen: true },
    },
    {
      mailboxId: inbox.id,
      fromName: 'Discord',
      fromEmail: 'noreply@discord.com',
      subject: '4 new messages in #rust-async',
      bodyText: '4 new messages in your #rust-async channel since you last checked.',
      receivedAt: now - 4 * day - 5 * hr,
      keywords: { $seen: true },
    },
    {
      mailboxId: inbox.id,
      fromName: 'Chase Fraud Alert',
      fromEmail: 'no-reply@alerts.chase.com',
      subject: 'Did you make a charge of $148.20 at LARDO RESTAURANT?',
      bodyText: [
        'We noticed a charge that looks a little different than usual on',
        'your card ending in 9182.',
        '',
        'Amount: $148.20',
        'Merchant: LARDO RESTAURANT',
        'Location: Toronto, ON',
        'Date: Today',
        '',
        'If this was you, no action is needed. If not, reply NO to lock',
        'the card and we will reach out within 30 minutes.',
      ].join('\n'),
      receivedAt: now - 5 * day,
      keywords: { $seen: true },
    },
    {
      mailboxId: inbox.id,
      fromName: 'Mei Tanaka',
      fromEmail: 'mei@example.org',
      subject: 'Notes from the post-incident review',
      bodyText: [
        'Hey team,',
        '',
        "Wrote up the notes from the post-incident review for the JMAP",
        "push outage. The doc is here (link), but the headline takeaways:",
        '',
        "  1. Root cause was the missing reconnect supervisor — the",
        "     WebSocket dropped at ~04:12 UTC during a Stalwart restart",
        "     and never came back. Pending mutations queued normally but",
        "     push notifications stopped firing, so users only saw new",
        "     mail on manual refresh.",
        '',
        "  2. Detection was slow because our healthcheck only pings the",
        "     HTTP endpoint, not the WS. We had no signal until users",
        "     started reporting it ~2.5 hours later.",
        '',
        "  3. Action items:",
        "     • Ship the reconnect supervisor (done in PR #4421)",
        "     • Add WS healthcheck to the synthetic monitor (assigned: anna)",
        "     • Surface a 'reconnecting' UI state when the WS is down",
        "       longer than 10s (assigned: priya)",
        '',
        "Full retro is on the calendar for Wednesday 3pm.",
        '',
        'Mei',
      ].join('\n'),
      receivedAt: now - 5 * day - 11 * hr,
      keywords: { $seen: true },
    },
    {
      mailboxId: inbox.id,
      fromName: 'Hacker News Digest',
      fromEmail: 'digest@hndigest.com',
      subject: 'Your weekly Hacker News digest',
      bodyText: [
        'Top stories from your week on Hacker News:',
        '',
        '  1. The PostgreSQL 17 release post (612 points)',
        '  2. "We replaced Cloudflare with our own edge stack" (489 pts)',
        '  3. "A deep dive on the JMAP protocol" (412 pts)',
        '  4. "Why I left $TECH_COMPANY to work on something quiet" (388)',
        '  5. "Show HN: A minimal browser-only mail client" (266)',
        '  6. "Some thoughts on local-first software" (231)',
        '  7. "How Sentry handles 50B events per month" (198)',
        '',
        'Read more on hndigest.com →',
      ].join('\n'),
      receivedAt: now - 6 * day,
      keywords: { $seen: true },
    },
    {
      mailboxId: inbox.id,
      fromName: 'Doximity',
      fromEmail: 'no-reply@doctor-office.example',
      subject: 'Upcoming appointment: Tuesday Dec 3, 10:30 AM',
      bodyText: [
        'This is a reminder for your upcoming appointment.',
        '',
        '  Dr. Stephanie Robles, Family Medicine',
        '  Tuesday, December 3 at 10:30 AM',
        '  Riverside Medical Center, Suite 240',
        '',
        'Please arrive 15 minutes early to complete paperwork. If you',
        'need to reschedule, reply to this email or call (555) 821-3304.',
      ].join('\n'),
      receivedAt: now - 6 * day - 4 * hr,
    },
    {
      mailboxId: inbox.id,
      fromName: 'Notion',
      fromEmail: 'team@mail.notion.so',
      subject: 'Reminder: "Q1 roadmap" is shared with you',
      bodyText: [
        'Alex Kim shared "Q1 roadmap" with you.',
        '',
        '5 people have commented. Open in Notion to catch up on the',
        'thread before the planning sync on Friday.',
      ].join('\n'),
      receivedAt: now - 7 * day,
      keywords: { $seen: true },
    },
    {
      mailboxId: inbox.id,
      fromName: 'OpenTable',
      fromEmail: 'res@opentable.com',
      subject: 'Confirmed: Lardo · Saturday, Nov 23 at 7:00 PM · Party of 4',
      bodyText: [
        'Your reservation is confirmed!',
        '',
        '  Lardo Restaurant',
        '  287 College Street, Toronto, ON',
        '  Saturday, November 23 at 7:00 PM',
        '  Party of 4',
        '  Confirmation: OT-4582-3104',
        '',
        'If your plans change, please cancel at least 4 hours before',
        'your reservation time so the table can be released to other',
        'diners.',
      ].join('\n'),
      receivedAt: now - 7 * day - 9 * hr,
      keywords: { $seen: true },
    },
    {
      mailboxId: inbox.id,
      fromName: 'Mozilla',
      fromEmail: 'newsletter@mozilla.org',
      subject: 'The future of the open web — Mozilla\'s yearly update',
      bodyText: 'Mozilla\'s 2026 annual letter from the CEO, covering AI policy, Firefox roadmap, and the state of the open web.',
      htmlBody: substackLongHtml({
        title: 'Mozilla Update',
        author: 'Mozilla',
        subscribers: 921084,
      }),
      receivedAt: now - 8 * day,
      keywords: { $seen: true },
    },
  ];
}

// =============================================================
// Archive seeder. ~1500 messages varied across senders, dates,
// and subjects. Most are short plain-text; a small fraction reuse
// HTML templates for variety.
// =============================================================

const ARCHIVE_SENDERS = [
  { name: 'GitHub', email: 'noreply@github.com' },
  { name: 'Stripe', email: 'no-reply@stripe.com' },
  { name: 'Amazon.com', email: 'auto-confirm@amazon.com' },
  { name: 'LinkedIn', email: 'messages-noreply@linkedin.com' },
  { name: 'Notion', email: 'team@mail.notion.so' },
  { name: 'Figma', email: 'notify@figma.com' },
  { name: 'Slack', email: 'notifications@slack.com' },
  { name: 'Vercel', email: 'notifications@vercel.com' },
  { name: 'AWS', email: 'no-reply@amazon.com' },
  { name: 'Calendly', email: 'no-reply@calendly.com' },
  { name: 'Doordash', email: 'no-reply@doordash.com' },
  { name: 'Uber', email: 'noreply@uber.com' },
  { name: 'Spotify', email: 'no-reply@spotify.com' },
  { name: 'YouTube', email: 'noreply@youtube.com' },
  { name: 'Substack', email: 'newsletter@substack.com' },
  { name: 'OpenAI', email: 'no-reply@openai.com' },
  { name: 'Anthropic', email: 'team@anthropic.com' },
  { name: 'Eventbrite', email: 'no-reply@eventbrite.com' },
  { name: 'Costco', email: 'no-reply@costco.com' },
  { name: 'Expedia', email: 'travel@expedia.com' },
  { name: 'Sarah Chen', email: 'sarah@example.org' },
  { name: 'Marcus Lim', email: 'marcus@example.org' },
  { name: 'Priya Patel', email: 'priya@example.org' },
  { name: 'Diego Alvarez', email: 'diego@example.org' },
  { name: 'Mei Tanaka', email: 'mei@example.org' },
  { name: 'Renee Park', email: 'renee@example.org' },
  { name: 'Alex Kim', email: 'alex@example.org' },
  { name: 'Mom', email: 'mom@example.org' },
  { name: 'Dad', email: 'dad@example.org' },
  { name: 'Customer Support', email: 'support@example.com' },
];

const ARCHIVE_SUBJECT_PATTERNS = [
  () => 'Re: weekly 1:1 notes',
  () => 'Order shipped — track your package',
  () => 'Your statement is ready to view',
  () => 'Your trip is coming up',
  () => 'Action required: verify your account',
  () => 'Receipt for your recent purchase',
  () => 'Re: tomorrow\'s standup',
  () => 'Welcome to the team',
  () => 'Project update: weekly summary',
  () => 'You have a new connection request',
  () => 'Document shared with you',
  () => 'Calendar invitation',
  () => 'New comment on a page you follow',
  () => 'Password reset confirmation',
  () => 'Subscription renewal reminder',
  () => 'Security alert: new sign-in',
  () => 'Your order is out for delivery',
  () => 'Re: question about the deploy pipeline',
  () => 'Thanks for joining us yesterday',
  () => 'Re: design review feedback',
  () => 'Heads up about Friday',
  () => 'Re: PTO request',
  () => 'Quick favor — could you take a look?',
  () => 'FYI — moved this to next sprint',
  () => 'Re: that thing we discussed',
  () => 'See you on Thursday',
  () => 'Quick question',
  () => 'Re: budget approval',
  () => 'Notes from yesterday\'s sync',
  () => 'Re: customer feedback summary',
];

const ARCHIVE_BODY_TEMPLATES = [
  (i) => [
    `Hey, just confirming we\'re still on for tomorrow.`,
    ``,
    `Let me know if anything changes — otherwise see you at 10:30 in the Lakeshore room.`,
    ``,
    `Thanks,`,
    `— Archive entry ${i}`,
  ].join('\n'),
  (i) => [
    `Your order #114-${String(3782619 + i).padStart(7, '0')}-${String(4426601 + i).padStart(7, '0')} has shipped.`,
    ``,
    `Tracking: 1Z999AA${String(10000000 + i).padStart(8, '0')}`,
    `Estimated delivery: in 2–3 business days`,
    ``,
    `Track your package on the carrier\'s site or via our app.`,
  ].join('\n'),
  (i) => [
    `Hi,`,
    ``,
    `Just wrapping up the doc I mentioned. Want to compare notes on §3 before tomorrow?`,
    ``,
    `Open to either a quick call or async — whatever\'s easier.`,
    ``,
    `(Archive seed item ${i})`,
  ].join('\n'),
  (i) => [
    `Your account statement for the period ending ${new Date(Date.now() - i * 86400000).toLocaleDateString()} is now available.`,
    ``,
    `Account balance: $${(1000 + (i * 19) % 4000).toFixed(2)}`,
    `Available credit: $${(2500 + (i * 37) % 5000).toFixed(2)}`,
    ``,
    `Sign in to view detailed transactions.`,
  ].join('\n'),
  (i) => [
    `Just confirming the calendar invite for ${new Date(Date.now() + (10 + i) * 3600000).toLocaleString()}.`,
    ``,
    `Agenda:`,
    `  • Status update from each lead`,
    `  • Blockers for the week`,
    `  • Decisions needed`,
    ``,
    `Looking forward to it.`,
  ].join('\n'),
];

// Use a deterministic pseudo-random pick so re-runs produce stable
// content (helps when diffing screenshots, etc.).
function pickDeterministic(arr, salt) {
  const idx = Math.abs(hash32(salt)) % arr.length;
  return arr[idx];
}
function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h;
}

function buildArchiveSeed({ archive, fromEmail, index }) {
  const sender = pickDeterministic(ARCHIVE_SENDERS, `s${index}`);
  const subjectFn = pickDeterministic(ARCHIVE_SUBJECT_PATTERNS, `sub${index}`);
  const bodyFn = pickDeterministic(ARCHIVE_BODY_TEMPLATES, `b${index}`);
  // Spread the dates across the last 3 years. The `index` to date
  // mapping is roughly linear so newer entries appear newer.
  const ageMs = Math.floor((index / Math.max(1, ARCHIVE_TARGET)) * 3 * 365 * 86400_000);
  const jitter = (hash32(`j${index}`) % 86400_000);
  const receivedAt = Date.now() - ageMs - jitter;

  return buildEmail({
    mailboxId: archive.id,
    fromName: sender.name,
    fromEmail: sender.email,
    toEmail: fromEmail,
    subject: subjectFn(index),
    receivedAt,
    bodyText: bodyFn(index),
    // Most archive items are read.
    keywords: index % 11 === 0 ? {} : { $seen: true },
  });
}

async function countArchiveDevSeeds(jmap, archive) {
  // Same client-side counting strategy as sweep: the filter isn't
  // reliable, so we page through the archive and match the subject
  // prefix locally.
  let count = 0;
  let position = 0;
  while (true) {
    const q = await jmapRequest(jmap, [[
      'Email/query',
      {
        accountId: jmap.accountId,
        filter: { inMailbox: archive.id },
        position,
        limit: BATCH,
        calculateTotal: true,
      },
      'q',
    ]]);
    const ids = pickResponse(q, 'Email/query')?.ids ?? [];
    const total = pickResponse(q, 'Email/query')?.total ?? 0;
    if (ids.length === 0) break;
    const g = await jmapRequest(jmap, [[
      'Email/get',
      { accountId: jmap.accountId, ids, properties: ['id', 'subject'] },
      'g',
    ]]);
    const list = pickResponse(g, 'Email/get')?.list ?? [];
    for (const e of list) {
      if (typeof e.subject === 'string' && e.subject.startsWith(SUBJECT_PREFIX)) count += 1;
    }
    position += ids.length;
    if (position >= total) break;
  }
  return count;
}

async function seedArchive(jmap, { archive, fromEmail }) {
  console.log(`[seed-dev-mail] targeting ${ARCHIVE_TARGET} messages in archive (this takes ~30s)`);
  let createdSoFar = 0;
  for (let offset = 0; offset < ARCHIVE_TARGET; offset += BATCH) {
    const count = Math.min(BATCH, ARCHIVE_TARGET - offset);
    const create = {};
    for (let i = 0; i < count; i += 1) {
      const idx = offset + i;
      create[`a${idx}`] = buildArchiveSeed({ archive, fromEmail, index: idx });
    }
    const payload = await jmapRequest(jmap, [[
      'Email/set',
      { accountId: jmap.accountId, create },
      'arch',
    ]]);
    const set = pickResponse(payload, 'Email/set');
    if (set?.notCreated && Object.keys(set.notCreated).length > 0) {
      throw new Error(`Archive batch failed: ${JSON.stringify(set.notCreated)}`);
    }
    createdSoFar += Object.keys(set?.created ?? {}).length;
    if (offset % (BATCH * 5) === 0) {
      console.log(`[seed-dev-mail] archive ${createdSoFar}/${ARCHIVE_TARGET}`);
    }
    // Mild rate-limit pacing so the seeder doesn't hammer the local
    // Stalwart all in one go.
    await sleep(50);
  }
  console.log(`[seed-dev-mail] archive done (${createdSoFar} created)`);
}

async function seedInbox(jmap, { inbox, fromEmail }) {
  const seeds = buildInboxSeeds({ inbox, fromEmail }).slice(0, INBOX_TARGET);
  const create = {};
  seeds.forEach((seed, i) => {
    create[`s${i}`] = buildEmail({ ...seed, toEmail: fromEmail });
  });
  // Send in two batches to stay below any per-call object limit.
  const refs = Object.keys(create);
  for (let i = 0; i < refs.length; i += BATCH) {
    const slice = refs.slice(i, i + BATCH);
    const sliceCreate = {};
    for (const ref of slice) sliceCreate[ref] = create[ref];
    const payload = await jmapRequest(jmap, [[
      'Email/set',
      { accountId: jmap.accountId, create: sliceCreate },
      `inb${i}`,
    ]]);
    const set = pickResponse(payload, 'Email/set');
    if (set?.notCreated && Object.keys(set.notCreated).length > 0) {
      throw new Error(`Inbox seed failed: ${JSON.stringify(set.notCreated)}`);
    }
  }
  console.log(`[seed-dev-mail] inbox done (${seeds.length} created)`);
}

async function main() {
  console.log(`[seed-dev-mail] connecting to ${JMAP_BASE_URL} as ${DEV_OIDC_USERNAME}`);
  const jmap = await connectAsDev();
  const fromEmail = await getDevFromAddress(jmap);
  console.log(`[seed-dev-mail] connected; mail account ${jmap.accountId} (${fromEmail})`);

  let mailboxes = await listMailboxes(jmap);
  const inbox = mailboxByRole(mailboxes, 'inbox');
  if (!inbox) {
    throw new Error('No Inbox mailbox found — provision a Thundermail address first');
  }

  const { archive, created } = await ensureArchiveMailbox(jmap, mailboxes);
  if (created) {
    console.log('[seed-dev-mail] created role:archive mailbox');
  } else {
    console.log(`[seed-dev-mail] role:archive mailbox already exists (${archive.name})`);
  }

  await sweepDevSeeds(jmap);
  await seedInbox(jmap, { inbox, fromEmail });
  await seedArchive(jmap, { archive, fromEmail });

  console.log('[seed-dev-mail] all done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
