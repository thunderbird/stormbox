<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import {
  Bold,
  Check,
  Code,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Subscript,
  Superscript,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  Underline,
  Undo2,
} from '@lucide/vue';
import DOMPurify from 'dompurify';
import Squire from 'squire-rte';

import {
  RECIPIENT_FIELDS,
  useComposeStore,
  type RecipientEntry,
  type RecipientField,
} from '../stores/compose-store';
import { getRepositoryAsync } from '../composables/useRepository';
import { useAuthStore } from '../stores/auth-store';
import { useContactsStore } from '../stores/contacts-store';
import { COMPOSE_STATE } from '../constants/states';
import type { ContactListRow, IdentityRow } from '../types/db';
import { senderAvatarStyle, senderInitials } from '../utils/sender-avatar';
import AppButton from './AppButton.vue';
import AppDropdown from './AppDropdown.vue';
import RecipientInput from './RecipientInput.vue';

const composeStore = useComposeStore();
const authStore = useAuthStore();
const contactsStore = useContactsStore();

const editorEl = ref(null);
const toolbarEl = ref(null);
const toolbarState = ref({
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  subscript: false,
  superscript: false,
  code: false,
  link: false,
  unorderedList: false,
  orderedList: false,
  quote: false,
  canUndo: false,
  canRedo: false,
  fontFamily: '',
  fontSize: '',
  textColor: '#e5e7eb',
  highlightColor: '#fef3c7',
  direction: 'ltr',
});
const visibleToolbarGroups = ref(['style', 'font', 'insert', 'lists', 'alignment']);

let squire = null;
let lastSelection = null;
let toolbarResizeObserver = null;
let isResizingImage = false;
const toolbarGroupWidths = new Map();

const defaultTextColor = '#e5e7eb';
const defaultHighlightColor = '#fef3c7';
const toolbarGroupOrder = ['style', 'font', 'insert', 'lists', 'alignment'];
const blockElementNames = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIGURE',
  'FIGCAPTION',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'LI',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);
const fontOptions = [
  { label: 'Sans', value: 'Arial, sans-serif' },
  { label: 'Serif', value: 'Georgia, serif' },
  { label: 'Mono', value: '"Courier New", monospace' },
  { label: 'Verdana', value: 'Verdana, sans-serif' },
  { label: 'Times', value: '"Times New Roman", serif' },
];
const fontSizeOptions = [
  { label: 'Small', value: '12px' },
  { label: 'Normal', value: '14px' },
  { label: 'Large', value: '18px' },
  { label: 'Huge', value: '24px' },
];
// The menus offer "Default" as a choice; the buttons name themselves
// while nothing is chosen, so the two dropdowns stay distinguishable.
const fontFamilyChoices = [{ label: 'Default', value: '' }, ...fontOptions];
const fontSizeChoices = [{ label: 'Default', value: '' }, ...fontSizeOptions];
const alignmentOptions = [
  { label: 'Align left', value: 'left', icon: TextAlignStart },
  { label: 'Align center', value: 'center', icon: TextAlignCenter },
  { label: 'Align right', value: 'right', icon: TextAlignEnd },
  { label: 'Align justify', value: 'justify', icon: TextAlignJustify },
];

function isToolbarGroupVisible(group) {
  return visibleToolbarGroups.value.includes(group);
}

function syncDraftFromEditor() {
  if (!squire || !editorEl.value) return;
  composeStore.draft.htmlBody = squire.getHTML();
  composeStore.draft.textBody = editorEl.value.innerText;
}

function rememberSelection() {
  if (!squire) return;
  try {
    lastSelection = squire.getSelection().cloneRange();
  } catch {
    lastSelection = null;
  }
}

function restoreSelection() {
  if (!squire || !lastSelection) return;
  try {
    squire.setSelection(lastSelection);
  } catch {
    lastSelection = null;
  }
}

