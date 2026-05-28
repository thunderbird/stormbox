#!/usr/bin/env node
import fs from 'node:fs';

import {
  OIDC_CLIENT_ID,
  TEST_OIDC_EMAIL,
  TEST_OIDC_PASSWORD,
} from '../e2e/helpers/stack-env.js';

function stackHost() {
  if (process.env.STACK_HOST) return process.env.STACK_HOST;
  const inDocker = process.env.STORMBOX_IN_DOCKER === '1' || fs.existsSync('/.dockerenv');
  return inDocker ? '172.17.0.1' : '127.0.0.1';
}

const host = stackHost();
const KEYCLOAK_BASE = process.env.KEYCLOAK_BASE_URL ?? `http://${host}:8999`;
const REALM = process.env.KEYCLOAK_REALM ?? 'tbpro';
const PUBLIC_ORIGIN = process.env.VITE_LOCAL_PUBLIC_ORIGIN ?? 'https://localhost:3000';
const ADMIN_USER = process.env.KEYCLOAK_ADMIN_USER ?? 'admin';
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin';
const DEV_OIDC_USERNAME = process.env.DEV_OIDC_USERNAME ?? 'admin@example.org';
const DEV_OIDC_PASSWORD = process.env.DEV_OIDC_PASSWORD ?? 'admin';

async function request(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${options.method ?? 'GET'} ${url} failed: ${res.status} ${text}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function adminToken() {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: ADMIN_USER,
    password: ADMIN_PASSWORD,
  });
  const res = await fetch(`${KEYCLOAK_BASE}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Keycloak admin token failed: ${res.status} ${text}`);
  }
  return (await res.json()).access_token;
}

async function configureRealm(token) {
  const realm = await request(`${KEYCLOAK_BASE}/admin/realms/${REALM}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  realm.attributes = {
    ...(realm.attributes ?? {}),
    frontendUrl: PUBLIC_ORIGIN,
  };
  await request(`${KEYCLOAK_BASE}/admin/realms/${REALM}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(realm),
  });
}

async function configureClient(token) {
  const clients = await request(
    `${KEYCLOAK_BASE}/admin/realms/${REALM}/clients?clientId=${encodeURIComponent(OIDC_CLIENT_ID)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const client = clients?.[0] ?? {
    clientId: OIDC_CLIENT_ID,
    enabled: true,
    publicClient: true,
    protocol: 'openid-connect',
  };
  Object.assign(client, {
    name: 'Thunderbird Stormbox (local e2e)',
    rootUrl: `${PUBLIC_ORIGIN}/`,
    baseUrl: `${PUBLIC_ORIGIN}/`,
    adminUrl: `${PUBLIC_ORIGIN}/`,
    redirectUris: [`${PUBLIC_ORIGIN}/*`],
    webOrigins: [PUBLIC_ORIGIN],
    standardFlowEnabled: true,
    directAccessGrantsEnabled: true,
    publicClient: true,
  });
  client.attributes = {
    ...(client.attributes ?? {}),
    'pkce.code.challenge.method': 'S256',
    'post.logout.redirect.uris': `${PUBLIC_ORIGIN}/*`,
  };

  if (client.id) {
    await request(`${KEYCLOAK_BASE}/admin/realms/${REALM}/clients/${client.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(client),
    });
  } else {
    await request(`${KEYCLOAK_BASE}/admin/realms/${REALM}/clients`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(client),
    });
  }
}

async function findUser(token, username) {
  const users = await request(
    `${KEYCLOAK_BASE}/admin/realms/${REALM}/users?username=${encodeURIComponent(username)}&exact=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return users?.[0] ?? null;
}

async function ensureUser(token, { username, email, firstName, lastName, password }) {
  let user = await findUser(token, username);
  if (!user?.id) {
    // Idempotent create: the e2e account isn't in the realm import,
    // so on a fresh stack (or any time the Keycloak postgres volume
    // gets wiped) we provision it from this script. Plain
    // password credential, emailVerified=true so the OIDC flow
    // doesn't gate on a verification email.
    await request(`${KEYCLOAK_BASE}/admin/realms/${REALM}/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        username,
        email,
        firstName,
        lastName,
        emailVerified: true,
        enabled: true,
        attributes: {
          locale: ['en'],
          zoneinfo: ['UTC'],
        },
        credentials: [
          { type: 'password', value: password, temporary: false },
        ],
      }),
    });
    user = await findUser(token, username);
    if (!user?.id) throw new Error(`Failed to create Keycloak user ${username}`);
  }

  // Direct grant cannot satisfy OTP, so strip it from any test
  // user (the realm-imported admin sometimes carries one).
  const credentials = await request(
    `${KEYCLOAK_BASE}/admin/realms/${REALM}/users/${user.id}/credentials`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  for (const credential of credentials ?? []) {
    if (credential.type === 'otp') {
      await request(
        `${KEYCLOAK_BASE}/admin/realms/${REALM}/users/${user.id}/credentials/${credential.id}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      );
    }
  }

  // Always reset the password, so a stale hash from an earlier run
  // (or a pre-imported user) doesn't break direct-grant auth.
  await request(`${KEYCLOAK_BASE}/admin/realms/${REALM}/users/${user.id}/reset-password`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      type: 'password',
      value: password,
      temporary: false,
    }),
  });

  return user;
}

export async function configureKeycloak() {
  const token = await adminToken();
  await configureRealm(token);
  await configureClient(token);
  // Ensure the dedicated e2e account exists. It stays separate from
  // the developer account so Playwright sweeps and fixtures never
  // mutate a human's local mailbox.
  await ensureUser(token, {
    username: TEST_OIDC_EMAIL,
    email: TEST_OIDC_EMAIL,
    firstName: 'Stormbox',
    lastName: 'E2E',
    password: TEST_OIDC_PASSWORD,
  });
  // Keep the local developer login deterministic too. Existing
  // Keycloak volumes can otherwise preserve an unknown imported
  // password, which breaks seed-dev-mail's direct-grant auth.
  await ensureUser(token, {
    username: DEV_OIDC_USERNAME,
    email: DEV_OIDC_USERNAME,
    firstName: 'Stormbox',
    lastName: 'Dev',
    password: DEV_OIDC_PASSWORD,
  });
  console.log(
    `[configure-keycloak] ${REALM} ready for ${PUBLIC_ORIGIN}; `
    + `e2e user: ${TEST_OIDC_EMAIL}; dev user: ${DEV_OIDC_USERNAME}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  configureKeycloak().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
