import fs from "node:fs";
import http from "node:http";

/**
 * Vite dev-server proxies for LOCAL_STACK=1.
 *
 * Stormbox must stay on HTTPS (self-signed via @vitejs/plugin-basic-ssl) so
 * OPFS / SharedWorker / SubtleCrypto work. Keycloak and Stalwart speak plain
 * HTTP on the docker host, so we reverse-proxy them through the Vite origin
 * and rewrite Keycloak's advertised URLs to https://localhost:3000.
 */

const PUBLIC_ORIGIN = process.env.VITE_LOCAL_PUBLIC_ORIGIN ?? "https://localhost:3000";
const EMPTY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"></svg>';

export function localStackHost() {
  if (process.env.STACK_HOST) return process.env.STACK_HOST;
  const inDocker = process.env.STORMBOX_IN_DOCKER === "1" || fs.existsSync("/.dockerenv");
  return inDocker ? "172.17.0.1" : "127.0.0.1";
}

export function localStackHttpTarget(port) {
  return `http://${localStackHost()}:${port}`;
}

function rewriteKeycloakBody(body) {
  return body
    .replaceAll("http://keycloak:8999", PUBLIC_ORIGIN)
    .replaceAll("http://localhost:8999", PUBLIC_ORIGIN);
}

function rewriteKeycloakHeaders(headers) {
  const next = { ...headers };
  if (typeof next.location === "string") {
    next.location = rewriteKeycloakBody(next.location);
  }
  return next;
}

