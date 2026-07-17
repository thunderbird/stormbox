<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import {
  ChevronRight,
  FolderRoot,
  Pencil,
  Plus,
  Star,
  StarOff,
  Trash2,
  X,
} from '@lucide/vue';
import { SwitchToggle } from '@thunderbirdops/services-ui';

import { useAuthStore } from '../stores/auth-store';
import { useMailStore } from '../stores/mail-store';
import type { AccountRow, FolderRow } from '../types';
import { folderCapabilities } from '../utils/folder-capabilities';
import { folderSortKey } from '../utils/folder-presentation';
import FolderCreateDialog from './FolderCreateDialog.vue';

const emit = defineEmits<{ close: [] }>();

const authStore = useAuthStore();
const mailStore = useMailStore();
const closeButtonEl = ref<HTMLButtonElement | null>(null);
const scrollEl = ref<HTMLElement | null>(null);
const searchText = ref('');
const showCreateDialog = ref(false);
// Preselected parent for the create dialog: null = top level (the root
// row's +), a folder id when created via a row's + shortcut.
const createParentId = ref<number | null>(null);

function openCreateDialog(parentId: number | null) {
  createParentId.value = parentId;
  showCreateDialog.value = true;
}

interface DialogFolderRow {
  folder: FolderRow;
  depth: number;
  isOwn: boolean;
  subscribed: boolean;
  pending: boolean;
  /** Subscription toggle enabled. */
  editable: boolean;
  /** Role folders on the user's own account can't be hidden. */
  isSystem: boolean;
  canRename: boolean;
  canDelete: boolean;
  canDeleteWithMail: boolean;
  canSelect: boolean;
  /** May host a new child folder (RFC 9670 mayCreateChild for shared). */
  canCreateChild: boolean;
  /** Client-local priority pin; sorts the folder to the top of its peers. */
  starred: boolean;
  hasChildren: boolean;
  /** Ancestor names, root first — locates a row shown out of tree context. */
  path: string[];
}

interface DialogAccountSection {
  account: AccountRow;
  isOwn: boolean;
  label: string;
  rows: DialogFolderRow[];
}

/**
 * One entry in the virtualized list: an account heading, the account's
 * visual tree root ("Top Level", also the move-to-root drop target),
 * or a folder row.
 */
type ManagerItem =
  | { kind: 'header'; key: string; section: DialogAccountSection }
  | { kind: 'root'; key: string; section: DialogAccountSection }
  | {
      kind: 'row';
      key: string;
      section: DialogAccountSection;
      row: DialogFolderRow;
      /** Visual depth: rows under the tree root are shifted one level. */
      indent: number;
    };

/**
 * Depth-first flattening of one account's folder tree, mirroring the
 * sidebar's ordering (role folders first, then alphabetical).
 */
function flattenFolders(accountFolders: FolderRow[], isOwn: boolean): DialogFolderRow[] {
  const byParent = new Map<number | 'ROOT', FolderRow[]>();
  for (const folder of accountFolders) {
    if (Number(folder.is_deleted) === 1) continue;
    const key = folder.parent_id ?? 'ROOT';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(folder);
  }
  for (const list of byParent.values()) {
    // Structural order only (role, then name) — deliberately NOT the
    // sidebar's starred-first comparator. The manager is where stars
    // get toggled; re-sorting on click would make rows jump under the
    // cursor. The priority grouping is a sidebar presentation concern.
    list.sort((a, b) => folderSortKey(a) - folderSortKey(b) || a.name.localeCompare(b.name));
  }
  const out: DialogFolderRow[] = [];
  function walk(parentKey: number | 'ROOT', depth: number, path: string[]) {
    for (const folder of byParent.get(parentKey) ?? []) {
      const isSystem = isOwn && folder.role != null;
      const capabilities = folderCapabilities(folder, authStore.accountId);
      // The open eye mirrors the effective subscription, which is also
      // what the sidebar renders: system folders always show; own user
      // folders count as subscribed unless explicitly unsubscribed
      // (NULL = never reported); shared folders only when explicitly
      // subscribed.
      const subscribed = isSystem
        || (isOwn
          ? Number(folder.is_subscribed ?? 1) !== 0
          : Number(folder.is_subscribed) === 1);
      out.push({
        folder,
        depth,
        isOwn,
        subscribed,
        pending: mailStore.subscriptionPendingFolderIds.has(folder.id)
          || mailStore.folderEditPendingIds.has(folder.id),
        editable: capabilities.maySubscribe,
        isSystem,
        canRename: capabilities.mayRename && !capabilities.isSystemProtected,
        canDelete: capabilities.mayDelete && !capabilities.isSystemProtected,
        canDeleteWithMail: capabilities.mayDeleteWithMail,
        canSelect: !capabilities.isSystemProtected && (
          capabilities.mayStar
          || capabilities.maySubscribe
          || capabilities.mayDelete
        ),
        canCreateChild: capabilities.mayCreateChild && !capabilities.isSystemProtected,
        starred: Number(folder.is_starred) === 1,
        hasChildren: byParent.has(folder.id),
        path,
      });
      walk(folder.id, depth + 1, [...path, folder.name || '(unnamed)']);
    }
  }
  walk('ROOT', 0, []);
  return out;
}

const sections = computed<DialogAccountSection[]>(() => mailStore.accounts.map((account) => {
  const isOwn = account.id === authStore.accountId;
  return {
    account,
    isOwn,
    label: isOwn
      ? `${account.display_name ?? account.primary_email ?? 'My account'} (default folders)`
      : account.display_name ?? account.primary_email ?? 'Shared account',
    rows: flattenFolders(
      mailStore.folders.filter((f) => f.account_id === account.id),
      isOwn,
    ),
  };
}).filter((section) => section.rows.length > 0));

// ----- collapse / expand -----------------------------------------------
// Mirrors the sidebar: explicitly-expanded folders are tracked and
// everything else defaults to collapsed, so big accounts open as a
// short list of top-level folders. Cascades (subscription, selection)
// intentionally still walk collapsed descendants via section.rows.

const expandedFolderIds = ref<Set<number>>(new Set());

// The own account's default (system) folders are informational-only
// rows ("always shown"), so the block opens collapsed behind the
// account heading and expands on demand.
const expandedSystemAccountIds = ref<Set<number>>(new Set());

function isSystemBlockExpanded(section: DialogAccountSection): boolean {
  return expandedSystemAccountIds.value.has(section.account.id);
}

function toggleSystemBlock(section: DialogAccountSection) {
  const next = new Set(expandedSystemAccountIds.value);
  if (next.has(section.account.id)) next.delete(section.account.id);
  else next.add(section.account.id);
  expandedSystemAccountIds.value = next;
}

function isRowCollapsed(row: DialogFolderRow): boolean {
  return row.hasChildren && !expandedFolderIds.value.has(row.folder.id);
}

function toggleRowCollapsed(row: DialogFolderRow) {
  const next = new Set(expandedFolderIds.value);
  if (next.has(row.folder.id)) next.delete(row.folder.id);
  else next.add(row.folder.id);
  expandedFolderIds.value = next;
}

const searching = computed(() => searchText.value.trim().length > 0);

