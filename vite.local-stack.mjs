/**
 * Vite dev-server proxies for LOCAL_STACK=1.
 *
 * Stormbox must stay on HTTPS (self-signed via @vitejs/plugin-basic-ssl) so
 * OPFS / SharedWorker / SubtleCrypto work. Keycloak and Stalwart speak plain
 * HTTP on the docker host, so we reverse-proxy them through the Vite origin
 * and rewrite Keycloak's advertised URLs to https://localhost:3000.
 */

const PUBLIC_ORIGIN = process.env.VITE_LOCAL_PUBLIC_ORIGIN ?? "https://localhost:3000";

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

function bufferAndRewriteResponse(proxyRes, req, res, { rewriteBody = false, rewriteBodyFn, rewriteHeadersFn } = {}) {
  const chunks = [];
  proxyRes.on("data", (chunk) => chunks.push(chunk));
  proxyRes.on("end", () => {
    let body = Buffer.concat(chunks);
    const headers = rewriteHeadersFn ? rewriteHeadersFn(proxyRes.headers) : proxyRes.headers;
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

export function localStackPublicOrigin() {
  return PUBLIC_ORIGIN;
}
