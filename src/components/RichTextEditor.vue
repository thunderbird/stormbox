<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
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
import Squire from 'squire-rte';

import { shortcutModifierAria, shortcutModifierLabel } from '../utils/keyboard';
import {
  QUOTED_CONTENT_BOUNDARY_ATTRIBUTE,
  TRACKED_ORIGIN_ATTRIBUTE,
  TRACKED_ORIGIN_TOUCHED_ATTRIBUTE,
  type TrackedOriginState,
} from '../utils/compose-provenance';
import {
  richTextPlainText,
  sanitizeRichTextToDOMFragment,
} from '../utils/rich-text';
import AppDropdown from './AppDropdown.vue';

interface EditorContent {
  html: string;
  text: string;
}

interface EditorValidation {
  valid: boolean;
  htmlBytes: number;
  textBytes: number;
  maxSerializedUtf8Bytes: number | null;
}

const props = withDefaults(
  defineProps<{
    accessibleLabel?: string;
    ariaDescribedby?: string;
    ariaInvalid?: boolean;
    contentKey?: string | number;
    initialHtml?: string;
    maxSerializedUtf8Bytes?: number | null;
  }>(),
  {
    accessibleLabel: 'Rich text editor',
    ariaDescribedby: undefined,
    ariaInvalid: false,
    contentKey: 'default',
    initialHtml: '',
    maxSerializedUtf8Bytes: null,
  },
);

const emit = defineEmits<{
  update: [EditorContent];
  'tracked-origin-state': [TrackedOriginState[]];
}>();

const editorEl = ref<HTMLElement | null>(null);
const toolbarEl = ref<HTMLElement | null>(null);
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

const defaultTextColor = '#e5e7eb';
const defaultHighlightColor = '#fef3c7';
const toolbarGroupOrder = ['style', 'font', 'insert', 'lists', 'alignment'] as const;
type ToolbarGroup = (typeof toolbarGroupOrder)[number];

const visibleToolbarGroups = ref<ToolbarGroup[]>([...toolbarGroupOrder]);
const toolbarGroupWidths = new Map<ToolbarGroup, number>();
const currentContent = ref<EditorContent>({ html: '', text: '' });

let squire: Squire | null = null;
let lastSelection: Range | null = null;
let toolbarResizeObserver: ResizeObserver | null = null;
let isResizingImage = false;
let pendingHtml: string | null = null;
const trackedOriginBaselines = new Map<string, string>();
const knownTrackedOrigins = new Set<string>();
const touchedTrackedOrigins = new Set<string>();

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

const shortcutModifier = shortcutModifierLabel();
const ariaShortcutModifier = shortcutModifierAria();

const serializedByteLimit = computed(() => {
  const limit = props.maxSerializedUtf8Bytes;
  return typeof limit === 'number' && Number.isFinite(limit) && limit >= 0
    ? Math.floor(limit)
    : null;
});
const serializedByteLengths = computed(() => ({
  html: new TextEncoder().encode(currentContent.value.html).byteLength,
  text: new TextEncoder().encode(currentContent.value.text).byteLength,
}));
const exceedsSerializedByteLimit = computed(() => {
  const limit = serializedByteLimit.value;
  return limit !== null
    && (serializedByteLengths.value.html > limit || serializedByteLengths.value.text > limit);
});

function serializeContent(): EditorContent {
  if (!squire || !editorEl.value) return { ...currentContent.value };
  return {
    html: squire.getHTML(),
    text: richTextPlainText(editorEl.value)
      .replace(/\u200B/gu, '')
      .replace(/\n+$/u, ''),
  };
}

function trackedOriginElements(): HTMLElement[] {
  if (!editorEl.value) return [];
  return Array.from(
    editorEl.value.querySelectorAll<HTMLElement>(`[${TRACKED_ORIGIN_ATTRIBUTE}]`),
  );
}

function trackedOriginContent(elements: readonly HTMLElement[]): Map<string, string> {
  const byId = new Map<string, string[]>();
  for (const element of elements) {
    const id = element.getAttribute(TRACKED_ORIGIN_ATTRIBUTE);
    if (!id) continue;
    const values = byId.get(id) ?? [];
    values.push(element.innerHTML);
    byId.set(id, values);
  }
  return new Map(Array.from(byId, ([id, values]) => [id, values.join('\u0000')]));
}

