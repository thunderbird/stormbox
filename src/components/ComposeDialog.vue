<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  Bold,
  Code,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListIndentDecrease,
  ListIndentIncrease,
  ListOrdered,
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
} from 'lucide-vue-next';
import DOMPurify from 'dompurify';
import Squire from 'squire-rte';

import { useComposeStore } from '../stores/compose-store.js';
import { useContactsStore } from '../stores/contacts-store.js';
import { COMPOSE_STATE } from '../constants/states.js';

const composeStore = useComposeStore();
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
const toolbarGroupWidths = new Map();
let currentPath = '';

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
    range = null;
  }

  const path = pathOverride ?? squire.getPath();
  currentPath = path;
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

function handleEditorInput() {
  syncDraftFromEditor();
  rememberSelection();
  updateToolbarState();
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
    if (type === 'UL') {
      /(?:^|>)UL/.test(path) ? editor.removeList() : editor.makeUnorderedList();
    } else {
      /(?:^|>)OL/.test(path) ? editor.removeList() : editor.makeOrderedList();
    }
  });
}

function adjustIndent(delta: number) {
  runEditorCommand((editor: any) => {
    const path = editor.getPath();
    const inList = /(?:^|>)[OU]L/.test(path);
    const inQuote = /(?:^|>)BLOCKQUOTE/.test(path);

    if (delta > 0) {
      inList && !inQuote ? editor.increaseListLevel() : editor.increaseQuoteLevel();
    } else {
      inList && !inQuote ? editor.decreaseListLevel() : editor.decreaseQuoteLevel();
    }
  });
}

function applyFontFace(value: string) {
  runEditorCommand((editor: any) => editor.setFontFace(value || null));
}

function applyFontSize(value: string) {
  runEditorCommand((editor: any) => editor.setFontSize(value || null));
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
  squire?.destroy?.();
  squire = null;
  lastSelection = null;
  currentPath = '';
}

function initEditor() {
  if (!editorEl.value) return;
  destroyEditor();
  ensureSquireSanitizer();
  squire = new Squire(editorEl.value);
  squire.setHTML(composeStore.draft.htmlBody || '<p><br></p>');
  registerKeyboardShortcuts();
  squire.addEventListener('input', handleEditorInput);
  squire.addEventListener('pathChange', handleSquirePathChange);
  squire.addEventListener('select', handlePathChange);
  squire.addEventListener('cursor', handlePathChange);
  squire.addEventListener('undoStateChange', handleUndoStateChange);
  updateToolbarState();
  scheduleToolbarOverflowUpdate();
  observeToolbarSize();
}

onMounted(() => {
  window.addEventListener('resize', scheduleToolbarOverflowUpdate);
  if (composeStore.isOpen) {
    void nextTick().then(initEditor);
  }
});

watch(() => composeStore.isOpen, (open) => {
  if (open) {
    void nextTick().then(initEditor);
  } else {
    destroyEditor();
  }
});

onUnmounted(() => {
  window.removeEventListener('resize', scheduleToolbarOverflowUpdate);
  destroyEditor();
});

const autocompleteSuggestions = ref([]);
const autocompleteFor = ref(null);

async function onRecipientInput(field) {
  autocompleteFor.value = field;
  const value = composeStore.draft[field];
  const lastTokenMatch = value.match(/(?:^|,)\s*([^,]+)$/);
  const prefix = (lastTokenMatch?.[1] ?? '').trim();
  if (prefix.length < 2) {
    autocompleteSuggestions.value = [];
    return;
  }
  autocompleteSuggestions.value = await contactsStore.autocomplete(prefix, 8);
}

function applySuggestion(field: 'to' | 'cc' | 'bcc', candidate: any) {
  const value = composeStore.draft[field];
  const lastTokenIdx = value.lastIndexOf(',');
  const prefix = lastTokenIdx >= 0 ? value.slice(0, lastTokenIdx + 1) + ' ' : '';
  const formatted = candidate.name
    ? `${candidate.name} <${candidate.email}>`
    : candidate.email;
  composeStore.draft[field] = `${prefix}${formatted}, `;
  autocompleteSuggestions.value = [];
}

async function send() {
  await composeStore.send();
}
</script>

