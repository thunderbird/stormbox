<script setup lang="ts">
import { t, LocalizedError } from '../i18n/messages';
import { computed, nextTick, onMounted, onUnmounted, onUpdated, ref, watch } from 'vue';
import {
  Bold,
  Check,
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
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  Underline,
  Undo2,
} from '@lucide/vue';
import Squire from 'squire-rte';

import { closeContainingDropdown } from '../utils/dropdown';
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
import {
  isInlineRasterType,
  MAX_INLINE_RASTER_BYTES,
} from '../utils/raster-images';
import { scriptedPasteDetail } from '../utils/scripted-paste';
import AppButton from './AppButton.vue';
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

interface PastedEditorFile {
  file: File;
  kind: 'inline' | 'attachment';
}

const PICKABLE_IMAGE_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);
const PICKABLE_IMAGE_ACCEPT = [...PICKABLE_IMAGE_TYPES].join(',');

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
    accessibleLabel: undefined,
    ariaDescribedby: undefined,
    ariaInvalid: false,
    contentKey: 'default',
    initialHtml: '',
    maxSerializedUtf8Bytes: null,
  },
);

const resolvedAccessibleLabel = computed(() => props.accessibleLabel ?? t('richTextEditor.richTextEditor'));

const emit = defineEmits<{
  update: [EditorContent];
  'tracked-origin-state': [TrackedOriginState[]];
  'paste-files': [PastedEditorFile[]];
}>();

const editorEl = ref<HTMLElement | null>(null);
const imageInputEl = ref<HTMLInputElement | null>(null);
const imageInsertError = ref<string | null>(null);
const linkInputEl = ref<HTMLInputElement | null>(null);
const linkEditorOpen = ref(false);
const linkEditorHasLink = ref(false);
const linkUrl = ref('');
const linkError = ref<string | null>(null);
const toolbarEl = ref<HTMLElement | null>(null);
const normalFontSize = '14px';
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
  fontSize: normalFontSize as string | null,
  textColor: '#e5e7eb',
  highlightColor: '#fef3c7',
  alignment: 'left' as string | null,
  direction: 'ltr' as string | null,
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
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
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
  { get label() { return t('richTextEditor.sans'); }, value: "Arial, sans-serif" },
  { get label() { return t('richTextEditor.serif'); }, value: "Georgia, serif" },
  { get label() { return t('richTextEditor.mono'); }, value: "\"Courier New\", monospace" },
  { get label() { return t('richTextEditor.verdana'); }, value: "Verdana, sans-serif" },
  { get label() { return t('richTextEditor.times'); }, value: "\"Times New Roman\", serif" },
];
const fontSizeOptions = [
  { get label() { return t('richTextEditor.small'); }, value: '12px' },
  { get label() { return t('richTextEditor.normal'); }, value: normalFontSize },
  { get label() { return t('richTextEditor.large'); }, value: '18px' },
  { get label() { return t('richTextEditor.huge'); }, value: '24px' },
];
const fontFamilyChoices = [{ get label() { return t('richTextEditor.default'); }, value: '' }, ...fontOptions];
const alignmentOptions = [
  { get label() { return t('richTextEditor.alignLeft'); }, value: 'left', icon: TextAlignStart },
  { get label() { return t('richTextEditor.alignCenter'); }, value: 'center', icon: TextAlignCenter },
  { get label() { return t('richTextEditor.alignRight'); }, value: 'right', icon: TextAlignEnd },
  { get label() { return t('richTextEditor.alignJustify'); }, value: 'justify', icon: TextAlignJustify },
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

function selectedFontSize(range: Range | null): string | null {
  if (!range) return null;

  const sizeForNode = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement;
    return element ? getComputedStyle(element).fontSize || normalFontSize : normalFontSize;
  };
  const common = range.commonAncestorContainer;
  if (range.collapsed || common instanceof Text) return sizeForNode(range.startContainer);

  const walker = document.createTreeWalker(common, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let selectedSize: string | null = null;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!(node instanceof Text) && node.nodeName !== 'BR' && node.nodeName !== 'IMG') continue;
    if (!range.intersectsNode(node)) continue;
    if (node instanceof Text && (!node.length
      || (node === range.startContainer && range.startOffset === node.length)
      || (node === range.endContainer && range.endOffset === 0))) continue;

    const size = sizeForNode(node);
    if (selectedSize !== null && selectedSize !== size) return null;
    selectedSize = size;
  }
  return selectedSize;
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