/** DFS rows minus subtrees hidden under a collapsed ancestor. */
function visibleRows(rows: DialogFolderRow[]): DialogFolderRow[] {
  const out: DialogFolderRow[] = [];
  let skipDeeperThan: number | null = null;
  for (const row of rows) {
    if (skipDeeperThan != null && row.depth > skipDeeperThan) continue;
    skipDeeperThan = null;
    out.push(row);
    if (isRowCollapsed(row)) skipDeeperThan = row.depth;
  }
  return out;
}

const items = computed<ManagerItem[]>(() => {
  const query = searchText.value.trim().toLowerCase();
  const out: ManagerItem[] = [];
  for (const section of sections.value) {
    // A search cuts across the tree, so it ignores collapse state —
    // a match must never be hidden by a collapsed ancestor.
    const rows = query
      ? section.rows.filter((row) => (row.folder.name ?? '').toLowerCase().includes(query))
      : visibleRows(section.rows);
    if (rows.length === 0) continue;
    out.push({ kind: 'header', key: `h-${section.account.id}`, section });
    // Own accounts get a visible tree root: it anchors the hierarchy
    // and is the drop target for moving a folder back to top level.
    // System folders sort first and can't be moved, so the root sits
    // below them, directly above the user folders it applies to, which
    // are indented one level to read as its children. Shared accounts
    // get no root (Stalwart rejects top-level creates there), and
    // search results are a flat list without one.
    if (section.isOwn && !query) {
      const splitIdx = rows.findIndex((row) => row.depth === 0 && !row.isSystem);
      const systemRows = splitIdx === -1 ? rows : rows.slice(0, splitIdx);
      const userRows = splitIdx === -1 ? [] : rows.slice(splitIdx);
      if (isSystemBlockExpanded(section)) {
        for (const row of systemRows) {
          out.push({ kind: 'row', key: `f-${row.folder.id}`, section, row, indent: row.depth });
        }
      }
      out.push({ kind: 'root', key: `r-${section.account.id}`, section });
      for (const row of userRows) {
        out.push({ kind: 'row', key: `f-${row.folder.id}`, section, row, indent: row.depth + 1 });
      }
    } else {
      for (const row of rows) {
        out.push({ kind: 'row', key: `f-${row.folder.id}`, section, row, indent: row.depth });
      }
    }
  }
  return out;
});

function indentPx(indent: number): string {
  return `${8 + Math.min(indent, 7) * 18}px`;
}

// ----- virtualization -------------------------------------------------
// The flattened list is unbounded (hundreds or thousands of folders on
// big accounts), so only the visible window is mounted. Row heights are
// dynamic — the inline editor expands a row — hence measureElement.

const HEADER_ESTIMATE = 38;
const ROW_ESTIMATE = 33;

const virtualizer = useVirtualizer(
  computed(() => ({
    count: items.value.length,
    getScrollElement: () => scrollEl.value,
    estimateSize: (index: number) => (
      items.value[index]?.kind === 'header' ? HEADER_ESTIMATE : ROW_ESTIMATE
    ),
    overscan: 12,
    getItemKey: (index: number) => items.value[index]?.key ?? index,
  })),
);
const totalSize = computed(() => virtualizer.value.getTotalSize());
const renderedItems = computed(() => virtualizer.value.getVirtualItems()
  .map((virtualRow) => ({ virtualRow, item: items.value[virtualRow.index] }))
  .filter((entry) => entry.item != null));
const measureElement = (el: Element | null) => {
  if (el) virtualizer.value.measureElement(el);
};

// ----- subscription eye toggle -----------------------------------------
// isSubscribed is a per-user Mailbox property (RFC 8621 §2), not a
// client-local preference: unsubscribing hides the folder in every
// mail app of this user that honours subscriptions, Stormbox's sidebar
// included. The copy below says "subscribe", not "show in sidebar".

/**
 * Toggle a folder's subscription and cascade the new state to its
 * descendants: subscribing a parent subscribes its whole subtree,
 * unsubscribing unsubscribes it. Descendants that are read-only,
 * already in the target state, or mid-flight are left alone. One
 * batched store call so the sidebar repaints once, straight to the
 * final state, instead of stepping through every child.
 */
async function toggleSubscription(section: DialogAccountSection, row: DialogFolderRow) {
  if (row.pending || !row.editable) return;
  const target = !row.subscribed;
  const startIndex = section.rows.indexOf(row);
  const affected = [row];
  for (let i = startIndex + 1; i < section.rows.length; i += 1) {
    const candidate = section.rows[i];
    if (candidate.depth <= row.depth) break;
    if (candidate.editable && !candidate.pending && candidate.subscribed !== target) {
      affected.push(candidate);
    }
  }
  await mailStore.setFolderSubscriptions(affected.map((entry) => entry.folder.id), target);
}

// ----- multi-selection + bulk delete ----------------------------------

const selectedIds = ref<Set<number>>(new Set());
/** null = idle; 'confirm' = first ask; 'escalate' = mailboxHasEmail retry ask. */
const bulkStage = ref<'confirm' | 'escalate' | null>(null);
const bulkBusy = ref(false);
const bulkError = ref<string | null>(null);

const selectedCount = computed(() => selectedIds.value.size);

/** Cached message total across the selection, for the confirm copy. */
const selectedMessageCount = computed(() => {
  let sum = 0;
  for (const section of sections.value) {
    for (const row of section.rows) {
      if (selectedIds.value.has(row.folder.id)) {
        sum += Number(row.folder.total_emails ?? 0);
      }
    }
  }
  return sum;
});

// Folders can vanish underneath the selection (deleted here or by a
// peer, or a sync removed them); prune dead ids so the count and the
// bulk passes never operate on ghosts.
watch(sections, (secs) => {
  const alive = new Set<number>();
  for (const section of secs) {
    for (const row of section.rows) alive.add(row.folder.id);
  }
  if (![...selectedIds.value].every((id) => alive.has(id))) {
    selectedIds.value = new Set([...selectedIds.value].filter((id) => alive.has(id)));
  }
});

/**
 * Select/deselect a folder, cascading over its deletable descendants —
 * same shape as the visibility cascade. Cascading selection keeps the
 * server's leaf-only delete rule satisfiable: selecting a parent
 * implies its subtree, and the bulk pass deletes deepest-first.
 */
function toggleSelect(section: DialogAccountSection, row: DialogFolderRow) {
  if (!row.canSelect) return;
  const target = !selectedIds.value.has(row.folder.id);
  const next = new Set(selectedIds.value);
  const apply = (r: DialogFolderRow) => {
    if (!r.canSelect) return;
    if (target) next.add(r.folder.id);
    else next.delete(r.folder.id);
  };
  apply(row);
  const startIndex = section.rows.indexOf(row);
  for (let i = startIndex + 1; i < section.rows.length; i += 1) {
    const candidate = section.rows[i];
    if (candidate.depth <= row.depth) break;
    apply(candidate);
  }
  selectedIds.value = next;
  bulkStage.value = null;
  bulkError.value = null;
}

// Anchor for shift-click range selection: the last row whose checkbox
// (or ctrl-clicked row) was toggled directly.
const selectionAnchorId = ref<number | null>(null);

