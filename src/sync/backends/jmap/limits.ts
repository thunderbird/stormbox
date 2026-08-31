import { JMAP_CAPS } from './transport';

type JmapCoreLimit =
  | 'maxObjectsInGet'
  | 'maxObjectsInSet'
  | 'maxSizeUpload'
  | 'maxConcurrentUpload';

function coreLimit(transport: any, property: JmapCoreLimit): number {
  const raw = Number(
    transport?.session?.capabilities?.[JMAP_CAPS.CORE]?.[property],
  );
  if (!Number.isSafeInteger(raw) || raw <= 0) {
    throw capabilityLimitError(`JMAP Session missing valid ${property}`, property);
  }
  return Math.max(1, Math.floor(raw));
}

function capabilityLimitError(message: string, capability: string) {
  const error: any = new Error(message);
  error.type = 'capabilityUnavailable';
  error.capability = capability;
  return error;
}

export function maxObjectsInGet(transport: any): number {
  return coreLimit(transport, 'maxObjectsInGet');
}

export function maxObjectsInSet(transport: any): number {
  return coreLimit(transport, 'maxObjectsInSet');
}

export function maxSizeUpload(transport: any): number {
  return coreLimit(transport, 'maxSizeUpload');
}

export function maxConcurrentUpload(transport: any): number {
  return coreLimit(transport, 'maxConcurrentUpload');
}

export function maxSizeAttachmentsPerEmail(transport: any, account: any): number {
  const remoteAccountId = account?.remote_account_id;
  const raw = Number(
    transport?.session?.accounts?.[remoteAccountId]
      ?.accountCapabilities?.[JMAP_CAPS.MAIL]
      ?.maxSizeAttachmentsPerEmail,
  );
  if (!Number.isSafeInteger(raw) || raw <= 0) {
    throw capabilityLimitError(
      `JMAP account ${remoteAccountId ?? '(unknown)'} missing valid maxSizeAttachmentsPerEmail`,
      'maxSizeAttachmentsPerEmail',
    );
  }
  return Math.floor(raw);
}

export function attachmentTransferLimits(transport: any, account: any) {
  return {
    maxSizeUpload: maxSizeUpload(transport),
    maxSizeAttachmentsPerEmail: maxSizeAttachmentsPerEmail(transport, account),
    maxConcurrentUpload: maxConcurrentUpload(transport),
  };
}
