import {
  ADDRESSBOOK_ERROR,
} from '../constants/addressbook-errors';

export const TRUSTED_SENDERS_BOOK_NAME = 'Trusted senders';

export type AddressBookDeleteDisabledReason =
  | typeof ADDRESSBOOK_ERROR.LAST_ADDRESSBOOK
  | typeof ADDRESSBOOK_ERROR.PERMISSION_DENIED
  | typeof ADDRESSBOOK_ERROR.PROTECTED;

interface AddressBookPolicyEntry {
  name?: unknown;
  is_deleted?: number | null;
  may_delete?: number | null;
  myRights?: {
    mayDelete?: boolean;
  } | null;
}

export function isTrustedSendersBook(book: AddressBookPolicyEntry): boolean {
  return typeof book.name === 'string'
    && book.name.trim().toLocaleLowerCase()
      === TRUSTED_SENDERS_BOOK_NAME.toLocaleLowerCase();
}

function isActiveAddressBook(book: AddressBookPolicyEntry): boolean {
  return book.is_deleted !== 1;
}

function mayDeleteAddressBook(book: AddressBookPolicyEntry): boolean {
  if ('may_delete' in book) return book.may_delete === 1;
  if ('myRights' in book) return book.myRights?.mayDelete === true;
  return true;
}

export function addressBookDeleteDisabledReason(
  book: AddressBookPolicyEntry,
  addressbooks: readonly AddressBookPolicyEntry[],
): AddressBookDeleteDisabledReason | null {
  if (isTrustedSendersBook(book)) return ADDRESSBOOK_ERROR.PROTECTED;
  const regularBooks = addressbooks.filter((candidate) =>
    isActiveAddressBook(candidate) && !isTrustedSendersBook(candidate));
  if (regularBooks.length <= 1) return ADDRESSBOOK_ERROR.LAST_ADDRESSBOOK;
  if (!mayDeleteAddressBook(book)) return ADDRESSBOOK_ERROR.PERMISSION_DENIED;
  return null;
}
