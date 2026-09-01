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

const ADDRESSBOOK_ERROR_MESSAGES: Record<AddressBookError, string> = {
  [ADDRESSBOOK_ERROR.INVALID_NAME]:
    'Enter an address book name without a line break.',
  [ADDRESSBOOK_ERROR.PERMISSION_DENIED]:
    'You don’t have permission to manage this address book.',
  [ADDRESSBOOK_ERROR.UNSUPPORTED_SUBSCRIPTION]:
    'The server does not allow this subscription change.',
  [ADDRESSBOOK_ERROR.STATE_MISMATCH]:
    'The address book changed on the server. Refresh and try again.',
  [ADDRESSBOOK_ERROR.MISSING]:
    'This address book no longer exists.',
  [ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE]:
    'The address book service is temporarily unavailable.',
  [ADDRESSBOOK_ERROR.CACHE_REPAIR_FAILED]:
    'The address book changed on the server, but the local list could not be refreshed.',
  [ADDRESSBOOK_ERROR.AMBIGUOUS_CREATE]:
    'The server may have created this address book, but it could not be identified safely.',
  [ADDRESSBOOK_ERROR.CONFIRMATION_REQUIRED]:
    'Review the address book contents before deleting it.',
  [ADDRESSBOOK_ERROR.CONFIRMATION_STALE]:
    'The address book contents changed. Review them again before deleting.',
  [ADDRESSBOOK_ERROR.PROTECTED]:
    'Trusted Senders cannot be deleted.',
  [ADDRESSBOOK_ERROR.LAST_ADDRESSBOOK]:
    'The last address book cannot be deleted.',
  [ADDRESSBOOK_ERROR.INVALID_ARGUMENTS]:
    'Enter valid address book details.',
};

export function addressBookErrorMessage(error: AddressBookError): string {
  return ADDRESSBOOK_ERROR_MESSAGES[error];
}