function selectedBlockFormatting(range: Range | null) {
  let alignment: string | null = null;
  let direction: string | null = null;
  let seenBlock = false;
  if (range) squire?.forEachBlock((block) => {
    const style = getComputedStyle(block);
    const blockDirection = style.direction === 'rtl' ? 'rtl' : 'ltr';
    const textAlign = style.textAlign.replace(/^-(?:moz|webkit)-/, '');
    let blockAlignment = textAlign;
    if (!textAlign || textAlign === 'start' || textAlign === 'auto') {
      blockAlignment = blockDirection === 'rtl' ? 'right' : 'left';
    } else if (textAlign === 'end') {
      blockAlignment = blockDirection === 'rtl' ? 'left' : 'right';
    }
    alignment = !seenBlock || alignment === blockAlignment ? blockAlignment : null;
    direction = !seenBlock || direction === blockDirection ? blockDirection : null;
    seenBlock = true;
    return alignment === null && direction === null;
  }, false, range);
  return { alignment, direction };
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
  const blockFormatting = selectedBlockFormatting(range);
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
    unorderedList: stateForFormat('UL', path, range),
    orderedList: stateForFormat('OL', path, range),
    quote: /(?:^|>)BLOCKQUOTE/.test(path),
    fontFamily: normalizeFontFamily(fontInfo.fontFamily),
    fontSize: selectedFontSize(range),
    textColor: normalizeColor(fontInfo.color, toolbarState.value.textColor || defaultTextColor),
    highlightColor: normalizeColor(
      fontInfo.backgroundColor,
      toolbarState.value.highlightColor || defaultHighlightColor,
    ),
    ...blockFormatting,
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
    if (editor.hasFormat(type)) {
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
  fontOptions.find((font) => font.value === toolbarState.value.fontFamily)?.label ?? t('richTextEditor.font'));
const fontSizeLabel = computed(() =>
  fontSizeOptions.find((size) => size.value === toolbarState.value.fontSize)?.label ?? t('richTextEditor.size'));

function pickFontFace(value: string, event: Event) {
  closeContainingDropdown(event);
  applyFontFace(value);
}

function pickFontSize(value: string, event: Event) {
  closeContainingDropdown(event);
  applyFontSize(value);
}

function applyTextColor(value: string) {
  runEditorCommand((editor) => editor.setTextColor(value || null));
}

function applyHighlightColor(value: string) {
  runEditorCommand((editor) => editor.setHighlightColor(value || null));
}

function selectedLink(): HTMLAnchorElement | null {
  if (!squire) return null;
  const range = lastSelection ?? squire.getSelection();
  const node = range.startContainer;
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  return element?.closest('a') as HTMLAnchorElement | null;
}

function openLinkEditor(event?: Event) {
  if (!squire) return;
  rememberSelection();
  if (event) closeContainingDropdown(event);
  const anchor = selectedLink();
  const selectedText = squire.getSelectedText().trim();
  linkEditorHasLink.value = anchor !== null;
  linkUrl.value = anchor?.getAttribute('href')
    ?? (/^https?:\/\//i.test(selectedText) || /^mailto:/i.test(selectedText)
    ? selectedText
    : '');
  linkError.value = null;
  linkEditorOpen.value = true;
  void nextTick(() => {
    linkInputEl.value?.focus();
    linkInputEl.value?.select();
  });
}

function validLinkUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol.toLowerCase();
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}

function applyLink() {
  const trimmed = linkUrl.value.trim();
  if (!validLinkUrl(trimmed)) {
    linkError.value = t('richTextEditor.enterAnHTTPHTTPSOrMailtoURL');
    void nextTick(() => linkInputEl.value?.focus());
    return;
  }
  runEditorCommand((editor) => {
    editor.makeLink(trimmed);
  });
  linkEditorOpen.value = false;
  linkError.value = null;
}

function removeLink() {
  runEditorCommand((editor) => editor.removeLink());
  linkEditorOpen.value = false;
  linkError.value = null;
}

function cancelLinkEditor() {
  linkEditorOpen.value = false;
  linkError.value = null;
  squire?.focus();
  restoreSelection();
}

function chooseImage(event: Event) {
  closeContainingDropdown(event);
  imageInsertError.value = null;
  rememberSelection();
  imageInputEl.value?.click();
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new LocalizedError('richTextEditor.pastedFileDidNotProduceADataURL'));
    };
    reader.onerror = () => reject(reader.error ?? new LocalizedError('richTextEditor.pastedFileCouldNotBeRead'));
    reader.readAsDataURL(file);
  });
}