/** Selectable rows in current visual order (what the user sees). */
function selectableItems(): Array<{ section: DialogAccountSection; row: DialogFolderRow }> {
  const out: Array<{ section: DialogAccountSection; row: DialogFolderRow }> = [];
  for (const item of items.value) {
    if (item.kind === 'row' && item.row.canSelect) {
      out.push({ section: item.section, row: item.row });
    }
  }
  return out;
}

/**
 * Shift-click: apply the clicked row's new state to every selectable
 * row between the anchor and it, in visual order. Deliberately no
 * descendant cascade — the range is exactly what the user swept over;
 * the delete gap check still guards leaf-only deletion later.
 */
function rangeSelect(target: DialogFolderRow) {
  const rows = selectableItems();
  const anchorIdx = rows.findIndex((r) => r.row.folder.id === selectionAnchorId.value);
  const targetIdx = rows.findIndex((r) => r.row.folder.id === target.folder.id);
  if (anchorIdx === -1 || targetIdx === -1) return false;
  const [lo, hi] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
  const state = !selectedIds.value.has(target.folder.id);
  const next = new Set(selectedIds.value);
  for (let i = lo; i <= hi; i += 1) {
    if (state) next.add(rows[i].row.folder.id);
    else next.delete(rows[i].row.folder.id);
  }
  selectedIds.value = next;
  bulkStage.value = null;
  bulkError.value = null;
  return true;
}

function onSelectClick(section: DialogAccountSection, row: DialogFolderRow, event: MouseEvent) {
  if (
    event.shiftKey
    && selectionAnchorId.value != null
    && selectionAnchorId.value !== row.folder.id
    && rangeSelect(row)
  ) {
    return;
  }
  selectionAnchorId.value = row.folder.id;
  toggleSelect(section, row);
}

/**
 * Ctrl/Cmd-click (toggle) or Shift-click (range) anywhere on a row
 * body selects it, so building a selection doesn't require hitting
 * the small checkboxes. Plain clicks fall through to the row's other
 * affordances (drag, buttons, the checkbox's own handler).
 */
function onRowModifierClick(
  section: DialogAccountSection,
  row: DialogFolderRow,
  event: MouseEvent,
) {
  if (!(event.ctrlKey || event.metaKey || event.shiftKey)) return;
  if (!row.canSelect || bulkBusy.value) return;
  const target = event.target as HTMLElement | null;
  // Interactive controls keep their own modifier-click behaviour.
  if (target?.closest('button, input, select, .folder-subs__switch')) return;
  event.preventDefault();
  onSelectClick(section, row, event);
}

function clearSelection() {
  selectedIds.value = new Set();
  bulkStage.value = null;
  bulkError.value = null;
}

function selectedRowsDeepestFirst(): DialogFolderRow[] {
  const rows: DialogFolderRow[] = [];
  for (const section of sections.value) {
    for (const row of section.rows) {
      if (selectedIds.value.has(row.folder.id)) rows.push(row);
    }
  }
  return rows.sort((a, b) => b.depth - a.depth);
}

/**
 * The server only destroys leaves, so a selected folder is deletable
 * in one bulk pass only when its entire subtree is selected too.
 * Cascading selection makes violations rare (the user must uncheck a
 * child after checking the parent), but catch it before the wire.
 */
function findSelectionGap(): string | null {
  for (const section of sections.value) {
    for (let i = 0; i < section.rows.length; i += 1) {
      const row = section.rows[i];
      if (!selectedIds.value.has(row.folder.id)) continue;
      for (let j = i + 1; j < section.rows.length; j += 1) {
        const candidate = section.rows[j];
        if (candidate.depth <= row.depth) break;
        if (!selectedIds.value.has(candidate.folder.id)) {
          return `“${row.folder.name}” can’t be deleted while its subfolder “${candidate.folder.name}” is kept. Select the whole subtree or move the subfolder first.`;
        }
      }
    }
  }
  return null;
}

function requestBulkDelete() {
  if (!selectedRows().every((row) => row.canDelete)) {
    bulkError.value = 'Every selected folder must allow deletion.';
    bulkStage.value = null;
    return;
  }
  const gap = findSelectionGap();
  if (gap) {
    bulkError.value = gap;
    bulkStage.value = null;
    return;
  }
  bulkError.value = null;
  bulkStage.value = 'confirm';
}

/**
 * One bulk pass, deepest-first so parents become leaves before their
 * own destroy is attempted. First pass sends onDestroyRemoveEmails:
 * false; mailboxHasEmail rejections stay selected and trigger the
 * escalate stage (a parent's mailboxHasChild in that pass is the
 * shadow of a child's mailboxHasEmail, so it is deferred the same
 * way). After confirmation, only folders that actually returned
 * mailboxHasEmail are retried destructively; newly reached ancestors
 * still receive their own non-destructive probe first.
 */
async function runBulkDelete(removeEmails: boolean) {
  if (bulkBusy.value) return;
  bulkBusy.value = true;
  bulkError.value = null;
  try {
    const result = await mailStore.deleteFolders(
      selectedRowsDeepestFirst().map((row) => row.folder.id),
      { removeEmails, skipChildCheck: true },
    );
    const next = new Set(selectedIds.value);
    for (const id of result.succeededIds ?? []) next.delete(Number(id));
    selectedIds.value = next;
    if (result.ok) {
      bulkStage.value = null;
      return;
    }
    const reasons = Object.values(result.errors ?? {}).map((failure: any) =>
      failure?.detail?.type ?? failure?.type);
    const mayEscalate = !removeEmails
      && reasons.includes('mailboxHasEmail')
      && reasons.every((reason) => reason === 'mailboxHasEmail' || reason === 'childFailed');
    if (mayEscalate) {
      bulkStage.value = 'escalate';
      return;
    }
    const reason = reasons.find((value) => value !== 'childFailed') ?? result.reason;
    bulkError.value = describeFolderOpFailure(reason);
    bulkStage.value = null;
  } finally {
    bulkBusy.value = false;
  }
}

// ----- bulk star / subscription ----------------------------------------

function selectedRows(): DialogFolderRow[] {
  const rows: DialogFolderRow[] = [];
  for (const section of sections.value) {
    for (const row of section.rows) {
      if (selectedIds.value.has(row.folder.id)) rows.push(row);
    }
  }
  return rows;
}

// Modal toggle buttons, mirroring Gmail-style bulk actions: if any
// selected folder is starred (or subscribed), the action clears the
// flag everywhere; only when the whole selection is off does it set.

const bulkStarAction = computed<boolean>(
  () => !selectedRows().some((row) => !row.isSystem && row.starred),
);
const bulkStarDisabled = computed<boolean>(
  () => !selectedRows().some((row) => !row.isSystem && row.subscribed),
);
const bulkSubscribeAction = computed<boolean>(
  () => !selectedRows().some((row) => row.editable && row.subscribed),
);
const bulkDeleteDisabled = computed<boolean>(
  () => !selectedRows().every((row) => row.canDelete) || findSelectionGap() != null,
);

