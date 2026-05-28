/**
 * Session ingestion. Takes a JMAP session document (RFC 8620 §2) plus the
 * server's hostname-derived origin, and upserts the corresponding rows in
 * accounts, account_services, and account_capabilities.
 *
 * One JMAP session can advertise multiple data services (mail, contacts,
 * calendars). We create one account_services row per (mail | contacts |
 * calendars) capability the server advertises and the user's primary
 * account supports. The websocket URL is replicated onto each service so
 * the sync engine can find it without re-walking the session document.
 */

import { DB_RPC } from '../../../db/protocol';
import { SERVICE_KIND } from '../../../constants/states';
import { JMAP_CAPS } from './transport';

/**
 * Map a JMAP capability URI to the service_kind we store in
 * account_services.service_kind. Capabilities that do not correspond to
 * a service kind (urn:ietf:params:jmap:core etc.) return null.
 */
function serviceKindFor(capability) {
  if (capability === JMAP_CAPS.MAIL) return SERVICE_KIND.JMAP_MAIL;
  if (capability === JMAP_CAPS.CONTACTS) return SERVICE_KIND.JMAP_CONTACTS;
  if (capability === 'urn:ietf:params:jmap:calendars') return SERVICE_KIND.JMAP_CALENDARS;
  return null;
}

/**
 * Ingest a JMAP session into the local store. Returns the local account
 * row (post-upsert). serverOrigin must be the server's https origin
 * (e.g. https://mail.example.com).
 *
 * @param {object} args
 * @param {object} args.session  the parsed JMAP session document
 * @param {string} args.serverOrigin
 * @param {Record<string, (params: any) => Promise<any>>} args.handlers  RPC handler map
 * @returns {Promise<{account: any, services: Array<{serviceKind: string, remoteAccountId: string}>}>}
 */
export async function ingestSession({ session, serverOrigin, handlers }) {
  if (!session) {
    throw new Error('ingestSession requires a session document');
  }
  const primaryAccounts = session.primaryAccounts ?? {};
  const remoteAccountId = primaryAccounts[JMAP_CAPS.MAIL]
    ?? Object.keys(session.accounts ?? {})[0];
  if (!remoteAccountId) {
    throw new Error('JMAP session has no primary mail account');
  }
  const accountInfo = session.accounts?.[remoteAccountId] ?? {};

  const upserted = await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: accountInfo.name ?? session.username ?? null,
    primaryEmail: session.username ?? accountInfo.name ?? null,
    serverOrigin,
    remoteAccountId,
    isPrimary: true,
  });
  const account = upserted.row;

  const wsCap = session.capabilities?.[JMAP_CAPS.WEBSOCKET];
  const websocketUrl = wsCap?.url ?? null;
  const supportsWebsocketPush = wsCap?.supportsPush ? 1 : 0;

  // Walk the account's accountCapabilities and create one
  // account_services row for each data service we recognise.
  const services = [];
  const accountCaps = accountInfo.accountCapabilities ?? {};
  for (const capability of Object.keys(accountCaps)) {
    const serviceKind = serviceKindFor(capability);
    if (!serviceKind) {
      continue;
    }
    await handlers[DB_RPC.ACCOUNT_SERVICE_UPSERT]({
      accountId: account.id,
      serviceKind,
      baseUrl: serverOrigin,
      apiUrl: session.apiUrl ?? null,
      downloadUrlTemplate: session.downloadUrl ?? null,
      uploadUrlTemplate: session.uploadUrl ?? null,
      websocketUrl,
      supportsWebsocketPush,
      sessionState: session.state ?? null,
    });
    services.push({ serviceKind, remoteAccountId });
  }

  // Top-level session capabilities apply to every service (jmap-core,
  // urn:ietf:params:jmap:websocket, etc.). Replicate them onto each
  // service we just created.
  for (const { serviceKind } of services) {
    const merged = {};
    for (const [cap, payload] of Object.entries(session.capabilities ?? {})) {
      merged[cap] = payload;
    }
    for (const [cap, payload] of Object.entries(accountCaps)) {
      merged[cap] = payload;
    }
    await handlers[DB_RPC.ACCOUNT_CAPABILITIES_REPLACE]({
      accountId: account.id,
      serviceKind,
      capabilities: merged,
    });
  }

  return { account, services };
}