async function decodeRaster(file: File, dataUrl: string): Promise<boolean> {
  if (typeof globalThis.createImageBitmap === 'function') {
    try {
      const bitmap = await globalThis.createImageBitmap(file);
      bitmap.close();
      return true;
    } catch {
      return false;
    }
  }
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = dataUrl;
  });
}

async function insertPickedImage(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  input.value = '';
  if (!file) return;
  if (!PICKABLE_IMAGE_TYPES.has(file.type.trim().toLowerCase())) {
    imageInsertError.value = t('richTextEditor.chooseAPNGJPEGGIFOrWebPImage');
    return;
  }
  if (file.size > MAX_INLINE_RASTER_BYTES) {
    imageInsertError.value = t('richTextEditor.chooseAnImageNoLargerThan10MiB');
    return;
  }

  try {
    const dataUrl = await readFileAsDataUrl(file);
    if (!await decodeRaster(file, dataUrl)) {
      imageInsertError.value = t('richTextEditor.thisImageCouldNotBeRead');
      return;
    }
    runEditorCommand((editor) => {
      editor.insertImage(dataUrl, {
        alt: file.name,
        style: 'max-width:100%;height:auto;',
      });
      editor.setTextAlignment('center');
    });
    imageInsertError.value = null;
  } catch {
    imageInsertError.value = t('richTextEditor.thisImageCouldNotBeRead');
  }
}

async function classifyAndInsertPastedFiles(files: readonly File[]): Promise<void> {
  const classified: PastedEditorFile[] = [];
  for (const file of files) {
    let dataUrl: string | null = null;
    if (isInlineRasterType(file.type) && file.size <= MAX_INLINE_RASTER_BYTES) {
      try {
        const read = await readFileAsDataUrl(file);
        if (await decodeRaster(file, read)) dataUrl = read;
      } catch {
        dataUrl = null;
      }
    }
    if (!dataUrl) {
      classified.push({ file, kind: 'attachment' });
      continue;
    }
    runEditorCommand((editor) => {
      editor.insertImage(dataUrl, { style: 'max-width:100%;height:auto;' });
      editor.setTextAlignment('center');
    });
    classified.push({ file, kind: 'inline' });
  }
  emit('paste-files', classified);
}

