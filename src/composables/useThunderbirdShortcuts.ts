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
  isComposingKeyEvent,
  isDeleteKey,
  isEditableTarget,
  isModKey,
  matchesShortcut,
} from '../utils/keyboard';

export interface UseThunderbirdShortcutsOptions {
  /** Current app space ('mail' | 'contacts'). */
  space: Ref<string>;
  /** When false, no shortcuts are handled (e.g. login gate). */
  enabled: Ref<boolean>;
  /** Focuses the app-level Quick Filter field. */
  focusQuickFilter?: () => void;
}

export type MessageListNavigationCommand =
  | 'first'
  | 'last'
  | 'next'
  | 'nextUnread'
  | 'previous'
  | 'previousUnread';

export interface MessageListCommands {
  navigate: (command: MessageListNavigationCommand) => void;
  selectAll: () => void;
}

let activeMessageListCommands: MessageListCommands | null = null;

export function registerMessageListCommands(commands: MessageListCommands): () => void {
  activeMessageListCommands = commands;
  return () => {
    if (activeMessageListCommands === commands) {
      activeMessageListCommands = null;
    }
  };
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

function hasScheduledTarget(
  mailStore: ReturnType<typeof useMailStore>,
  ids: number[],
): boolean {
  const targets = new Set(ids);
  return mailStore.messages.some((message) =>
    message?.id != null
    && targets.has(Number(message.id))
    && message.scheduled_undo_status != null);
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
    if (event.defaultPrevented) return;
    if (isComposingKeyEvent(event)) return;
    if (!enabled.value) return;
    if (composeStore.isExpanded) {
      if (event.key === 'Escape') {
        if (composeStore.activeSession?.closePromptOpen) {
          event.preventDefault();
          composeStore.cancelClose(composeStore.activeSessionId);
          return;
        }
        // The nested scheduling dialog owns Escape one layer at a time.
        // This listener runs first in the document capture phase.
        if (document.querySelector('.schedule-dialog[aria-modal="true"]')) {
          return;
        }
        // A combobox showing its list owns Escape: dismissing the list is
        // what the user meant, and closing the whole message instead throws
        // away a draft over a keypress. This handler runs in the capture
        // phase, so the control cannot stop the event on its way past —
        // hence reading the state it already publishes for a screen reader
        // rather than a flag kept in parallel with it.
        //
        // Only where it has focus, because only there will it receive the
        // key. Standing down for a list somewhere else in the dialog leaves
        // Escape doing nothing at all, and a message that cannot be closed.
        const focused = document.activeElement;
        if (focused?.matches?.('.compose-dialog [role="combobox"][aria-expanded="true"]')) {
          return;
        }
        // An open dropdown owns Escape the same way, but is checked
        // document-wide rather than by focus: its summary keeps focus in
        // the editor on purpose, so the menu is open while focus sits
        // elsewhere. The widget's own capture listener registers after
        // this one, so standing down is what lets it act.
        if (document.querySelector(
          '.compose-dialog--expanded details[data-dropdown-group][open]',
        )) {
          return;
        }
        event.preventDefault();
        composeStore.requestClose(composeStore.activeSessionId);
      }
      return;
    }

    if (matchesShortcut(event, { key: 'k', mod: true })) {
      event.preventDefault();
      focusQuickFilter?.();
      return;
    }

    if (space.value !== 'mail') return;

    if (isEditableTarget(event.target)) return;

    const mod = isModKey(event);

    // --- Compose / reply / forward ---
    if (matchesShortcut(event, { key: 'n', mod: true }) || matchesShortcut(event, { key: 'm', mod: true })) {
      event.preventDefault();
      composeStore.open();
      return;
    }

    // Scheduled (Send Later) messages are read-only outgoing mail, so
    // the reply/forward shortcuts stand down for them just like the
    // hidden toolbar buttons.
    const singleTarget = getSingleMessage(mailStore);
    const single = singleTarget?.scheduled_undo_status == null ? singleTarget : null;
    // The reply prefills read the parent's addresses from the cache, so
    // they settle a tick later. The handler stays synchronous — it has a
    // keystroke to preventDefault — and the composer opens when the read
    // returns, which is the same latency the toolbar buttons have.
    if (single && matchesShortcut(event, { key: 'r', mod: true }) && !event.shiftKey) {
      event.preventDefault();
      void composeStore.prepareReplyFromMessage(single, mailStore.messageBody ?? {});
      return;
    }
    if (single && matchesShortcut(event, { key: 'r', mod: true, shift: true })) {
      event.preventDefault();
      void composeStore.prepareReplyAll(single, mailStore.messageBody ?? {});
      return;
    }
    if (single && matchesShortcut(event, { key: 'l', mod: true })) {
      event.preventDefault();
      composeStore.prepareForward(single, mailStore.messageBody ?? {});
      return;
    }

    // --- Selection ---
    if (matchesShortcut(event, { key: 'a', mod: true })) {
      if (!activeMessageListCommands) return;
      event.preventDefault();
      activeMessageListCommands.selectAll();
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
      if (
        hasScheduledTarget(mailStore, targetIds)
        && (
          isDeleteKey(event)
          || event.key === 'a'
          || event.key === 'A'
        )
      ) {
        event.preventDefault();
        return;
      }
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
      let command: MessageListNavigationCommand | null = null;
      if (event.key === 'f' || event.key === 'F') {
        command = 'next';
      } else if (event.key === 'b' || event.key === 'B') {
        command = 'previous';
      } else if (event.key === 'n' || event.key === 'N') {
        command = 'nextUnread';
      } else if (event.key === 'p' || event.key === 'P') {
        command = 'previousUnread';
      } else if (event.key === 'Home') {
        command = 'first';
      } else if (event.key === 'End') {
        command = 'last';
      }
      if (command && activeMessageListCommands) {
        event.preventDefault();
        activeMessageListCommands.navigate(command);
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
