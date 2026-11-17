import { t } from '../i18n/messages';
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
  get [IDENTITY_ERROR.NAME_REQUIRED]() { return t('identityErrors.enterANameForTheIdentity'); },
  get [IDENTITY_ERROR.INVALID_NAME]() { return t('identityErrors.enterAValidIdentityName'); },
  get [IDENTITY_ERROR.INVALID_EMAIL]() { return t('identityErrors.enterAValidEmailAddress'); },
  get [IDENTITY_ERROR.INVALID_REPLY_TO]() { return t('identityErrors.enterAValidMailboxInEachReplyToRow'); },
  get [IDENTITY_ERROR.INVALID_BCC]() { return t('identityErrors.enterAValidMailboxInEachAutomaticBccRow'); },
  get [IDENTITY_ERROR.SIGNATURE_TOO_LARGE]() { return t('identityErrors.shortenTheSignatureSoBothItsHTMLAndPlain'); },
  get [IDENTITY_ERROR.INVALID_SIGNATURE]() { return t('identityErrors.theSignatureIsInvalidUseTextFormattingLinksOr'); },
  get [IDENTITY_ERROR.IMMUTABLE_FIELD]() { return t('identityErrors.theServerDoesNotAllowThatIdentityFieldTo'); },
  get [IDENTITY_ERROR.ADDRESS_NOT_CONFIGURED]() { return t('identityErrors.youCanTSendFromThisEmailAddressAdd'); },
  get [IDENTITY_ERROR.OVER_QUOTA]() { return t('identityErrors.thisAccountHasReachedItsIdentityLimitRemoveAnother'); },
  get [IDENTITY_ERROR.OBJECT_TOO_LARGE]() { return t('identityErrors.theIdentityIsTooLargeForTheServerShorten'); },
  get [IDENTITY_ERROR.INVALID_PATCH]() { return t('identityErrors.theServerRejectedThisIdentityUpdateRefreshItAnd'); },
  get [IDENTITY_ERROR.WILL_DESTROY]() { return t('identityErrors.thisChangeDependsOnAnotherIdentityBeingRemovedAnd'); },
  get [IDENTITY_ERROR.SINGLETON]() { return t('identityErrors.theServerRequiresThisIdentityToRemainTheOnly'); },
  get [IDENTITY_ERROR.INVALID_ARGUMENTS]() { return t('identityErrors.theServerRejectedTheIdentityRequestAsInvalid'); },
  get [IDENTITY_ERROR.AMBIGUOUS_CREATE]() { return t('identityErrors.theServerMayHaveCreatedThisIdentityButThe'); },
  get [IDENTITY_ERROR.MISSING]() { return t('identityErrors.thisIdentityNoLongerExistsRefreshTheListAnd'); },
  get [IDENTITY_ERROR.NOT_CONNECTED]() { return t('identityErrors.notConnected'); },
  get [IDENTITY_ERROR.PERMISSION_DENIED]() { return t('identityErrors.youDonTHavePermissionToManageIdentitiesFor'); },
  get [IDENTITY_ERROR.CACHE_REPAIR_FAILED]() { return t('identityErrors.theIdentityChangedOnTheServerButTheLocal'); },
  get [IDENTITY_ERROR.SERVER_UNAVAILABLE]() { return t('identityErrors.theIdentityServiceIsTemporarilyUnavailablePleaseTryAgain'); },
  get [IDENTITY_ERROR.UNKNOWN]() { return t('identityErrors.theIdentityChangeCouldNotBeCompletedPleaseTry'); },
};
