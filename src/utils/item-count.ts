import { t } from '../i18n/messages';

/** Count labels share semantic ids across list headers, progress, and drag images. */
export function itemCount(kind: string, count: number): string {
  const key: Record<string, string> = {
    contact: 'counts.contacts', contacts: 'counts.contacts',
    message: 'counts.messages', messages: 'counts.messages',
    identity: 'counts.identities', identities: 'counts.identities',
    'trashed contact': 'counts.trashedContacts', 'trashed contacts': 'counts.trashedContacts',
  };
  return t(key[kind] ?? 'counts.items', { count }, count);
}
