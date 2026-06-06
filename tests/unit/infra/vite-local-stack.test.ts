import { EventEmitter } from 'node:events';
import zlib from 'node:zlib';

import {
  describe, expect, it, vi,
} from 'vitest';

import {
  bufferAndRewriteResponse,
  keycloakDevProxy,
  shouldRewriteKeycloakBody,
} from '../../../vite.local-stack.mjs';

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