function resetTrackedOriginBaselines(): void {
  trackedOriginBaselines.clear();
  knownTrackedOrigins.clear();
  touchedTrackedOrigins.clear();
  const elements = trackedOriginElements();
  const contentById = trackedOriginContent(elements);
  for (const [id, content] of contentById) {
    knownTrackedOrigins.add(id);
    trackedOriginBaselines.set(id, content);
  }
  for (const element of elements) {
    const id = element.getAttribute(TRACKED_ORIGIN_ATTRIBUTE);
    if (id && element.getAttribute(TRACKED_ORIGIN_TOUCHED_ATTRIBUTE) === 'true') {
      touchedTrackedOrigins.add(id);
    }
  }
}

function markTrackedOriginTouched(id: string): void {
  knownTrackedOrigins.add(id);
  touchedTrackedOrigins.add(id);
  for (const element of trackedOriginElements()) {
    if (element.getAttribute(TRACKED_ORIGIN_ATTRIBUTE) === id
        && element.getAttribute(TRACKED_ORIGIN_TOUCHED_ATTRIBUTE) !== 'true') {
      element.setAttribute(TRACKED_ORIGIN_TOUCHED_ATTRIBUTE, 'true');
    }
  }
}

function updateTrackedOriginStates(): void {
  const elements = trackedOriginElements();
  const contentById = trackedOriginContent(elements);
  for (const [id, content] of contentById) {
    if (!knownTrackedOrigins.has(id)) {
      knownTrackedOrigins.add(id);
      trackedOriginBaselines.set(id, content);
    }
    if (trackedOriginBaselines.get(id) !== content) markTrackedOriginTouched(id);
  }
  for (const id of knownTrackedOrigins) {
    if (!contentById.has(id)) markTrackedOriginTouched(id);
  }
  for (const id of touchedTrackedOrigins) {
    for (const element of elements) {
      if (element.getAttribute(TRACKED_ORIGIN_ATTRIBUTE) === id
          && element.getAttribute(TRACKED_ORIGIN_TOUCHED_ATTRIBUTE) !== 'true') {
        element.setAttribute(TRACKED_ORIGIN_TOUCHED_ATTRIBUTE, 'true');
      }
    }
  }
  emit(
    'tracked-origin-state',
    Array.from(knownTrackedOrigins, (id) => ({
      id,
      present: contentById.has(id),
      touched: touchedTrackedOrigins.has(id),
    })),
  );
}

function markTrackedOriginsTouchedByRange(range: Range | null): void {
  if (!range) return;
  for (const element of trackedOriginElements()) {
    const id = element.getAttribute(TRACKED_ORIGIN_ATTRIBUTE);
    if (!id) continue;
    const endpointInside = element.contains(range.startContainer)
      || element.contains(range.endContainer);
    let crosses = false;
    if (!range.collapsed) {
      try {
        crosses = range.intersectsNode(element);
      } catch {
        crosses = false;
      }
    }
    if (endpointInside || crosses) markTrackedOriginTouched(id);
  }
}

function reusableBoundaryBlock(node: Node | null): HTMLElement | null {
  if (!(node instanceof HTMLElement) || !isBlockNode(node)) return null;
  if (node.hasAttribute(TRACKED_ORIGIN_ATTRIBUTE)
      || node.hasAttribute(QUOTED_CONTENT_BOUNDARY_ATTRIBUTE)) return null;
  return node;
}

