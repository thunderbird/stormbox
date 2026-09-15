/**
 * Configuration of the message list columns: which folders the extra
 * columns show and how wide every column is. Persisted per account in
 * the browser mirror so the layout comes back after a reload; folders
 * are stored by JMAP mailbox id (plus the owning account's remote id)
 * so a local cache reset does not lose them. The primary column's
 * folder is the mail store's `currentFolderId` and is not stored here.
 */

import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

import type { FolderRow } from '../types';
import { useAuthStore } from './auth-store';
import { useMailStore } from './mail-store';

export const MAX_MESSAGE_COLUMNS = 8;
export const MESSAGE_COLUMN_MIN_WIDTH = 280;
export const MESSAGE_COLUMN_MAX_WIDTH = 720;
export const MESSAGE_COLUMN_DEFAULT_WIDTH = 360;
export const MESSAGE_COLUMN_RESIZER_WIDTH = 6;
export const PRIMARY_COLUMN_ID = 'primary';

const STORAGE_KEY_PREFIX = 'stormbox.messageColumns.v1:';
/**
 * Where the shell kept the single message list's width before columns
 * existed (`useColumnResize` in App.vue, pane `messageList`). An account
 * without a stored layout starts its primary column at that width so an
 * upgrade keeps the list where the user left it.
 */
const LEGACY_WIDTHS_KEY = 'stormbox.mailColumnWidths.v1';
const LEGACY_LIST_PANE = 'messageList';

export interface ColumnFolderRef {
  accountRemoteId: string;
  mailboxRemoteId: string;
}

export interface MessageColumnConfig {
  id: string;
  folder: ColumnFolderRef | null;
  width: number;
}

/** A column as the columns area renders it: config resolved against the folder cache. */
export interface MessageColumn {
  id: string;
  primary: boolean;
  /** Local folder id, or null while the column has no (resolvable) folder. */
  folderId: number | null;
  width: number;
}

interface StoredColumns {
  primaryWidth: number;
  columns: MessageColumnConfig[];
}

export function clampColumnWidth(width: number): number {
  const numeric = Number(width);
  if (!Number.isFinite(numeric)) return MESSAGE_COLUMN_DEFAULT_WIDTH;
  return Math.round(Math.max(
    MESSAGE_COLUMN_MIN_WIDTH,
    Math.min(MESSAGE_COLUMN_MAX_WIDTH, numeric),
  ));
}

function readStored(key: string): StoredColumns | null {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const columns: MessageColumnConfig[] = [];
    const seen = new Set<string>();
    for (const entry of Array.isArray(parsed.columns) ? parsed.columns : []) {
      if (!entry || typeof entry !== 'object') continue;
      const id = typeof entry.id === 'string' && entry.id && !seen.has(entry.id)
        ? entry.id
        : `c${columns.length + 1}-${Date.now().toString(36)}`;
      seen.add(id);
      const folder = entry.folder
        && typeof entry.folder.accountRemoteId === 'string'
        && typeof entry.folder.mailboxRemoteId === 'string'
        ? {
          accountRemoteId: entry.folder.accountRemoteId,
          mailboxRemoteId: entry.folder.mailboxRemoteId,
        }
        : null;
      columns.push({ id, folder, width: clampColumnWidth(entry.width) });
      if (columns.length >= MAX_MESSAGE_COLUMNS - 1) break;
    }
    return {
      primaryWidth: clampColumnWidth(parsed.primaryWidth),
      columns,
    };
  } catch {
    return null;
  }
}

/** The pre-columns list width, or null when none was stored or it is not a number. */
function readLegacyListWidth(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(LEGACY_WIDTHS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const width = Number(parsed?.[LEGACY_LIST_PANE]);
    return Number.isFinite(width) && width > 0 ? clampColumnWidth(width) : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: StoredColumns): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // The in-memory layout still applies when browser storage is unavailable.
  }
}

