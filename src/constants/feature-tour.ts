import { t } from '../i18n/messages';
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
    get title() { return t('featureTour.composeWithConfidence'); },
    get description() { return t('featureTour.workOnSeveralDraftsAtOnceMinimizeAndRestore'); },
    spotlight: 'composeDrafts',
  },
  {
    icon: CalendarClock,
    get title() { return t('featureTour.sendOnYourSchedule'); },
    get description() { return t('featureTour.pickADeliveryTimeForAMessageAndCancel'); },
    spotlight: 'sendLater',
  },
  {
    icon: Paperclip,
    get title() { return t('featureTour.attachmentsAndClipboard'); },
    get description() { return t('featureTour.attachFilesPasteImagesAndPasteLinksOverSelected'); },
    spotlight: 'attachments',
  },
  {
    icon: FolderTree,
    get title() { return t('featureTour.organizeYourMail'); },
    get description() { return t('featureTour.createFavoriteAndSubscribeToFoldersAndActOn'); },
    spotlight: 'folders',
  },
  {
    icon: BookUser,
    get title() { return t('featureTour.contactsAndIdentities'); },
    get description() { return t('featureTour.manageAddressBooksAndSendingIdentitiesIncludingSignatures'); },
    spotlight: 'contacts',
  },
  {
    icon: UsersRound,
    get title() { return t('featureTour.smarterRecipients'); },
    get description() { return t('featureTour.autocompleteFromYourContactsAndAddCCAndBCC'); },
    spotlight: 'recipients',
  },
];

export const SPOTLIGHT_IDS: readonly SpotlightId[] = FEATURE_CARDS.map((card) => card.spotlight);