function rewriteStalwartBody(body) {
  return body.replaceAll(/http:\/\/[^"/]+:8081/g, `${PUBLIC_ORIGIN}/stalwart-jmap`);
}

function rewriteStalwartHeaders(headers) {
  const next = { ...headers };
  if (typeof next.location === "string" && next.location.startsWith("/jmap/")) {
    next.location = `/stalwart-jmap${next.location}`;
  }
  if (typeof next.location === "string") {
    next.location = rewriteStalwartBody(next.location);
  }
  return next;
}

function stripHopByHopHeaders(headers) {
  const next = { ...headers };
  delete next.connection;
  delete next["keep-alive"];
  delete next["proxy-authenticate"];
  delete next["proxy-authorization"];
  delete next.te;
  delete next.trailer;
  delete next["transfer-encoding"];
  delete next.upgrade;
  return next;
}

function bufferAndRewriteResponse(proxyRes, req, res, { rewriteBody = false, rewriteBodyFn, rewriteHeadersFn } = {}) {
  const chunks = [];
  proxyRes.on("data", (chunk) => chunks.push(chunk));
  proxyRes.on("end", () => {
    let body = Buffer.concat(chunks);
    const rewrittenHeaders = rewriteHeadersFn ? rewriteHeadersFn(proxyRes.headers) : proxyRes.headers;
    const headers = stripHopByHopHeaders(rewrittenHeaders);
    delete headers["content-length"];

    if (rewriteBody) {
      const text = body.toString("utf8");
      const rewritten = rewriteBodyFn ? rewriteBodyFn(text) : text;
      body = Buffer.from(rewritten, "utf8");
    }

    headers["content-length"] = String(body.length);
    res.writeHead(proxyRes.statusCode ?? 502, headers);
    res.end(body);
  });
}

export function keycloakDevProxy(target) {
  return {
    target,
    changeOrigin: true,
    secure: false,
    selfHandleResponse: true,
    headers: {
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "localhost:3000",
      "X-Forwarded-Port": "3000",
    },
    configure(proxy) {
      proxy.on("proxyRes", (proxyRes, req, res) => {
        const ct = String(proxyRes.headers["content-type"] ?? "");
        const shouldRewrite =
          req.url?.includes(".well-known/openid-configuration")
          || ct.includes("json")
          || ct.includes("html")
          || ct.includes("javascript");
        bufferAndRewriteResponse(proxyRes, req, res, {
          rewriteBody: shouldRewrite,
          rewriteBodyFn: rewriteKeycloakBody,
          rewriteHeadersFn: rewriteKeycloakHeaders,
        });
      });
    },
  };
}

export function stalwartJmapDevProxy(target) {
  return {
    target,
    changeOrigin: true,
    secure: false,
    selfHandleResponse: true,
    rewrite: (path) => path.replace(/^\/stalwart-jmap/, ""),
    configure(proxy) {
      proxy.on("proxyRes", (proxyRes, req, res) => {
        const ct = String(proxyRes.headers["content-type"] ?? "");
        const shouldRewrite = ct.includes("json");
        bufferAndRewriteResponse(proxyRes, req, res, {
          rewriteBody: shouldRewrite,
          rewriteBodyFn: rewriteStalwartBody,
          rewriteHeadersFn: rewriteStalwartHeaders,
        });
      });
    },
  };
}

function socketCanWrite(socket) {
  return !socket.destroyed && !socket.writableEnded;
}

function writeIfOpen(socket, data) {
  if (!socketCanWrite(socket)) return false;
  socket.write(data);
  return true;
}

function endIfOpen(socket) {
  if (socketCanWrite(socket)) socket.end();
}

function destroyIfOpen(socket) {
  if (!socket.destroyed) socket.destroy();
}

function isExpectedPeerClose(err) {
  return err?.code === "ECONNRESET"
    || err?.code === "EPIPE"
    || err?.code === "ERR_STREAM_WRITE_AFTER_END"
    || /socket has been ended|write after end/i.test(String(err?.message ?? ""));
}

function logUnexpectedSocketError(logger, label, err) {
  if (isExpectedPeerClose(err)) return;
  logger.warn(`[jmap-ws-proxy] ${label}: ${err?.message ?? err}`);
}

function rawHeaders(rawHeaders) {
  const lines = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    lines.push(`${rawHeaders[index]}: ${rawHeaders[index + 1]}`);
  }
  return lines;
}

function responseHead(proxyRes) {
  const statusCode = proxyRes.statusCode ?? 502;
  const statusMessage = proxyRes.statusMessage ?? http.STATUS_CODES[statusCode] ?? "";
  return [
    `HTTP/1.1 ${statusCode} ${statusMessage}`,
    ...rawHeaders(proxyRes.rawHeaders ?? []),
    "",
    "",
  ].join("\r\n");
}

function pipeWebSocketSockets(clientSocket, upstreamSocket, logger) {
  const forward = (source, destination) => (chunk) => {
    if (!writeIfOpen(destination, chunk)) {
      destroyIfOpen(source);
    }
  };

  clientSocket.on("data", forward(clientSocket, upstreamSocket));
  upstreamSocket.on("data", forward(upstreamSocket, clientSocket));
  clientSocket.on("end", () => endIfOpen(upstreamSocket));
  upstreamSocket.on("end", () => endIfOpen(clientSocket));
  clientSocket.on("close", () => destroyIfOpen(upstreamSocket));
  upstreamSocket.on("close", () => destroyIfOpen(clientSocket));
  clientSocket.on("error", (err) => {
    logUnexpectedSocketError(logger, "client socket error", err);
    destroyIfOpen(upstreamSocket);
  });
  upstreamSocket.on("error", (err) => {
    logUnexpectedSocketError(logger, "upstream socket error", err);
    destroyIfOpen(clientSocket);
  });
}

function proxyJmapWebSocket(req, clientSocket, head, target, logger) {
  const proxyReq = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: req.url,
    headers: {
      ...req.headers,
      host: target.host,
    },
  });

  proxyReq.on("upgrade", (proxyRes, upstreamSocket, proxyHead) => {
    if (!writeIfOpen(clientSocket, responseHead(proxyRes))) {
      destroyIfOpen(upstreamSocket);
      return;
    }
    if (proxyHead.length > 0) writeIfOpen(clientSocket, proxyHead);
    if (head.length > 0) writeIfOpen(upstreamSocket, head);
    pipeWebSocketSockets(clientSocket, upstreamSocket, logger);
  });

  proxyReq.on("response", (proxyRes) => {
    if (!writeIfOpen(clientSocket, responseHead(proxyRes))) {
      proxyRes.resume();
      return;
    }
    proxyRes.on("data", (chunk) => writeIfOpen(clientSocket, chunk));
    proxyRes.on("end", () => destroyIfOpen(clientSocket));
  });

  proxyReq.on("error", (err) => {
    logUnexpectedSocketError(logger, "upgrade request error", err);
    if (socketCanWrite(clientSocket)) {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    }
  });

  clientSocket.on("error", (err) => {
    logUnexpectedSocketError(logger, "client socket error", err);
    proxyReq.destroy();
  });
  clientSocket.on("close", () => proxyReq.destroy());

  proxyReq.end();
}

