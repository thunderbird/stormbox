import type { Component } from 'vue';
import {
  BookUser,
  CalendarClock,
  FolderTree,
  Keyboard,
  Minus,
  PenLine,
  Star,
  UsersRound,
} from '@lucide/vue';

import { SPOTLIGHT_TARGETS } from '../composables/featureSpotlightScripts';

/**
 * Beacons announce this round's features to users who dismissed Welcome
 * before it shipped: a pulsing dot on each new control that opens a short
 * card. Staged beacons wait for their host (composer, Contacts space) to
 * mount; the header pill counts every unseen beacon, staged included.
 */
export type BeaconId =
  | 'newMessage'
  | 'composeMinimize'
  | 'composeSchedule'
  | 'contacts'
  | 'manageIdentities'
  | 'manageFolders'
  | 'starMessages'
  | 'keyboardShortcuts';

export type BeaconStage = 'composer' | 'contacts';

export interface FeatureBeacon {
  id: BeaconId;
  /** CSS selector of the control the dot sits on. */
  anchor: string;
  title: string;
  body: string;
  icon: Component;
  /** Host that must be on screen before the dot can show. */
  stage?: BeaconStage;
  /**
   * Where the dot sits on the anchor: its top-right corner (default), or
   * on its left edge at mid-height, in line with a row's label.
   */
  dot?: 'corner' | 'inline-start';
}

export const BEACON_SESSION_LIMIT = 5;

export const BEACON_TIMING = {
  /** Hover or focus on a dot or its control before the card previews. */
  previewOpenMs: 150,
  /** Grace after the pointer leaves so it can cross onto the card. */
  previewCloseMs: 250,
  /** How long a card shown by clicking the control itself stays up. */
  alongsideMs: 6000,
  /** Reading a card this long marks its beacon seen. */
  seenDwellMs: 1500,
  /** How long a pinned card waits for a staged anchor before giving up. */
  anchorGraceMs: 2000,
} as const;

// Dated with the What's New round it announces.
export const FEATURE_BEACONS_STORAGE_KEY = 'stormbox.featureBeacons.2026-09-compose';

export const FEATURE_BEACONS: readonly FeatureBeacon[] = [
  {
    id: 'newMessage',
    anchor: '.sidebar__compose',
    title: 'A new composer',
    body: 'Work on several drafts at once, autocomplete recipients as pills, paste images and links, attach files, and schedule a send. Open a message to see the new controls.',
    icon: PenLine,
  },
  {
    id: 'composeMinimize',
    anchor: SPOTLIGHT_TARGETS.composeMinimize,
    title: 'Minimize a draft',
    body: 'A minimized draft waits in the dock, named by its subject, while you read or reply to other mail.',
    icon: Minus,
    stage: 'composer',
  },
  {
    id: 'composeSchedule',
    anchor: SPOTLIGHT_TARGETS.scheduleTrigger,
    title: 'Send on your schedule',
    body: 'Pick a delivery time next to Send. The message waits in Scheduled, where you can still cancel it.',
    icon: CalendarClock,
    stage: 'composer',
  },
  {
    id: 'contacts',
    anchor: SPOTLIGHT_TARGETS.contactsSpace,
    title: 'Contacts have their own space',
    body: 'Manage address books and drag contacts between them from the toolbar on the left.',
    icon: UsersRound,
  },
  {
    id: 'manageIdentities',
    anchor: SPOTLIGHT_TARGETS.contactsIdentitiesButton,
    title: 'Manage identities',
    body: 'Set up each address you send from: display name, signature, Reply-To, and automatic Bcc.',
    icon: BookUser,
    stage: 'contacts',
    dot: 'inline-start',
  },
  {
    id: 'manageFolders',
    anchor: SPOTLIGHT_TARGETS.manageFolders,
    title: 'Manage Folders',
    body: 'Create folders, choose which ones to show, and star favorites so they float to the top of the list.',
    icon: FolderTree,
  },
  {
    // The row's own star is hidden until hover, so the dot sits on the
    // always-visible Starred filter instead.
    id: 'starMessages',
    anchor: SPOTLIGHT_TARGETS.starredFilter,
    title: 'Star a message',
    body: 'Hover a message and click the star, or press S to star a message, and then use the Starred filter to view them.',
    icon: Star,
  },
  {
    // Shortcuts have no control of their own; the gear leads to the scheme
    // picker and, through Show welcome, the full list (OB-4.12).
    id: 'keyboardShortcuts',
    anchor: SPOTLIGHT_TARGETS.settingsGear,
    title: 'Keyboard shortcuts',
    body: 'Move through mail, archive, star, and reply without leaving the keyboard. Choose Web or Thunderbird-style keys in Settings, and see the full list under Show welcome.',
    icon: Keyboard,
  },
];

export const BEACON_IDS: readonly BeaconId[] = FEATURE_BEACONS.map((beacon) => beacon.id);

export function beaconById(id: BeaconId): FeatureBeacon {
  const beacon = FEATURE_BEACONS.find((entry) => entry.id === id);
  if (!beacon) throw new Error(`Unknown beacon ${id}`);
  return beacon;
}

export function isBeaconId(value: unknown): value is BeaconId {
  return typeof value === 'string' && (BEACON_IDS as readonly string[]).includes(value);
}
