import type {
  AddressbookRow,
  ContactListRow,
  ContactTrashListRow,
  IdentityRow,
} from '../../types';

export type DirectoryKind = 'contacts' | 'identities' | 'trash';
export type DirectoryLayout = 'desktop' | 'phone' | 'tablet';
export type DirectoryMobilePane = 'detail' | 'list';
export type ContactsConfirmationKind =
  | 'delete-contacts-scoped'
  | 'delete-contact-trash'
  | 'delete-identity'
  | 'external-addressbook-change'
  | 'external-change'
  | 'unsaved';
export type ContactsConfirmationChoice =
  | 'cancel'
  | 'delete'
  | 'discard'
  | 'save';

export type DirectoryEntry =
  | {
      key: string;
      kind: 'contact';
      id: number;
      name: string;
      email: string;
      contact: ContactListRow;
    }
  | {
      key: string;
      kind: 'trash';
      id: number;
      name: string;
      email: string;
      trash: ContactTrashListRow;
    }
  | {
      key: string;
      kind: 'identity';
      id: number;
      name: string;
      email: string;
      identity: IdentityRow;
    };

export function contactEntry(contact: ContactListRow): DirectoryEntry {
  return {
    key: `contact:${contact.id}`,
    kind: 'contact',
    id: contact.id,
    name: contact.display_name?.trim() || '(no name)',
    email: contact.email?.trim() || 'No email address',
    contact,
  };
}

export function identityEntry(identity: IdentityRow): DirectoryEntry {
  return {
    key: `identity:${identity.id}`,
    kind: 'identity',
    id: identity.id,
    name: identity.name?.trim() || '(no name)',
    email: identity.email,
    identity,
  };
}

export function trashEntry(trash: ContactTrashListRow): DirectoryEntry {
  return {
    key: `trash:${trash.id}`,
    kind: 'trash',
    id: trash.id,
    name: trash.display_name?.trim() || '(no name)',
    email: trash.primary_email?.trim() || 'No email address',
    trash,
  };
}

export function identityMayDelete(identity: IdentityRow): boolean {
  return identity.may_delete === 1;
}

export function addressBookDisplayName(book: AddressbookRow): string {
  return book.name?.trim() || 'Address book';
}

export function isTrustedSendersAddressBook(book: AddressbookRow): boolean {
  return addressBookDisplayName(book).toLocaleLowerCase() === 'trusted senders';
}

export function addressBookDeleteDisabledReason(
  book: AddressbookRow,
  addressbooks: readonly AddressbookRow[],
): string | null {
  if (isTrustedSendersAddressBook(book)) {
    return 'Trusted Senders cannot be deleted.';
  }
  const regularBooks = addressbooks.filter((candidate) =>
    candidate.is_deleted === 0 && !isTrustedSendersAddressBook(candidate));
  if (regularBooks.length <= 1) {
    return 'The final non-Trusted-Senders address book cannot be deleted.';
  }
  if (book.may_delete !== 1) {
    return 'You don’t have permission to delete this address book.';
  }
  return null;
}

export function addressBookMayDelete(
  book: AddressbookRow,
  addressbooks: readonly AddressbookRow[],
): boolean {
  return addressBookDeleteDisabledReason(book, addressbooks) === null;
}

export function directoryOptionId(key: string): string {
  return `directory-option-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}
