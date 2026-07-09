/**
 * Thunderbird-standard keyboard shortcuts for the mail UI.
 *
 * Bound at the App shell so shortcuts work regardless of which pane
 * has focus. Compose editor formatting keys are handled by Squire.
 *
 * Reference: https://support.mozilla.org/kb/keyboard-shortcuts-thunderbird
 */

import {
  onMounted,
  onUnmounted,
  type Ref,
} from 'vue';

import { useMailStore } from '../stores/mail-store';
import { useComposeStore } from '../stores/compose-store';
import {
  isDeleteKey,
  isEditableTarget,
  isModKey,
  matchesShortcut,
} from '../utils/keyboard';

export interface UseThunderbirdShortcutsOptions {
  /** Current app space ('mail' | 'contacts'). Shortcuts only run in mail. */
  space: Ref<string>;
  /** When false, no shortcuts are handled (e.g. login gate). */
  enabled: Ref<boolean>;
  /** Focuses the app-level Quick Filter field. */
  focusQuickFilter?: () => void;
}

function getTargetIds(mailStore: ReturnType<typeof useMailStore>): number[] {
  if (mailStore.selectedIds.size > 0) {
    return [...mailStore.selectedIds];
  }
  if (mailStore.selectedMessageId != null) {
    return [mailStore.selectedMessageId];
  }
  return [];
}

function getSingleMessage(mailStore: ReturnType<typeof useMailStore>) {
  const ids = getTargetIds(mailStore);
  if (ids.length !== 1) return null;
  return mailStore.messages.find((m) => m?.id === ids[0]) ?? null;
}

function findMessageIndex(mailStore: ReturnType<typeof useMailStore>, messageId: number | null) {
  if (messageId == null) return -1;
  return mailStore.messages.findIndex((m) => m?.id === messageId);
}

function firstLoadedIndex(mailStore: ReturnType<typeof useMailStore>) {
  return mailStore.messages.findIndex((m) => m?.id != null);
}

function lastLoadedIndex(mailStore: ReturnType<typeof useMailStore>) {
  for (let i = mailStore.messages.length - 1; i >= 0; i -= 1) {
    if (mailStore.messages[i]?.id != null) return i;
  }
  return -1;
}

function navigateToIndex(mailStore: ReturnType<typeof useMailStore>, index: number) {
  const row = mailStore.messages[index];
  if (row?.id == null) return;
  mailStore.selectMessage(row.id);
}

function navigateRelative(
  mailStore: ReturnType<typeof useMailStore>,
  direction: 1 | -1,
  { unreadOnly = false } = {},
) {
  const len = mailStore.messages.length;
  if (!len) return;
  let index = findMessageIndex(mailStore, mailStore.selectedMessageId);
  if (index < 0) {
    index = direction > 0 ? -1 : len;
  }
  for (let i = index + direction; direction > 0 ? i < len : i >= 0; i += direction) {
    const row = mailStore.messages[i];
    if (row?.id == null) continue;
    if (unreadOnly && Number(row.is_seen) === 1) continue;
    navigateToIndex(mailStore, i);
    return;
  }
}

function selectAllLoaded(mailStore: ReturnType<typeof useMailStore>) {
  const upper = Math.min(
    mailStore.messages.length,
    mailStore.totalForFolder ?? mailStore.messages.length,
  );
  const next = new Set(mailStore.selectedIds);
  for (let i = 0; i < upper; i += 1) {
    const id = mailStore.messages[i]?.id;
    if (id != null) next.add(id);
  }
  mailStore.selectedIds = next;
}

type ShortcutHandler = (event: KeyboardEvent) => void | Promise<void>;
let activeShortcutHandler: ShortcutHandler | null = null;

/** Forward key events from nested documents (e.g. message iframe) to the handler. */
export function invokeThunderbirdShortcut(event: KeyboardEvent) {
  void activeShortcutHandler?.(event);
}

