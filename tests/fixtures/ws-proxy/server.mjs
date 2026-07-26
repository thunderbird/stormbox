#!/usr/bin/env node
/**
 * Local JMAP WebSocket auth proxy for the e2e stack.
 * Converts ?access_token= or ?basic= on the upgrade URL into Authorization.
 *
 * It also injects method-level JMAP errors on demand; see inject.mjs
 * for why that has to happen here.
 */
import http from 'node:http';
import fs from 'node:fs';
import { URL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

import { createInjector, FAULTS_PATH, KNOWN_FAULT_MODES, STATUS_PATH } from './inject.mjs';

function stackHost() {
  if (process.env.STACK_HOST) return process.env.STACK_HOST;
  const inDocker = process.env.STORMBOX_IN_DOCKER === '1' || fs.existsSync('/.dockerenv');
  return inDocker ? '172.17.0.1' : '127.0.0.1';
}

const UPSTREAM_BASE = process.env.UPSTREAM_BASE ?? `http://${stackHost()}:8081`;
const PORT = Number(process.env.WS_PROXY_PORT ?? 8787);
const upstreamOrigin = new URL(UPSTREAM_BASE);
const upstreamIsTls = upstreamOrigin.protocol === 'https:';

function closePeer(peer, code, reason) {
  try {
    if (code === 1000 || (code >= 3000 && code <= 4999)) {
      peer.close(code, reason);
    } else {
      peer.close();
    }
  } catch {
    peer.terminate?.();
  }
}

/**
 * Every fault this process has applied, newest connection last. Read by
 * the interrupted-send spec: without it, a test whose injection quietly
 * stopped matching would still pass, because an uninterrupted send
 * satisfies most of what it asserts.
 */
const appliedFaults = [];

/** Client sockets currently connected, reported over STATUS_PATH. */
let liveSockets = 0;

const server = http.createServer((req, res) => {
  if (req.url === FAULTS_PATH) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(appliedFaults));
    return;
  }
  if (req.url === STATUS_PATH) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ liveSockets, modes: KNOWN_FAULT_MODES }));
    return;
  }
  res.writeHead(426, { 'Content-Type': 'text/plain' });
  res.end('Expected Upgrade: websocket');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (!url.pathname.startsWith('/jmap/')) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\nOnly /jmap/* upgrades are proxied\r\n');
    socket.destroy();
    return;
  }

  const bearer = url.searchParams.get('access_token');
  const basic = url.searchParams.get('basic');
  url.searchParams.delete('access_token');
  url.searchParams.delete('basic');

  let authHeader = null;
  if (bearer && !basic) authHeader = `Bearer ${bearer}`;
  else if (basic && !bearer) authHeader = `Basic ${basic}`;
  else {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\nMissing access_token or basic\r\n');
    socket.destroy();
    return;
  }

  const targetPath = url.pathname + url.search;
  const wsProto = upstreamIsTls ? 'wss' : 'ws';
  const targetUrl = `${wsProto}://${upstreamOrigin.host}${targetPath}`;

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    liveSockets += 1;
    clientWs.on('close', () => {
      liveSockets -= 1;
    });
    const upstreamWs = new WebSocket(targetUrl, ['jmap'], {
      headers: { Authorization: authHeader },
      rejectUnauthorized: false,
    });
    const queuedClientMessages = [];
    const injector = createInjector({ applied: appliedFaults });

    clientWs.on('message', (data, isBinary) => {
      if (!isBinary) {
        const decision = injector.onClientFrame(data.toString());
        if (decision.action === 'answer') {
          console.log(`[ws-proxy] answering request ${decision.response.requestId} with ${decision.kind}`);
          clientWs.send(JSON.stringify(decision.response));
          return;
        }
        if (decision.kind) {
          console.log(`[ws-proxy] forwarding request under ${decision.kind}`);
        }
      }
      if (upstreamWs.readyState === WebSocket.OPEN) {
        upstreamWs.send(data, { binary: isBinary });
      } else if (upstreamWs.readyState === WebSocket.CONNECTING) {
        queuedClientMessages.push({ data, isBinary });
      }
    });
    clientWs.on('close', (code, reason) => {
      if (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING) {
        closePeer(upstreamWs, code, reason);
      }
    });

    upstreamWs.on('open', () => {
      for (const { data, isBinary } of queuedClientMessages.splice(0)) {
        upstreamWs.send(data, { binary: isBinary });
      }
    });

    upstreamWs.on('message', (data, isBinary) => {
      if (clientWs.readyState !== WebSocket.OPEN) return;
      if (!isBinary) {
        const decision = injector.onServerFrame(data.toString());
        if (decision.action === 'drop') {
          console.log(`[ws-proxy] withholding a response under ${decision.kind}`);
          return;
        }
        if (decision.action === 'replace') {
          console.log(`[ws-proxy] blanking response ${decision.response.requestId} under ${decision.kind}`);
          clientWs.send(JSON.stringify(decision.response));
          return;
        }
      }
      clientWs.send(data, { binary: isBinary });
    });
    upstreamWs.on('close', (code, reason) => {
      if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
        closePeer(clientWs, code, reason);
      }
    });

    upstreamWs.on('error', (err) => {
      console.error('[ws-proxy] upstream error:', err.message);
      clientWs.close(1011, 'upstream error');
    });

    clientWs.on('error', (err) => {
      console.error('[ws-proxy] client error:', err.message);
      upstreamWs.close();
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ws-proxy] listening on http://127.0.0.1:${PORT} -> ${UPSTREAM_BASE}`);
});