<template>
  <div v-if="composeStore.isOpen" class="compose-dialog" role="dialog" aria-label="Compose">
    <div class="compose-dialog__card">
      <header>
        <h2>{{ composeStore.draft.subject || 'New Message' }}</h2>
        <button type="button" class="icon" @click="composeStore.close()" aria-label="Close">×</button>
      </header>

      <div class="row">
        <label>From</label>
        <select v-model="composeStore.draft.fromIdx">
          <option v-for="(id, idx) in composeStore.identities" :key="id.id" :value="idx">
            {{ id.name ? `${id.name} <${id.email}>` : id.email }}
          </option>
        </select>
      </div>

      <div class="row">
        <label>To</label>
        <input
          type="text"
          v-model="composeStore.draft.to"
          @input="onRecipientInput('to')"
          autocomplete="off"
        />
      </div>
      <ul v-if="autocompleteFor === 'to' && autocompleteSuggestions.length > 0" class="autocomplete">
        <li v-for="s in autocompleteSuggestions" :key="`${s.email}-${s.source}`">
          <button type="button" @click="applySuggestion('to', s)">
            <span class="ac-name">{{ s.name || s.email }}</span>
            <span class="ac-email">{{ s.email }}</span>
            <span class="ac-source">{{ s.source }}</span>
          </button>
        </li>
      </ul>

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
          <select
            class="toolbar-select"
            :value="toolbarState.fontFamily"
            aria-label="Font family"
            title="Font family"
            @mousedown="rememberSelection"
            @change="applyFontFace(($event.target as HTMLInputElement | HTMLSelectElement).value)"
          >
            <option value="">Font</option>
            <option v-for="font in fontOptions" :key="font.value" :value="font.value">
              {{ font.label }}
            </option>
          </select>
          <select
            class="toolbar-select toolbar-select--size"
            :value="toolbarState.fontSize"
            aria-label="Font size"
            title="Font size"
            @mousedown="rememberSelection"
            @change="applyFontSize(($event.target as HTMLInputElement | HTMLSelectElement).value)"
          >
            <option value="">Size</option>
            <option v-for="size in fontSizeOptions" :key="size.value" :value="size.value">
              {{ size.label }}
            </option>
          </select>
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
            aria-label="Decrease quote or list indent"
            title="Decrease quote or list indent"
            @mousedown.prevent
            @click="adjustIndent(-1)"
          >
            <ListIndentDecrease :size="15" />
          </button>
          <button
            type="button"
            class="toolbar-button"
            :class="{ active: toolbarState.quote }"
            aria-label="Increase quote or list indent"
            title="Increase quote or list indent"
            @mousedown.prevent
            @click="adjustIndent(1)"
          >
            <ListIndentIncrease :size="15" />
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

        <details class="toolbar-more">
          <summary class="toolbar-button toolbar-more__summary" @mousedown.prevent>
            More
          </summary>
          <div class="toolbar-more__menu" role="menu" aria-label="More formatting options">
            <div v-if="!isToolbarGroupVisible('font')" class="toolbar-menu-section" role="group" aria-label="Font formatting">
              <label class="toolbar-menu-field">
                <span>Font</span>
                <select
                  :value="toolbarState.fontFamily"
                  aria-label="Font family"
                  @mousedown="rememberSelection"
                  @change="applyFontFace(($event.target as HTMLInputElement | HTMLSelectElement).value)"
                >
                  <option value="">Default</option>
                  <option v-for="font in fontOptions" :key="font.value" :value="font.value">
                    {{ font.label }}
                  </option>
                </select>
              </label>
              <label class="toolbar-menu-field">
                <span>Size</span>
                <select
                  :value="toolbarState.fontSize"
                  aria-label="Font size"
                  @mousedown="rememberSelection"
                  @change="applyFontSize(($event.target as HTMLInputElement | HTMLSelectElement).value)"
                >
                  <option value="">Default</option>
                  <option v-for="size in fontSizeOptions" :key="size.value" :value="size.value">
                    {{ size.label }}
                  </option>
                </select>
              </label>
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

            <div v-if="!isToolbarGroupVisible('lists')" class="toolbar-menu-section" role="group" aria-label="Lists and indentation">
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
                role="menuitem"
                @mousedown.prevent
                @click="adjustIndent(-1)"
              >
                <ListIndentDecrease :size="15" />
                <span>Decrease indent</span>
              </button>
              <button
                type="button"
                class="toolbar-menu-button"
                :class="{ active: toolbarState.quote }"
                role="menuitem"
                @mousedown.prevent
                @click="adjustIndent(1)"
              >
                <ListIndentIncrease :size="15" />
                <span>Increase indent</span>
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
        </details>
      </div>

      <div class="editor-wrap">
        <div ref="editorEl" class="editor" contenteditable="true" />
      </div>

      <footer>
        <button type="button" class="secondary" @click="composeStore.close()">Discard</button>
        <button type="button" class="primary" :disabled="composeStore.status === COMPOSE_STATE.SENDING" @click="send">
          {{ composeStore.status === COMPOSE_STATE.SENDING ? 'Sending…' : 'Send' }}
        </button>
      </footer>

      <p v-if="composeStore.error" class="compose-error">{{ composeStore.error }}</p>
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
.row input, .row select {
  padding: 7px 10px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 8px;
  font-size: 14px;
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
.toolbar-select,
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
.toolbar-select:hover,
.toolbar-color:hover {
  background: rgba(127, 127, 127, 0.18);
}
.toolbar-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.toolbar-select {
  max-width: 76px;
  padding: 0 4px;
  cursor: pointer;
  font-size: 12px;
}
.toolbar-select--size {
  max-width: 70px;
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
  min-height: 100%;
  outline: none;
  font-size: 14px;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.primary { background: #2563eb; color: #fff; border: 0; padding: 8px 14px; border-radius: 8px; cursor: pointer; }
.secondary { background: transparent; color: #555; border: 1px solid var(--border, #d6d9e2); padding: 8px 14px; border-radius: 8px; cursor: pointer; }
.autocomplete {
  margin: 0 0 0 78px;
  padding: 0;
  list-style: none;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 8px;
  max-height: 200px;
  overflow-y: auto;
}
.autocomplete button {
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
  padding: 8px 10px;
  cursor: pointer;
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 8px;
  align-items: baseline;
}
.autocomplete button:hover { background: rgba(0, 0, 0, 0.04); }
.ac-name { font-size: 13px; }
.ac-email { font-size: 12px; color: var(--muted, #6b7388); }
.ac-source { font-size: 11px; color: var(--muted, #6b7388); text-transform: uppercase; }
.compose-error { color: #b3261e; font-size: 13px; }
</style>
