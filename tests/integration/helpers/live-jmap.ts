import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { JmapBackend } from '../../../src/sync/backends/jmap/backend';
import { processMutationRow } from '../../../src/sync/backends/jmap/outbox';
import { deleteRow } from '../../../src/sync/backends/jmap/outbox/batch';
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
import { queuePendingMutation } from '../../unit/sync/_pending-mutations';

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

export const FILE_NODE_USING = [
  JMAP_CAPS.CORE,
  JMAP_CAPS.FILENODE,
] as const;

export interface LiveRequestTransport {
  request(using: string[], methodCalls: any[]): Promise<any>;
}

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

/**
 * One JMAP method call under `using`; returns its response object or
 * throws with the server's error tuple.
 */
export async function callMethod(
  transport: LiveRequestTransport,
  using: readonly string[],
  name: string,
  args: Record<string, unknown>,
  callId: string = name,
): Promise<any> {
  const response = await transport.request([...using], [[name, args, callId]]);
  return requireResponseById(response, name, callId);
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

export interface LiveTransportOptions {
  email: string;
  password: string;
  /** Capability whose primary account id is returned; defaults to mail. */
  primaryCapability?: string;
}

/**
 * Authenticated JmapTransport against the local stack. Session endpoints
 * are rewritten to the public origin on every fetch, including forced
 * refreshes.
 */
export async function createLiveTransport({
  email,
  password,
  primaryCapability = JMAP_CAPS.MAIL,
}: LiveTransportOptions) {
  const token = await getAccessToken({ email, password });
  const authHeader = `Bearer ${token}`;
  const publicOrigin = new URL(JMAP_BASE_URL).origin;
  const transport = new JmapTransport({
    sessionUrl: `${JMAP_BASE_URL.replace(/\/$/, '')}/.well-known/jmap`,
    getAuthHeader: async () => authHeader,
  });
  const fetchSession = transport.fetchSession.bind(transport);
  transport.fetchSession = async (options = {}) => rewriteSessionEndpoints(
    await fetchSession(options),
    publicOrigin,
  );
  const session = await transport.fetchSession();
  const accountId = session.primaryAccounts?.[primaryCapability];
  if (typeof accountId !== 'string' || !accountId) {
    throw new Error(
      `JMAP session for ${email} has no primary account for ${primaryCapability}`,
    );
  }
  return {
    accountId,
    publicOrigin,
    session,
    transport,
  };
}

/** Engine + handlers + one primary account row for the contacts account. */
export async function createLiveIntegrationContext() {
  const live = await createLiveTransport({
    email: INTEGRATION_TEST_OIDC_EMAIL,
    password: INTEGRATION_TEST_OIDC_PASSWORD,
    primaryCapability: JMAP_CAPS.CONTACTS,
  });
  const engine = await bootTestEngine();
  const handlers = makeHandlers(engine);
  const account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'Stormbox Integration',
    primaryEmail: INTEGRATION_TEST_OIDC_EMAIL,
    serverOrigin: live.publicOrigin,
    remoteAccountId: live.accountId,
    isPrimary: true,
  })).row;
  return {
    account,
    engine,
    handlers,
    publicOrigin: live.publicOrigin,
    session: live.session,
    transport: live.transport,
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

export interface LiveMutationContext {
  transport: any;
  account: any;
  handlers: Record<string, (params: any) => Promise<any>>;
}

/**
 * What happens to the pending_mutations row once the outbox has run it.
 * `processMutationRow` alone leaves the row 'pending', so a suite that
 * later drains by status would re-run it; drainOutbox itself deletes on
 * success and marks 'conflicted' on failure.
 */
export interface PendingMutationCompletion {
  /** Remove the row after a successful run, as drainOutbox would. */
  deleteOnSuccess: boolean;
  /**
   * Remove the row after a failed run as well. Off by default so the
   * failed row stays inspectable.
   */
  deleteOnFailure?: boolean;
}

/** Run one stored pending_mutations row through the outbox once. */
export async function processPendingMutationRow(
  context: LiveMutationContext,
  row: any,
  { deleteOnSuccess, deleteOnFailure = false }: PendingMutationCompletion,
) {
  const outcome = await processMutationRow({
    transport: context.transport,
    account: context.account,
    handlers: context.handlers,
    row,
  });
  if (outcome.ok ? deleteOnSuccess : deleteOnFailure) {
    await deleteRow(context.handlers, row.id);
  }
  return outcome;
}

export interface ProcessInsertedMutationOptions extends PendingMutationCompletion {
  mutationType: string;
  request: Record<string, unknown>;
  targetMessageId?: number | null;
}

/**
 * Enqueue `request` the way the store does and run it once against the
 * live server. Returns the outbox outcome; the completion policy decides
 * whether the row survives.
 */
export async function processInsertedMutation(
  context: LiveMutationContext,
  {
    mutationType,
    request,
    targetMessageId = null,
    ...completion
  }: ProcessInsertedMutationOptions,
) {
  const row = await queuePendingMutation(context.handlers, {
    accountId: context.account.id,
    mutationType,
    request,
    targetMessageId,
  });
  return processPendingMutationRow(context, row, completion);
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
