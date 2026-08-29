import type {
  ContactListRow,
  IdentityRow,
} from '../../types';

export type DirectoryKind = 'contacts' | 'identities';
export type DirectoryLayout = 'desktop' | 'phone' | 'tablet';
export type DirectoryMobilePane = 'detail' | 'list';
export type ContactsConfirmationKind =
  | 'delete-contact'
  | 'delete-contacts-global'
  | 'delete-contacts-scoped'
  | 'delete-identity'
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

export function identityMayDelete(identity: IdentityRow): boolean {
  return identity.may_delete === 1;
}

export function directoryOptionId(key: string): string {
  return `directory-option-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}
