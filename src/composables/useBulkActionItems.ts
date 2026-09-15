import { computed } from 'vue';
import type { Component, Ref } from 'vue';
import { Mail, MailOpen, Star, Trash2 } from '@lucide/vue';

import archiveIcon from '../assets/icons/tb-folder-archive.svg?raw';
import junkIcon from '../assets/icons/tb-folder-spam.svg?raw';
import type { FolderRow } from '../types';

export type BulkActionId =
  | 'whitelist'
  | 'archive'
  | 'junk'
  | 'delete'
  | 'cancel-send'
  | 'toggle-star'
  | 'mark-read'
  | 'mark-unread';

export type BulkActionVariant = 'default' | 'danger' | 'star' | 'whitelist';

export interface BulkActionItem {
  id: BulkActionId;
  /** Label in the overflow menu. */
  label: string;
  /** Tooltip of the inline button. */
  title: string;
  ariaLabel: string;
  /** Lucide component, or null when `rawIcon` carries the SVG markup. */
  icon: Component | null;
  rawIcon?: string;
  variant: BulkActionVariant;
  pressed?: boolean;
  disabled?: boolean;
  /** Room the inline button takes, in units of a standard 34px icon button. */
  slots: number;
  /**
   * Order in which the action leaves the header row when there is no
   * room: lower ranks leave first; null never leaves.
   */
  overflowRank: number | null;
  run: () => void;
}

export interface BulkActionHandlers {
  archive: () => void;
  junk: () => void;
  delete: () => void;
  cancelSend: () => void;
  toggleStar: () => void;
  markRead: () => void;
  markUnread: () => void;
  whitelist: () => void;
}

export interface UseBulkActionItemsInput {
  folder: Ref<FolderRow | null | undefined>;
  /** Whether "Not junk" applies (Junk folder of the primary account). */
  canWhitelist: Ref<boolean>;
  whitelisting: Ref<boolean>;
  /** Whether any selected row is starred; picks the star action's verb. */
  anyStarred: Ref<boolean>;
  /** Whether any selected row is a pending scheduled send. */
  anyScheduled: Ref<boolean>;
  handlers: BulkActionHandlers;
}

/**
 * The bulk actions for a checkbox selection, in display order: "Not junk"
 * inside a Junk folder, archive, junk, delete, star, mark read, mark
 * unread. Archive is not offered inside the Archive folder and Junk not
 * inside Junk. While any selected row is a pending scheduled send,
 * archive, junk and star are dropped and the delete slot cancels the
 * selected sends instead (SL-5.6). Star is modal (MK-2.4): it unstars
 * when any selected row is starred, otherwise stars them all.
 */
export function useBulkActionItems(input: UseBulkActionItemsInput) {
  return computed<BulkActionItem[]>(() => {
    const role = input.folder.value?.role;
    const scheduled = input.anyScheduled.value;
    const items: BulkActionItem[] = [];
    if (input.canWhitelist.value) {
      items.push({
        id: 'whitelist',
        label: 'Not junk',
        title: 'Whitelist senders and move to Inbox',
        ariaLabel: 'Not junk — whitelist senders and move the selected messages to Inbox',
        icon: null,
        variant: 'whitelist',
        disabled: input.whitelisting.value,
        slots: 3,
        overflowRank: 5,
        run: input.handlers.whitelist,
      });
    }
    if (!scheduled && role !== 'archive') {
      items.push({
        id: 'archive',
        label: 'Archive',
        title: 'Archive',
        ariaLabel: 'Archive',
        icon: null,
        rawIcon: archiveIcon,
        variant: 'default',
        slots: 1,
        overflowRank: 4,
        run: input.handlers.archive,
      });
    }
    if (!scheduled && role !== 'junk') {
      items.push({
        id: 'junk',
        label: 'Mark as junk',
        title: 'Junk',
        ariaLabel: 'Mark as junk',
        icon: null,
        rawIcon: junkIcon,
        variant: 'default',
        slots: 1,
        overflowRank: 2,
        run: input.handlers.junk,
      });
    }
    if (scheduled) {
      items.push({
        id: 'cancel-send',
        label: 'Cancel send',
        title: 'Cancel send',
        ariaLabel: 'Cancel send — return the selected messages to Drafts',
        icon: Trash2,
        variant: 'danger',
        slots: 1,
        overflowRank: null,
        run: input.handlers.cancelSend,
      });
    } else {
      items.push({
        id: 'delete',
        label: 'Delete',
        title: 'Delete',
        ariaLabel: 'Delete',
        icon: Trash2,
        variant: 'danger',
        slots: 1,
        overflowRank: null,
        run: input.handlers.delete,
      });
    }
    if (!scheduled) {
      const starred = input.anyStarred.value;
      items.push({
        id: 'toggle-star',
        label: starred ? 'Unstar' : 'Star',
        title: starred ? 'Unstar' : 'Star',
        ariaLabel: starred ? 'Unstar' : 'Star',
        icon: Star,
        variant: 'star',
        pressed: starred,
        slots: 1,
        overflowRank: 3,
        run: input.handlers.toggleStar,
      });
    }
    items.push({
      id: 'mark-read',
      label: 'Mark as read',
      title: 'Mark as read',
      ariaLabel: 'Mark as read',
      icon: MailOpen,
      variant: 'default',
      slots: 1,
      overflowRank: 1,
      run: input.handlers.markRead,
    });
    items.push({
      id: 'mark-unread',
      label: 'Mark as unread',
      title: 'Mark as unread',
      ariaLabel: 'Mark as unread',
      icon: Mail,
      variant: 'default',
      slots: 1,
      overflowRank: 0,
      run: input.handlers.markUnread,
    });
    return items;
  });
}

/**
 * Split the actions into the ones that stay in the header row and the
 * ones that move to the overflow menu. `capacity` is the number of
 * standard button slots the row can hold; null means unlimited (width
 * unknown). Actions with a null overflow rank always stay; the rest are
 * kept by descending rank while they fit. Both lists keep display order.
 */
export function splitBulkActions(
  items: readonly BulkActionItem[],
  capacity: number | null,
): { inline: BulkActionItem[]; overflow: BulkActionItem[] } {
  if (capacity == null) return { inline: [...items], overflow: [] };
  const inline = new Set<BulkActionItem>();
  let used = 0;
  for (const item of items) {
    if (item.overflowRank === null) {
      inline.add(item);
      used += item.slots;
    }
  }
  const candidates = items
    .filter((item) => item.overflowRank !== null)
    .sort((a, b) => (b.overflowRank ?? 0) - (a.overflowRank ?? 0));
  for (const item of candidates) {
    if (used + item.slots > capacity) continue;
    inline.add(item);
    used += item.slots;
  }
  return {
    inline: items.filter((item) => inline.has(item)),
    overflow: items.filter((item) => !inline.has(item)),
  };
}