function normalizeColor(value, fallback) {
  if (/^#[0-9a-f]{6}$/i.test(value || '')) return value;

  const rgb = (value || '').match(/^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/i);
  if (!rgb) return fallback;

  return rgb
    .slice(1)
    .map((channel) => Number(channel).toString(16).padStart(2, '0'))
    .join('')
    .replace(/^/, '#');
}

function normalizeFontFamily(value) {
  const firstFamily = (value || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();
  return fontOptions.find((option) => {
    const optionFamily = option.value.split(',')[0].replace(/["']/g, '').trim().toLowerCase();
    return optionFamily === firstFamily;
  })?.value || '';
}

function pathHasFormat(path, tag) {
  return new RegExp(`(?:^|>)${tag}(?:$|[.#\\[])`).test(path) || new RegExp(`(?:^|>)${tag}(?:>|$)`).test(path);
}

function stateForFormat(tag, path, range) {
  if (path && path !== '(selection)') {
    return pathHasFormat(path, tag);
  }
  return !!range && squire.hasFormat(tag, null, range);
}

function updateToolbarState(pathOverride = null) {
  if (!squire) return;

  let range = null;
  try {
    range = squire.getSelection();
  } catch {
    // Selection may be unavailable mid-update; fall through with range=null.
  }

  const path = pathOverride ?? squire.getPath();
  const fontInfo = range ? squire.getFontInfo(range) : {};
  toolbarState.value = {
    ...toolbarState.value,
    bold: stateForFormat('B', path, range),
    italic: stateForFormat('I', path, range),
    underline: stateForFormat('U', path, range),
    strikethrough: stateForFormat('S', path, range),
    subscript: stateForFormat('SUB', path, range),
    superscript: stateForFormat('SUP', path, range),
    code: stateForFormat('CODE', path, range) || stateForFormat('PRE', path, range),
    link: stateForFormat('A', path, range),
    unorderedList: /(?:^|>)UL/.test(path),
    orderedList: /(?:^|>)OL/.test(path),
    quote: /(?:^|>)BLOCKQUOTE/.test(path),
    fontFamily: normalizeFontFamily(fontInfo.fontFamily),
    fontSize: fontInfo.fontSize || '',
    textColor: normalizeColor(fontInfo.color, toolbarState.value.textColor || defaultTextColor),
    highlightColor: normalizeColor(
      fontInfo.backgroundColor,
      toolbarState.value.highlightColor || defaultHighlightColor,
    ),
    direction: /\[dir=rtl\]/.test(path) ? 'rtl' : 'ltr',
  };
}

function syncEditorState() {
  syncDraftFromEditor();
  rememberSelection();
  updateToolbarState();
}

function handleEditorInput() {
  // Squire's image resizer mutates the <img> on every pointermove, which
  // fires 'input'. syncDraftFromEditor() reads squire.getHTML(), and
  // getHTML() momentarily removes and re-adds Squire's resize-handle
  // container — which releases the in-flight pointer capture and freezes
  // the drag after a single step. Skip the per-mutation sync while a
  // resize handle is being dragged; we sync once when the drag ends.
  if (isResizingImage) return;
  syncEditorState();
}

function handleResizeHandlePointerDown(event: PointerEvent) {
  const target = event.target as Element | null;
  if (target?.closest?.('.squire-resize-handle')) {
    isResizingImage = true;
  }
}

function handleResizeHandlePointerUp() {
  if (!isResizingImage) return;
  isResizingImage = false;
  syncEditorState();
}

function handlePathChange() {
  rememberSelection();
  updateToolbarState();
}

function handleSquirePathChange(event) {
  rememberSelection();
  updateToolbarState(event.detail?.path ?? null);
}

function handleUndoStateChange(event) {
  toolbarState.value = {
    ...toolbarState.value,
    canUndo: !!event.detail?.canUndo,
    canRedo: !!event.detail?.canRedo,
  };
}

function runEditorCommand(command: (editor: any) => void, { restore = true } = {}) {
  if (!squire) return;
  if (restore) {
    squire.focus();
    restoreSelection();
  }
  ensureEditorBlocks();
  command(squire);
  syncDraftFromEditor();
  rememberSelection();
  updateToolbarState();
  if (restore) {
    squire.focus();
  }
}

function toggleFormat(tag: string, remove: any = null, options?: any) {
  runEditorCommand((editor: any) => {
    const range = editor.getSelection();
    toggleFormatInRange(editor, tag, remove, range);
  }, options);
}

function toggleFormatInRange(editor: any, tag: string, remove: any = null, range: any = editor.getSelection()) {
  ensureEditorBlocks();
  if (editor.hasFormat(tag, null, range)) {
    editor.changeFormat(null, { tag }, range);
  } else {
    editor.changeFormat({ tag }, remove, range);
  }
}

function isBlockNode(node) {
  return node.nodeType === Node.ELEMENT_NODE && blockElementNames.has(node.nodeName);
}

function shouldWrapRootChild(node) {
  if (isBlockNode(node)) return false;
  if (node.nodeType === Node.TEXT_NODE) return node.data.length > 0;
  return node.nodeType === Node.ELEMENT_NODE;
}

function ensureEditorBlocks() {
  if (!squire) return;

  const root = squire.getRoot();
  let wrapper = null;
  Array.from(root.childNodes).forEach((child) => {
    if (!shouldWrapRootChild(child)) {
      wrapper = null;
      return;
    }

    if (!wrapper) {
      wrapper = document.createElement('div');
      root.insertBefore(wrapper, child);
    }
    wrapper.appendChild(child);
  });
}

function toggleList(type: 'UL' | 'OL') {
  runEditorCommand((editor: any) => {
    const path = editor.getPath();
    const tag = type === 'UL' ? 'UL' : 'OL';
    const inList = new RegExp(`(?:^|>)${tag}`).test(path);
    if (inList) {
      editor.removeList();
    } else if (type === 'UL') {
      editor.makeUnorderedList();
    } else {
      editor.makeOrderedList();
    }
  });
}

/**
 * Quote or unquote the selection. In HTML mail the blockquote is the
 * quoting element — the one other clients draw with the vertical bar —
 * and it is distinct from list nesting, which Squire's own Tab and
 * Shift+Tab handle inside a list. The buttons are purely about quoting,
 * the way Fastmail's Squire toolbar exposes the same commands.
 */
function adjustQuote(delta: number) {
  runEditorCommand((editor: any) => {
    if (delta > 0) editor.increaseQuoteLevel();
    else editor.decreaseQuoteLevel();
  });
}

function applyFontFace(value: string) {
  runEditorCommand((editor: any) => editor.setFontFace(value || null));
}

function applyFontSize(value: string) {
  runEditorCommand((editor: any) => editor.setFontSize(value || null));
}

const fontFamilyLabel = computed(() =>
  fontOptions.find((font) => font.value === toolbarState.value.fontFamily)?.label ?? 'Font');
const fontSizeLabel = computed(() =>
  fontSizeOptions.find((size) => size.value === toolbarState.value.fontSize)?.label ?? 'Size');

/**
 * Close the <details> dropdown a picked item belongs to. A single-choice
 * menu that stays open after the choice reads as a menu that did not
 * work; <details> provides no close-on-activate of its own.
 */
function closeDropdown(event: Event) {
  const details = (event.currentTarget as HTMLElement).closest('details');
  if (details) details.open = false;
}

function pickFontFace(value: string, event: Event) {
  closeDropdown(event);
  applyFontFace(value);
}

function pickFontSize(value: string, event: Event) {
  closeDropdown(event);
  applyFontSize(value);
}

function applyTextColor(value: string) {
  runEditorCommand((editor: any) => editor.setTextColor(value || null));
}

function applyHighlightColor(value: string) {
  runEditorCommand((editor: any) => editor.setHighlightColor(value || null));
}

function promptForLink() {
  if (!squire) return;
  restoreSelection();
  const selectedText = squire.getSelectedText().trim();
  const initialValue = /^https?:\/\//i.test(selectedText) || /^mailto:/i.test(selectedText) ? selectedText : '';
  const url = window.prompt('Enter link URL', initialValue);
  if (url === null) return;

  const trimmed = url.trim();
  runEditorCommand((editor) => {
    if (trimmed) {
      editor.makeLink(trimmed);
    } else {
      editor.removeLink();
    }
  });
}

function promptForImage() {
  const src = window.prompt('Enter image URL');
  if (src === null || !src.trim()) return;

  const alt = window.prompt('Image alt text', '') ?? '';
  runEditorCommand((editor) => editor.insertImage(src.trim(), { alt }));
}

// Pasted images are inlined as data: URLs for an instant, offline-safe
// draft. The send pipeline (runSend) later uploads them as JMAP blobs
// and rewrites them to cid: inline attachments so recipients see them.
const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024;

function insertPastedImageFile(file: File | null) {
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > MAX_PASTED_IMAGE_BYTES) {
    console.warn('[compose] pasted image exceeds size limit; skipping', file.size);
    return;
  }
  // Capture the caret before the async read so the image lands where the
  // user pasted rather than wherever the selection drifts to.
  rememberSelection();
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = typeof reader.result === 'string' ? reader.result : '';
    if (!dataUrl.startsWith('data:image/')) return;
    runEditorCommand((editor: any) => {
      editor.insertImage(dataUrl, { style: 'max-width:100%;height:auto;' });
      // Centre by default via the containing block's text-align rather
      // than the image's own margin, so the toolbar alignment buttons
      // (which set block text-align) can re-align the image afterwards.
      // text-align centering also survives Outlook, unlike margin:auto.
      editor.setTextAlignment('center');
    });
  };
  reader.readAsDataURL(file);
}

// Squire fires 'pasteImage' for image-only clipboard payloads (it has
// already called preventDefault), handing us the ClipboardData so we can
// inline the bitmap ourselves.
function handlePasteImage(event: any) {
  const clipboardData = event?.detail?.clipboardData;
  const items = clipboardData?.items ? Array.from(clipboardData.items) : [];
  const imageItem = items.find(
    (item: any) => item?.kind === 'file' && typeof item?.type === 'string' && item.type.startsWith('image/'),
  ) as any;
  insertPastedImageFile(imageItem?.getAsFile?.() ?? null);
}

function syncAfterKeyboardCommand(editor, range = null) {
  ensureEditorBlocks();
  syncDraftFromEditor();
  if (range) {
    lastSelection = range.cloneRange();
  } else {
    rememberSelection();
  }
  updateToolbarState();
}

function registerKeyboardShortcut(key: string, command: (editor: any, range?: any) => void) {
  squire.setKeyHandler(key, (editor: any, event: KeyboardEvent, range: any) => {
    event.preventDefault();
    command(editor, range);
    syncAfterKeyboardCommand(editor, range);
  });
}

function registerKeyboardShortcuts() {
  ['Ctrl-b', 'Ctrl-B', 'Meta-b', 'Meta-B'].forEach((key) => registerKeyboardShortcut(
    key,
    (editor, range) => toggleFormatInRange(editor, 'B', null, range),
  ));
  ['Ctrl-i', 'Ctrl-I', 'Meta-i', 'Meta-I'].forEach((key) => registerKeyboardShortcut(
    key,
    (editor, range) => toggleFormatInRange(editor, 'I', null, range),
  ));
  ['Ctrl-u', 'Ctrl-U', 'Meta-u', 'Meta-U'].forEach((key) => registerKeyboardShortcut(
    key,
    (editor, range) => toggleFormatInRange(editor, 'U', null, range),
  ));
  ['Ctrl-z', 'Meta-z'].forEach((key) => registerKeyboardShortcut(key, (editor) => editor.undo()));
  ['Ctrl-y', 'Meta-y', 'Ctrl-Shift-z', 'Ctrl-Shift-Z', 'Meta-Shift-z', 'Meta-Shift-Z']
    .forEach((key) => registerKeyboardShortcut(key, (editor) => editor.redo()));
  ['Ctrl-k', 'Meta-k'].forEach((key) => {
    squire.setKeyHandler(key, (editor, event, range) => {
      event.preventDefault();
      lastSelection = range.cloneRange();
      promptForLink();
    });
  });
}

function elementOuterWidth(element) {
  const styles = window.getComputedStyle(element);
  const rectWidth = element.getBoundingClientRect().width || element.offsetWidth || 0;
  return rectWidth + Number.parseFloat(styles.marginLeft || '0') + Number.parseFloat(styles.marginRight || '0');
}

function updateToolbarOverflow() {
  if (!toolbarEl.value) return;

  toolbarEl.value.querySelectorAll('[data-toolbar-group]').forEach((groupEl) => {
    const group = groupEl.dataset.toolbarGroup;
    const width = elementOuterWidth(groupEl);
    if (group && width > 0) {
      toolbarGroupWidths.set(group, width);
    }
  });

  const toolbarWidth = toolbarEl.value.clientWidth || toolbarEl.value.getBoundingClientRect().width;
  if (!toolbarWidth) return;

  const moreWidth = elementOuterWidth(toolbarEl.value.querySelector('.toolbar-more')) || 70;
  const toolbarGap = 4;
  const nextVisible = [...toolbarGroupOrder];
  const widthFor = (group) => toolbarGroupWidths.get(group) ?? 0;
  const totalWidth = () =>
    moreWidth + (nextVisible.length * toolbarGap) + nextVisible.reduce((sum, group) => sum + widthFor(group), 0);

  while (nextVisible.length > 1 && totalWidth() > toolbarWidth) {
    nextVisible.pop();
  }

  if (nextVisible.join('|') !== visibleToolbarGroups.value.join('|')) {
    visibleToolbarGroups.value = nextVisible;
  }
}

function scheduleToolbarOverflowUpdate() {
  void nextTick().then(updateToolbarOverflow);
}

function ensureSquireSanitizer() {
  (window as any).DOMPurify ??= DOMPurify;
  (globalThis as any).DOMPurify ??= DOMPurify;
}

function observeToolbarSize() {
  toolbarResizeObserver?.disconnect();
  toolbarResizeObserver = null;
  if ('ResizeObserver' in window && toolbarEl.value) {
    toolbarResizeObserver = new window.ResizeObserver(scheduleToolbarOverflowUpdate);
    toolbarResizeObserver.observe(toolbarEl.value);
  }
}

function destroyEditor() {
  toolbarResizeObserver?.disconnect();
  toolbarResizeObserver = null;
  document.removeEventListener('pointerdown', handleResizeHandlePointerDown, true);
  document.removeEventListener('pointerup', handleResizeHandlePointerUp);
  document.removeEventListener('pointercancel', handleResizeHandlePointerUp);
  isResizingImage = false;
  squire?.destroy?.();
  squire = null;
  lastSelection = null;
}

function initEditor() {
  if (!editorEl.value) return;
  destroyEditor();
  ensureSquireSanitizer();
  squire = new Squire(editorEl.value);
  squire.setHTML(composeStore.draft.htmlBody || '<p><br></p>');
  registerKeyboardShortcuts();
  squire.addEventListener('input', handleEditorInput);
  squire.addEventListener('pasteImage', handlePasteImage);
  squire.addEventListener('pathChange', handleSquirePathChange);
  squire.addEventListener('select', handlePathChange);
  squire.addEventListener('cursor', handlePathChange);
  squire.addEventListener('undoStateChange', handleUndoStateChange);
  // Squire's resize handles capture the pointer; track drag start/end so
  // handleEditorInput can suppress the getHTML sync that would break it.
  // pointerdown is captured because Squire stops propagation on the handle.
  document.addEventListener('pointerdown', handleResizeHandlePointerDown, true);
  document.addEventListener('pointerup', handleResizeHandlePointerUp);
  document.addEventListener('pointercancel', handleResizeHandlePointerUp);
  updateToolbarState();
  scheduleToolbarOverflowUpdate();
  observeToolbarSize();
}

/**
 * Where writing starts for this draft: the To field when it is empty (a
 * fresh message begins with addressing), the body when recipients came
 * prefilled (a reply or forward — addressing is done, prose is next).
 * Called after the open/remount tick, so the target exists.
 */
function focusFreshDraft() {
  if (!composeStore.isOpen) return;
  if (composeStore.draft.to.length === 0) {
    document.getElementById('compose-to')?.focus();
  } else {
    squire?.focus();
  }
}

onMounted(() => {
  window.addEventListener('resize', scheduleToolbarOverflowUpdate);
  if (composeStore.isOpen) {
    void nextTick().then(() => {
      initEditor();
      focusFreshDraft();
    });
  }
});

watch(() => composeStore.isOpen, (open) => {
  if (open) {
    void nextTick().then(() => {
      initEditor();
      focusFreshDraft();
    });
  } else {
    destroyEditor();
  }
});

onUnmounted(() => {
  window.removeEventListener('resize', scheduleToolbarOverflowUpdate);
  destroyEditor();
});

// Discard and Close are withheld while the send mutation is in flight:
// the queued request payload is the only durable copy of the message, so
// erasing the draft here could lose it if the send then fails.
const isSending = computed(() => composeStore.status === COMPOSE_STATE.SENDING);

/**
 * The committed recipients of each field, as the control shows them.
 *
 * Held here rather than read from the store on render because the order the
 * two kinds appear in is the control's: a fragment stays between the
 * addresses it was typed between, which the draft does not record. The
 * store keeps what the message carries and what refuses the send.
 */
const recipientEntries = reactive<Record<RecipientField, RecipientEntry[]>>({
  to: [],
  cc: [],
  bcc: [],
});

// Cc and Bcc stay out of the way until they hold something or are asked
// for: three empty fields on every new message is the reason they were
// left out in the first place.
const showCc = ref(false);
const showBcc = ref(false);

const RECIPIENT_LABELS: Record<RecipientField, string> = { to: 'To', cc: 'Cc', bcc: 'Bcc' };

const visibleRecipientFields = computed<RecipientField[]>(() => [
  'to',
  ...(showCc.value ? (['cc'] as const) : []),
  ...(showBcc.value ? (['bcc'] as const) : []),
]);

watch(
  () => composeStore.draftEpoch,
  () => {
    for (const field of RECIPIENT_FIELDS) {
      recipientEntries[field] = composeStore.recipientEntries(field);
    }
    showCc.value = composeStore.draft.cc.length > 0;
    showBcc.value = composeStore.draft.bcc.length > 0;
    // A draft replacing the current one while the dialog is open (reply
    // taken from the message view, say) restarts writing too. No-op while
    // closed; the recipient controls remount on the epoch, hence the tick.
    void nextTick().then(focusFreshDraft);
  },
  { immediate: true },
);

function setEntries(field: RecipientField, entries: RecipientEntry[]) {
  recipientEntries[field] = entries;
  composeStore.setRecipientEntries(field, entries);
}

/** Reveal Cc or Bcc and put the cursor in it. */
function revealField(field: 'cc' | 'bcc') {
  if (field === 'cc') showCc.value = true;
  else showBcc.value = true;
  void nextTick().then(() => document.getElementById(`compose-${field}`)?.focus());
}

/**
 * A Cc or Bcc left empty collapses when focus leaves the row, so an
 * unused field is not left open. focusout bubbles from the control's
 * input to this row; relatedTarget still inside the row means focus only
 * moved between the field and its own pills, which is not leaving.
 *
 * The empty check is deferred a tick because leaving the field also
 * commits any pending text, and a committed recipient must keep the
 * field open. To never hides.
 */
function onRecipientFocusOut(field: RecipientField, event: FocusEvent) {
  if (field === 'to') return;
  const row = event.currentTarget as HTMLElement | null;
  const next = event.relatedTarget as Node | null;
  if (row && next && row.contains(next)) return;
  void nextTick().then(() => {
    if (recipientEntries[field].length > 0) return;
    if (field === 'cc') showCc.value = false;
    else showBcc.value = false;
  });
}

/**
 * Addresses this message already carries in its other fields. Offering one
 * of them again spends a row of the list on a recipient who is already on
 * the message.
 */
function takenElsewhere(field: RecipientField): string[] {
  return RECIPIENT_FIELDS
    .filter((other) => other !== field)
    .flatMap((other) => composeStore.draft[other].map((address) => address.email));
}

function queryContacts(prefix: string, limit: number, exclude: string[]) {
  return contactsStore.autocomplete(prefix, limit, exclude);
}

/**
 * The whole address book, for the browse path. The Contacts space is the
 * other place this list lives, and it is behind this dialog rather than
 * beside it, so the browse path stays in the field. No limit is passed:
 * CS-3.12 requires every contact to be selectable from the browse list.
 */
async function browseAllContacts() {
  const accountId = authStore.accountId;
  if (accountId == null) return [];
  const repo = await getRepositoryAsync();
  const contacts: ContactListRow[] = await repo.listContacts(accountId);
  return contacts
    .filter((contact) => !!contact.email)
    .map((contact) => ({
      ...(contact.display_name ? { name: contact.display_name } : {}),
      email: contact.email as string,
      source: 'contact' as const,
    }));
}

async function send() {
  await composeStore.send();
}

function pickFromIdentity(idx: number, event: Event) {
  closeDropdown(event);
  composeStore.selectFromIndex(idx);
}

function identityLabel(id: IdentityRow | null): string {
  if (!id) return '';
  return id.name ? `${id.name} <${id.email}>` : id.email;
}

/** The message list's sender circle, so one address is one color everywhere. */
function identityAvatarStyle(id: IdentityRow): Record<string, string> {
  return senderAvatarStyle(id.email);
}

function identityInitials(id: IdentityRow): string {
  return senderInitials(id.name?.trim() || id.email);
}
</script>

<template>
    <div
      v-if="composeStore.isOpen"
      class="compose-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Compose"
    >
    <div class="compose-dialog__card">
      <header>
        <h2>{{ composeStore.draft.subject || 'New Message' }}</h2>
        <button
          type="button"
          class="icon"
          :disabled="isSending"
          :title="isSending ? 'Sending — please wait' : 'Close'"
          aria-label="Close"
          @click="composeStore.close()"
        >×</button>
      </header>

      <div class="row">
        <label id="compose-from-label">From</label>
        <!-- An identity is a person with an address, so its rows wear the
             same avatar-and-two-lines dress the suggestion list and the
             message list use: one look for one kind of thing. -->
        <AppDropdown class="from-picker" data-compose-from>
          <summary
            class="app-dropdown__summary from-picker__summary"
            aria-labelledby="compose-from-label"
          >
            <span
              v-if="composeStore.fromIdentity"
              class="from-picker__avatar"
              aria-hidden="true"
              :style="identityAvatarStyle(composeStore.fromIdentity)"
            >{{ identityInitials(composeStore.fromIdentity) }}</span>
            <span class="from-picker__summary-text">
              {{ identityLabel(composeStore.fromIdentity) }}
            </span>
          </summary>
          <div class="app-dropdown__menu from-picker__menu" role="menu" aria-label="From identity">
            <button
              v-for="(id, idx) in composeStore.identities"
              :key="id.id"
              type="button"
              class="app-dropdown__item from-picker__option"
              role="menuitemradio"
              :aria-checked="idx === composeStore.draft.fromIdx"
              @click="pickFromIdentity(idx, $event)"
            >
              <span
                class="from-picker__avatar"
                aria-hidden="true"
                :style="identityAvatarStyle(id)"
              >{{ identityInitials(id) }}</span>
              <span class="from-picker__lines">
                <span v-if="id.name" class="from-picker__name">{{ id.name }}</span>
                <span class="from-picker__email" :class="{ 'from-picker__email--primary': !id.name }">
                  {{ id.email }}
                </span>
              </span>
              <Check v-if="idx === composeStore.draft.fromIdx" :size="15" class="from-picker__check" />
            </button>
          </div>
        </AppDropdown>
      </div>

      <!-- Remounted per draft: the control owns the text being typed, and a
           reply that replaces the draft has to replace that too. -->
      <div
        v-for="field in visibleRecipientFields"
        :key="field"
        class="row row--recipient"
        :class="{ 'row--to': field === 'to' }"
        @focusout="onRecipientFocusOut(field, $event)"
      >
        <label :for="`compose-${field}`">{{ RECIPIENT_LABELS[field] }}</label>
        <RecipientInput
          :key="`${field}-${composeStore.draftEpoch}`"
          :input-id="`compose-${field}`"
          :label="RECIPIENT_LABELS[field]"
          :entries="recipientEntries[field]"
          :taken="takenElsewhere(field)"
          :query="queryContacts"
          :browse-all="browseAllContacts"
          @update:entries="(entries: RecipientEntry[]) => setEntries(field, entries)"
        />
        <!-- Cc/Bcc live at the right of To, both offered at once. Each
             reveals its field; an empty field hides again on blur, so the
             toggle returns. -->
        <div v-if="field === 'to'" class="recipient-cc-toggles">
          <button
            v-if="!showCc"
            type="button"
            class="recipient-toggle"
            @click="revealField('cc')"
          >Cc</button>
          <button
            v-if="!showBcc"
            type="button"
            class="recipient-toggle"
            @click="revealField('bcc')"
          >Bcc</button>
        </div>
      </div>

      <div class="row">
        <label>Subject</label>
        <input type="text" v-model="composeStore.draft.subject" />
      </div>

      <div ref="toolbarEl" class="compose-toolbar" role="toolbar" aria-label="Rich text formatting" @pointerdown.capture="rememberSelection">
        <div v-if="isToolbarGroupVisible('style')" class="toolbar-group" data-toolbar-group="style">
          <button
            type="button"
            class="toolbar-button"
            :class="{ active: toolbarState.bold }"
            aria-label="Bold"
            title="Bold"
            @mousedown.prevent
            @click="toggleFormat('B')"
          >
            <Bold :size="15" />
          </button>
          <button
            type="button"
            class="toolbar-button"
            :class="{ active: toolbarState.italic }"
            aria-label="Italic"
            title="Italic"
            @mousedown.prevent
            @click="toggleFormat('I')"
          >
            <Italic :size="15" />
          </button>
          <button
            type="button"
            class="toolbar-button"
            :class="{ active: toolbarState.underline }"
            aria-label="Underline"
            title="Underline"
            @mousedown.prevent
            @click="toggleFormat('U')"
          >
            <Underline :size="15" />
          </button>
          <button
            type="button"
            class="toolbar-button"
            :class="{ active: toolbarState.strikethrough }"
            aria-label="Strikethrough"
            title="Strikethrough"
            @mousedown.prevent
            @click="toggleFormat('S')"
          >
            <Strikethrough :size="15" />
          </button>
        </div>

        <div v-if="isToolbarGroupVisible('font')" class="toolbar-group" data-toolbar-group="font">
          <AppDropdown class="toolbar-dropdown">
            <summary
              class="toolbar-button toolbar-more__summary"
              aria-label="Font family"
              title="Font family"
              @mousedown.prevent
            >{{ fontFamilyLabel }}</summary>
            <div class="toolbar-more__menu" role="menu" aria-label="Font family">
              <button
                v-for="font in fontFamilyChoices"
                :key="font.value"
                type="button"
                class="toolbar-menu-button"
                role="menuitemradio"
                :aria-checked="toolbarState.fontFamily === font.value"
                @mousedown.prevent
                @click="pickFontFace(font.value, $event)"
              >
                <Check v-if="toolbarState.fontFamily === font.value" :size="15" />
                <span v-else aria-hidden="true" />
                <span :style="font.value ? { fontFamily: font.value } : undefined">{{ font.label }}</span>
              </button>
            </div>
          </AppDropdown>
          <AppDropdown class="toolbar-dropdown">
            <summary
              class="toolbar-button toolbar-more__summary"
              aria-label="Font size"
              title="Font size"
              @mousedown.prevent
            >{{ fontSizeLabel }}</summary>
            <div class="toolbar-more__menu" role="menu" aria-label="Font size">
              <button
                v-for="size in fontSizeChoices"
                :key="size.value"
                type="button"
                class="toolbar-menu-button"
                role="menuitemradio"
                :aria-checked="toolbarState.fontSize === size.value"
                @mousedown.prevent
                @click="pickFontSize(size.value, $event)"
              >
                <Check v-if="toolbarState.fontSize === size.value" :size="15" />
                <span v-else aria-hidden="true" />
                <span>{{ size.label }}</span>
              </button>
            </div>
          </AppDropdown>
          <label class="toolbar-color" title="Text color">
            <span>A</span>
            <input
              type="color"
              :value="toolbarState.textColor"
              aria-label="Text color"
              @mousedown="rememberSelection"
              @input="applyTextColor(($event.target as HTMLInputElement | HTMLSelectElement).value)"
            />
          </label>
          <label class="toolbar-color" title="Highlight color">
            <Highlighter :size="15" />
            <input
              type="color"
              :value="toolbarState.highlightColor"
              aria-label="Highlight color"
              @mousedown="rememberSelection"
              @input="applyHighlightColor(($event.target as HTMLInputElement | HTMLSelectElement).value)"
            />
          </label>
        </div>

        <div v-if="isToolbarGroupVisible('insert')" class="toolbar-group" data-toolbar-group="insert">
          <button
            type="button"
            class="toolbar-button"
            aria-label="Insert image"
            title="Insert image"
            @mousedown.prevent
            @click="promptForImage"
          >
            <ImageIcon :size="15" />
          </button>
          <button
            type="button"
            class="toolbar-button"
            :class="{ active: toolbarState.link }"
            aria-label="Insert or remove link"
            title="Insert or remove link"
            @mousedown.prevent
            @click="promptForLink"
          >
            <LinkIcon :size="15" />
          </button>
        </div>

        <div v-if="isToolbarGroupVisible('lists')" class="toolbar-group" data-toolbar-group="lists">
          <button
            type="button"
            class="toolbar-button"
            :class="{ active: toolbarState.unorderedList }"
            aria-label="Bulleted list"
            title="Bulleted list"
            @mousedown.prevent
            @click="toggleList('UL')"
          >
            <List :size="15" />
          </button>
          <button
            type="button"
            class="toolbar-button"
            :class="{ active: toolbarState.orderedList }"
            aria-label="Numbered list"
            title="Numbered list"
            @mousedown.prevent
            @click="toggleList('OL')"
          >
            <ListOrdered :size="15" />
          </button>
          <button
            type="button"
            class="toolbar-button"
            :class="{ active: toolbarState.quote }"
            aria-label="Quote"
            title="Quote"
            @mousedown.prevent
            @click="adjustQuote(1)"
          >
            <Quote :size="15" class="icon-mirrored" />
          </button>
          <button
            type="button"
            class="toolbar-button"
            aria-label="Unquote"
            title="Unquote"
            @mousedown.prevent
            @click="adjustQuote(-1)"
          >
            <Quote :size="15" />
          </button>
        </div>

        <div v-if="isToolbarGroupVisible('alignment')" class="toolbar-group" data-toolbar-group="alignment">
          <button
            v-for="alignment in alignmentOptions"
            :key="alignment.value"
            type="button"
            class="toolbar-button"
            :aria-label="alignment.label"
            :title="alignment.label"
            @mousedown.prevent
            @click="runEditorCommand((editor) => editor.setTextAlignment(alignment.value))"
          >
            <component :is="alignment.icon" :size="15" />
          </button>
        </div>

        <AppDropdown class="toolbar-more">
          <summary class="toolbar-button toolbar-more__summary" @mousedown.prevent>
            More
          </summary>
          <div class="toolbar-more__menu" role="menu" aria-label="More formatting options">
            <div v-if="!isToolbarGroupVisible('font')" class="toolbar-menu-section" role="group" aria-label="Font formatting">
              <span class="toolbar-menu-heading" aria-hidden="true">Font</span>
              <button
                v-for="font in fontFamilyChoices"
                :key="`font-${font.value}`"
                type="button"
                class="toolbar-menu-button"
                role="menuitemradio"
                :aria-checked="toolbarState.fontFamily === font.value"
                :aria-label="`Font: ${font.label}`"
                @mousedown.prevent
                @click="applyFontFace(font.value)"
              >
                <Check v-if="toolbarState.fontFamily === font.value" :size="15" />
                <span v-else aria-hidden="true" />
                <span :style="font.value ? { fontFamily: font.value } : undefined">{{ font.label }}</span>
              </button>
              <span class="toolbar-menu-heading" aria-hidden="true">Size</span>
              <button
                v-for="size in fontSizeChoices"
                :key="`size-${size.value}`"
                type="button"
                class="toolbar-menu-button"
                role="menuitemradio"
                :aria-checked="toolbarState.fontSize === size.value"
                :aria-label="`Size: ${size.label}`"
                @mousedown.prevent
                @click="applyFontSize(size.value)"
              >
                <Check v-if="toolbarState.fontSize === size.value" :size="15" />
                <span v-else aria-hidden="true" />
                <span>{{ size.label }}</span>
              </button>
              <label class="toolbar-menu-field">
                <span>Text color</span>
                <input
                  type="color"
                  :value="toolbarState.textColor"
                  aria-label="Text color"
                  @mousedown="rememberSelection"
                  @input="applyTextColor(($event.target as HTMLInputElement | HTMLSelectElement).value)"
                />
              </label>
              <label class="toolbar-menu-field">
                <span>Highlight</span>
                <input
                  type="color"
                  :value="toolbarState.highlightColor"
                  aria-label="Highlight color"
                  @mousedown="rememberSelection"
                  @input="applyHighlightColor(($event.target as HTMLInputElement | HTMLSelectElement).value)"
                />
              </label>
            </div>

            <div v-if="!isToolbarGroupVisible('insert')" class="toolbar-menu-section" role="group" aria-label="Insert">
              <button
                type="button"
                class="toolbar-menu-button"
                role="menuitem"
                @mousedown.prevent
                @click="promptForImage"
              >
                <ImageIcon :size="15" />
                <span>Insert image</span>
              </button>
              <button
                type="button"
                class="toolbar-menu-button"
                :class="{ active: toolbarState.link }"
                role="menuitem"
                @mousedown.prevent
                @click="promptForLink"
              >
                <LinkIcon :size="15" />
                <span>Link</span>
              </button>
            </div>

            <div v-if="!isToolbarGroupVisible('lists')" class="toolbar-menu-section" role="group" aria-label="Lists and quoting">
              <button
                type="button"
                class="toolbar-menu-button"
                :class="{ active: toolbarState.unorderedList }"
                role="menuitem"
                @mousedown.prevent
                @click="toggleList('UL')"
              >
                <List :size="15" />
                <span>Bulleted list</span>
              </button>
              <button
                type="button"
                class="toolbar-menu-button"
                :class="{ active: toolbarState.orderedList }"
                role="menuitem"
                @mousedown.prevent
                @click="toggleList('OL')"
              >
                <ListOrdered :size="15" />
                <span>Numbered list</span>
              </button>
              <button
                type="button"
                class="toolbar-menu-button"
                :class="{ active: toolbarState.quote }"
                role="menuitem"
                @mousedown.prevent
                @click="adjustQuote(1)"
              >
                <Quote :size="15" class="icon-mirrored" />
                <span>Quote</span>
              </button>
              <button
                type="button"
                class="toolbar-menu-button"
                role="menuitem"
                @mousedown.prevent
                @click="adjustQuote(-1)"
              >
                <Quote :size="15" />
                <span>Unquote</span>
              </button>
            </div>

            <div v-if="!isToolbarGroupVisible('alignment')" class="toolbar-menu-section" role="group" aria-label="Alignment">
              <button
                v-for="alignment in alignmentOptions"
                :key="alignment.value"
                type="button"
                class="toolbar-menu-button"
                role="menuitem"
                @mousedown.prevent
                @click="runEditorCommand((editor) => editor.setTextAlignment(alignment.value))"
              >
                <component :is="alignment.icon" :size="15" />
                <span>{{ alignment.label }}</span>
              </button>
            </div>

            <div class="toolbar-menu-section" role="group" aria-label="More formatting">
            <button
              type="button"
              class="toolbar-menu-button"
              :class="{ active: toolbarState.direction === 'ltr' }"
              role="menuitem"
              @mousedown.prevent
              @click="runEditorCommand((editor) => editor.setTextDirection('ltr'))"
            >
              <span>LTR</span>
              <span>Left-to-right</span>
            </button>
            <button
              type="button"
              class="toolbar-menu-button"
              :class="{ active: toolbarState.direction === 'rtl' }"
              role="menuitem"
              @mousedown.prevent
              @click="runEditorCommand((editor) => editor.setTextDirection('rtl'))"
            >
              <span>RTL</span>
              <span>Right-to-left</span>
            </button>
            <button
              type="button"
              class="toolbar-menu-button"
              :class="{ active: toolbarState.subscript }"
              role="menuitem"
              @mousedown.prevent
              @click="toggleFormat('SUB', { tag: 'SUP' })"
            >
              <Subscript :size="15" />
              <span>Subscript</span>
            </button>
            <button
              type="button"
              class="toolbar-menu-button"
              :class="{ active: toolbarState.superscript }"
              role="menuitem"
              @mousedown.prevent
              @click="toggleFormat('SUP', { tag: 'SUB' })"
            >
              <Superscript :size="15" />
              <span>Superscript</span>
            </button>
            <button
              type="button"
              class="toolbar-menu-button"
              :class="{ active: toolbarState.code }"
              role="menuitem"
              @mousedown.prevent
              @click="runEditorCommand((editor) => editor.toggleCode())"
            >
              <Code :size="15" />
              <span>Code</span>
            </button>
            <button
              type="button"
              class="toolbar-menu-button"
              role="menuitem"
              @mousedown.prevent
              @click="runEditorCommand((editor) => editor.removeAllFormatting())"
            >
              <RemoveFormatting :size="15" />
              <span>Clear formatting</span>
            </button>
            <button
              type="button"
              class="toolbar-menu-button"
              :disabled="!toolbarState.canUndo"
              role="menuitem"
              @mousedown.prevent
              @click="runEditorCommand((editor) => editor.undo())"
            >
              <Undo2 :size="15" />
              <span>Undo</span>
            </button>
            <button
              type="button"
              class="toolbar-menu-button"
              :disabled="!toolbarState.canRedo"
              role="menuitem"
              @mousedown.prevent
              @click="runEditorCommand((editor) => editor.redo())"
            >
              <Redo2 :size="15" />
              <span>Redo</span>
            </button>
            </div>
          </div>
        </AppDropdown>
      </div>

      <div class="editor-wrap">
        <div ref="editorEl" class="editor" contenteditable="true" />
      </div>

      <footer>
        <AppButton
          variant="outline"
          :disabled="isSending"
          @click="composeStore.close()"
        >Discard</AppButton>
        <AppButton
          :disabled="isSending"
          @click="send"
        >
          {{ isSending ? 'Sending…' : 'Send' }}
        </AppButton>
      </footer>

      <!-- role="alert" carries an implicit assertive live region, which is
           announced on insertion. The element is conditional because the
           card is a flex column with a gap, and a permanently rendered
           container would hold that gap open under the footer whenever
           there is no error. -->
      <p
        v-if="composeStore.error"
        class="compose-error"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >{{ composeStore.error }}</p>
    </div>
  </div>
</template>

<style scoped>
.compose-dialog {
  position: fixed;
  inset: 0;
  background: rgba(13, 22, 42, 0.4);
  display: grid;
  place-items: center;
  z-index: 50;
}
.compose-dialog__card {
  width: min(960px, 96vw);
  height: min(640px, 90vh);
  background: var(--surface, #fff);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  padding: 16px;
  gap: 8px;
}
.compose-dialog__card header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.compose-dialog__card header h2 { margin: 0; font-size: 16px; }
.icon {
  background: transparent;
  border: 0;
  font-size: 24px;
  cursor: pointer;
  color: inherit;
}
.row {
  display: grid;
  grid-template-columns: 70px 1fr;
  gap: 8px;
  align-items: center;
}
.row label {
  font-size: 12px;
  color: var(--muted, #6b7388);
}
.row input {
  padding: 7px 10px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 8px;
  font-size: 14px;
}
/* The field look of .row input, on a summary; the chevron rides the
   right edge. */
.from-picker__summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 8px;
  font-size: 14px;
  background: var(--panel, transparent);
}
.from-picker__summary::after {
  margin-left: auto;
}
.from-picker__summary-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Full row width: an identity line is long, a 190px panel is not. */
.from-picker__menu {
  right: 0;
}
/* Person rows: avatar, the two lines, and the check on the selected
   one — the suggestion list's shape. */
.from-picker__option {
  grid-template-columns: 24px 1fr auto;
}
.from-picker__avatar {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 999px;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  flex: none;
}
.from-picker__summary .from-picker__avatar {
  width: 20px;
  height: 20px;
  font-size: 9px;
}
.from-picker__lines {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.from-picker__name {
  font-weight: 600;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.from-picker__email {
  font-size: 12px;
  line-height: 1.3;
  color: var(--muted, #6b7280);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.from-picker__email--primary {
  font-size: inherit;
  color: inherit;
  font-weight: 600;
}
.from-picker__check {
  flex: none;
  color: var(--accent, #0060df);
}
/* The To row carries the Cc/Bcc toggles in a third, content-width column
   at its right edge; the label column stays 70px so every row aligns. */
.row--to {
  grid-template-columns: 70px 1fr auto;
}
.recipient-cc-toggles {
  display: flex;
  gap: 4px;
}
.recipient-toggle {
  padding: 4px 8px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 6px;
  background: none;
  color: var(--muted, #6b7388);
  font-size: 12px;
  cursor: pointer;
}
.recipient-toggle:hover {
  color: var(--text, inherit);
  border-color: var(--accent, #0060df);
}
.compose-toolbar {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.04);
  overflow: visible;
}
.toolbar-group {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding-right: 6px;
  margin-right: 4px;
  border-right: 1px solid var(--border, #d6d9e2);
}
.toolbar-group:last-child {
  padding-right: 0;
  margin-right: 0;
  border-right: 0;
}
.toolbar-button,
.toolbar-color {
  height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
}
.toolbar-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  padding: 0 7px;
  cursor: pointer;
  font-size: 12px;
}
.toolbar-button svg,
.toolbar-color svg {
  pointer-events: none;
}
.toolbar-button:hover,
.toolbar-button.active,
.toolbar-color:hover {
  background: rgba(127, 127, 127, 0.18);
}
.toolbar-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.toolbar-color {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  padding: 0 5px;
  cursor: pointer;
  font-size: 12px;
}
.toolbar-color input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}
.toolbar-more {
  position: relative;
  flex: 0 0 auto;
}
/* Font and size share the More menu's popup pieces; the container class
   differs because the overflow maths reserves width by `.toolbar-more`
   and must keep finding only the real More control. */
.toolbar-dropdown {
  position: relative;
  flex: 0 0 auto;
}
/* Anchored at the button's start edge: these sit at the toolbar's left,
   where a right-anchored panel would escape the dialog. */
.toolbar-dropdown .toolbar-more__menu {
  left: 0;
  right: auto;
  min-width: 130px;
}
.toolbar-dropdown[open] .toolbar-more__summary {
  background: rgba(127, 127, 127, 0.18);
}
.toolbar-menu-heading {
  padding: 4px 8px 0;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted, #6b7388);
}
.toolbar-more__summary {
  list-style: none;
}
.toolbar-more__summary::-webkit-details-marker {
  display: none;
}
.toolbar-more__summary::after {
  content: '▾';
  margin-left: 5px;
  font-size: 10px;
  opacity: 0.7;
}
.toolbar-more[open] .toolbar-more__summary {
  background: rgba(127, 127, 127, 0.18);
}
.toolbar-more__menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 3;
  display: grid;
  min-width: 190px;
  padding: 6px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 8px;
  background: var(--surface, #fff);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.22);
}
.toolbar-menu-section {
  display: grid;
  gap: 2px;
  padding: 4px 0;
}
.toolbar-menu-section + .toolbar-menu-section {
  border-top: 1px solid var(--border, #d6d9e2);
}
.toolbar-menu-button {
  display: grid;
  grid-template-columns: 24px 1fr;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.toolbar-menu-button:hover,
.toolbar-menu-button.active {
  background: rgba(127, 127, 127, 0.18);
}
.toolbar-menu-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.toolbar-menu-field {
  display: grid;
  grid-template-columns: 72px 1fr;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 4px 8px;
  font-size: 12px;
}
.toolbar-menu-field select,
.toolbar-menu-field input {
  min-width: 0;
}
.editor-wrap {
  flex: 1;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 8px;
  padding: 8px;
  overflow-y: auto;
  min-height: 0;
}
.editor {
  /* Positioned so Squire's built-in image resize handles, which it
     appends to the editor root and positions absolutely relative to it,
     anchor over the image instead of the fixed dialog overlay. */
  position: relative;
  min-height: 100%;
  outline: none;
  font-size: 14px;
}
/* Inserted images are added dynamically, so they never carry the scoped
   data-attribute; :deep keeps pasted screenshots from overflowing. */
.editor :deep(img) {
  max-width: 100%;
  height: auto;
}
/* Editor chrome only: the sent HTML carries a bare <blockquote> and the
   receiving client draws its own bar. The border mirrors what the
   message view puts on a first-level quote, so quoting looks the same
   while writing as it will when read. */
.editor :deep(blockquote) {
  margin: 1ex 0;
  padding: 0.4ex 1ex;
  border-inline-start: 2px solid rgb(114, 159, 207);
}
/* The lucide glyph draws closing marks; mirrored it reads as the opening
   pair, which is the convention for "quote" beside "unquote". */
.icon-mirrored {
  transform: scaleX(-1);
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.compose-error { color: #b3261e; font-size: 13px; }
</style>