/** Star or unstar every selected non-system folder (client-local). */
async function bulkToggleStarred() {
  if (bulkBusy.value) return;
  const target = bulkStarAction.value;
  bulkBusy.value = true;
  bulkError.value = null;
  try {
    const ids = selectedRows()
      .filter((row) => !row.isSystem && row.subscribed && row.starred !== target)
      .map((row) => row.folder.id);
    if (ids.length > 0) await mailStore.setFoldersStarred(ids, target);
  } finally {
    bulkBusy.value = false;
  }
}

/**
 * Subscribe or unsubscribe every selected folder the server lets this
 * user edit. No descendant cascade: the selection is the exact set to
 * act on (unlike the single-row switch, where toggling a parent means
 * the subtree).
 */
async function bulkToggleSubscription() {
  if (bulkBusy.value) return;
  const target = bulkSubscribeAction.value;
  bulkBusy.value = true;
  bulkError.value = null;
  try {
    const ids = selectedRows()
      .filter((row) => row.editable && !row.pending && row.subscribed !== target)
      .map((row) => row.folder.id);
    if (ids.length > 0) {
      await mailStore.setFolderSubscriptions(ids, target);
    }
  } finally {
    bulkBusy.value = false;
  }
}

// ----- drag & drop move ------------------------------------------------

const dragFolderId = ref<number | null>(null);
const dropTargetKey = ref<string | null>(null);

function rowDraggable(row: DialogFolderRow): boolean {
  return !row.isSystem && row.canRename && !row.pending;
}

function isDescendantOf(candidateId: number, ancestorId: number): boolean {
  let cursor = mailStore.folders.find((f) => f.id === candidateId) ?? null;
  while (cursor?.parent_id != null) {
    if (cursor.parent_id === ancestorId) return true;
    cursor = mailStore.folders.find((f) => f.id === cursor!.parent_id) ?? null;
  }
  return false;
}

function canDropOnRow(target: DialogFolderRow): boolean {
  const dragId = dragFolderId.value;
  if (dragId == null || dragId === target.folder.id) return false;
  const dragged = mailStore.folders.find((f) => f.id === dragId);
  if (!dragged) return false;
  // parentId must reference a mailbox in the same account (RFC 8621 §2).
  if (dragged.account_id !== target.folder.account_id) return false;
  if ((dragged.parent_id ?? null) === target.folder.id) return false;
  if (isDescendantOf(target.folder.id, dragId)) return false;
  if (!folderCapabilities(target.folder, authStore.accountId).mayCreateChild) return false;
  return true;
}

/** The account heading doubles as the "move to top level" drop zone. */
function canDropOnSection(section: DialogAccountSection): boolean {
  const dragId = dragFolderId.value;
  if (dragId == null || !section.isOwn) return false;
  const dragged = mailStore.folders.find((f) => f.id === dragId);
  return !!dragged
    && dragged.account_id === section.account.id
    && dragged.parent_id != null;
}

function onRowDragStart(row: DialogFolderRow, event: DragEvent) {
  if (!rowDraggable(row)) {
    event.preventDefault();
    return;
  }
  dragFolderId.value = row.folder.id;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    // Firefox refuses to start a drag with an empty data store.
    event.dataTransfer.setData('text/plain', String(row.folder.id));
  }
}

function onDragEnd() {
  dragFolderId.value = null;
  dropTargetKey.value = null;
}

