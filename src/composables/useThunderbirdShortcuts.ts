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
import { isScheduledMessage } from '../utils/scheduled-message';

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
  /** Folder the registering list shows; a list without one matches any target. */
  folderId?: () => number | null;
  /** True for the primary column, the fallback when no list owns the target. */
  primary?: () => boolean;
  /** True while keyboard focus is inside the registering list. */
  containsFocus?: () => boolean;
}

const messageListCommandRegistry: MessageListCommands[] = [];

/**
 * Register one list column's navigation commands. Every mounted column
 * registers; the global handler routes a command to the column whose
 * folder owns the checked rows, then the cursor, then the open message,
 * then to the primary column.
 */
export function registerMessageListCommands(commands: MessageListCommands): () => void {
  messageListCommandRegistry.push(commands);
  return () => {
    const index = messageListCommandRegistry.indexOf(commands);
    if (index >= 0) messageListCommandRegistry.splice(index, 1);
  };
}

/** Folder whose rows a message shortcut should act on, or null for none. */
function targetFolderId(mailStore: ReturnType<typeof useMailStore>): number | null {
  if (mailStore.selectedIds.size > 0) return mailStore.selectionFolderId ?? mailStore.currentFolderId;
  if (mailStore.focusedMessageId != null && mailStore.focusedFolderId != null) {
    return mailStore.focusedFolderId;
  }
  if (mailStore.selectedMessageId != null) return mailStore.openMessageFolderId;
  return mailStore.currentFolderId;
}

function resolveMessageListCommands(
  mailStore: ReturnType<typeof useMailStore>,
): MessageListCommands | null {
  if (messageListCommandRegistry.length === 0) return null;
  const target = targetFolderId(mailStore);
  const owners = messageListCommandRegistry.filter((entry) => {
    const folderId = entry.folderId?.();
    return folderId !== undefined && folderId != null && Number(folderId) === Number(target);
  });
  // Two columns may show the same folder; the one the keyboard is in
  // wins, since the filters that shape navigation are per column.
  return owners.find((entry) => entry.containsFocus?.() === true)
    ?? owners[0]
    ?? messageListCommandRegistry.find((entry) => entry.primary?.() === true)
    ?? messageListCommandRegistry.find((entry) => entry.folderId === undefined)
    ?? messageListCommandRegistry[messageListCommandRegistry.length - 1]
    ?? null;
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

/** Folder the targeted rows belong to: the checked column's, else the open message's. */
function sourceFolderForTargets(mailStore: ReturnType<typeof useMailStore>): number | null {
  if (mailStore.selectedIds.size > 0) return mailStore.selectionFolderId;
  if (mailStore.selectedMessageId != null) return mailStore.selectedMessageFolderId;
  return null;
}

function getSingleMessage(mailStore: ReturnType<typeof useMailStore>) {
  const ids = getTargetIds(mailStore);
  if (ids.length !== 1) return null;
  return mailStore.findLoadedRow(ids[0], sourceFolderForTargets(mailStore)) ?? null;
}

function hasScheduledTarget(
  mailStore: ReturnType<typeof useMailStore>,
  ids: number[],
): boolean {
  const folderId = sourceFolderForTargets(mailStore);
  return ids.some((id) => isScheduledMessage(mailStore.findLoadedRow(Number(id), folderId)));
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
    const resolved = resolveShortcut(event, scheme);

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
      // A pending scheduled send is read-only outgoing mail, so these
      // stand down for it just like the hidden toolbar buttons.
      case 'reply':
      case 'replyAll':
      case 'forward': {
        const singleTarget = getSingleMessage(mailStore);
        const single = isScheduledMessage(singleTarget) ? null : singleTarget;
        if (!single) return;
        event.preventDefault();
        const body = mailStore.messageBody ?? {};
        if (action === 'reply') void composeStore.prepareReplyFromMessage(single, body);
        else if (action === 'replyAll') void composeStore.prepareReplyAll(single, body);
        else composeStore.prepareForward(single, body);
        return;
      }

      case 'selectAll': {
        const commands = resolveMessageListCommands(mailStore);
        if (!commands) return;
        event.preventDefault();
        commands.selectAll();
        return;
      }

      case 'clearSelection':
        if (mailStore.selectedIds.size === 0) return;
        // An open dropdown (a column's folder picker or More menu) owns
        // Escape: it closes on the same capture-phase listener, registered
        // after this one, so the selection must not go with it.
        if (document.querySelector('details.app-dropdown[open]')) return;
        event.preventDefault();
        mailStore.clearSelection();
        return;

      case 'archive':
      case 'delete':
      case 'deleteForever':
      case 'toggleRead':
      case 'toggleStar': {
        const targetIds = targetsForMessageAction(action);
        if (targetIds == null) return;
        event.preventDefault();
        if (targetIds.length === 0) return;
        // The rows may belong to a column other than the primary one;
        // name their folder so the store acts on it.
        const source = { sourceFolderId: sourceFolderForTargets(mailStore) };
        if (action === 'archive') {
          void mailStore.archiveMessages(targetIds, source);
        } else if (action === 'toggleRead') {
          void mailStore.toggleManySeen(targetIds, source);
        } else if (action === 'toggleStar') {
          void mailStore.toggleManyFlagged(targetIds, source);
        } else {
          try {
            if (action === 'deleteForever') {
              await mailStore.permanentlyDestroyMessages(targetIds, source);
            } else {
              await mailStore.destroyMessages(targetIds, source);
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
      case 'last': {
        const commands = resolveMessageListCommands(mailStore);
        if (!commands) return;
        event.preventDefault();
        commands.navigate(action);
        return;
      }

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
    if (activeShortcutHandler === onKeyDown) {
      activeShortcutHandler = null;
    }
    document.removeEventListener('keydown', onKeyDown, true);
  });
}