export const useMessageColumnsStore = defineStore('message-columns', () => {
  const authStore = useAuthStore();
  const mailStore = useMailStore();

  const primaryWidth = ref(MESSAGE_COLUMN_DEFAULT_WIDTH);
  const extraColumns = ref<MessageColumnConfig[]>([]);
  /**
   * The column a message was last opened from. Not persisted: it only
   * lets the columns area, remounted after the single-column layout
   * showed the message, scroll back to that column.
   */
  const lastActiveColumnId = ref<string | null>(null);
  let nextColumnSeq = 1;
  let loadedKey: string | null = null;

  /**
   * Storage key for the signed-in account, from identifiers the server
   * assigns so it survives a local cache reset; null until the account
   * row is known.
   */
  const accountKey = computed<string | null>(() => {
    const account = mailStore.accounts.find((row) => row.id === authStore.accountId);
    if (!account) return null;
    return `${STORAGE_KEY_PREFIX}${account.server_origin}|${account.remote_account_id}`;
  });

  function resolveFolderId(folderRef: ColumnFolderRef | null): number | null {
    if (!folderRef) return null;
    const account = mailStore.accounts.find(
      (row) => row.remote_account_id === folderRef.accountRemoteId,
    );
    if (!account) return null;
    const folder = mailStore.folders.find((row) => (
      row.account_id === account.id
      && row.remote_id === folderRef.mailboxRemoteId
      && Number(row.is_deleted) !== 1
    ));
    return folder?.id ?? null;
  }

  function folderRefFor(folderId: number | null): ColumnFolderRef | null {
    if (folderId == null) return null;
    const folder: FolderRow | null = mailStore.folderById(folderId);
    if (!folder) return null;
    const account = mailStore.accounts.find((row) => row.id === folder.account_id);
    if (!account) return null;
    return { accountRemoteId: account.remote_account_id, mailboxRemoteId: folder.remote_id };
  }

  /** Every column in display order, the primary column first. */
  const columns = computed<MessageColumn[]>(() => [
    {
      id: PRIMARY_COLUMN_ID,
      primary: true,
      folderId: mailStore.currentFolderId,
      width: primaryWidth.value,
    },
    ...extraColumns.value.map((column) => ({
      id: column.id,
      primary: false,
      folderId: resolveFolderId(column.folder),
      width: column.width,
    })),
  ]);

  const canAddColumn = computed(() => columns.value.length < MAX_MESSAGE_COLUMNS);

  function newColumnId(): string {
    let id = `c${nextColumnSeq}`;
    while (extraColumns.value.some((column) => column.id === id)) {
      nextColumnSeq += 1;
      id = `c${nextColumnSeq}`;
    }
    nextColumnSeq += 1;
    return id;
  }

  /** Append a column with no folder; returns its id, or null at the limit. */
  function addColumn(): string | null {
    if (!canAddColumn.value) return null;
    const id = newColumnId();
    extraColumns.value = [
      ...extraColumns.value,
      { id, folder: null, width: MESSAGE_COLUMN_DEFAULT_WIDTH },
    ];
    return id;
  }

  function removeColumn(id: string): void {
    if (id === PRIMARY_COLUMN_ID) return;
    extraColumns.value = extraColumns.value.filter((column) => column.id !== id);
  }

  function setColumnFolder(id: string, folderId: number | null): void {
    if (id === PRIMARY_COLUMN_ID) return;
    const folder = folderRefFor(folderId);
    extraColumns.value = extraColumns.value.map((column) => (
      column.id === id ? { ...column, folder } : column
    ));
  }

  function columnWidth(id: string): number {
    if (id === PRIMARY_COLUMN_ID) return primaryWidth.value;
    return extraColumns.value.find((column) => column.id === id)?.width
      ?? MESSAGE_COLUMN_DEFAULT_WIDTH;
  }

  function setColumnWidth(id: string, width: number): void {
    const clamped = clampColumnWidth(width);
    if (id === PRIMARY_COLUMN_ID) {
      primaryWidth.value = clamped;
      return;
    }
    extraColumns.value = extraColumns.value.map((column) => (
      column.id === id && column.width !== clamped ? { ...column, width: clamped } : column
    ));
  }

  function applyStored(stored: StoredColumns | null): void {
    primaryWidth.value = stored?.primaryWidth ?? MESSAGE_COLUMN_DEFAULT_WIDTH;
    extraColumns.value = stored?.columns ?? [];
    nextColumnSeq = extraColumns.value.length + 1;
  }

  function persist(): void {
    if (!loadedKey) return;
    writeStored(loadedKey, {
      primaryWidth: primaryWidth.value,
      columns: extraColumns.value,
    });
  }

  // The layout follows the account: load its stored columns when the
  // account row appears, drop to the default single column when it goes.
  // An account with no layout yet starts from the shell's old list width.
  watch(accountKey, (key) => {
    if (key === loadedKey) return;
    loadedKey = key;
    const stored = key ? readStored(key) : null;
    applyStored(stored);
    if (key && !stored) {
      const legacyWidth = readLegacyListWidth();
      if (legacyWidth != null) {
        primaryWidth.value = legacyWidth;
        persist();
      }
    }
  }, { immediate: true });

  watch([primaryWidth, extraColumns], persist, { deep: true });

  /** Drops the in-memory layout to the default single column (tests, sign-out). */
  function $reset(): void {
    loadedKey = null;
    lastActiveColumnId.value = null;
    applyStored(null);
  }

  return {
    primaryWidth,
    extraColumns,
    lastActiveColumnId,
    accountKey,
    columns,
    canAddColumn,
    addColumn,
    removeColumn,
    setColumnFolder,
    columnWidth,
    setColumnWidth,
    $reset,
  };
});
