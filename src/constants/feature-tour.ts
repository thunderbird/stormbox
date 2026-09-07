import type { Component } from 'vue';
import {
  BookUser,
  CalendarClock,
  FolderTree,
  Paperclip,
  PenLine,
  UsersRound,
} from '@lucide/vue';

/**
 * Feature cards shown in the Welcome modal. Each card names the spotlight
 * script that demonstrates it in the live UI.
 */
export type SpotlightId =
  | 'composeDrafts'
  | 'recipients'
  | 'attachments'
  | 'sendLater'
  | 'contacts'
  | 'folders';

export interface FeatureCard {
  icon: Component;
  title: string;
  description: string;
  spotlight: SpotlightId;
}

// Send Later is always listed; the composer shows the control disabled when
// the server lacks the capability.
export const FEATURE_CARDS: readonly FeatureCard[] = [
  {
    icon: PenLine,
    title: 'Compose with confidence',
    description: 'Work on several drafts at once, minimize and restore them.',
    spotlight: 'composeDrafts',
  },
  {
    icon: CalendarClock,
    title: 'Send on your schedule',
    description: 'Pick a delivery time for a message and cancel it from the Scheduled folder while it waits.',
    spotlight: 'sendLater',
  },
  {
    icon: Paperclip,
    title: 'Attachments and Clipboard',
    description: 'Attach files, paste images, and paste links over selected text in a message.',
    spotlight: 'attachments',
  },
  {
    icon: FolderTree,
    title: 'Organize your mail',
    description: 'Create, favorite, and subscribe to folders and act on many messages at once.',
    spotlight: 'folders',
  },
  {
    icon: BookUser,
    title: 'Contacts and identities',
    description: 'Manage address books and sending identities, including signatures.',
    spotlight: 'contacts',
  },
  {
    icon: UsersRound,
    title: 'Smarter recipients',
    description: 'Autocomplete from your contacts and add CC and BCC automatically via identities.',
    spotlight: 'recipients',
  },
];

export const SPOTLIGHT_IDS: readonly SpotlightId[] = FEATURE_CARDS.map((card) => card.spotlight);
