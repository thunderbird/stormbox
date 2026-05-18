#!/usr/bin/env node

import { chromium, firefox } from '@playwright/test';
import WebSocket from 'ws';

const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';
const ACCOUNT_ID = process.env.STAGE_ACCOUNT_ID || 'u';
const ARCHIVE_MAILBOX_ID = process.env.STAGE_ARCHIVE_MAILBOX_ID || 'h';
const USERNAME = process.env.STAGE_USERNAME || 'sancus@stage-thundermail.com';
const PASSWORD = process.env.STAGE_PASSWORD;
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'https://localhost:3000';
const CHUNK = Number(process.env.CHUNK_SIZE || 500);
const MODE = process.env.MODE || 'both';
const BROWSER = process.env.BROWSER || 'chromium';

const PROPERTIES = [
  'id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'size',
  'receivedAt', 'sentAt', 'messageId', 'inReplyTo', 'references',
  'sender', 'from', 'to', 'cc', 'bcc', 'replyTo',
  'subject', 'preview', 'hasAttachment',
];

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function waitFor(ws, event) {
  return new Promise((resolve, reject) => {
    const onErr = (err) => { cleanup(); reject(err); };
    const onEvent = (...args) => { cleanup(); resolve(args); };
    const cleanup = () => {
      ws.off('error', onErr);
      ws.off(event, onEvent);
    };
    ws.once('error', onErr);
    ws.once(event, onEvent);
  });
}

function chunkSummary(chunks) {
  const sumMs = chunks.reduce((sum, c) => sum + c.ms, 0);
  return {
    chunks: chunks.length,
    emails: chunks.reduce((sum, c) => sum + (c.emails ?? c.fetched ?? 0), 0),
    bytes: chunks.reduce((sum, c) => sum + (c.bytes ?? 0), 0),
    sumMs: Math.round(sumMs),
    avgMs: chunks.length ? Math.round(sumMs / chunks.length) : null,
    maxMs: chunks.length ? Math.max(...chunks.map((c) => c.ms)) : null,
    minMs: chunks.length ? Math.min(...chunks.map((c) => c.ms)) : null,
  };
}

async function networkOnly() {
  const basic = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  const wsUrl = `wss://wsmail.stage-thundermail.com/jmap/ws?basic=${encodeURIComponent(basic)}`;
  const connectStart = nowMs();
  const ws = new WebSocket(wsUrl, ['jmap']);
  await waitFor(ws, 'open');
  const connectMs = nowMs() - connectStart;
  let nextId = 1;
  const pending = new Map();
  ws.on('message', (buf) => {
    const recvMs = nowMs();
    const raw = buf.toString();
    const msg = JSON.parse(raw);
    const p = pending.get(msg.requestId);
    if (!p) return;
    pending.delete(msg.requestId);
    p.resolve({ msg, rawBytes: Buffer.byteLength(raw), recvMs });
  });

  function request(position, limit) {
    const id = `r${nextId++}`;
    const payload = {
      '@type': 'Request',
      id,
      using: [CORE, MAIL],
      methodCalls: [
        ['Email/query', {
          accountId: ACCOUNT_ID,
          filter: { inMailbox: ARCHIVE_MAILBOX_ID },
          sort: [{ property: 'receivedAt', isAscending: false }],
          position,
          limit,
          calculateTotal: true,
          collapseThreads: false,
        }, 'q1'],
        ['Email/get', {
          accountId: ACCOUNT_ID,
          '#ids': { resultOf: 'q1', name: 'Email/query', path: '/ids' },
          properties: PROPERTIES,
        }, 'g1'],
      ],
    };
    const sentMs = nowMs();
    const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    ws.send(JSON.stringify(payload));
    return promise.then(({ msg, rawBytes, recvMs }) => {
      const query = msg.methodResponses?.find((r) => r[0] === 'Email/query')?.[1] ?? {};
      const get = msg.methodResponses?.find((r) => r[0] === 'Email/get')?.[1] ?? {};
      return {
        position,
        requested: limit,
        ids: query.ids?.length ?? 0,
        total: query.total ?? null,
        emails: get.list?.length ?? 0,
        bytes: rawBytes,
        ms: Math.round(recvMs - sentMs),
      };
    });
  }

  const chunks = [];
  const first = await request(0, CHUNK);
  chunks.push(first);
  const total = first.total ?? first.ids;
  for (let pos = CHUNK; pos < total; pos += CHUNK) {
    chunks.push(await request(pos, Math.min(CHUNK, total - pos)));
  }
  ws.close(1000, 'done');
  return {
    transport: 'direct WS via wsmail.stage-thundermail.com proxy',
    connectMs: Math.round(connectMs),
    chunkLimit: CHUNK,
    totalMessages: total,
    chunks,
    totals: chunkSummary(chunks),
  };
}

async function persist() {
  const browserType = BROWSER === 'firefox' ? firefox : chromium;
  const browser = await browserType.launch({ headless: true });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: /use app password instead/i }).click();
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('App password').fill(PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.locator('.shell').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => !!window.__repo, { timeout: 30_000 });
  const setup = await page.evaluate(async () => {
    const accounts = await window.__repo.listAccounts();
    const account = accounts[0];
    const folders = await window.__repo.listFolders(account.id);
    const archive = folders.find((f) => f.role === 'archive' || /archive/i.test(f.name));
    return {
      accountId: account.id,
      folderId: archive.id,
      folderName: archive.name,
      total: Number(archive.total_emails || 0),
    };
  });

  const chunks = [];
  const wallStart = nowMs();
  for (let position = 0; position < setup.total; position += CHUNK) {
    const limit = Math.min(CHUNK, setup.total - position);
    const start = nowMs();
    const result = await page.evaluate(async ({ accountId, folderId, offset, limit }) => {
      return window.__repo.ensureFolderWindow(accountId, folderId, { offset, limit });
    }, { accountId: setup.accountId, folderId: setup.folderId, offset: position, limit });
    const rowCount = await page.evaluate(async ({ accountId, folderId, offset, limit }) => {
      const rows = await window.__repo.listMessagesForView({ accountId, folderId, sort: 'received', offset, limit });
      return rows.length;
    }, { accountId: setup.accountId, folderId: setup.folderId, offset: position, limit });
    chunks.push({
      position,
      requested: limit,
      fetched: result?.fetched ?? null,
      total: result?.total ?? null,
      readBack: rowCount,
      ms: Math.round(nowMs() - start),
    });
  }
  const wallMs = Math.round(nowMs() - wallStart);
  await browser.close();
  return {
    browser: BROWSER,
    baseUrl: BASE_URL,
    folder: setup.folderName,
    chunkLimit: CHUNK,
    totalMessages: setup.total,
    wallMs,
    chunks,
    totals: chunkSummary(chunks),
  };
}

if (!PASSWORD) {
  throw new Error('STAGE_PASSWORD is required');
}

const out = {};
if (MODE === 'network-only' || MODE === 'both') {
  out.networkOnly = await networkOnly();
}
if (MODE === 'persist' || MODE === 'both') {
  out.persist = await persist();
}
if (out.networkOnly && out.persist) {
  out.ratio = {
    wall: Number((out.persist.wallMs / (out.networkOnly.totals.sumMs + out.networkOnly.connectMs)).toFixed(2)),
    avgChunk: Number((out.persist.totals.avgMs / out.networkOnly.totals.avgMs).toFixed(2)),
  };
}
console.log(JSON.stringify(out, null, 2));
