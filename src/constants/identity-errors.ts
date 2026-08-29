export const IDENTITY_ERROR = {
  NAME_REQUIRED: 'identityNameRequired',
  INVALID_NAME: 'identityInvalidName',
  INVALID_EMAIL: 'identityInvalidEmail',
  INVALID_REPLY_TO: 'identityInvalidReplyTo',
  INVALID_BCC: 'identityInvalidBcc',
  SIGNATURE_TOO_LARGE: 'identitySignatureTooLarge',
  INVALID_SIGNATURE: 'identityInvalidSignature',
  IMMUTABLE_FIELD: 'identityImmutableField',
  ADDRESS_NOT_CONFIGURED: 'identityAddressNotConfigured',
  ADDRESS_NOT_ALLOWED: 'identityAddressNotConfigured',
  OVER_QUOTA: 'identityOverQuota',
  OBJECT_TOO_LARGE: 'identityObjectTooLarge',
  INVALID_PATCH: 'identityInvalidPatch',
  WILL_DESTROY: 'identityWillDestroy',
  SINGLETON: 'identitySingleton',
  INVALID_ARGUMENTS: 'identityInvalidArguments',
  AMBIGUOUS_CREATE: 'identityCreateAmbiguous',
  MISSING: 'identityMissing',
  NOT_FOUND: 'identityMissing',
  NOT_CONNECTED: 'identityNotConnected',
  PERMISSION_DENIED: 'identityPermissionDenied',
  CACHE_REPAIR_FAILED: 'identityCacheRepairFailed',
  CACHE_RECONCILIATION_FAILED: 'identityCacheRepairFailed',
  SERVER_UNAVAILABLE: 'identityServerUnavailable',
  UNKNOWN: 'identityUnknown',
} as const;

export type IdentityError = (typeof IDENTITY_ERROR)[keyof typeof IDENTITY_ERROR];

export type IdentityActionResult =
  | { ok: true }
  | { ok: false; error: IdentityError };

export const IDENTITY_ERROR_MESSAGE: Record<IdentityError, string> = {
  [IDENTITY_ERROR.NAME_REQUIRED]: 'Enter a name for the identity.',
  [IDENTITY_ERROR.INVALID_NAME]: 'Enter a valid identity name.',
  [IDENTITY_ERROR.INVALID_EMAIL]: 'Enter a valid email address.',
  [IDENTITY_ERROR.INVALID_REPLY_TO]: 'Enter a valid mailbox in each Reply-To row.',
  [IDENTITY_ERROR.INVALID_BCC]: 'Enter a valid mailbox in each automatic Bcc row.',
  [IDENTITY_ERROR.SIGNATURE_TOO_LARGE]:
    'Shorten the signature so both its HTML and plain text are under 2,048 bytes.',
  [IDENTITY_ERROR.INVALID_SIGNATURE]:
    'The signature is invalid. Use text, formatting, links, or a small raster image.',
  [IDENTITY_ERROR.IMMUTABLE_FIELD]:
    'The server does not allow that identity field to be changed.',
  [IDENTITY_ERROR.ADDRESS_NOT_CONFIGURED]:
    'You can’t send from this email address. Add it to your account before creating an identity.',
  [IDENTITY_ERROR.OVER_QUOTA]:
    'This account has reached its identity limit. Remove another identity or contact the administrator.',
  [IDENTITY_ERROR.OBJECT_TOO_LARGE]:
    'The identity is too large for the server. Shorten its fields or signature.',
  [IDENTITY_ERROR.INVALID_PATCH]:
    'The server rejected this identity update. Refresh it and try the change again.',
  [IDENTITY_ERROR.WILL_DESTROY]:
    'This change depends on another identity being removed and was not applied.',
  [IDENTITY_ERROR.SINGLETON]:
    'The server requires this identity to remain the only identity of its kind.',
  [IDENTITY_ERROR.INVALID_ARGUMENTS]:
    'The server rejected the identity request as invalid.',
  [IDENTITY_ERROR.AMBIGUOUS_CREATE]:
    'The server may have created this identity, but the result could not be identified safely. Refresh and retry recovery without creating another copy.',
  [IDENTITY_ERROR.MISSING]:
    'This identity no longer exists. Refresh the list and try again.',
  [IDENTITY_ERROR.NOT_CONNECTED]: 'Not connected.',
  [IDENTITY_ERROR.PERMISSION_DENIED]:
    'You don’t have permission to manage identities for this account.',
  [IDENTITY_ERROR.CACHE_REPAIR_FAILED]:
    'The identity changed on the server, but the local list could not be refreshed. Please try again.',
  [IDENTITY_ERROR.SERVER_UNAVAILABLE]:
    'The identity service is temporarily unavailable. Please try again.',
  [IDENTITY_ERROR.UNKNOWN]:
    'The identity change could not be completed. Please try again.',
};
