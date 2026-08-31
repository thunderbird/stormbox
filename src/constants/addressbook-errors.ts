export const ADDRESSBOOK_ERROR = {
  INVALID_NAME: 'addressBookInvalidName',
  PERMISSION_DENIED: 'addressBookPermissionDenied',
  UNSUPPORTED_SUBSCRIPTION: 'addressBookSubscriptionUnsupported',
  STATE_MISMATCH: 'addressBookStateMismatch',
  MISSING: 'addressBookMissing',
  SERVER_UNAVAILABLE: 'addressBookServerUnavailable',
  CACHE_REPAIR_FAILED: 'addressBookCacheRepairFailed',
  AMBIGUOUS_CREATE: 'addressBookCreateAmbiguous',
  CONFIRMATION_REQUIRED: 'addressBookConfirmationRequired',
  CONFIRMATION_STALE: 'addressBookConfirmationStale',
  PROTECTED: 'addressBookProtected',
  LAST_ADDRESSBOOK: 'addressBookLastAddressBook',
  INVALID_ARGUMENTS: 'addressBookInvalidArguments',
} as const;

export type AddressBookError =
  (typeof ADDRESSBOOK_ERROR)[keyof typeof ADDRESSBOOK_ERROR];
