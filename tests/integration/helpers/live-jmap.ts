import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { JmapBackend } from '../../../src/sync/backends/jmap/backend';
import { ingestSession } from '../../../src/sync/backends/jmap/session';
import {
  JMAP_CAPS,
  JmapTransport,
} from '../../../src/sync/backends/jmap/transport';
import { getAccessToken } from '../../e2e/helpers/jmap-client';
import {
  INTEGRATION_TEST_OIDC_EMAIL,
  INTEGRATION_TEST_OIDC_PASSWORD,
  JMAP_BASE_URL,
} from '../../e2e/helpers/stack-env';

export const CONTACTS_USING = [
  JMAP_CAPS.CORE,
  JMAP_CAPS.CONTACTS,
] as const;

export const MAIL_USING = [
  JMAP_CAPS.CORE,
  JMAP_CAPS.MAIL,
] as const;

export const MAIL_SEND_USING = [
  JMAP_CAPS.CORE,
  JMAP_CAPS.MAIL,
  JMAP_CAPS.SUBMISSION,
] as const;

export function responseById(
  response: any,
  name: string,
  callId: string,
): any {
  return response?.methodResponses?.find(
    (item: any) => item?.[0] === name && item?.[2] === callId,
  )?.[1] ?? null;
}

export function requireResponseById(
  response: any,
  name: string,
  callId: string,
): any {
  const result = responseById(response, name, callId);
  if (result) return result;
  const error = responseById(response, 'error', callId);
  throw new Error(
    `${name} ${callId} failed: ${JSON.stringify(error ?? response)}`,
  );
}

function rewriteEndpoint(endpoint: string, publicOrigin: string): string {
  const advertisedOrigin = new URL(endpoint).origin;
  return endpoint.replace(advertisedOrigin, publicOrigin);
}

function rewriteSessionEndpoints(session: any, publicOrigin: string) {
  for (const key of ['apiUrl', 'uploadUrl', 'downloadUrl'] as const) {
    if (typeof session[key] === 'string') {
      session[key] = rewriteEndpoint(session[key], publicOrigin);
    }
  }
  return session;
}

function bindBackendAccounts(
  backend: JmapBackend,
  ingested: { account: any; sharedAccounts: any[] },
) {
  backend.account = ingested.account;
  backend.sharedAccounts = ingested.sharedAccounts ?? [];
  backend._accountsByLocalId = new Map(
    [backend.account, ...backend.sharedAccounts].map((account) => [
      Number(account.id),
      account,
    ]),
  );
  backend._accountsByRemoteId = new Map(
    [backend.account, ...backend.sharedAccounts].map((account) => [
      account.remote_account_id,
      account,
    ]),
  );
}

export async function createLiveTransport(credentials: {
  email: string;
  password: string;
}) {
  const token = await getAccessToken(credentials);
  const authHeader = `Bearer ${token}`;
  const publicOrigin = new URL(JMAP_BASE_URL).origin;
  const transport = new JmapTransport({
    sessionUrl: `${JMAP_BASE_URL.replace(/\/$/, '')}/.well-known/jmap`,
    getAuthHeader: async () => authHeader,
  });
  const session = rewriteSessionEndpoints(await transport.fetchSession(), publicOrigin);
  const accountId = session.primaryAccounts?.[JMAP_CAPS.MAIL];
  if (typeof accountId !== 'string' || !accountId) {
    throw new Error(`JMAP session for ${credentials.email} has no primary mail account`);
  }
  return {
    accountId,
    publicOrigin,
    session,
    transport,
  };
}

export async function createLiveIntegrationContext() {
  const token = await getAccessToken({
    email: INTEGRATION_TEST_OIDC_EMAIL,
    password: INTEGRATION_TEST_OIDC_PASSWORD,
  });
  const authHeader = `Bearer ${token}`;
  const publicOrigin = new URL(JMAP_BASE_URL).origin;
  const transport = new JmapTransport({
    sessionUrl: `${JMAP_BASE_URL.replace(/\/$/, '')}/.well-known/jmap`,
    getAuthHeader: async () => authHeader,
  });
  const session = rewriteSessionEndpoints(await transport.fetchSession(), publicOrigin);
  const remoteAccountId = session.primaryAccounts?.[JMAP_CAPS.CONTACTS];
  if (typeof remoteAccountId !== 'string' || !remoteAccountId) {
    throw new Error('JMAP session has no primary contacts account');
  }
  const engine = await bootTestEngine();
  const handlers = makeHandlers(engine);
  const account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'Stormbox Integration',
    primaryEmail: INTEGRATION_TEST_OIDC_EMAIL,
    serverOrigin: publicOrigin,
    remoteAccountId,
    isPrimary: true,
  })).row;
  return {
    account,
    engine,
    handlers,
    session,
    transport,
  };
}

export async function createLiveMailIntegrationContext() {
  const live = await createLiveTransport({
    email: INTEGRATION_TEST_OIDC_EMAIL,
    password: INTEGRATION_TEST_OIDC_PASSWORD,
  });
  const engine = await bootTestEngine();
  const handlers = makeHandlers(engine);
  const ingested = await ingestSession({
    session: live.session,
    serverOrigin: live.publicOrigin,
    handlers,
  });
  const backend = new JmapBackend({
    transport: live.transport,
    serverOrigin: live.publicOrigin,
    handlers,
    options: { useWebSocket: false },
  });
  bindBackendAccounts(backend, ingested);
  return {
    account: ingested.account,
    backend,
    engine,
    handlers,
    publicOrigin: live.publicOrigin,
    session: live.session,
    sharedAccounts: ingested.sharedAccounts,
    transport: live.transport,
  };
}

export async function refreshLiveMailSession(
  context: Awaited<ReturnType<typeof createLiveMailIntegrationContext>>,
) {
  const session = rewriteSessionEndpoints(
    await context.transport.fetchSession({ force: true }),
    context.publicOrigin,
  );
  const ingested = await ingestSession({
    session,
    serverOrigin: context.publicOrigin,
    handlers: context.handlers,
  });
  bindBackendAccounts(context.backend, ingested);
  context.account = ingested.account;
  context.session = session;
  context.sharedAccounts = ingested.sharedAccounts;
  return ingested;
}
