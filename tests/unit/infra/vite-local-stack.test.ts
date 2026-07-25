import { EventEmitter } from 'node:events';
import zlib from 'node:zlib';

import {
  afterEach, describe, expect, it, vi,
} from 'vitest';

import {
  bufferAndRewriteResponse,
  keycloakDevProxy,
  rewriteKeycloakBody,
  shouldRewriteKeycloakBody,
} from '../../../vite.local-stack.mjs';

/**
 * The module reads its origins once at import time, so tests that change
 * them have to re-import. Returns the freshly evaluated module.
 */
async function withOrigins({ publicOrigin, frontendOrigin }: {
  publicOrigin?: string;
  frontendOrigin?: string;
}) {
  vi.resetModules();
  if (publicOrigin !== undefined) {
    vi.stubEnv('VITE_LOCAL_PUBLIC_ORIGIN', publicOrigin);
  }
  if (frontendOrigin !== undefined) {
    vi.stubEnv('KEYCLOAK_FRONTEND_ORIGIN', frontendOrigin);
  }
  return import('../../../vite.local-stack.mjs');
}

type ProxyHeaders = Record<string, string | string[] | undefined>;

interface BufferedRequest {
  body: Buffer;
  headers: ProxyHeaders;
  rewriteBody?: boolean;
  rewriteBodyFn?: (body: string) => string;
  statusCode?: number;
}

interface BufferedResult {
  body: Buffer;
  headers: ProxyHeaders;
  status: number;
}

function bufferedResponse({
  body,
  headers,
  rewriteBody = false,
  rewriteBodyFn,
  statusCode = 200,
}: BufferedRequest): Promise<BufferedResult> {
  return new Promise<BufferedResult>((resolve) => {
    const proxyRes = Object.assign(new EventEmitter(), { headers, statusCode });

    const res = {
      status: 0,
      headers: {} as ProxyHeaders,
      writeHead(status: number, writtenHeaders: ProxyHeaders) {
        this.status = status;
        this.headers = writtenHeaders;
      },
      end(writtenBody: Buffer | string) {
        resolve({
          body: Buffer.from(writtenBody),
          headers: this.headers,
          status: this.status,
        });
      },
    };

    const rewriteOptions = { rewriteBody, rewriteBodyFn };
    bufferAndRewriteResponse(proxyRes, { url: '/test' }, res, rewriteOptions);

    proxyRes.emit('data', body);
    proxyRes.emit('end');
  });
}

describe('local-stack Keycloak dev proxy', () => {
  it('requests identity encoding from Keycloak', () => {
    const proxy = new EventEmitter();
    const config = keycloakDevProxy('http://keycloak:8999');

    config.configure(proxy);

    const proxyReq = { setHeader: vi.fn() };
    proxy.emit('proxyReq', proxyReq);

    expect(config.headers['Accept-Encoding']).toBe('identity');
    expect(proxyReq.setHeader).toHaveBeenCalledWith('Accept-Encoding', 'identity');
  });

  it('does not rewrite static JavaScript resources', () => {
    expect(shouldRewriteKeycloakBody(
      { url: '/resources/abc/login/tbpro/static/app.js' },
      { headers: { 'content-type': 'application/javascript' } },
    )).toBe(false);

    expect(shouldRewriteKeycloakBody(
      { url: '/resources/abc/login/tbpro/static/app.css' },
      { headers: { 'content-type': 'text/css' } },
    )).toBe(false);
  });

  it('rewrites OIDC JSON and HTML pages', () => {
    expect(shouldRewriteKeycloakBody(
      { url: '/realms/tbpro/.well-known/openid-configuration' },
      { headers: { 'content-type': 'application/json' } },
    )).toBe(true);

    expect(shouldRewriteKeycloakBody(
      { url: '/realms/tbpro/protocol/openid-connect/auth' },
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    )).toBe(true);
  });
});