function moveCollapsedRangeOutsideTrackedOrigin(range: Range): Range {
  const root = editorEl.value;
  if (!root || !range.collapsed || range.startContainer !== root) return range;
  const offset = range.startOffset;
  const next = root.childNodes[offset] ?? null;
  const previous = offset > 0 ? root.childNodes[offset - 1] : null;
  const beforeOrigin = next instanceof HTMLElement
    && next.hasAttribute(TRACKED_ORIGIN_ATTRIBUTE);
  const afterOrigin = previous instanceof HTMLElement
    && previous.hasAttribute(TRACKED_ORIGIN_ATTRIBUTE);
  if (!beforeOrigin && !afterOrigin) return range;

  const reusable = reusableBoundaryBlock(beforeOrigin ? previous : next);
  const block = reusable ?? document.createElement('div');
  if (!reusable) {
    block.append(document.createElement('br'));
    root.insertBefore(block, next);
  }
  const targetOffset = beforeOrigin && block.textContent
    ? block.childNodes.length
    : 0;
  const redirected = document.createRange();
  redirected.setStart(block, targetOffset);
  redirected.collapse(true);
  squire?.setSelection(redirected);
  return redirected;
}

function handleBeforeInput(): void {
  if (!squire) return;
  try {
    const range = moveCollapsedRangeOutsideTrackedOrigin(squire.getSelection());
    markTrackedOriginsTouchedByRange(range);
  } catch {
    // The post-input comparison still detects changed or removed origins.
  }
}

function syncContentFromEditor() {
  updateTrackedOriginStates();
  currentContent.value = serializeContent();
  emit('update', { ...currentContent.value });
}

function getContent(): EditorContent {
  currentContent.value = serializeContent();
  return { ...currentContent.value };
}

function getValidation(): EditorValidation {
  const lengths = serializedByteLengths.value;
  return {
    valid: !exceedsSerializedByteLimit.value,
    htmlBytes: lengths.html,
    textBytes: lengths.text,
    maxSerializedUtf8Bytes: serializedByteLimit.value,
  };
}

