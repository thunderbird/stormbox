/**
 * Global keyboard shortcuts for the mail UI.
 *
 * Bound at the App shell so shortcuts work regardless of which pane has
 * focus. Key bindings come from the scheme table selected by the
 * `shortcutScheme` setting (`constants/shortcuts.ts`); this file only
 * maps the resolved action onto store calls. Compose editor formatting
 * keys are handled by Squire.
 */

import {
  onMounted,
  onUnmounted,
  type Ref,
} from 'vue';

import {
  prefixForEvent,
  resolveShortcut,
  type ShortcutAction,
} from '../constants/shortcuts';
import { useMailStore } from '../stores/mail-store';
import { useComposeStore } from '../stores/compose-store';
import { useSettingsStore } from '../stores/settings-store';
import {
  isComposingKeyEvent,
  isEditableTarget,
} from '../utils/keyboard';

/** How long a sequence prefix such as `*` waits for its second key. */
export const SHORTCUT_PREFIX_TIMEOUT_MS = 1500;

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
  const settingsStore = useSettingsStore();

  let pendingPrefix: string | null = null;
  let pendingPrefixTimer: number | null = null;

  function clearPendingPrefix() {
    pendingPrefix = null;
    if (pendingPrefixTimer != null) {
      window.clearTimeout(pendingPrefixTimer);
      pendingPrefixTimer = null;
    }
  }

  function startPendingPrefix(prefix: string) {
    clearPendingPrefix();
    pendingPrefix = prefix;
    pendingPrefixTimer = window.setTimeout(() => {
      pendingPrefixTimer = null;
      pendingPrefix = null;
    }, SHORTCUT_PREFIX_TIMEOUT_MS);
  }

  function targetsForMessageAction(action: ShortcutAction): number[] | null {
    const targetIds = getTargetIds(mailStore);
    if (targetIds.length === 0) return null;
    // Scheduled (Send Later) mail is read-only outgoing mail: archive and
    // delete stand down for it exactly as the hidden toolbar buttons do.
    const mutatesScheduled = action === 'archive' || action === 'delete' || action === 'deleteForever';
    if (mutatesScheduled && hasScheduledTarget(mailStore, targetIds)) return [];
    return targetIds;
  }

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

    const scheme = settingsStore.get('shortcutScheme');
    const editable = isEditableTarget(event.target);
    const resolved = resolveShortcut(event, scheme, pendingPrefix);

    // Quick Filter is shared by every space and its chord form works
    // from inside a text field; `/` does not, so typing it still works.
    if (resolved?.action === 'quickFilter') {
      if (editable && !resolved.binding.inEditable) return;
      event.preventDefault();
      focusQuickFilter?.();
      return;
    }

    if (space.value !== 'mail') return;
    if (editable) return;

    const prefix = prefixForEvent(event, scheme);
    if (prefix) {
      event.preventDefault();
      startPendingPrefix(prefix);
      return;
    }
    clearPendingPrefix();

    if (!resolved) return;
    const { action } = resolved;

    switch (action) {
      case 'compose':
        event.preventDefault();
        composeStore.open();
        return;

      // The reply prefills read the parent's addresses from the cache, so
      // they settle a tick later. The handler stays synchronous — it has a
      // keystroke to preventDefault — and the composer opens when the read
      // returns, which is the same latency the toolbar buttons have.
      // Scheduled (Send Later) mail is read-only outgoing mail, so these
      // stand down for it just like the hidden toolbar buttons.
      case 'reply':
      case 'replyAll':
      case 'forward': {
        const singleTarget = getSingleMessage(mailStore);
        const single = singleTarget?.scheduled_undo_status == null ? singleTarget : null;
        if (!single) return;
        event.preventDefault();
        const body = mailStore.messageBody ?? {};
        if (action === 'reply') void composeStore.prepareReplyFromMessage(single, body);
        else if (action === 'replyAll') void composeStore.prepareReplyAll(single, body);
        else composeStore.prepareForward(single, body);
        return;
      }

      case 'selectAll':
        if (!activeMessageListCommands) return;
        event.preventDefault();
        activeMessageListCommands.selectAll();
        return;

      case 'clearSelection':
        if (mailStore.selectedIds.size === 0) return;
        event.preventDefault();
        mailStore.clearSelection();
        return;

      case 'archive':
      case 'delete':
      case 'deleteForever':
      case 'markRead':
      case 'markUnread':
      case 'toggleRead': {
        const targetIds = targetsForMessageAction(action);
        if (targetIds == null) return;
        event.preventDefault();
        if (targetIds.length === 0) return;
        if (action === 'archive') {
          void mailStore.archiveMessages(targetIds);
        } else if (action === 'markRead') {
          void mailStore.markManySeen(targetIds, true);
        } else if (action === 'markUnread') {
          void mailStore.markManySeen(targetIds, false);
        } else if (action === 'toggleRead') {
          void mailStore.toggleManySeen(targetIds);
        } else {
          try {
            if (action === 'deleteForever') {
              await mailStore.permanentlyDestroyMessages(targetIds);
            } else {
              await mailStore.destroyMessages(targetIds);
            }
          } catch (err) {
            console.warn(`[shortcuts] ${action} failed`, err);
          }
        }
        return;
      }

      case 'next':
      case 'previous':
      case 'nextUnread':
      case 'previousUnread':
      case 'first':
      case 'last':
        if (!activeMessageListCommands) return;
        event.preventDefault();
        activeMessageListCommands.navigate(action);
        return;

      default: {
        const unhandled: never = action;
        return unhandled;
      }
    }
  }

  activeShortcutHandler = onKeyDown;

  onMounted(() => {
    document.addEventListener('keydown', onKeyDown, true);
  });

  onUnmounted(() => {
    clearPendingPrefix();
    if (activeShortcutHandler === onKeyDown) {
      activeShortcutHandler = null;
    }
    document.removeEventListener('keydown', onKeyDown, true);
  });
}