function onRowDragOver(target: DialogFolderRow, event: DragEvent) {
  if (!canDropOnRow(target)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dropTargetKey.value = `f-${target.folder.id}`;
}

function onSectionDragOver(section: DialogAccountSection, event: DragEvent) {
  if (!canDropOnSection(section)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dropTargetKey.value = `r-${section.account.id}`;
}

function onDragLeave(key: string) {
  if (dropTargetKey.value === key) dropTargetKey.value = null;
}

async function onRowDrop(target: DialogFolderRow) {
  const dragId = dragFolderId.value;
  const valid = dragId != null && canDropOnRow(target);
  onDragEnd();
  if (!valid) return;
  await mailStore.updateFolder(dragId!, { parentFolderId: target.folder.id });
}

async function onSectionDrop(section: DialogAccountSection) {
  const dragId = dragFolderId.value;
  const valid = dragId != null && canDropOnSection(section);
  onDragEnd();
  if (!valid) return;
  await mailStore.updateFolder(dragId!, { parentFolderId: null });
}

// ----- row editor (rename / move / delete) ----------------------------

const editingFolderId = ref<number | null>(null);
const editorName = ref('');
const editorParentId = ref<number | null>(null);
const editorError = ref<string | null>(null);
/** null = editing; 'confirm' = first delete ask; 'escalate' = mailboxHasEmail. */
const deleteStage = ref<'confirm' | 'escalate' | null>(null);
const editorBusy = ref(false);

function openEditor(row: DialogFolderRow) {
  editingFolderId.value = row.folder.id;
  editorName.value = row.folder.name ?? '';
  editorParentId.value = row.folder.parent_id ?? null;
  editorError.value = null;
  deleteStage.value = null;
  // Re-measure the expanded row once the editor is in the DOM.
  void nextTick(() => virtualizer.value.measure());
}

function closeEditor() {
  editingFolderId.value = null;
  editorError.value = null;
  deleteStage.value = null;
  void nextTick(() => virtualizer.value.measure());
}

interface ParentOption {
  id: number | null;
  label: string;
}

/**
 * Move destinations for the folder being edited: same-account folders
 * except itself and its descendants (a cycle), plus "Top Level" on the
 * user's own account. Stalwart rejects creating top-level mailboxes in
 * shared accounts, so shared folders can only move under a sibling.
 */
const editorParentOptions = computed<ParentOption[]>(() => {
  const id = editingFolderId.value;
  if (id == null) return [];
  const folder = mailStore.folders.find((f) => f.id === id);
  if (!folder) return [];
  const section = sections.value.find((s) => s.account.id === folder.account_id);
  if (!section) return [];
  const excluded = new Set<number>([id]);
  for (const row of section.rows) {
    const parentId = row.folder.parent_id;
    if (parentId != null && excluded.has(parentId)) excluded.add(row.folder.id);
  }
  const options: ParentOption[] = section.isOwn ? [{ id: null, label: 'Top Level' }] : [];
  for (const row of section.rows) {
    if (excluded.has(row.folder.id)) continue;
    if (!row.canCreateChild) continue;
    options.push({
      id: row.folder.id,
      label: `${'\u00a0'.repeat(row.depth * 3)}${row.folder.name || '(unnamed)'}`,
    });
  }
  return options;
});

async function saveEditor(row: DialogFolderRow) {
  if (editorBusy.value) return;
  const changes: { name?: string; parentFolderId?: number | null } = {};
  const nextName = editorName.value.trim();
  if (nextName && nextName !== row.folder.name) changes.name = nextName;
  if ((editorParentId.value ?? null) !== (row.folder.parent_id ?? null)) {
    changes.parentFolderId = editorParentId.value ?? null;
  }
  if (Object.keys(changes).length === 0) {
    closeEditor();
    return;
  }
  editorBusy.value = true;
  try {
    const result = await mailStore.updateFolder(row.folder.id, changes);
    if (result.ok) {
      closeEditor();
    } else {
      editorError.value = describeFolderOpFailure(result.reason);
    }
  } finally {
    editorBusy.value = false;
  }
}

async function requestDelete(row: DialogFolderRow) {
  if (deleteStage.value == null) {
    deleteStage.value = 'confirm';
    editorError.value = null;
    void nextTick(() => virtualizer.value.measure());
    return;
  }
  if (editorBusy.value) return;
  editorBusy.value = true;
  try {
    const removeEmails = deleteStage.value === 'escalate';
    const result = await mailStore.deleteFolder(row.folder.id, { removeEmails });
    if (result.ok) {
      closeEditor();
    } else if (result.reason === 'mailboxHasEmail' && !removeEmails) {
      deleteStage.value = 'escalate';
      void nextTick(() => virtualizer.value.measure());
    } else {
      editorError.value = describeFolderOpFailure(result.reason);
      deleteStage.value = null;
    }
  } finally {
    editorBusy.value = false;
  }
}

function describeFolderOpFailure(reason?: string): string {
  switch (reason) {
    case 'duplicateName':
      return 'A folder with that name already exists here.';
    case 'mailboxHasChild':
      return 'Move or delete its subfolders first.';
    case 'forbidden':
      return 'You do not have permission to do that.';
    case 'parentLoop':
      return 'A folder cannot be moved into itself.';
    case 'overQuota':
      return 'This account has reached its folder limit. Delete some folders to make room.';
    case 'tooDeep':
      return 'Folders cannot be nested this deeply. Choose a parent closer to the top level.';
    default:
      return `Could not update the folder${reason ? ` (${reason})` : ''}.`;
  }
}

function editedMessageCount(row: DialogFolderRow): number {
  return Number(row.folder.total_emails ?? 0);
}

// Escape must close the dialog even when focus has drifted to <body>
// (e.g. after a toggled control is briefly disabled while its mutation
// is in flight), so listen at the window level instead of relying on
// bubbling from a focused descendant. An open row editor, bulk
// confirmation, or nested create dialog swallows the first Escape.
function onWindowKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (showCreateDialog.value) {
    // FolderCreateDialog has its own window listener that closes it.
    return;
  }
  if (editingFolderId.value != null) {
    closeEditor();
    return;
  }
  if (bulkStage.value != null) {
    bulkStage.value = null;
    return;
  }
  emit('close');
}

onMounted(() => {
  closeButtonEl.value?.focus();
  window.addEventListener('keydown', onWindowKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown);
});
</script>

<template>
  <!--
    Teleported to <body>: the sidebar column animates with a CSS
    transform, which would otherwise become the containing block for
    this fixed-position overlay and squeeze the dialog into the
    sidebar's width.
  -->
  <Teleport to="body">
  <div class="folder-subs" role="presentation" @click.self="emit('close')">
    <section
      class="folder-subs__panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="folder-subs-title"
    >
      <header class="folder-subs__header">
        <h2 id="folder-subs-title">Manage Folders</h2>
        <button
          ref="closeButtonEl"
          type="button"
          class="folder-subs__close"
          aria-label="Close manage folders"
          @click="emit('close')"
        >
          <X :size="18" :stroke-width="2" aria-hidden="true" />
        </button>
      </header>
      <p class="folder-subs__hint">
        Drag a folder to move it, or select several to delete them.
      </p>
      <div class="folder-subs__search">
        <input
          v-model="searchText"
          type="search"
          class="folder-subs__search-input"
          placeholder="Search folders"
          aria-label="Search folders"
        />
      </div>
      <div ref="scrollEl" class="folder-subs__body">
        <div
          class="folder-subs__spacer"
          :style="{ height: `${totalSize}px` }"
        >
          <div
            v-for="{ virtualRow, item } in renderedItems"
            :key="String(virtualRow.key)"
            :ref="measureElement"
            :data-index="virtualRow.index"
            class="folder-subs__item"
            :style="{ transform: `translateY(${virtualRow.start}px)` }"
          >
            <h3
              v-if="item.kind === 'header'"
              class="folder-subs__account-name"
            >
              <!-- Search results are flat and ignore collapse, so no
                   chevron while filtering. -->
              <button
                v-if="item.section.isOwn && !searching"
                type="button"
                class="folder-subs__collapse"
                :class="{ 'is-collapsed': !isSystemBlockExpanded(item.section) }"
                :aria-expanded="isSystemBlockExpanded(item.section)"
                :aria-label="isSystemBlockExpanded(item.section)
                  ? 'Collapse default folders'
                  : 'Expand default folders'"
                data-account-toggle
                @click="toggleSystemBlock(item.section)"
              >
                <ChevronRight :size="14" :stroke-width="2" aria-hidden="true" />
              </button>
              {{ item.section.label }}
              <span v-if="!item.section.isOwn" class="folder-subs__badge">shared</span>
            </h3>
            <div
              v-else-if="item.kind === 'root'"
              class="folder-subs__root"
              :class="{
                'is-drop-target': dropTargetKey === `r-${item.section.account.id}`,
                'is-droppable': dragFolderId != null && canDropOnSection(item.section),
              }"
              data-folder-root
              @dragover="onSectionDragOver(item.section, $event)"
              @dragleave="onDragLeave(`r-${item.section.account.id}`)"
              @drop.prevent="onSectionDrop(item.section)"
            >
              <FolderRoot :size="15" :stroke-width="1.75" aria-hidden="true" />
              <span class="folder-subs__root-label">Top Level</span>
              <span
                v-if="dragFolderId != null && canDropOnSection(item.section)"
                class="folder-subs__drop-hint"
              >drop here to move to top level</span>
              <button
                type="button"
                class="folder-subs__root-add"
                data-folder-new
                aria-label="New folder"
                title="New folder"
                @click="openCreateDialog(null)"
              >
                <Plus :size="15" :stroke-width="2" aria-hidden="true" />
              </button>
            </div>
            <div
              v-else
              class="folder-subs__row"
              :class="{
                'is-editing': editingFolderId === item.row.folder.id,
                'is-drop-target': dropTargetKey === `f-${item.row.folder.id}`,
                'is-dragging': dragFolderId === item.row.folder.id,
              }"
            >
              <div
                class="folder-subs__row-main"
                :style="{ paddingLeft: indentPx(item.indent) }"
                :draggable="rowDraggable(item.row)"
                @dragstart="onRowDragStart(item.row, $event)"
                @dragend="onDragEnd()"
                @dragover="onRowDragOver(item.row, $event)"
                @dragleave="onDragLeave(`f-${item.row.folder.id}`)"
                @drop.prevent="onRowDrop(item.row)"
                @click="onRowModifierClick(item.section, item.row, $event)"
              >
                <!-- Search results ignore collapse state, so the
                     chevron would be a no-op while filtering. -->
                <button
                  v-if="item.row.hasChildren && !searching"
                  type="button"
                  class="folder-subs__collapse"
                  :class="{ 'is-collapsed': isRowCollapsed(item.row) }"
                  :aria-expanded="!isRowCollapsed(item.row)"
                  :aria-label="isRowCollapsed(item.row)
                    ? `Expand ${item.row.folder.name}`
                    : `Collapse ${item.row.folder.name}`"
                  :data-folder-toggle="item.row.folder.name"
                  @click="toggleRowCollapsed(item.row)"
                >
                  <ChevronRight :size="14" :stroke-width="1.75" aria-hidden="true" />
                </button>
                <span v-else class="folder-subs__collapse-spacer" aria-hidden="true" />
                <label
                  v-if="item.row.canSelect"
                  class="folder-subs__label"
                >
                  <input
                    type="checkbox"
                    class="folder-subs__checkbox"
                    :checked="selectedIds.has(item.row.folder.id)"
                    :disabled="bulkBusy"
                    :data-folder-select="item.row.folder.name"
                    :aria-label="`Select folder ${item.row.folder.name}`"
                    @click="onSelectClick(item.section, item.row, $event)"
                  />
                  <span
                    class="folder-subs__name"
                    :class="{ 'is-hidden': !item.row.subscribed }"
                  >{{ item.row.folder.name || '(unnamed)' }}</span>
                  <span
                    v-if="searching && item.row.path.length"
                    class="folder-subs__path"
                    :title="`In ${item.row.path.join(' / ')}`"
                  >{{ item.row.path.join(' / ') }}</span>
                </label>
                <span v-else class="folder-subs__label is-disabled">
                  <span class="folder-subs__checkbox-spacer" aria-hidden="true" />
                  <span
                    class="folder-subs__name"
                    :class="{ 'is-hidden': !item.row.subscribed }"
                  >{{ item.row.folder.name || '(unnamed)' }}</span>
                  <span
                    v-if="searching && item.row.path.length"
                    class="folder-subs__path"
                    :title="`In ${item.row.path.join(' / ')}`"
                  >{{ item.row.path.join(' / ') }}</span>
                </span>
                <!-- Star: client-local priority pin, no server call.
                     Sits right beside the name so the favorite marker
                     reads as part of the folder's title. -->
                <button
                  v-if="!item.row.isSystem"
                  type="button"
                  class="folder-subs__edit folder-subs__star"
                  :class="{ 'is-starred': item.row.starred }"
                  :disabled="item.row.pending || !item.row.subscribed"
                  :data-folder-star="item.row.folder.name"
                  :aria-pressed="item.row.starred"
                  :aria-label="item.row.starred
                    ? `Unstar folder ${item.row.folder.name}`
                    : `Star folder ${item.row.folder.name}`"
                  :title="item.row.starred
                    ? 'Starred — click to remove from the top of the folder list'
                    : 'Star — pin to the top of the folder list'"
                  @click="mailStore.setFolderStarred(item.row.folder.id, !item.row.starred)"
                >
                  <Star :size="14" :stroke-width="1.75" aria-hidden="true" />
                </button>
                <span class="folder-subs__row-spacer" aria-hidden="true" />
                <span v-if="item.row.pending" class="folder-subs__pending">saving…</span>
                <span
                  v-else-if="item.row.isSystem"
                  class="folder-subs__pending"
                  title="System folders are always shown in the sidebar."
                >always shown</span>
                <span
                  v-else-if="!item.row.editable"
                  class="folder-subs__pending"
                  title="You do not have permission to change the subscription for this folder."
                >read-only</span>
                <!--
                  services-ui switch, used controlled: state comes from
                  the store and the update event enqueues the mutation.
                  A switch (not an eye) because isSubscribed is a
                  per-user server setting, distinct from any future
                  client-local show/hide preference.
                -->
                <span
                  v-if="!item.row.isSystem"
                  class="folder-subs__switch-label"
                  aria-hidden="true"
                >{{ item.row.subscribed ? 'Subscribed' : 'Subscribe' }}</span>
                <SwitchToggle
                  v-if="!item.row.isSystem"
                  class="folder-subs__switch"
                  :name="`folder-sub-${item.row.folder.id}`"
                  :model-value="item.row.subscribed"
                  :disabled="item.row.pending || !item.row.editable"
                  :data-folder-name="item.row.folder.name"
                  :title="item.row.subscribed
                    ? 'Subscribed — click to unsubscribe and hide it in your mail apps'
                    : 'Unsubscribed — click to subscribe and show it in your mail apps'"
                  @update:model-value="toggleSubscription(item.section, item.row)"
                />
                <button
                  v-if="item.row.canRename || item.row.canDelete"
                  type="button"
                  class="folder-subs__edit"
                  :data-folder-edit="item.row.folder.name"
                  :aria-label="`Edit folder ${item.row.folder.name}`"
                  title="Rename, move, or delete"
                  @click="editingFolderId === item.row.folder.id ? closeEditor() : openEditor(item.row)"
                >
                  <Pencil :size="13" :stroke-width="1.75" aria-hidden="true" />
                </button>
                <!-- Last so it column-aligns with the Top Level row's +. -->
                <button
                  v-if="item.row.canCreateChild"
                  type="button"
                  class="folder-subs__edit"
                  :data-folder-add="item.row.folder.name"
                  :aria-label="`New folder in ${item.row.folder.name}`"
                  :title="`New folder in ${item.row.folder.name}`"
                  @click="openCreateDialog(item.row.folder.id)"
                >
                  <Plus :size="14" :stroke-width="1.75" aria-hidden="true" />
                </button>
              </div>

              <div
                v-if="editingFolderId === item.row.folder.id"
                class="folder-subs__editor"
              >
                <template v-if="deleteStage == null">
                  <label class="folder-subs__editor-field">
                    <span>Name</span>
                    <input
                      v-model="editorName"
                      type="text"
                      class="folder-subs__editor-input"
                      :disabled="!item.row.canRename || editorBusy"
                      data-folder-rename-input
                      @keydown.enter.prevent="saveEditor(item.row)"
                    />
                  </label>
                  <label class="folder-subs__editor-field">
                    <span>Parent</span>
                    <select
                      v-model="editorParentId"
                      class="folder-subs__editor-input"
                      :disabled="!item.row.canRename || editorBusy"
                      data-folder-move-select
                    >
                      <option
                        v-for="option in editorParentOptions"
                        :key="option.id ?? 'root'"
                        :value="option.id"
                      >{{ option.label }}</option>
                    </select>
                  </label>
                  <p v-if="editorError" class="folder-subs__editor-error">{{ editorError }}</p>
                  <div class="folder-subs__editor-actions">
                    <button
                      v-if="item.row.canDelete"
                      type="button"
                      class="folder-subs__btn folder-subs__btn--danger"
                      :disabled="editorBusy"
                      data-folder-delete
                      @click="requestDelete(item.row)"
                    >Delete…</button>
                    <span class="folder-subs__editor-spacer" />
                    <button
                      type="button"
                      class="folder-subs__btn"
                      :disabled="editorBusy"
                      @click="closeEditor()"
                    >Cancel</button>
                    <button
                      type="button"
                      class="folder-subs__btn folder-subs__btn--primary"
                      :disabled="!item.row.canRename || editorBusy"
                      data-folder-save
                      @click="saveEditor(item.row)"
                    >Save</button>
                  </div>
                </template>
                <template v-else>
                  <p class="folder-subs__editor-confirm">
                    <template v-if="deleteStage === 'confirm'">
                      Delete “{{ item.row.folder.name }}”?
                      <template v-if="editedMessageCount(item.row) > 0">
                        It contains {{ editedMessageCount(item.row) }}
                        message{{ editedMessageCount(item.row) === 1 ? '' : 's' }}.
                      </template>
                    </template>
                    <template v-else>
                      “{{ item.row.folder.name }}” still contains mail.
                      Deleting it will <strong>permanently delete</strong> any message
                      not filed in another folder.
                    </template>
                  </p>
                  <p v-if="editorError" class="folder-subs__editor-error">{{ editorError }}</p>
                  <div class="folder-subs__editor-actions">
                    <span class="folder-subs__editor-spacer" />
                    <button
                      type="button"
                      class="folder-subs__btn"
                      :disabled="editorBusy"
                      @click="deleteStage = null"
                    >Cancel</button>
                    <button
                      type="button"
                      class="folder-subs__btn folder-subs__btn--danger"
                      :disabled="editorBusy"
                      data-folder-delete-confirm
                      @click="requestDelete(item.row)"
                    >{{ deleteStage === 'escalate' ? 'Delete permanently' : 'Delete' }}</button>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div>
        <p v-if="items.length === 0" class="folder-subs__hint">
          {{ searchText.trim() ? 'No folders match your search.' : 'No folders yet.' }}
        </p>
      </div>
      <footer
        v-if="selectedCount > 0"
        class="folder-subs__bulkbar"
        data-folder-bulkbar
      >
        <template v-if="bulkStage == null">
          <span class="folder-subs__bulk-count">{{ selectedCount }} selected</span>
          <p v-if="bulkError" class="folder-subs__editor-error">{{ bulkError }}</p>
          <span class="folder-subs__editor-spacer" />
          <button
            type="button"
            class="folder-subs__edit"
            :disabled="bulkBusy || bulkStarDisabled"
            data-bulk-star
            :aria-label="bulkStarAction ? 'Star selected folders' : 'Unstar selected folders'"
            :title="bulkStarAction ? 'Star selected folders' : 'Unstar selected folders'"
            @click="bulkToggleStarred()"
          >
            <Star v-if="bulkStarAction" :size="14" :stroke-width="1.75" aria-hidden="true" />
            <StarOff v-else :size="14" :stroke-width="1.75" aria-hidden="true" />
          </button>
          <!-- The same switch component as the rows: on = something in
               the selection is subscribed, and flipping it applies the
               modal action (unsubscribe all / subscribe all). -->
          <SwitchToggle
            class="folder-subs__switch"
            name="folder-bulk-subscribe"
            :model-value="!bulkSubscribeAction"
            :disabled="bulkBusy || !selectedRows().some((row) => row.editable)"
            data-bulk-subscribe
            :title="bulkSubscribeAction
              ? 'Subscribe to selected folders'
              : 'Unsubscribe from selected folders'"
            @update:model-value="bulkToggleSubscription()"
          />
          <button
            type="button"
            class="folder-subs__edit folder-subs__edit--danger"
            :disabled="bulkBusy || bulkDeleteDisabled"
            data-folder-bulk-delete
            aria-label="Delete selected folders"
            title="Delete selected folders"
            @click="requestBulkDelete()"
          >
            <Trash2 :size="14" :stroke-width="1.75" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="folder-subs__edit"
            :disabled="bulkBusy"
            data-folder-bulk-clear
            aria-label="Clear selection"
            title="Clear selection"
            @click="clearSelection()"
          >
            <X :size="14" :stroke-width="1.75" aria-hidden="true" />
          </button>
        </template>
        <template v-else-if="bulkStage === 'confirm'">
          <p class="folder-subs__bulk-confirm">
            Delete {{ selectedCount }} folder{{ selectedCount === 1 ? '' : 's' }}?
            <template v-if="selectedMessageCount > 0">
              {{ selectedCount === 1 ? 'It contains' : 'They contain' }}
              {{ selectedMessageCount }}
              message{{ selectedMessageCount === 1 ? '' : 's' }}.
            </template>
          </p>
          <span class="folder-subs__editor-spacer" />
          <button
            type="button"
            class="folder-subs__btn"
            :disabled="bulkBusy"
            @click="bulkStage = null"
          >Cancel</button>
          <button
            type="button"
            class="folder-subs__btn folder-subs__btn--danger"
            :disabled="bulkBusy"
            data-folder-bulk-confirm
            @click="runBulkDelete(false)"
          >Delete</button>
        </template>
        <template v-else>
          <p class="folder-subs__bulk-confirm">
            {{ selectedCount }} folder{{ selectedCount === 1 ? ' still contains' : 's still contain' }}
            mail. Deleting will <strong>permanently delete</strong> any message
            not filed in another folder.
          </p>
          <span class="folder-subs__editor-spacer" />
          <button
            type="button"
            class="folder-subs__btn"
            :disabled="bulkBusy"
            @click="bulkStage = null"
          >Cancel</button>
          <button
            type="button"
            class="folder-subs__btn folder-subs__btn--danger"
            :disabled="bulkBusy"
            data-folder-bulk-confirm
            @click="runBulkDelete(true)"
          >Delete permanently</button>
        </template>
      </footer>
    </section>
  </div>
  </Teleport>
  <FolderCreateDialog
    v-if="showCreateDialog"
    :initial-parent-id="createParentId"
    @close="showCreateDialog = false"
  />
