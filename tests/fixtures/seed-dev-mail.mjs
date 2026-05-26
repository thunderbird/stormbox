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
 * Re-runnable: every seeded message carries the [dev seed] subject
 * prefix, and the script sweeps all messages with that prefix before
 * recreating them. Hand-curated mail in the inbox (including
 * pre-existing "Logo demo:" messages) is left alone.
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

const SUBJECT_PREFIX = '[dev seed]';

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
 * SUBJECT_PREFIX locally on the metadata Email/get response. That's
 * O(N) over the whole mailbox but only runs at seed time and only
 * for the dev account, which is small.
 */
async function sweepDevSeeds(jmap) {
  const PAGE = 100;
  const stale = [];
  let position = 0;
  while (true) {
    const queryPayload = await jmapRequest(jmap, [[
      'Email/query',
      {
        accountId: jmap.accountId,
        position,
        limit: PAGE,
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
  // Destroy in batches so a huge sweep does not hit any per-call
  // limits.
  for (let i = 0; i < stale.length; i += PAGE) {
    const chunk = stale.slice(i, i + PAGE);
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
 * Build an Email/set create payload. `receivedAt` lets us spread the
 * seed mail across the last few weeks so the list isn't a wall of
 * identical timestamps. JMAP Email/set accepts receivedAt on create
 * for "imported" messages (RFC 8621 §4.6).
 */
function buildEmail({
  mailboxId,
  fromName, fromEmail,
  toEmail,
  subject,
  // preview is server-computed in JMAP (RFC 8621 §4) — not settable
  // on Email/set create. Stalwart derives it from the body, so we
  // just rely on a representative first line of bodyText.
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

/**
 * Provider-themed HTML templates. Each takes a few customisable
 * params and returns a self-contained HTML string. No external
 * resources — every image is an inline data URI or SVG so the
 * sandboxed message iframe renders without network access.
 */

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
    { title: 'Staff Software Engineer', company: 'Discord', location: 'San Francisco, CA · Remote', salary: '$220K–$300K · Equity' },
    { title: 'Principal Engineer, Distributed Systems', company: 'Stripe', location: 'New York, NY · On-site', salary: '$280K–$380K' },
    { title: 'Senior Backend Engineer', company: 'Anthropic', location: 'San Francisco, CA · Hybrid', salary: '$240K–$320K · 0.1%–0.5%' },
    { title: 'Engineering Manager, Platform', company: 'Vercel', location: 'Remote', salary: '$260K–$340K' },
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
    <p style="margin:0 0 24px;color:#666;font-size:14px">4 roles matched to your search · Updated 12 minutes ago</p>
    ${jobs.map((job) => `
    <div style="border:1px solid #e0e0e0;border-radius:8px;padding:16px;margin-bottom:12px">
      <h2 style="margin:0 0 4px;font-size:16px;color:#0a66c2">${job.title}</h2>
      <p style="margin:0;font-size:14px;color:#000"><strong>${job.company}</strong></p>
      <p style="margin:4px 0 0;font-size:13px;color:#666">${job.location}</p>
      <p style="margin:8px 0 12px;font-size:13px;color:#057642"><strong>${job.salary}</strong></p>
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
      ${['Sarah Chen', 'Marcus Lim', 'Priya Patel'].map((name) => `
      <div style="display:flex;gap:12px;align-items:center;padding:8px 0">
        <div style="width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#0a66c2,#004182);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:bold">${name.split(' ').map((p) => p[0]).join('')}</div>
        <div style="flex:1">
          <p style="margin:0;font-weight:bold;font-size:14px">${name}</p>
          <p style="margin:2px 0 0;font-size:13px;color:#666">Senior Engineer at Notion</p>
        </div>
        <a style="background:#fff;color:#0a66c2;border:1px solid #0a66c2;padding:4px 12px;border-radius:16px;text-decoration:none;font-size:13px;font-weight:bold">+ Connect</a>
      </div>`).join('')}
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

function substackNewsletterHtml({ title, author, subscribers }) {
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
  <p style="margin:0 0 16px;font-size:13px;color:#737373">Nov 18 · 12 min read</p>
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
    process: the systematic conversion of public goods into private capture.
  </p>
  <h2 style="margin:32px 0 12px;font-size:22px">2. The cracks that are showing</h2>
  <p style="margin:0 0 16px;font-size:17px;line-height:1.7">
    What's interesting now is that the post-platform web is taking very specific, identifiable
    shapes. Newsletters. Discords. Group chats. Small federated networks. Personal websites
    again, of all things. The forms are not new; what's new is that smart people are choosing
    them over the platforms, on purpose, with their eyes open.
  </p>
  <p style="margin:0 0 16px;font-size:17px;line-height:1.7">
    I think this is the most under-reported story of the year. Continue reading on the site →
  </p>
  <div style="text-align:center;margin:48px 0">
    <a style="display:inline-block;background:#ff6719;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px">Read on Substack</a>
  </div>
  <div style="border-top:1px solid #e0e0e0;padding-top:24px;text-align:center;font-size:13px;color:#737373">
    <p style="margin:0">You're receiving this because you subscribe to ${title}.</p>
    <p style="margin:8px 0 0"><a style="color:#737373">Unsubscribe</a> · <a style="color:#737373">Get the app</a></p>
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

async function seedMessages(jmap, { inbox, archive, fromEmail }) {
  const now = Date.now();
  const minutes = 60 * 1000;
  const hours = 60 * minutes;
  const days = 24 * hours;

  const seeds = [
    {
      mailboxId: inbox.id,
      fromName: 'Netflix',
      fromEmail: 'info@mailer.netflix.com',
      subject: 'New on Netflix: Three Body Problem and more',
      preview: "Hand-picked because you watched Stranger Things. The Substitute, Long Bright River, Pandemic Diaries, Quiet on Set — all new this week.",
      bodyText: 'See what is new on Netflix this week. Open in a browser for the best experience.',
      htmlBody: netflixHtml({
        showTitle: 'Three Body Problem',
        episodeTitle: 'Countdown — a young physicist begins seeing numbers everywhere, ticking down to a date she cannot identify.',
        runtime: '57m',
      }),
      receivedAt: now - 2 * hours,
    },
    {
      mailboxId: inbox.id,
      fromName: 'Amazon.com',
      fromEmail: 'shipment-tracking@amazon.com',
      subject: 'Shipped: Your order of Coffee Filters and Office Supplies',
      preview: 'Order #114-3782619-4426601 is on the way. Arriving Tuesday by 9pm.',
      bodyText: 'Your Amazon order has shipped. Tracking number 1Z999AA10123456784. Arriving Tuesday by 9pm.',
      htmlBody: amazonHtml({
        orderId: '114-3782619-4426601',
        deliveryWindow: 'Tuesday by 9pm',
        items: [
          { title: 'Melitta #4 Cone Coffee Filters, Natural Brown (200 ct)', seller: 'Amazon.com', price: '6.99', qty: 2 },
          { title: 'Pilot G2 Premium Gel Pens, Fine Point 0.7mm (12-pack)', seller: 'Pilot', price: '14.49', qty: 1 },
          { title: 'Logitech MX Master 3S Wireless Mouse, Graphite', seller: 'Amazon.com', price: '99.99', qty: 1 },
        ],
        total: '128.46',
      }),
      receivedAt: now - 5 * hours,
    },
    {
      mailboxId: inbox.id,
      fromName: 'LinkedIn Jobs',
      fromEmail: 'jobs-noreply@linkedin.com',
      subject: 'Senior Engineer roles matched to your search',
      preview: '4 new matches: Discord, Stripe, Anthropic, Vercel. Salaries from $220K.',
      bodyText: 'Your LinkedIn job alerts: 4 new matches today.',
      htmlBody: linkedinHtml({ recipientName: 'Admin' }),
      receivedAt: now - 8 * hours,
    },
    {
      mailboxId: inbox.id,
      fromName: 'GitHub',
      fromEmail: 'noreply@github.com',
      subject: '[Security] High severity advisory in mozilla/example-svc',
      preview: 'A vulnerability in lodash@4.17.20 requires your attention. CVSS 8.1. Upgrade available.',
      bodyText: 'Security advisory CVE-2026-4421. Severity: High. Package: lodash@4.17.20. Upgrade to lodash@4.18.0.',
      htmlBody: githubHtml({
        repo: 'mozilla/example-svc',
        advisoryId: 'CVE-2026-4421',
        severity: 'High',
        packageName: 'lodash',
        packageVersion: '4.17.20',
      }),
      receivedAt: now - 1 * days,
      keywords: { $seen: true },
    },
    {
      mailboxId: inbox.id,
      fromName: 'Spotify',
      fromEmail: 'no-reply@spotify.com',
      subject: 'Your 2026 Wrapped is here',
      preview: 'You listened for 47,302 minutes this year. That puts you in the top 2% of Phoebe Bridgers listeners.',
      bodyText: 'Your year in music. Listening time: 47,302 minutes. Top artist: Phoebe Bridgers. Top genre: Indie Folk.',
      htmlBody: spotifyWrappedHtml({
        recipientName: 'Admin',
        year: 2026,
        minutes: 47302,
        topArtist: 'Phoebe Bridgers',
        topGenre: 'Indie Folk',
      }),
      receivedAt: now - 3 * days,
    },
    {
      mailboxId: inbox.id,
      fromName: 'The Quiet Web',
      fromEmail: 'newsletter@thequietweb.substack.com',
      subject: 'The quiet collapse of the open web',
      preview: 'A reckoning is coming for the platforms that ate the internet. Here is what comes next. 12 min read.',
      bodyText: 'The Quiet Web newsletter, by R. Marsh. The quiet collapse of the open web. 12 min read.',
      htmlBody: substackNewsletterHtml({
        title: 'The Quiet Web',
        author: 'R. Marsh',
        subscribers: 18421,
      }),
      receivedAt: now - 4 * days,
      keywords: { $seen: true },
    },
    {
      mailboxId: inbox.id,
      fromName: 'UPS',
      fromEmail: 'mcinfo@ups.com',
      subject: 'UPS Update: Out for delivery today',
      preview: 'Your package, tracking 1Z999AA10123456784, is on a UPS vehicle.',
      bodyText: 'Your UPS package is out for delivery today.',
      htmlBody: upsHtml({
        trackingNumber: '1Z999AA10123456784',
        deliveryDate: 'Tuesday by end of day',
      }),
      receivedAt: now - 30 * minutes,
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
      receivedAt: now - 45 * minutes,
    },
    // Two in archive to show the role-folder works once we create it.
    {
      mailboxId: archive.id,
      fromName: 'Chase',
      fromEmail: 'no-reply@alertsp.chase.com',
      subject: 'Your monthly statement is ready',
      preview: 'Statement period: Oct 18 to Nov 17. New balance: $2,481.40.',
      bodyText: 'Your monthly Chase statement is ready. Sign in to view.',
      receivedAt: now - 12 * days,
      keywords: { $seen: true },
    },
    {
      mailboxId: archive.id,
      fromName: 'Notion',
      fromEmail: 'team@mail.notion.so',
      subject: 'You have 4 unread comments on "Q3 Retro"',
      preview: 'Alex, Priya, and 2 others left comments on a page you follow.',
      bodyText: 'New comments on "Q3 Retro": Alex, Priya, Sam, and Lin commented.',
      receivedAt: now - 20 * days,
      keywords: { $seen: true },
    },
  ];

  const create = {};
  seeds.forEach((seed, i) => {
    create[`s${i}`] = buildEmail({
      ...seed,
      toEmail: fromEmail,
    });
  });

  const payload = await jmapRequest(jmap, [[
    'Email/set',
    { accountId: jmap.accountId, create },
    'seedAll',
  ]]);
  const set = pickResponse(payload, 'Email/set');
  if (set?.notCreated && Object.keys(set.notCreated).length > 0) {
    throw new Error(`Seed create failed: ${JSON.stringify(set.notCreated)}`);
  }
  console.log(`[seed-dev-mail] seeded ${Object.keys(set?.created ?? {}).length} messages`);
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
  await seedMessages(jmap, { inbox, archive, fromEmail });

  console.log('[seed-dev-mail] done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
