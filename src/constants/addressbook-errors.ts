import { t } from '../i18n/messages';
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
  get [ADDRESSBOOK_ERROR.INVALID_NAME]() { return t('addressbookErrors.enterAnAddressBookNameWithoutALineBreak'); },
  get [ADDRESSBOOK_ERROR.PERMISSION_DENIED]() { return t('addressbookErrors.youDonTHavePermissionToManageThisAddress'); },
  get [ADDRESSBOOK_ERROR.UNSUPPORTED_SUBSCRIPTION]() { return t('addressbookErrors.theServerDoesNotAllowThisSubscriptionChange'); },
  get [ADDRESSBOOK_ERROR.STATE_MISMATCH]() { return t('addressbookErrors.theAddressBookChangedOnTheServerRefreshAnd'); },
  get [ADDRESSBOOK_ERROR.MISSING]() { return t('addressbookErrors.thisAddressBookNoLongerExists'); },
  get [ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE]() { return t('addressbookErrors.theAddressBookServiceIsTemporarilyUnavailable'); },
  get [ADDRESSBOOK_ERROR.CACHE_REPAIR_FAILED]() { return t('addressbookErrors.theAddressBookChangedOnTheServerButThe'); },
  get [ADDRESSBOOK_ERROR.AMBIGUOUS_CREATE]() { return t('addressbookErrors.theServerMayHaveCreatedThisAddressBookBut'); },
  get [ADDRESSBOOK_ERROR.CONFIRMATION_REQUIRED]() { return t('addressbookErrors.reviewTheAddressBookContentsBeforeDeletingIt'); },
  get [ADDRESSBOOK_ERROR.CONFIRMATION_STALE]() { return t('addressbookErrors.theAddressBookContentsChangedReviewThemAgainBefore'); },
  get [ADDRESSBOOK_ERROR.PROTECTED]() { return t('addressbookErrors.trustedSendersCannotBeDeleted'); },
  get [ADDRESSBOOK_ERROR.LAST_ADDRESSBOOK]() { return t('addressbookErrors.theLastAddressBookCannotBeDeleted'); },
  get [ADDRESSBOOK_ERROR.INVALID_ARGUMENTS]() { return t('addressbookErrors.enterValidAddressBookDetails'); },
};

export function addressBookErrorMessage(error: AddressBookError): string {
  return ADDRESSBOOK_ERROR_MESSAGES[error];
}