</template>

<style scoped>
.folder-subs {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  padding: 16px;
  background: color-mix(in srgb, #000 55%, transparent);
}
.folder-subs__panel {
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr) auto;
  width: min(560px, 100%);
  /* Fit the content (collapsed trees keep it short) but never exceed
     80% of the viewport — past that the folder list scrolls. The
     calc() keeps it inside the overlay's 16px padding on short
     windows. */
  max-height: min(80vh, calc(100vh - 32px));
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--panel);
  color: var(--text);
  box-shadow: 0 24px 60px color-mix(in srgb, #000 40%, transparent);
}
/* Single-column mobile: use the whole screen as a sheet. */
@media (max-width: 639px) {
  .folder-subs {
    padding: 0;
  }
  .folder-subs__panel {
    width: 100%;
    height: 100%;
    border: 0;
    border-radius: 0;
  }
}
.folder-subs__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 16px 18px 8px;
}
.folder-subs__header h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}
.folder-subs__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.folder-subs__close:hover,
.folder-subs__close:focus-visible {
  background: var(--rowHover);
  border-color: var(--border);
  color: var(--text);
  outline: none;
}
.folder-subs__hint {
  margin: 0;
  padding: 0 18px 10px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
}
.folder-subs__search {
  padding: 0 18px 10px;
}
.folder-subs__search-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
}
.folder-subs__search-input:focus-visible {
  outline: none;
  border-color: var(--accent);
}
.folder-subs__body {
  min-height: 0;
  overflow-y: auto;
  /* Long or deeply nested folder names must ellipsize, never widen
     the panel into a horizontal scrollbar. */
  overflow-x: hidden;
  padding: 0 12px 14px;
}
.folder-subs__spacer {
  position: relative;
  width: 100%;
}
.folder-subs__item {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
}
.folder-subs__account-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 12px 6px 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  border-radius: 8px;
}
/* The visual tree root: anchors the hierarchy and is the drop target
   for moving a folder back to the top level. */
