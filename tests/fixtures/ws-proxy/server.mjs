#!/usr/bin/env node
/**
 * Local JMAP WebSocket auth proxy (same contract as infra/ws-proxy).
 * Converts ?access_token= or ?basic= on the upgrade URL into Authorization.
 */
import http from 'node:http';
import fs from 'node:fs';
import { URL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

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

const server = http.createServer((_req, res) => {
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
    const upstreamWs = new WebSocket(targetUrl, ['jmap'], {
      headers: { Authorization: authHeader },
      rejectUnauthorized: false,
    });
    const queuedClientMessages = [];

    clientWs.on('message', (data, isBinary) => {
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
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
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