describe('serving a worktree on a non-default origin', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('rewrites the realm\'s pinned frontend origin to this worktree\'s origin', async () => {
    // The shared Keycloak realm pins `frontendUrl` to one origin and
    // honours it over X-Forwarded-* headers, so a second worktree
    // receives a discovery document pointing at the first one. Without
    // this rewrite its OIDC redirect leaves the app entirely.
    const mod = await withOrigins({
      publicOrigin: 'https://localhost:3001',
      frontendOrigin: 'https://localhost:3000',
    });

    const discovery = JSON.stringify({
      issuer: 'https://localhost:3000/realms/tbpro',
      authorization_endpoint: 'https://localhost:3000/realms/tbpro/protocol/openid-connect/auth',
      jwks_uri: 'http://keycloak:8999/realms/tbpro/protocol/openid-connect/certs',
    });

    const rewritten = JSON.parse(mod.rewriteKeycloakBody(discovery));
    expect(rewritten.issuer).toBe('https://localhost:3001/realms/tbpro');
    expect(rewritten.authorization_endpoint).toContain('https://localhost:3001');
    // The pre-existing in-cluster host rewrite still applies.
    expect(rewritten.jwks_uri).toContain('https://localhost:3001');
  });

  it('does not corrupt an origin whose port merely starts with the pinned one', async () => {
    // A plain substring replace turns "https://localhost:30001/x" into
    // "https://localhost:300011/x", because :3000 is a prefix of :30001.
    const mod = await withOrigins({
      publicOrigin: 'https://localhost:30001',
      frontendOrigin: 'https://localhost:3000',
    });
    const body = JSON.stringify({
      issuer: 'https://localhost:3000/realms/tbpro',
      already: 'https://localhost:30001/realms/tbpro',
    });
    const out = JSON.parse(mod.rewriteKeycloakBody(body));
    expect(out.issuer).toBe('https://localhost:30001/realms/tbpro');
    expect(out.already).toBe('https://localhost:30001/realms/tbpro');
  });

  it('leaves the body untouched when the worktree owns the pinned origin', async () => {
    const mod = await withOrigins({
      publicOrigin: 'https://localhost:3000',
      frontendOrigin: 'https://localhost:3000',
    });
    const body = JSON.stringify({ issuer: 'https://localhost:3000/realms/tbpro' });
    expect(mod.rewriteKeycloakBody(body)).toBe(body);
  });

  it('derives the forwarded host and port from the public origin', async () => {
    const mod = await withOrigins({ publicOrigin: 'https://localhost:3001' });
    const config = mod.keycloakDevProxy('http://keycloak:8999');
    expect(config.headers['X-Forwarded-Host']).toBe('localhost:3001');
    expect(config.headers['X-Forwarded-Port']).toBe('3001');
    expect(config.headers['X-Forwarded-Proto']).toBe('https');
  });

  it('falls back to the default port when the origin omits one', async () => {
    const mod = await withOrigins({ publicOrigin: 'https://mail.example.test' });
    const config = mod.keycloakDevProxy('http://keycloak:8999');
    expect(config.headers['X-Forwarded-Host']).toBe('mail.example.test');
    expect(config.headers['X-Forwarded-Port']).toBe('443');
  });
});

describe('bufferAndRewriteResponse', () => {
  it('decodes compressed rewritten responses and drops stale body headers', async () => {
    const upstreamBody = Buffer.from('{"issuer":"http://keycloak:8999/realms/tbpro"}');
    const gzipped = zlib.gzipSync(upstreamBody);

    const result = await bufferedResponse({
      body: gzipped,
      headers: {
        'content-encoding': 'gzip',
        'content-length': String(gzipped.length),
        'content-type': 'application/json',
        etag: '"stale"',
      },
      rewriteBody: true,
      rewriteBodyFn: (body) => body.replaceAll('http://keycloak:8999', 'https://localhost:3000'),
    });

    expect(result.status).toBe(200);
    expect(result.headers['content-encoding']).toBeUndefined();
    expect(result.headers.etag).toBeUndefined();
    expect(result.headers['content-length']).toBe(String(result.body.length));
    expect(result.body.toString('utf8')).toBe('{"issuer":"https://localhost:3000/realms/tbpro"}');
  });

  it('passes compressed static resources through unchanged when not rewriting', async () => {
    const upstreamBody = Buffer.from('console.log("tbpro theme");');
    const gzipped = zlib.gzipSync(upstreamBody);

    const result = await bufferedResponse({
      body: gzipped,
      headers: {
        'content-encoding': 'gzip',
        'content-length': String(gzipped.length),
        'content-type': 'application/javascript',
      },
      rewriteBody: false,
    });

    expect(result.status).toBe(200);
    expect(result.headers['content-encoding']).toBe('gzip');
    expect(result.headers['content-length']).toBe(String(gzipped.length));
    expect(result.body.equals(gzipped)).toBe(true);
  });
});