.folder-subs__root {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px 5px 8px;
  border: 1px dashed transparent;
  border-radius: 8px;
  color: var(--muted);
  font-size: 12.5px;
}
.folder-subs__root svg { flex-shrink: 0; }
/* Same header treatment as .folder-subs__account-name so the two
   top-level group labels read consistently. */
.folder-subs__root-label {
  font-size: 12px;
  font-weight: 600;
}
/* Create button, pinned to the row's right edge. Same treatment as the
   per-row pencil buttons. */
.folder-subs__root-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  margin-left: auto;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.folder-subs__root-add:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--text);
}
/* Light up as soon as a drag could land here, brighter while hovered. */
.folder-subs__root.is-droppable {
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  color: var(--text);
}
.folder-subs__root.is-drop-target {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border-color: var(--accent);
  color: var(--text);
}
.folder-subs__drop-hint {
  font-size: 10px;
  font-weight: 400;
  color: var(--accent);
}
.folder-subs__badge {
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
  font-size: 10px;
}
.folder-subs__row {
  border-radius: 8px;
}
.folder-subs__row:hover,
.folder-subs__row.is-editing { background: var(--rowHover); }
.folder-subs__row.is-drop-target {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  outline: 1px dashed var(--accent);
  outline-offset: -1px;
}
.folder-subs__row.is-dragging { opacity: 0.45; }
.folder-subs__row-main {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 6px;
}
.folder-subs__row-main[draggable='true'] { cursor: grab; }
.folder-subs__collapse {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.folder-subs__collapse:hover,
.folder-subs__collapse:focus-visible {
  background: color-mix(in srgb, var(--text) 10%, transparent);
  color: var(--text);
  outline: none;
}
/* Same affordance as the sidebar: chevron points right when
   collapsed, rotates down when expanded. display: block kills the
   inline baseline slack that pushed the icon off-center. */
.folder-subs__collapse svg {
  display: block;
  transition: transform 0.12s ease;
  transform: rotate(90deg);
}
.folder-subs__collapse.is-collapsed svg { transform: rotate(0deg); }
.folder-subs__collapse-spacer {
  flex-shrink: 0;
  width: 18px;
}
.folder-subs__label {
  display: flex;
  align-items: center;
  gap: 10px;
  /* Sized to the name so the star sits right beside it; shrinks (and
     ellipsizes) before the controls on the right do. */
  flex: 0 1 auto;
  min-width: 0;
  /* Indentation is on the row; keep the checkbox snug against the
     chevron (row gap 4px + 2px here). */
  padding: 6px 0 6px 2px;
  cursor: pointer;
  font-size: 13px;
}
/* Absorbs the slack between the name/star group and the subscription
   and edit controls pinned at the row's right edge. */
.folder-subs__row-spacer {
  flex: 1;
}
.folder-subs__label.is-disabled {
  cursor: default;
  color: var(--muted);
}
.folder-subs__checkbox {
  flex-shrink: 0;
  width: 15px;
  height: 15px;
  /* Firefox gives checkboxes an asymmetric default margin that skews
     both the gap to the chevron and the vertical centring. */
  margin: 0;
  accent-color: var(--accent);
}
.folder-subs__checkbox-spacer {
  flex-shrink: 0;
  width: 15px;
  height: 15px;
}
.folder-subs__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Hidden (unsubscribed) folders read as inactive, not just eye-off. */
.folder-subs__name.is-hidden {
  color: var(--muted);
}
/* Ancestor breadcrumb shown next to search matches, so a hit deep in
   the tree isn't a context-free floating name. */
.folder-subs__path {
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 11px;
}
.folder-subs__pending {
  flex-shrink: 0;
  color: var(--muted);
  font-size: 11px;
}
.folder-subs__switch {
  flex-shrink: 0;
  /* The track is a solid block flush with its box, while the +/pencil
     glyphs sit inset ~5px inside transparent 24px hover boxes. Even
     out the ink gaps at ~10px: pad the switch slightly, and pull
     consecutive icon buttons together to cancel their double inset. */
  margin-right: 1px;
}
/* "Subscribe" caption in front of the row switch. */
.folder-subs__switch-label {
  flex-shrink: 0;
  color: var(--muted);
  font-size: 11px;
  margin-right: 2px;
}
.folder-subs__edit + .folder-subs__edit {
  margin-left: -5px;
}
/* Starred state: filled gold star, matching the 'important' role tone.
   Unstarred stays the muted outline like its sibling icon buttons. */
.folder-subs__star.is-starred {
  color: #f9ab00;
}
.folder-subs__star.is-starred svg {
  fill: currentColor;
}
/* services-ui's stock switch is 40x24px — settings-page scale. Shrink
   it to fit these dense rows. The checked translate must match the new
   geometry: track 32px - 2px margins each side - 14px handle = 14px. */
.folder-subs__switch :deep(.toggle-container .toggle) {
  width: 2rem;
  height: 1.25rem;
}
.folder-subs__switch :deep(.toggle .toggle-handle) {
  width: 0.875rem;
  height: 0.875rem;
}
.folder-subs__switch :deep(.toggle .toggle-handle .toggle-icon-on) {
  width: 0.5rem;
  height: 0.5rem;
}
.folder-subs__switch :deep(.toggle .toggle-input:checked ~ .toggle-handle) {
  transform: translate(0.875rem);
}
.folder-subs__edit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.folder-subs__edit:hover,
.folder-subs__edit:focus-visible {
  background: color-mix(in srgb, var(--text) 10%, transparent);
  color: var(--text);
  outline: none;
}
.folder-subs__edit:disabled {
  opacity: 0.5;
  cursor: default;
}
/* Destructive icon button (bulk delete): red at rest and on hover. */
.folder-subs__edit--danger {
  color: #d93025;
}
.folder-subs__edit--danger:hover,
.folder-subs__edit--danger:focus-visible {
  background: color-mix(in srgb, #d93025 10%, transparent);
  color: #d93025;
}
.folder-subs__editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 6px 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}
.folder-subs__editor-field {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--muted);
}
.folder-subs__editor-field > span {
  flex-shrink: 0;
  width: 60px;
}
.folder-subs__editor-input {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
}
.folder-subs__editor-input:focus-visible {
  outline: none;
  border-color: var(--accent);
}
.folder-subs__editor-error {
  margin: 0;
  font-size: 12px;
  color: #d93025;
}
.folder-subs__editor-confirm {
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
}
.folder-subs__editor-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.folder-subs__editor-spacer { flex: 1; }
.folder-subs__bulkbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 18px;
  border-top: 1px solid var(--border);
}
.folder-subs__bulk-count {
  font-size: 13px;
  font-weight: 600;
}
.folder-subs__bulk-confirm {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.4;
}
.folder-subs__btn {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  flex-shrink: 0;
}
.folder-subs__btn:hover:not(:disabled) { background: var(--rowHover); }
.folder-subs__btn:disabled { opacity: 0.55; cursor: default; }
.folder-subs__btn--primary {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}
.folder-subs__btn--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 88%, #000);
}
.folder-subs__btn--danger {
  border-color: color-mix(in srgb, #d93025 55%, transparent);
  color: #d93025;
}
.folder-subs__btn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, #d93025 10%, transparent);
}
</style>
