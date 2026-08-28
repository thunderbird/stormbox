export const IDENTITY_ERROR = {
  NAME_REQUIRED: 'identityNameRequired',
  INVALID_NAME: 'identityInvalidName',
  INVALID_EMAIL: 'identityInvalidEmail',
  ADDRESS_NOT_ALLOWED: 'identityAddressNotAllowed',
  NOT_FOUND: 'identityNotFound',
  NOT_CONNECTED: 'identityNotConnected',
  PERMISSION_DENIED: 'identityPermissionDenied',
  CACHE_RECONCILIATION_FAILED: 'identityCacheReconciliationFailed',
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
  [IDENTITY_ERROR.ADDRESS_NOT_ALLOWED]:
    'You can’t send from this email address. Add it to your account before creating an identity.',
  [IDENTITY_ERROR.NOT_FOUND]:
    'This identity no longer exists. Refresh the list and try again.',
  [IDENTITY_ERROR.NOT_CONNECTED]: 'Not connected.',
  [IDENTITY_ERROR.PERMISSION_DENIED]:
    'You don’t have permission to manage identities for this account.',
  [IDENTITY_ERROR.CACHE_RECONCILIATION_FAILED]:
    'The identity changed on the server, but the local list could not be refreshed. Please try again.',
  [IDENTITY_ERROR.SERVER_UNAVAILABLE]:
    'The identity service is temporarily unavailable. Please try again.',
  [IDENTITY_ERROR.UNKNOWN]:
    'The identity change could not be completed. Please try again.',
};