function handleNativePaste(event: ClipboardEvent): void {
  const clipboard = event.clipboardData;
  const itemFiles = clipboard?.items
    ? Array.from(clipboard.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    : [];
  const files = itemFiles.length > 0
    ? itemFiles
    : Array.from(clipboard?.files ?? []);
  if (files.length === 0) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  rememberSelection();
  const text = clipboard?.getData('text/plain') ?? '';
  if (text) {
    runEditorCommand((editor) => editor.insertPlainText(text, true));
  }
  void classifyAndInsertPastedFiles(files);
}

const LONE_URL_PATTERN = /^https?:\/\/\S+$/i;

// Files take the native paste-files path; text takes Squire's plain-text
// paste behaviour, where a lone URL over a selection links that selection.
function handleScriptedPaste(event: Event): void {
  const detail = scriptedPasteDetail(event);
  if (!detail || !squire) return;
  rememberSelection();
  if (detail.files && detail.files.length > 0) {
    void classifyAndInsertPastedFiles(detail.files);
    return;
  }
  const text = detail.text;
  if (!text) return;
  runEditorCommand((editor) => {
    const range = editor.getSelection();
    if (!range.collapsed && range.toString().trim() !== '' && LONE_URL_PATTERN.test(text)) {
      editor.makeLink(text);
    } else {
      editor.insertPlainText(text, true);
    }
  });
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
  ["Ctrl-b", "Ctrl-B", "Meta-b", "Meta-B"].forEach((key) => registerKeyboardShortcut(
    key,
    (editor, range) => toggleFormatInRange(editor, 'B', null, range),
  ));
  ["Ctrl-i", "Ctrl-I", "Meta-i", "Meta-I"].forEach((key) => registerKeyboardShortcut(
    key,
    (editor, range) => toggleFormatInRange(editor, 'I', null, range),
  ));
  ["Ctrl-u", "Ctrl-U", "Meta-u", "Meta-U"].forEach((key) => registerKeyboardShortcut(
    key,
    (editor, range) => toggleFormatInRange(editor, 'U', null, range),
  ));
  ["Ctrl-z", "Meta-z"].forEach((key) => registerKeyboardShortcut(key, (editor) => editor.undo()));
  ["Ctrl-y", "Meta-y", "Ctrl-Shift-z", "Ctrl-Shift-Z", "Meta-Shift-z", "Meta-Shift-Z"]
    .forEach((key) => registerKeyboardShortcut(key, (editor) => editor.redo()));
  ["Ctrl-k", "Meta-k"].forEach((key) => {
    squire?.setKeyHandler(key, (_editor, event, range) => {
      event.preventDefault();
      lastSelection = range.cloneRange();
      openLinkEditor();
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

/*
 * WAI-ARIA toolbar pattern (APG "Toolbar"): the toolbar is one Tab stop.
 * Exactly one top-level control carries tabindex="0" — the one focused most
 * recently — and Arrow Left/Right, Home and End move between them. Menu
 * items inside the dropdowns are not toolbar stops; a <details> hides them
 * until its summary is activated.
 */
const TOOLBAR_CONTROL_SELECTOR = "button, summary, input, select";
let toolbarTabStop: HTMLElement | null = null;

function toolbarControls(): HTMLElement[] {
  const toolbar = toolbarEl.value;
  if (!toolbar) return [];
  return [...toolbar.querySelectorAll<HTMLElement>(TOOLBAR_CONTROL_SELECTOR)]
    .filter((control) => !control.closest('.app-dropdown__menu'));
}

function syncToolbarTabStops() {
  const controls = toolbarControls();
  if (!toolbarTabStop || !controls.includes(toolbarTabStop)) {
    toolbarTabStop = controls[0] ?? null;
  }
  controls.forEach((control) => {
    const tabIndex = control === toolbarTabStop ? 0 : -1;
    if (control.tabIndex !== tabIndex) control.tabIndex = tabIndex;
  });
}

function onToolbarFocusIn(event: FocusEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !toolbarControls().includes(target)) return;
  toolbarTabStop = target;
  syncToolbarTabStops();
}

function onToolbarKeydown(event: KeyboardEvent) {
  const controls = toolbarControls();
  const from = controls.indexOf(event.target as HTMLElement);
  if (from === -1) return;
  const rtl = toolbarEl.value
    ? window.getComputedStyle(toolbarEl.value).direction === 'rtl'
    : false;
  const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
  const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
  let to: number;
  switch (event.key) {
    case forward: to = (from + 1) % controls.length; break;
    case backward: to = (from - 1 + controls.length) % controls.length; break;
    case 'Home': to = 0; break;
    case 'End': to = controls.length - 1; break;
    default: return;
  }
  event.preventDefault();
  controls[to].focus();
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
    imageInsertError.value = null;
    linkEditorOpen.value = false;
    linkError.value = null;
    void nextTick().then(reset);
  },
);

onMounted(() => {
  window.addEventListener('resize', scheduleToolbarOverflowUpdate);
  const initialHtml = pendingHtml ?? props.initialHtml;
  pendingHtml = null;
  initEditor(initialHtml);
  syncToolbarTabStops();
});

// Overflow re-renders toolbar groups; the single Tab stop has to survive it.
onUpdated(syncToolbarTabStops);

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
    <input
      ref="imageInputEl"
      hidden
      type="file"
      :accept="PICKABLE_IMAGE_ACCEPT"
      @change="insertPickedImage"
    >
    <div
      ref="toolbarEl"
      class="compose-toolbar"
      role="toolbar"
      :aria-label="t('richTextEditor.richTextFormatting')"
      @pointerdown.capture="rememberSelection"
      @focusin="onToolbarFocusIn"
      @keydown="onToolbarKeydown"
    >
      <div v-if="isToolbarGroupVisible('style')" class="toolbar-group" data-toolbar-group="style">
        <button
          type="button"
          class="toolbar-button"
          :class="{ active: toolbarState.bold }"
          :aria-label="t('richTextEditor.bold')"
          :aria-keyshortcuts="`${ariaShortcutModifier}+B`"
          :title="t('richTextEditor.boldB', { value1: shortcutModifier })"
          @mousedown.prevent
          @click="toggleFormat('B')"
        >
          <Bold :size="15" />
        </button>
        <button
          type="button"
          class="toolbar-button"
          :class="{ active: toolbarState.italic }"
          :aria-label="t('richTextEditor.italic')"
          :aria-keyshortcuts="`${ariaShortcutModifier}+I`"
          :title="t('richTextEditor.italicI', { value1: shortcutModifier })"
          @mousedown.prevent
          @click="toggleFormat('I')"
        >
          <Italic :size="15" />
        </button>
        <button
          type="button"
          class="toolbar-button"
          :class="{ active: toolbarState.underline }"
          :aria-label="t('richTextEditor.underline')"
          :aria-keyshortcuts="`${ariaShortcutModifier}+U`"
          :title="t('richTextEditor.underlineU', { value1: shortcutModifier })"
          @mousedown.prevent
          @click="toggleFormat('U')"
        >
          <Underline :size="15" />
        </button>
        <button
          type="button"
          class="toolbar-button"
          :class="{ active: toolbarState.strikethrough }"
          :aria-label="t('richTextEditor.strikethrough')"
          :title="t('richTextEditor.strikethrough')"
          @mousedown.prevent
          @click="toggleFormat('S')"
        >
          <Strikethrough :size="15" />
        </button>
      </div>

      <div v-if="isToolbarGroupVisible('font')" class="toolbar-group" data-toolbar-group="font">
        <AppDropdown class="toolbar-dropdown">
          <summary
            class="app-dropdown__summary toolbar-button toolbar-more__summary"
            :aria-label="t('richTextEditor.fontFamily')"
            :title="t('richTextEditor.fontFamily')"
            @mousedown.prevent
          >{{ fontFamilyLabel }}</summary>
          <div
            class="app-dropdown__menu toolbar-more__menu"
            role="menu"
            :aria-label="t('richTextEditor.fontFamily')"
          >
            <button
              v-for="font in fontFamilyChoices"
              :key="font.value"
              type="button"
              class="app-dropdown__item toolbar-menu-button"
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
            class="app-dropdown__summary toolbar-button toolbar-more__summary"
            :aria-label="t('richTextEditor.fontSize')"
            :title="t('richTextEditor.fontSize')"
            @mousedown.prevent
          >{{ fontSizeLabel }}</summary>
          <div
            class="app-dropdown__menu toolbar-more__menu"
            role="menu"
            :aria-label="t('richTextEditor.fontSize')"
          >
            <button
              v-for="size in fontSizeOptions"
              :key="size.value"
              type="button"
              class="app-dropdown__item toolbar-menu-button"
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
        <label class="toolbar-color" :title="t('richTextEditor.textColor')">
          <span>{{ t('richTextEditor.a') }}</span>
          <input
            type="color"
            :value="toolbarState.textColor"
            :aria-label="t('richTextEditor.textColor')"
            @mousedown="rememberSelection"
            @input="applyTextColor(($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="toolbar-color" :title="t('richTextEditor.highlightColor')">
          <Highlighter :size="15" />
          <input
            type="color"
            :value="toolbarState.highlightColor"
            :aria-label="t('richTextEditor.highlightColor')"
            @mousedown="rememberSelection"
            @input="applyHighlightColor(($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>

      <div
        v-if="isToolbarGroupVisible('insert')"
        class="toolbar-group"
        data-toolbar-group="insert"
        data-tour="image-tools"
      >
        <button
          type="button"
          class="toolbar-button"
          :aria-label="t('richTextEditor.insertImage')"
          :title="t('richTextEditor.insertImage')"
          @mousedown.prevent
          @click="chooseImage"
        >
          <ImageIcon :size="15" />
        </button>
        <button
          type="button"
          class="toolbar-button"
          :class="{ active: toolbarState.link }"
          :aria-label="t('richTextEditor.insertOrRemoveLink')"
          :aria-keyshortcuts="`${ariaShortcutModifier}+K`"
          :title="t('richTextEditor.insertOrRemoveLinkK', { value1: shortcutModifier })"
          @mousedown.prevent
          @click="openLinkEditor"
        >
          <LinkIcon :size="15" />
        </button>
      </div>

      <div v-if="isToolbarGroupVisible('lists')" class="toolbar-group" data-toolbar-group="lists">
        <button
          type="button"
          class="toolbar-button"
          :class="{ active: toolbarState.unorderedList }"
          :aria-label="t('richTextEditor.bulletedList')"
          :title="t('richTextEditor.bulletedList')"
          @mousedown.prevent
          @click="toggleList('UL')"
        >
          <List :size="15" />
        </button>
        <button
          type="button"
          class="toolbar-button"
          :class="{ active: toolbarState.orderedList }"
          :aria-label="t('richTextEditor.numberedList')"
          :title="t('richTextEditor.numberedList')"
          @mousedown.prevent
          @click="toggleList('OL')"
        >
          <ListOrdered :size="15" />
        </button>
        <button
          type="button"
          class="toolbar-button"
          :class="{ active: toolbarState.quote }"
          :aria-label="t('richTextEditor.quote')"
          :title="t('richTextEditor.quote')"
          @mousedown.prevent
          @click="adjustQuote(1)"
        >
          <Quote :size="15" class="icon-mirrored" />
        </button>
        <button
          type="button"
          class="toolbar-button"
          :aria-label="t('richTextEditor.unquote')"
          :title="t('richTextEditor.unquote')"
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
        <summary
          class="app-dropdown__summary toolbar-button toolbar-more__summary"
          @mousedown.prevent
        >
          {{ t('richTextEditor.more') }}
        </summary>
        <div
          class="app-dropdown__menu toolbar-more__menu"
          role="menu"
          :aria-label="t('richTextEditor.moreFormattingOptions')"
        >
          <div
            v-if="!isToolbarGroupVisible('font')"
            class="toolbar-menu-section"
            role="group"
            :aria-label="t('richTextEditor.fontFormatting')"
          >
            <span
              class="app-dropdown__heading toolbar-menu-heading"
              aria-hidden="true"
            >{{ t('richTextEditor.font') }}</span>
            <button
              v-for="font in fontFamilyChoices"
              :key="`font-${font.value}`"
              type="button"
              class="app-dropdown__item toolbar-menu-button"
              role="menuitemradio"
              :aria-checked="toolbarState.fontFamily === font.value"
              :aria-label="t('richTextEditor.font2', { value1: font.label })"
              @mousedown.prevent
              @click="applyFontFace(font.value)"
            >
              <Check v-if="toolbarState.fontFamily === font.value" :size="15" />
              <span v-else aria-hidden="true" />
              <span :style="font.value ? { fontFamily: font.value } : undefined">{{ font.label }}</span>
            </button>
            <span
              class="app-dropdown__heading toolbar-menu-heading"
              aria-hidden="true"
            >{{ t('richTextEditor.size') }}</span>
            <button
              v-for="size in fontSizeOptions"
              :key="`size-${size.value}`"
              type="button"
              class="app-dropdown__item toolbar-menu-button"
              role="menuitemradio"
              :aria-checked="toolbarState.fontSize === size.value"
              :aria-label="t('richTextEditor.size2', { value1: size.label })"
              @mousedown.prevent
              @click="applyFontSize(size.value)"
            >
              <Check v-if="toolbarState.fontSize === size.value" :size="15" />
              <span v-else aria-hidden="true" />
              <span>{{ size.label }}</span>
            </button>
            <label class="toolbar-menu-field">
              <span>{{ t('richTextEditor.textColor') }}</span>
              <input
                type="color"
                :value="toolbarState.textColor"
                :aria-label="t('richTextEditor.textColor')"
                @mousedown="rememberSelection"
                @input="applyTextColor(($event.target as HTMLInputElement).value)"
              />
            </label>
            <label class="toolbar-menu-field">
              <span>{{ t('richTextEditor.highlight') }}</span>
              <input
                type="color"
                :value="toolbarState.highlightColor"
                :aria-label="t('richTextEditor.highlightColor')"
                @mousedown="rememberSelection"
                @input="applyHighlightColor(($event.target as HTMLInputElement).value)"
              />
            </label>
          </div>

          <div
            v-if="!isToolbarGroupVisible('insert')"
            class="toolbar-menu-section"
            role="group"
            :aria-label="t('richTextEditor.insert')"
          >
            <button
              type="button"
              class="app-dropdown__item toolbar-menu-button"
              role="menuitem"
              @mousedown.prevent
              @click="chooseImage"
            >
              <ImageIcon :size="15" />
              <span>{{ t('richTextEditor.insertImage') }}</span>
            </button>
            <button
              type="button"
              class="app-dropdown__item toolbar-menu-button"
              role="menuitem"
              :aria-label="t('richTextEditor.insertOrRemoveLink')"
              :aria-keyshortcuts="`${ariaShortcutModifier}+K`"
              :title="t('richTextEditor.insertOrRemoveLinkK', { value1: shortcutModifier })"
              @mousedown.prevent
              @click="openLinkEditor"
            >
              <LinkIcon :size="15" />
              <span>{{ t('richTextEditor.link') }}</span>
            </button>
          </div>

          <div
            v-if="!isToolbarGroupVisible('lists')"
            class="toolbar-menu-section"
            role="group"
            :aria-label="t('richTextEditor.listsAndQuoting')"
          >
            <button
              type="button"
              class="app-dropdown__item toolbar-menu-button"
              role="menuitemcheckbox"
              :aria-checked="toolbarState.unorderedList"
              @mousedown.prevent
              @click="toggleList('UL')"
            >
              <Check v-if="toolbarState.unorderedList" :size="15" aria-hidden="true" />
              <span v-else aria-hidden="true" />
              <span>{{ t('richTextEditor.bulletedList') }}</span>
            </button>
            <button
              type="button"
              class="app-dropdown__item toolbar-menu-button"
              role="menuitemcheckbox"
              :aria-checked="toolbarState.orderedList"
              @mousedown.prevent
              @click="toggleList('OL')"
            >
              <Check v-if="toolbarState.orderedList" :size="15" aria-hidden="true" />
              <span v-else aria-hidden="true" />
              <span>{{ t('richTextEditor.numberedList') }}</span>
            </button>
            <button
              type="button"
              class="app-dropdown__item toolbar-menu-button"
              role="menuitem"
              @mousedown.prevent
              @click="adjustQuote(1)"
            >
              <Quote :size="15" class="icon-mirrored" />
              <span>{{ t('richTextEditor.quote') }}</span>
            </button>
            <button
              type="button"
              class="app-dropdown__item toolbar-menu-button"
              role="menuitem"
              @mousedown.prevent
              @click="adjustQuote(-1)"
            >
              <Quote :size="15" />
              <span>{{ t('richTextEditor.unquote') }}</span>
            </button>
          </div>

          <div
            v-if="!isToolbarGroupVisible('alignment')"
            class="toolbar-menu-section"
            role="group"
            :aria-label="t('richTextEditor.alignment')"
          >
            <button
              v-for="alignment in alignmentOptions"
              :key="alignment.value"
              type="button"
              class="app-dropdown__item toolbar-menu-button"
              role="menuitemradio"
              :aria-checked="toolbarState.alignment === alignment.value"
              @mousedown.prevent
              @click="runEditorCommand((editor) => editor.setTextAlignment(alignment.value))"
            >
              <Check v-if="toolbarState.alignment === alignment.value" :size="15" aria-hidden="true" />
              <span v-else aria-hidden="true" />
              <span>{{ alignment.label }}</span>
            </button>
          </div>

          <div class="toolbar-menu-section" role="group" :aria-label="t('richTextEditor.moreFormatting')">
            <button
              type="button"
              class="app-dropdown__item toolbar-menu-button"
              role="menuitemradio"
              :aria-checked="toolbarState.direction === 'ltr'"
              @mousedown.prevent
              @click="runEditorCommand((editor) => editor.setTextDirection('ltr'))"
            >
              <Check v-if="toolbarState.direction === 'ltr'" :size="15" aria-hidden="true" />
              <span v-else aria-hidden="true" />
              <span>{{ t('richTextEditor.leftToRight') }}</span>
            </button>
            <button
              type="button"
              class="app-dropdown__item toolbar-menu-button"
              role="menuitemradio"
              :aria-checked="toolbarState.direction === 'rtl'"
              @mousedown.prevent
              @click="runEditorCommand((editor) => editor.setTextDirection('rtl'))"
            >
              <Check v-if="toolbarState.direction === 'rtl'" :size="15" aria-hidden="true" />
              <span v-else aria-hidden="true" />
              <span>{{ t('richTextEditor.rightToLeft') }}</span>
            </button>
            <button
              type="button"
              class="app-dropdown__item toolbar-menu-button"
              role="menuitemcheckbox"
              :aria-checked="toolbarState.subscript"
              @mousedown.prevent
              @click="toggleFormat('SUB', { tag: 'SUP' })"
            >
              <Check v-if="toolbarState.subscript" :size="15" aria-hidden="true" />
              <span v-else aria-hidden="true" />
              <span>{{ t('richTextEditor.subscript') }}</span>
            </button>
            <button
              type="button"
              class="app-dropdown__item toolbar-menu-button"
              role="menuitemcheckbox"
              :aria-checked="toolbarState.superscript"
              @mousedown.prevent
              @click="toggleFormat('SUP', { tag: 'SUB' })"
            >
              <Check v-if="toolbarState.superscript" :size="15" aria-hidden="true" />
              <span v-else aria-hidden="true" />
              <span>{{ t('richTextEditor.superscript') }}</span>
            </button>
            <button
              type="button"
              class="app-dropdown__item toolbar-menu-button"
              role="menuitemcheckbox"
              :aria-checked="toolbarState.code"
              @mousedown.prevent
              @click="runEditorCommand((editor) => editor.toggleCode())"
            >
              <Check v-if="toolbarState.code" :size="15" aria-hidden="true" />
              <span v-else aria-hidden="true" />
              <span>{{ t('richTextEditor.code') }}</span>
            </button>
            <button
              type="button"
              class="app-dropdown__item toolbar-menu-button"
              role="menuitem"
              @mousedown.prevent
              @click="runEditorCommand((editor) => editor.removeAllFormatting())"
            >
              <RemoveFormatting :size="15" />
              <span>{{ t('richTextEditor.clearFormatting') }}</span>
            </button>
            <button
              type="button"
              class="app-dropdown__item toolbar-menu-button"
              :disabled="!toolbarState.canUndo"
              role="menuitem"
              :aria-label="t('richTextEditor.undo')"
              :aria-keyshortcuts="`${ariaShortcutModifier}+Z`"
              :title="t('richTextEditor.undoZ', { value1: shortcutModifier })"
              @mousedown.prevent
              @click="runEditorCommand((editor) => editor.undo())"
            >
              <Undo2 :size="15" />
              <span>{{ t('richTextEditor.undo') }}</span>
            </button>
            <button
              type="button"
              class="app-dropdown__item toolbar-menu-button"
              :disabled="!toolbarState.canRedo"
              role="menuitem"
              :aria-label="t('richTextEditor.redo')"
              :aria-keyshortcuts="`${ariaShortcutModifier}+Y ${ariaShortcutModifier}+Shift+Z`"
              :title="t('richTextEditor.redoYShiftZ', { value1: shortcutModifier, value2: shortcutModifier })"
              @mousedown.prevent
              @click="runEditorCommand((editor) => editor.redo())"
            >
              <Redo2 :size="15" />
              <span>{{ t('richTextEditor.redo') }}</span>
            </button>
          </div>
        </div>
      </AppDropdown>
    </div>

    <p v-if="imageInsertError" class="editor-image-error" role="alert">
      {{ imageInsertError }}
    </p>

    <form
      v-if="linkEditorOpen"
      class="editor-link-form"
      @submit.prevent="applyLink"
      @keydown.esc.prevent.stop="cancelLinkEditor"
    >
      <label class="editor-link-form__field">
        <span>{{ t('richTextEditor.linkURL') }}</span>
        <input
          ref="linkInputEl"
          v-model="linkUrl"
          type="url"
          inputmode="url"
          autocomplete="url"
          :placeholder="t('richTextEditor.httpsExampleCom')"
          :aria-invalid="linkError ? 'true' : undefined"
          :aria-describedby="linkError ? 'editor-link-error' : undefined"
        >
      </label>
      <p
        v-if="linkError"
        id="editor-link-error"
        class="editor-link-form__error"
        role="alert"
      >
        {{ linkError }}
      </p>
      <div class="editor-link-form__actions">
        <AppButton variant="outline" @click="cancelLinkEditor">
          {{ t('richTextEditor.cancel') }}
        </AppButton>
        <AppButton
          v-if="linkEditorHasLink"
          variant="outline"
          @click="removeLink"
        >
          {{ t('richTextEditor.removeLink') }}
        </AppButton>
        <AppButton form-action="submit">
          {{ t('richTextEditor.applyLink') }}
        </AppButton>
      </div>
    </form>

    <!-- Firefox puts scrollable boxes in the Tab sequence; the body inside
         is the stop, not its scroller. -->
    <div class="editor-wrap" tabindex="-1">
      <div
        ref="editorEl"
        class="editor"
        contenteditable="true"
        role="textbox"
        :aria-label="resolvedAccessibleLabel"
        :aria-describedby="ariaDescribedby"
        :aria-invalid="ariaInvalid ? 'true' : undefined"
        aria-multiline="true"
        @paste.capture="handleNativePaste"
        @scripted-paste="handleScriptedPaste"
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
.editor-image-error {
  margin: 0;
  color: var(--error-fg, #c93838);
  font-size: 12px;
}
.editor-link-form {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--control-border, #d6d9e2);
  border-radius: 6px;
  background: var(--panel2, #f5f6f8);
}
.editor-link-form__field {
  display: grid;
  gap: 5px;
}
.editor-link-form__field > span {
  color: var(--muted, #6b7388);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
.editor-link-form__field input {
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid var(--control-border, #d6d9e2);
  border-radius: 4px;
  background: var(--panel, #fff);
  color: var(--text, #1a1d24);
  font: inherit;
}
.editor-link-form__field input:focus-visible {
  border-color: var(--accent);
  outline: none;
}
.editor-link-form__error {
  margin: 0;
  color: var(--error-fg, #c93838);
  font-size: 12px;
}
.editor-link-form__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.compose-toolbar {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--control-border, #d6d9e2);
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
.toolbar-more__summary::after {
  margin-left: 5px;
}
.toolbar-more[open] .toolbar-more__summary {
  background: rgba(127, 127, 127, 0.18);
}
.toolbar-more__menu {
  left: auto;
  right: 0;
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
  font-size: 12px;
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
  border: 1px solid var(--control-border, #d6d9e2);
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