export function useThunderbirdShortcuts({
  space,
  enabled,
  focusQuickFilter,
}: UseThunderbirdShortcutsOptions) {
  const mailStore = useMailStore();
  const composeStore = useComposeStore();

  async function onKeyDown(event: KeyboardEvent) {
    if (!enabled.value) return;
    if (composeStore.isOpen) {
      if (event.key === 'Escape') {
        event.preventDefault();
        composeStore.close();
      }
      return;
    }
    if (space.value !== 'mail') return;

    if (matchesShortcut(event, { key: 'k', mod: true })) {
      event.preventDefault();
      focusQuickFilter?.();
      return;
    }

    if (isEditableTarget(event.target)) return;

    const mod = isModKey(event);

    // --- Compose / reply / forward ---
    if (matchesShortcut(event, { key: 'n', mod: true }) || matchesShortcut(event, { key: 'm', mod: true })) {
      event.preventDefault();
      composeStore.open();
      return;
    }

    const single = getSingleMessage(mailStore);
    if (single && matchesShortcut(event, { key: 'r', mod: true }) && !event.shiftKey) {
      event.preventDefault();
      composeStore.prepareReplyFromMessage(single, mailStore.messageBody ?? {});
      return;
    }
    if (single && matchesShortcut(event, { key: 'r', mod: true, shift: true })) {
      event.preventDefault();
      composeStore.prepareReplyAll(single, mailStore.messageBody ?? {});
      return;
    }
    if (single && matchesShortcut(event, { key: 'l', mod: true })) {
      event.preventDefault();
      composeStore.prepareForward(single, mailStore.messageBody ?? {});
      return;
    }

    // --- Selection ---
    if (matchesShortcut(event, { key: 'a', mod: true })) {
      event.preventDefault();
      selectAllLoaded(mailStore);
      return;
    }
    if (event.key === 'Escape' && mailStore.selectedIds.size > 0) {
      event.preventDefault();
      mailStore.clearSelection();
      return;
    }

    // --- Message actions (need at least one target) ---
    const targetIds = getTargetIds(mailStore);
    if (targetIds.length > 0) {
      if (isDeleteKey(event) && event.shiftKey) {
        event.preventDefault();
        try {
          await mailStore.permanentlyDestroyMessages(targetIds);
        } catch (err) {
          console.warn('[shortcuts] permanent delete failed', err);
        }
        return;
      }
      if (isDeleteKey(event)) {
        event.preventDefault();
        try {
          await mailStore.destroyMessages(targetIds);
        } catch (err) {
          console.warn('[shortcuts] delete failed', err);
        }
        return;
      }
      if (event.key === 'a' || event.key === 'A') {
        event.preventDefault();
        void mailStore.archiveMessages(targetIds);
        return;
      }
      if (event.key === 'm' || event.key === 'M') {
        event.preventDefault();
        void mailStore.toggleManySeen(targetIds);
        return;
      }
    }

    // --- Navigation (single-key, no modifiers) ---
    if (!mod && !event.altKey && !event.shiftKey) {
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        navigateRelative(mailStore, 1);
        return;
      }
      if (event.key === 'b' || event.key === 'B') {
        event.preventDefault();
        navigateRelative(mailStore, -1);
        return;
      }
      if (event.key === 'n' || event.key === 'N') {
        event.preventDefault();
        navigateRelative(mailStore, 1, { unreadOnly: true });
        return;
      }
      if (event.key === 'p' || event.key === 'P') {
        event.preventDefault();
        navigateRelative(mailStore, -1, { unreadOnly: true });
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        const index = firstLoadedIndex(mailStore);
        if (index >= 0) navigateToIndex(mailStore, index);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        const index = lastLoadedIndex(mailStore);
        if (index >= 0) navigateToIndex(mailStore, index);
        return;
      }
    }
  }

  activeShortcutHandler = onKeyDown;

  onMounted(() => {
    document.addEventListener('keydown', onKeyDown, true);
  });

  onUnmounted(() => {
    if (activeShortcutHandler === onKeyDown) {
      activeShortcutHandler = null;
    }
    document.removeEventListener('keydown', onKeyDown, true);
  });
}