function focus() {
  squire?.focus();
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

function normalizeColor(value: string | undefined, fallback: string) {
  if (/^#[0-9a-f]{6}$/i.test(value || '')) return value as string;

  const rgb = (value || '').match(/^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/i);
  if (!rgb) return fallback;

  return rgb
    .slice(1)
    .map((channel) => Number(channel).toString(16).padStart(2, '0'))
    .join('')
    .replace(/^/, '#');
}

function normalizeFontFamily(value: string | undefined) {
  const firstFamily = (value || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();
  return fontOptions.find((option) => {
    const optionFamily = option.value.split(',')[0].replace(/["']/g, '').trim().toLowerCase();
    return optionFamily === firstFamily;
  })?.value || '';
}

function pathHasFormat(path: string, tag: string) {
  return new RegExp(`(?:^|>)${tag}(?:$|[.#\\[])`).test(path)
    || new RegExp(`(?:^|>)${tag}(?:>|$)`).test(path);
}

function stateForFormat(tag: string, path: string, range: Range | null) {
  if (path && path !== '(selection)') {
    return pathHasFormat(path, tag);
  }
  return !!range && !!squire?.hasFormat(tag, null, range);
}

function updateToolbarState(pathOverride: string | null = null) {
  if (!squire) return;

  let range: Range | null = null;
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
  syncContentFromEditor();
  rememberSelection();
  updateToolbarState();
}

function handleEditorInput() {
  // Squire's image resizer mutates the <img> on every pointermove, which
  // fires 'input'. getHTML() momentarily removes and re-adds Squire's
  // resize-handle container, releasing pointer capture during a drag.
  if (isResizingImage) return;
  syncEditorState();
}

function handleResizeHandlePointerDown(event: PointerEvent) {
  const target = event.target as Element | null;
  const handle = target?.closest?.('.squire-resize-handle');
  if (handle && editorEl.value?.contains(handle)) {
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

function handleSquirePathChange(event: Event) {
  const detail = (event as CustomEvent<{ path?: string }>).detail;
  rememberSelection();
  updateToolbarState(detail?.path ?? null);
}

function handleUndoStateChange(event: Event) {
  const detail = (event as CustomEvent<{ canUndo?: boolean; canRedo?: boolean }>).detail;
  toolbarState.value = {
    ...toolbarState.value,
    canUndo: !!detail?.canUndo,
    canRedo: !!detail?.canRedo,
  };
}

function runEditorCommand(
  command: (editor: Squire) => void,
  { restore = true }: { restore?: boolean } = {},
) {
  if (!squire) return;
  if (restore) {
    squire.focus();
    restoreSelection();
  }
  try {
    markTrackedOriginsTouchedByRange(squire.getSelection());
  } catch {
    // A command without a readable selection still runs normally.
  }
  ensureEditorBlocks();
  command(squire);
  syncContentFromEditor();
  rememberSelection();
  updateToolbarState();
  if (restore) {
    squire.focus();
  }
}

function toggleFormat(
  tag: string,
  remove: { tag: string } | null = null,
  options?: { restore?: boolean },
) {
  runEditorCommand((editor) => {
    const range = editor.getSelection();
    toggleFormatInRange(editor, tag, remove, range);
  }, options);
}

function toggleFormatInRange(
  editor: Squire,
  tag: string,
  remove: { tag: string } | null = null,
  range: Range = editor.getSelection(),
) {
  ensureEditorBlocks();
  if (editor.hasFormat(tag, null, range)) {
    editor.changeFormat(null, { tag }, range);
  } else {
    editor.changeFormat({ tag }, remove, range);
  }
}

function isBlockNode(node: Node) {
  return node.nodeType === Node.ELEMENT_NODE && blockElementNames.has(node.nodeName);
}

function shouldWrapRootChild(node: Node) {
  if (isBlockNode(node)) return false;
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data.length > 0;
  return node.nodeType === Node.ELEMENT_NODE;
}

function ensureEditorBlocks() {
  if (!squire) return;

  const root = squire.getRoot();
  let wrapper: HTMLDivElement | null = null;
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
  runEditorCommand((editor) => {
    const path = editor.getPath();
    const inList = new RegExp(`(?:^|>)${type}`).test(path);
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
 * Quote and unquote use blockquotes. Squire handles list indentation
 * separately through Tab and Shift+Tab.
 */
function adjustQuote(delta: number) {
  runEditorCommand((editor) => {
    if (delta > 0) editor.increaseQuoteLevel();
    else editor.decreaseQuoteLevel();
  });
}

function applyFontFace(value: string) {
  runEditorCommand((editor) => editor.setFontFace(value || null));
}

function applyFontSize(value: string) {
  runEditorCommand((editor) => editor.setFontSize(value || null));
}

const fontFamilyLabel = computed(() =>
  fontOptions.find((font) => font.value === toolbarState.value.fontFamily)?.label ?? 'Font');
const fontSizeLabel = computed(() =>
  fontSizeOptions.find((size) => size.value === toolbarState.value.fontSize)?.label ?? 'Size');

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
  runEditorCommand((editor) => editor.setTextColor(value || null));
}

function applyHighlightColor(value: string) {
  runEditorCommand((editor) => editor.setHighlightColor(value || null));
}

function promptForLink() {
  if (!squire) return;
  restoreSelection();
  const selectedText = squire.getSelectedText().trim();
  const initialValue = /^https?:\/\//i.test(selectedText) || /^mailto:/i.test(selectedText)
    ? selectedText
    : '';
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

// Pasted images are inlined as data: URLs for instant, offline-safe editing.
// Compose later uploads them as JMAP blobs and rewrites them to cid: parts.
const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024;

function insertPastedImageFile(file: File | null) {
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > MAX_PASTED_IMAGE_BYTES) {
    console.warn('[compose] pasted image exceeds size limit; skipping', file.size);
    return;
  }
  // Capture the caret before the async read so the image lands at the
  // paste position if the live selection moves.
  rememberSelection();
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = typeof reader.result === 'string' ? reader.result : '';
    if (!dataUrl.startsWith('data:image/')) return;
    runEditorCommand((editor) => {
      editor.insertImage(dataUrl, { style: 'max-width:100%;height:auto;' });
      // Block text alignment lets toolbar commands reposition the image.
      editor.setTextAlignment('center');
    });
  };
  reader.readAsDataURL(file);
}

function handlePasteImage(event: Event) {
  const detail = (event as CustomEvent<{ clipboardData?: DataTransfer }>).detail;
  const items = detail?.clipboardData?.items
    ? Array.from(detail.clipboardData.items)
    : [];
  const imageItem = items.find(
    (item) => item.kind === 'file' && item.type.startsWith('image/'),
  );
  insertPastedImageFile(imageItem?.getAsFile() ?? null);
}

function syncAfterKeyboardCommand(editor: Squire, range: Range | null = null) {
  ensureEditorBlocks();
  syncContentFromEditor();
  if (range) {
    lastSelection = range.cloneRange();
  } else {
    rememberSelection();
  }
  updateToolbarState();
}

function registerKeyboardShortcut(
  key: string,
  command: (editor: Squire, range?: Range) => void,
) {
  if (!squire) return;
  squire.setKeyHandler(key, (editor, event, range) => {
    event.preventDefault();
    markTrackedOriginsTouchedByRange(range);
    command(editor, range);
    syncAfterKeyboardCommand(editor, range);
  });
}

function registerKeyboardShortcuts() {
  if (!squire) return;
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
    squire?.setKeyHandler(key, (_editor, event, range) => {
      event.preventDefault();
      lastSelection = range.cloneRange();
      promptForLink();
    });
  });
}

function elementOuterWidth(element: Element | null) {
  if (!element) return 0;
  const styles = window.getComputedStyle(element);
  const rectWidth = element.getBoundingClientRect().width
    || (element instanceof HTMLElement ? element.offsetWidth : 0);
  return rectWidth
    + Number.parseFloat(styles.marginLeft || '0')
    + Number.parseFloat(styles.marginRight || '0');
}

function isToolbarGroupVisible(group: ToolbarGroup) {
  return visibleToolbarGroups.value.includes(group);
}

function updateToolbarOverflow() {
  if (!toolbarEl.value) return;

  toolbarEl.value.querySelectorAll<HTMLElement>('[data-toolbar-group]').forEach((groupEl) => {
    const group = groupEl.dataset.toolbarGroup as ToolbarGroup | undefined;
    const width = elementOuterWidth(groupEl);
    if (group && width > 0) {
      toolbarGroupWidths.set(group, width);
    }
  });

  const toolbarWidth = toolbarEl.value.clientWidth
    || toolbarEl.value.getBoundingClientRect().width;
  if (!toolbarWidth) return;

  const moreWidth = elementOuterWidth(toolbarEl.value.querySelector('.toolbar-more')) || 70;
  const toolbarGap = 4;
  const nextVisible: ToolbarGroup[] = [...toolbarGroupOrder];
  const widthFor = (group: ToolbarGroup) => toolbarGroupWidths.get(group) ?? 0;
  const totalWidth = () =>
    moreWidth
    + (nextVisible.length * toolbarGap)
    + nextVisible.reduce((sum, group) => sum + widthFor(group), 0);

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
  squire?.destroy();
  squire = null;
  lastSelection = null;
  trackedOriginBaselines.clear();
  knownTrackedOrigins.clear();
  touchedTrackedOrigins.clear();
}

function initEditor(html: string) {
  if (!editorEl.value) {
    pendingHtml = html;
    return;
  }
  destroyEditor();
  squire = new Squire(editorEl.value, {
    sanitizeToDOMFragment: sanitizeRichTextToDOMFragment,
  });
  squire.setHTML(html || '<p><br></p>');
  resetTrackedOriginBaselines();
  currentContent.value = serializeContent();
  registerKeyboardShortcuts();
  squire.addEventListener('beforeinput', handleBeforeInput);
  squire.addEventListener('input', handleEditorInput);
  squire.addEventListener('pasteImage', handlePasteImage);
  squire.addEventListener('pathChange', handleSquirePathChange);
  squire.addEventListener('select', handlePathChange);
  squire.addEventListener('cursor', handlePathChange);
  squire.addEventListener('undoStateChange', handleUndoStateChange);
  // Squire's resize handles capture the pointer, so serialization waits
  // until the drag ends.
  document.addEventListener('pointerdown', handleResizeHandlePointerDown, true);
  document.addEventListener('pointerup', handleResizeHandlePointerUp);
  document.addEventListener('pointercancel', handleResizeHandlePointerUp);
  updateToolbarState();
  scheduleToolbarOverflowUpdate();
  observeToolbarSize();
}

function setContent(
  content: EditorContent | string,
  { preserveFocus = true }: { preserveFocus?: boolean } = {},
): EditorContent {
  const html = typeof content === 'string' ? content : content.html;
  pendingHtml = null;
  if (!squire || !editorEl.value) {
    initEditor(html);
    return { ...currentContent.value };
  }
  const hadFocus = preserveFocus && editorEl.value.contains(document.activeElement);
  squire.setHTML(html || '<p><br></p>');
  resetTrackedOriginBaselines();
  currentContent.value = serializeContent();
  rememberSelection();
  updateToolbarState();
  if (hadFocus) squire.focus();
  return { ...currentContent.value };
}

function updateTrackedContent(
  originId: string,
  content: EditorContent | string,
  { preserveFocus = true }: { preserveFocus?: boolean } = {},
): EditorContent {
  const html = typeof content === 'string' ? content : content.html;
  if (!squire || !editorEl.value) return setContent(html, { preserveFocus });

  const currentOrigin = trackedOriginElements().find(
    (element) => element.getAttribute(TRACKED_ORIGIN_ATTRIBUTE) === originId,
  );
  const incoming = sanitizeRichTextToDOMFragment(html);
  const nextOrigin = Array.from(
    incoming.querySelectorAll<HTMLElement>(`[${TRACKED_ORIGIN_ATTRIBUTE}]`),
  ).find((element) => element.getAttribute(TRACKED_ORIGIN_ATTRIBUTE) === originId);
  const insertionIndex = !currentOrigin && nextOrigin?.parentNode === incoming
    ? Array.from(incoming.childNodes).indexOf(nextOrigin)
    : -1;
  if (!currentOrigin && insertionIndex < 0) return setContent(html, { preserveFocus });

  const hadFocus = preserveFocus && editorEl.value.contains(document.activeElement);
  const range = squire.getSelection().cloneRange();
  const endpointInside = currentOrigin
    ? currentOrigin.contains(range.startContainer)
      || currentOrigin.contains(range.endContainer)
    : false;
  let crossesOrigin = false;
  if (currentOrigin && !range.collapsed) {
    try {
      crossesOrigin = range.intersectsNode(currentOrigin);
    } catch {
      crossesOrigin = true;
    }
  }
  const restoreRange = !endpointInside && !crossesOrigin;
  squire.saveUndoState(range);
  if (currentOrigin && nextOrigin) {
    currentOrigin.replaceWith(nextOrigin.cloneNode(true));
  } else if (currentOrigin) {
    currentOrigin.remove();
  } else if (nextOrigin) {
    editorEl.value.insertBefore(
      nextOrigin.cloneNode(true),
      editorEl.value.childNodes[insertionIndex] ?? null,
    );
  }
  resetTrackedOriginBaselines();
  currentContent.value = serializeContent();
  if (restoreRange
      && range.startContainer.isConnected
      && range.endContainer.isConnected) {
    squire.setSelection(range);
  }
  rememberSelection();
  updateToolbarState();
  if (hadFocus) squire.focus();
  return { ...currentContent.value };
}

function reset() {
  setContent(props.initialHtml);
}

watch(
  () => props.contentKey,
  () => {
    void nextTick().then(reset);
  },
);

onMounted(() => {
  window.addEventListener('resize', scheduleToolbarOverflowUpdate);
  const initialHtml = pendingHtml ?? props.initialHtml;
  pendingHtml = null;
  initEditor(initialHtml);
});

onUnmounted(() => {
  window.removeEventListener('resize', scheduleToolbarOverflowUpdate);
  destroyEditor();
});

defineExpose({
  focus,
  getContent,
  getValidation,
  reset,
  setContent,
  updateTrackedContent,
});
</script>

<template>
  <div class="rich-text-editor">
    <div
      ref="toolbarEl"
      class="compose-toolbar"
      role="toolbar"
      aria-label="Rich text formatting"
      @pointerdown.capture="rememberSelection"
    >
      <div v-if="isToolbarGroupVisible('style')" class="toolbar-group" data-toolbar-group="style">
        <button
          type="button"
          class="toolbar-button"
          :class="{ active: toolbarState.bold }"
          aria-label="Bold"
          :aria-keyshortcuts="`${ariaShortcutModifier}+B`"
          :title="`Bold (${shortcutModifier}+B)`"
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
          :aria-keyshortcuts="`${ariaShortcutModifier}+I`"
          :title="`Italic (${shortcutModifier}+I)`"
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
          :aria-keyshortcuts="`${ariaShortcutModifier}+U`"
          :title="`Underline (${shortcutModifier}+U)`"
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
            @input="applyTextColor(($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="toolbar-color" title="Highlight color">
          <Highlighter :size="15" />
          <input
            type="color"
            :value="toolbarState.highlightColor"
            aria-label="Highlight color"
            @mousedown="rememberSelection"
            @input="applyHighlightColor(($event.target as HTMLInputElement).value)"
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
          :aria-keyshortcuts="`${ariaShortcutModifier}+K`"
          :title="`Insert or remove link (${shortcutModifier}+K)`"
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

      <div
        v-if="isToolbarGroupVisible('alignment')"
        class="toolbar-group"
        data-toolbar-group="alignment"
      >
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
          <div
            v-if="!isToolbarGroupVisible('font')"
            class="toolbar-menu-section"
            role="group"
            aria-label="Font formatting"
          >
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
                @input="applyTextColor(($event.target as HTMLInputElement).value)"
              />
            </label>
            <label class="toolbar-menu-field">
              <span>Highlight</span>
              <input
                type="color"
                :value="toolbarState.highlightColor"
                aria-label="Highlight color"
                @mousedown="rememberSelection"
                @input="applyHighlightColor(($event.target as HTMLInputElement).value)"
              />
            </label>
          </div>

          <div
            v-if="!isToolbarGroupVisible('insert')"
            class="toolbar-menu-section"
            role="group"
            aria-label="Insert"
          >
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
              aria-label="Insert or remove link"
              :aria-keyshortcuts="`${ariaShortcutModifier}+K`"
              :title="`Insert or remove link (${shortcutModifier}+K)`"
              @mousedown.prevent
              @click="promptForLink"
            >
              <LinkIcon :size="15" />
              <span>Link</span>
            </button>
          </div>

          <div
            v-if="!isToolbarGroupVisible('lists')"
            class="toolbar-menu-section"
            role="group"
            aria-label="Lists and quoting"
          >
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

          <div
            v-if="!isToolbarGroupVisible('alignment')"
            class="toolbar-menu-section"
            role="group"
            aria-label="Alignment"
          >
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
              aria-label="Undo"
              :aria-keyshortcuts="`${ariaShortcutModifier}+Z`"
              :title="`Undo (${shortcutModifier}+Z)`"
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
              aria-label="Redo"
              :aria-keyshortcuts="`${ariaShortcutModifier}+Y ${ariaShortcutModifier}+Shift+Z`"
              :title="`Redo (${shortcutModifier}+Y / ${shortcutModifier}+Shift+Z)`"
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
      <div
        ref="editorEl"
        class="editor"
        contenteditable="true"
        role="textbox"
        :aria-label="accessibleLabel"
        :aria-describedby="ariaDescribedby"
        :aria-invalid="ariaInvalid ? 'true' : undefined"
        aria-multiline="true"
      />
    </div>
  </div>
</template>

<style scoped>
.rich-text-editor {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  min-height: 0;
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
  /* Squire appends image resize handles to the editor root and positions
     them absolutely relative to it. */
  position: relative;
  min-height: 100%;
  outline: none;
  font-size: 14px;
}
.editor :deep(img) {
  max-width: 100%;
  height: auto;
}
.editor :deep(blockquote) {
  margin: 1ex 0;
  padding: 0.4ex 1ex;
  border-inline-start: 2px solid rgb(114, 159, 207);
}
.editor :deep([data-stormbox-quoted-content]) {
  display: contents;
}
.editor :deep([data-stormbox-origin]) {
  display: block;
}
.icon-mirrored {
  transform: scaleX(-1);
}
</style>