export function jmapWsDevProxyPlugin(target = "http://127.0.0.1:8787") {
  const proxyTarget = new URL(target);
  return {
    name: "stormbox:jmap-ws-dev-proxy",
    apply: "serve",
    configureServer(server) {
      server.httpServer?.on("upgrade", (req, socket, head) => {
        if (!req.url?.startsWith("/jmap/ws")) return;
        proxyJmapWebSocket(req, socket, head, proxyTarget, server.config.logger);
      });
    },
  };
}

export function senderAvatarDevProxy(target = "https://geticon.dev") {
  return {
    target,
    changeOrigin: true,
    secure: true,
    selfHandleResponse: true,
    rewrite: (path) => {
      const [pathname] = path.split("?");
      const encoded = pathname.replace(/^\/sender-avatar\/?/, "");
      if (!encoded || encoded.includes("/")) return "/?url=";
      return `/?url=${encodeURIComponent(decodeURIComponent(encoded))}`;
    },
    configure(proxy) {
      proxy.on("proxyRes", (proxyRes, req, res) => {
        bufferSenderAvatarResponse(proxyRes, req, res);
      });
      proxy.on("error", (_err, _req, res) => {
        writeSenderAvatarResponse(res, {
          body: Buffer.from(EMPTY_SVG),
          headers: {
            "content-type": "image/svg+xml",
            "cache-control": "no-store",
          },
          status: 502,
        });
      });
    },
  };
}

export function localStackPublicOrigin() {
  return PUBLIC_ORIGIN;
}

async function bufferSenderAvatarResponse(proxyRes, req, res) {
  const chunks = [];
  proxyRes.on("data", (chunk) => chunks.push(chunk));
  proxyRes.on("end", async () => {
    let body = Buffer.concat(chunks);
    let headers = { ...proxyRes.headers };
    let status = proxyRes.statusCode ?? 502;

    if (shouldUseSenderAvatarFallback(status, headers, body)) {
      const fallback = await fetchGoogleFavicon(senderAvatarDomainFromRequest(req.url ?? ""));
      if (fallback) {
        ({ body, headers, status } = fallback);
      } else {
        body = Buffer.from(EMPTY_SVG);
        headers = {
          "content-type": "image/svg+xml",
          "cache-control": "no-store",
        };
        status = 404;
      }
    }

    writeSenderAvatarResponse(res, { body, headers, status });
  });
}

function writeSenderAvatarResponse(res, { body, headers, status }) {
  headers = stripHopByHopHeaders(headers);
  delete headers["content-length"];
  headers["content-length"] = String(body.length);
  res.writeHead(status, headers);
  res.end(body);
}

function shouldUseSenderAvatarFallback(status, headers, body) {
  if (status < 200 || status >= 300) return true;
  const contentType = String(headers["content-type"] ?? "");
  if (!contentType.includes("image/")) return true;
  return isGeticonGeneratedAvatar(headers, body);
}

function isGeticonGeneratedAvatar(headers, body) {
  const contentType = String(headers["content-type"] ?? "");
  return contentType.includes("image/svg")
    && body.includes("font-family=\"system-ui,sans-serif\"")
    && body.includes("<text");
}

function senderAvatarDomainFromRequest(url) {
  try {
    const parsed = new URL(url, "https://local.invalid");
    return parsed.searchParams.get("url") ?? "";
  } catch {
    return "";
  }
}

async function fetchGoogleFavicon(domain) {
  if (!domain) return null;
  try {
    const url = new URL("https://www.google.com/s2/favicons");
    url.searchParams.set("domain", domain);
    url.searchParams.set("sz", "64");
    const response = await fetch(url, { headers: { Accept: "image/png,image/*" } });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("image/")) return null;
    return {
      body: Buffer.from(await response.arrayBuffer()),
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=604800",
      },
      status: response.status,
    };
  } catch {
    return null;
  }
}
