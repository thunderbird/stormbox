<script setup lang="ts">
import {
  computed, nextTick, ref, watch,
} from 'vue';

import { useRecipientSuggestions } from '../composables/useRecipientSuggestions';
import {
  endsInsideAddress,
  formatAddress,
  parseAddressEntries,
  type ParsedAddress,
} from '../utils/address-parse';
import { addressKey } from '../utils/address-key';
import { isComposingKeyEvent } from '../utils/keyboard';
import { senderAvatarStyle, senderInitials } from '../utils/sender-avatar';
import type { RecipientEntry } from '../stores/compose-store';
import type { AutocompleteCandidate } from '../stores/contacts-store';

/**
 * One recipient field: committed recipients as pills, a text input for the
 * next one, and a suggestion list over the two.
 *
 * A pill is a recipient the user has finished with, which is what makes the
 * two states distinguishable at all — text in the field is being written,
 * a pill is decided. Anything committed that is not a readable address
 * becomes a pill too, marked invalid, because the alternative is dropping
 * a recipient or passing rubbish to the server as an address (CS-2.4). Any
 * pill reopens as the text it was entered as, so a typo is corrected where
 * it is rather than deleted and retyped (CS-3.16).
 */
const props = withDefaults(defineProps<{
  label: string;
  inputId: string;
  entries: readonly RecipientEntry[];
  /**
   * Suggestion source. Defaults to none, for callers with no directory.
   *
   * `exclude` is passed rather than filtered afterwards so that recipients
   * already entered do not consume places in a limited list (CS-3.7).
   */
  query?: (
    prefix: string, limit: number, exclude: string[],
  ) => Promise<AutocompleteCandidate[]>;
  /**
   * The whole address book, for the browse path CS-3.12 requires. All of
   * it: the control asks for no page size, because a browse list that ends
   * before the address book does silently hides the rest.
   */
  browseAll?: () => Promise<AutocompleteCandidate[]>;
  /** Addresses already committed elsewhere, which are not offered again. */
  taken?: readonly string[];
  /** How long to wait after a keystroke before querying. */
  debounceMs?: number;
}>(), {
  query: undefined,
  browseAll: undefined,
  taken: () => [],
  debounceMs: 120,
});

const emit = defineEmits<{
  'update:entries': [RecipientEntry[]];
  'update:pending-text': [string];
}>();

const text = ref('');
watch(text, (value) => emit('update:pending-text', value));
const inputEl = ref<HTMLInputElement | null>(null);
const pillsEl = ref<HTMLElement | null>(null);

function isInvalid(entry: RecipientEntry): boolean {
  return 'invalid' in entry;
}

/** What a pill reopens as: the address as written, or the text as typed. */
function entryText(entry: RecipientEntry): string {
  return 'invalid' in entry ? entry.text : formatAddress(entry);
}

function entryLabel(entry: RecipientEntry): string {
  if ('invalid' in entry) return entry.text;
  return entry.name?.trim() || entry.email;
}

/**
 * The whole accessible name of a pill. A pill's visible text is a display
 * name, which on its own does not say which address it stands for, and an
 * invalid one has to say so in words as well as in colour (WCAG 1.4.1).
 */
function entryDescription(entry: RecipientEntry): string {
  if ('invalid' in entry) return `${entry.text} — not a valid address`;
  const name = entry.name?.trim();
  return name ? `${name} <${entry.email}>` : entry.email;
}

const listboxId = computed(() => `${props.inputId}-listbox`);
const statusId = computed(() => `${props.inputId}-status`);
const optionId = (idx: number) => `${props.inputId}-option-${idx}`;

function suggestionContext(candidate: AutocompleteCandidate): string | null {
  const query = text.value.trim().toLocaleLowerCase();
  const organization = candidate.organization?.trim();
  if (!query || !organization) return null;
  if (candidate.name?.toLocaleLowerCase().includes(query)
      || candidate.email.toLocaleLowerCase().includes(query)) return null;
  return organization.toLocaleLowerCase().includes(query) ? organization : null;
}

/** The option's accessible name: who it is, not the row's decorations. */
function optionLabel(candidate: AutocompleteCandidate): string {
  const name = candidate.name?.trim();
  const address = name ? `${name} <${candidate.email}>` : candidate.email;
  const context = suggestionContext(candidate);
  return context ? `${address}, ${context}` : address;
}

/**
 * The same initials-on-a-hashed-hue circle the message list draws for a
 * sender, so one person is one color everywhere (see sender-avatar.ts).
 */
function avatarStyleFor(email: string): Record<string, string> {
  return senderAvatarStyle(email);
}

function avatarInitialsFor(candidate: { name?: string | null; email: string }): string {
  return senderInitials(candidate.name?.trim() || candidate.email);
}

function pillAvatarStyle(entry: RecipientEntry): Record<string, string> {
  return 'invalid' in entry ? {} : avatarStyleFor(entry.email);
}

function pillAvatarInitials(entry: RecipientEntry): string {
  return 'invalid' in entry ? '' : avatarInitialsFor(entry);
}

/**
 * How recently and often this contact appears in the bounded Sent window.
 */
function usageMeta(candidate: AutocompleteCandidate): string | null {
  const parts: string[] = [];
  const at = Number(candidate.last_sent_at);
  if (Number.isFinite(at) && at > 0) {
    const days = Math.floor((Date.now() - at) / 86_400_000);
    if (days < 1) parts.push('today');
    else if (days < 7) parts.push(`${days}d ago`);
    else if (days < 30) parts.push(`${Math.floor(days / 7)}w ago`);
    else if (days < 365) parts.push(`${Math.floor(days / 30)}mo ago`);
    else parts.push(`${Math.floor(days / 365)}y ago`);
  }
  const sends = Number(candidate.send_count);
  if (Number.isFinite(sends) && sends > 1) parts.push(`${sends} sends`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Split display text around the first occurrence of the typed text, so the
 * list can show why each row is here. Case-folded, display-level only —
 * membership was decided by the worker's key matching, and a row it
 * matched some other way (punycode, another word) simply shows unmarked.
 */
function matchSegments(displayText: string): { text: string; hit: boolean }[] {
  const typed = text.value.trim().toLowerCase();
  if (!typed) return [{ text: displayText, hit: false }];
  const idx = displayText.toLowerCase().indexOf(typed);
  if (idx < 0) return [{ text: displayText, hit: false }];
  const segments: { text: string; hit: boolean }[] = [];
  if (idx > 0) segments.push({ text: displayText.slice(0, idx), hit: false });
  segments.push({ text: displayText.slice(idx, idx + typed.length), hit: true });
  if (idx + typed.length < displayText.length) {
    segments.push({ text: displayText.slice(idx + typed.length), hit: false });
  }
  return segments;
}

/**
 * Everything already committed here or in a sibling field, keyed by
 * `addressKey` (CS-3.5) so an NFD or punycode spelling of a committed
 * address is recognized as the same recipient.
 *
 * This stays with recipient entries: the suggestion lifecycle only needs
 * their canonical keys and does not need to know the pill data model.
 */
const takenEmails = computed(() => new Set([
  ...props.entries
    .filter((entry): entry is ParsedAddress => !('invalid' in entry))
    .map((entry) => addressKey(entry.email)),
  ...props.taken.map((email) => addressKey(email)),
]));

const {
  suggestions,
  activeIndex,
  expanded,
  browsing,
  noMatches,
  isPanelOpen,
  resultSummary,
  countLabel,
  hasQueryPrefix,
  runQuery,
  scheduleQuery,
  browseContacts,
  closeList,
} = useRecipientSuggestions({
  text,
  takenEmails,
  getQuery: () => props.query,
  getBrowseAll: () => props.browseAll,
  getDebounceMs: () => props.debounceMs,
});

/**
 * Keep the highlighted option visible. aria-activedescendant moves the
 * screen reader's point of regard without moving DOM focus, so nothing
 * scrolls a capped-height list on its own and the visible highlight can
 * otherwise walk out of view.
 */
async function scrollActiveOptionIntoView(): Promise<void> {
  await nextTick();
  if (activeIndex.value < 0) return;
  document.getElementById(optionId(activeIndex.value))
    ?.scrollIntoView({ block: 'nearest' });
}

function commitEntries(next: RecipientEntry[]): void {
  emit('update:entries', next);
}

function onInput(): void {
  scheduleQuery();
}

/**
 * Commit whatever text is in the field, as one entry per address written.
 *
 * Everything committed goes through here, typed or pasted, so a paste of
 * ten addresses and a typed one are the same operation and neither can
 * lose a fragment (CS-3.11).
 */
function commitText(value = text.value): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const parsed = parseAddressEntries(trimmed);
  if (parsed.length === 0) {
    // Punctuation on its own — a stray comma — is nothing to commit and
    // nothing lost. Anything else that parses to no element at all is text
    // the user typed, and an empty group (`Team:;`) is legal enough to
    // reach here: it keeps a pill rather than disappearing out of the field.
    if (!/^[\s,;]+$/.test(trimmed)) {
      text.value = '';
      closeList();
      commitEntries([...props.entries, { text: trimmed, invalid: true }]);
      return true;
    }
    text.value = '';
    return false;
  }
  const next = [...props.entries];
  for (const element of parsed) {
    if ('rejected' in element) {
      next.push({ text: element.rejected, invalid: true });
      continue;
    }
    // The same address twice is one recipient; the server would collapse
    // them anyway, and a duplicate pill looks like a mistake. Keyed by
    // addressKey so a punycode or NFD respelling is the same recipient.
    const already = next.some(
      (entry) => !('invalid' in entry)
        && addressKey(entry.email) === addressKey(element.address.email),
    );
    if (!already) next.push(element.address);
  }
  text.value = '';
  closeList();
  commitEntries(next);
  return true;
}

function acceptSuggestion(candidate: AutocompleteCandidate): void {
  const name = candidate.name?.trim();
  const address: ParsedAddress = {
    ...(name ? { name } : {}),
    email: candidate.email,
  };
  commitText(formatAddress(address));
  focusInput();
}

/** Reopen a pill as text, which is how a mistyped recipient is corrected. */
function editEntry(index: number): void {
  const entry = props.entries[index];
  if (!entry) return;
  const reopened = entryText(entry);
  // Whatever was half-typed keeps its place after it, rather than being
  // thrown away or run together with it.
  const pending = text.value.trim();
  text.value = pending ? `${reopened}, ${pending}` : reopened;
  commitEntries(props.entries.filter((_, idx) => idx !== index));
  focusInput();
  scheduleQuery();
}

/**
 * Remove a pill, then put focus somewhere deliberate: the pill that took
 * its place, or the field. Removing the element that holds focus otherwise
 * drops focus to the document, which strands a keyboard user (CS-3.9).
 */
async function removeEntry(index: number): Promise<void> {
  const remaining = props.entries.filter((_, idx) => idx !== index);
  commitEntries(remaining);
  await nextTick();
  const next = pillsEl.value?.querySelectorAll<HTMLButtonElement>('.pill__remove');
  const target = next?.[Math.min(index, (next?.length ?? 0) - 1)];
  if (target) target.focus();
  else focusInput();
}

function focusInput(): void {
  inputEl.value?.focus();
}

async function browseContactsAndFocus(): Promise<void> {
  if (await browseContacts()) focusInput();
}

/**
 * What has been written ahead of the caret, which is the address a typed
 * separator would land in. The whole field stands in where the browser will
 * not say — a keystroke without a caret position is the end of the text.
 */
function textBeforeCaret(): string {
  const caret = inputEl.value?.selectionStart;
  return typeof caret === 'number' ? text.value.slice(0, caret) : text.value;
}

function onKeydown(event: KeyboardEvent): void {
  if (isComposingKeyEvent(event)) return;
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      if (suggestions.value.length === 0) {
        // Down opens the list, as a combobox does: the address book on an
        // empty field, and otherwise the matches for what is typed, which is
        // how the list comes back after Escape without typing another
        // character.
        if (event.key !== 'ArrowDown') return;
        event.preventDefault();
        const prefix = text.value.trim();
        if (hasQueryPrefix(prefix)) void runQuery(prefix);
        else void browseContactsAndFocus();
        return;
      }
      event.preventDefault();
      expanded.value = true;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const count = suggestions.value.length;
      // Results initially highlight the first option, so Down advances to
      // the second. Past either end, navigation wraps.
      activeIndex.value = activeIndex.value < 0
        ? (step === 1 ? 0 : count - 1)
        : (activeIndex.value + step + count) % count;
      void scrollActiveOptionIntoView();
      return;
    }
    case 'Enter': {
      // Enter takes the highlighted suggestion. The fallback covers a
      // transient list update before its initial highlight is installed.
      event.preventDefault();
      const candidate = suggestions.value[activeIndex.value] ?? suggestions.value[0];
      if (candidate) acceptSuggestion(candidate);
      else commitText();
      return;
    }
    case 'Tab': {
      // Leaves for the next field either way; what is typed comes with it.
      commitText();
      return;
    }
    case ',':
    case ';': {
      // The separators mean "that one is finished", which is a commit —
      // except where the address being written is still open, as inside the
      // quotes of `"Smith, Alice"`. There the character is part of the name
      // and typing it must not cut the recipient in two.
      if (endsInsideAddress(textBeforeCaret())) return;
      event.preventDefault();
      commitText();
      return;
    }
    case 'Escape': {
      // While the panel is open Escape dismisses it and the dialog stays,
      // which is the combobox pattern; with no panel open the key belongs
      // to whatever is listening above.
      if (isPanelOpen.value) {
        event.stopPropagation();
        event.preventDefault();
        closeList();
      }
      return;
    }
    case 'Backspace': {
      // An empty field means the caret is against the last pill, and
      // backspace over a recipient reopens it rather than deleting it
      // outright: it is nearly always a correction.
      if (text.value.length > 0 || props.entries.length === 0) return;
      event.preventDefault();
      editEntry(props.entries.length - 1);
      return;
    }
    default:
  }
}

/**
 * Leaving the field commits what is in it. Losing a typed address because
 * the user clicked Send rather than pressing Enter first is the whole
 * failure this control has to avoid.
 */
function onBlur(): void {
  commitText();
  closeList();
}

function onPaste(event: ClipboardEvent): void {
  const pasted = event.clipboardData?.getData('text/plain');
  if (!pasted) return;
  // Pasted text is committed rather than inserted: a paste is a finished
  // list, and newlines in a recipient field are not text a user meant to
  // keep typing into (CS-3.11).
  event.preventDefault();
  const combined = text.value.trim()
    ? `${text.value.trim()}, ${pasted}`
    : pasted;
  commitText(combined.replace(/[\r\n]+/g, ', '));
}

</script>

<template>
  <div class="recipient-input" :class="{ 'recipient-input--focused': isPanelOpen }">
    <div ref="pillsEl" class="recipient-input__field" @click="focusInput">
      <!-- The roles are spelled out because `display: contents` on the list
           drops list semantics from the accessibility tree in more than one
           browser, and "3 recipients" is the fact a screen reader is here
           for. -->
      <ul v-if="entries.length > 0" class="pills" role="list">
        <li
          v-for="(entry, idx) in entries"
          :key="`${entryText(entry)}-${idx}`"
          class="pill"
          :class="{ 'pill--invalid': isInvalid(entry) }"
          role="listitem"
        >
          <button
            type="button"
            class="pill__label"
            :aria-invalid="isInvalid(entry) ? 'true' : undefined"
            :aria-label="`${entryDescription(entry)}. Activate to edit.`"
            :title="entryDescription(entry)"
            @click.stop="editEntry(idx)"
          >
            <span v-if="isInvalid(entry)" class="pill__warning" aria-hidden="true">&#9888;</span>
            <span
              v-else
              class="pill__avatar"
              aria-hidden="true"
              :style="pillAvatarStyle(entry)"
            >{{ pillAvatarInitials(entry) }}</span>
            <span class="pill__text">{{ entryLabel(entry) }}</span>
          </button>
          <button
            type="button"
            class="pill__remove"
            :aria-label="`Remove ${entryDescription(entry)}`"
            @click.stop="removeEntry(idx)"
          >&times;</button>
        </li>
      </ul>
      <input
        :id="inputId"
        ref="inputEl"
        v-model="text"
        type="text"
        class="recipient-input__text"
        role="combobox"
        autocomplete="off"
        aria-autocomplete="list"
        :aria-expanded="isPanelOpen"
        :aria-controls="listboxId"
        :aria-activedescendant="activeIndex >= 0 ? optionId(activeIndex) : undefined"
        @input="onInput"
        @keydown="onKeydown"
        @blur="onBlur"
        @paste="onPaste"
      />
    </div>

    <div v-show="isPanelOpen" class="autocomplete">
      <!-- The browse control sits outside the listbox: an option list whose
           children are not all options is not a listbox any more, and a
           screen reader counts it among the matches. -->
      <ul
        :id="listboxId"
        class="autocomplete__options"
        role="listbox"
        :aria-label="`${label} suggestions`"
      >
        <li
          v-for="(candidate, idx) in suggestions"
          :id="optionId(idx)"
          :key="`${candidate.email}-${candidate.source}`"
          class="autocomplete__option"
          :class="{ 'autocomplete__option--active': idx === activeIndex }"
          role="option"
          :aria-selected="idx === activeIndex"
          :aria-label="optionLabel(candidate)"
          @mousedown.prevent
          @click="acceptSuggestion(candidate)"
        >
          <!-- Decorations are aria-hidden throughout: the option's name is
               the explicit aria-label, not its rendered contents. -->
          <span
            class="ac-avatar"
            aria-hidden="true"
            :style="avatarStyleFor(candidate.email)"
          >{{ avatarInitialsFor(candidate) }}</span>
          <span class="ac-lines">
            <span v-if="candidate.name?.trim()" class="ac-name">
              <template v-for="(seg, sidx) in matchSegments(candidate.name.trim())" :key="sidx">
                <span v-if="seg.hit" class="ac-match">{{ seg.text }}</span>
                <template v-else>{{ seg.text }}</template>
              </template>
            </span>
            <span class="ac-email" :class="{ 'ac-email--primary': !candidate.name?.trim() }">
              <template v-for="(seg, sidx) in matchSegments(candidate.email)" :key="sidx">
                <span v-if="seg.hit" class="ac-match">{{ seg.text }}</span>
                <template v-else>{{ seg.text }}</template>
              </template>
            </span>
            <span v-if="suggestionContext(candidate)" class="ac-context">
              <template
                v-for="(seg, sidx) in matchSegments(suggestionContext(candidate) ?? '')"
                :key="sidx"
              >
                <span v-if="seg.hit" class="ac-match">{{ seg.text }}</span>
                <template v-else>{{ seg.text }}</template>
              </template>
            </span>
          </span>
          <span v-if="usageMeta(candidate)" class="ac-meta" aria-hidden="true">
            {{ usageMeta(candidate) }}
          </span>
        </li>
      </ul>
      <!-- Visible-only: the live region already says this in words, so the
           panel copy is decoration to a screen reader. -->
      <div v-if="noMatches !== null" class="autocomplete__empty" aria-hidden="true">
        <span class="autocomplete__empty-text">No matches for “{{ noMatches }}”</span>
        <span class="ac-key-hint"><kbd>↵</kbd> add it as typed</span>
      </div>
      <p v-if="browseAll && !browsing" class="autocomplete__browse">
        <button type="button" @mousedown.prevent @click="browseContactsAndFocus()">
          Browse all contacts
        </button>
      </p>
      <div v-if="suggestions.length > 0" class="autocomplete__keys" aria-hidden="true">
        <span class="ac-key-hint"><kbd>↑↓</kbd> navigate</span>
        <span class="ac-key-hint"><kbd>↵</kbd> add</span>
        <span class="autocomplete__count">{{ countLabel }}</span>
      </div>
    </div>

    <!-- A live region, and deliberately not this field's `aria-describedby`:
         a description is read when the field is entered, and "3 suggestions
         available" is not a description of a recipient field. -->
    <p :id="statusId" class="sr-only" role="status">{{ resultSummary }}</p>
  </div>
</template>

<style scoped>
.recipient-input {
  position: relative;
  flex: 1;
  min-width: 0;
}

/* Tokens come from src/assets/styles.css; the fallbacks are the light
   palette, for a host that provides none. */
.recipient-input__field {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  border: 1px solid var(--border, #cfcfcf);
  border-radius: 4px;
  background: var(--panel2, #fff);
  cursor: text;
}

.recipient-input__field:focus-within {
  border-color: var(--accent, #0060df);
  outline: 2px solid color-mix(in srgb, var(--accent, #0060df) 35%, transparent);
  outline-offset: -1px;
}

.pills {
  display: contents;
  list-style: none;
  margin: 0;
  padding: 0;
}

.pill {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  border-radius: 999px;
  /* A wash of the theme's own text colour reads as a raised chip on any
     surface, in either theme. */
  background: color-mix(in srgb, var(--text, #111827) 9%, transparent);
  font-size: 0.85rem;
  line-height: 1.4;
}

.pill__label,
.pill__remove {
  border: 0;
  background: none;
  padding: 1px 4px 1px 8px;
  font: inherit;
  color: inherit;
  cursor: pointer;
  border-radius: 999px;
}

.pill__remove {
  padding: 1px 7px 1px 4px;
  opacity: 0.6;
}

.pill__remove:hover { opacity: 1; }

.pill__label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
}

.pill__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * Invalid is carried by the warning glyph and the dotted underline as well
 * as by the colour, per WCAG 1.4.1: colour alone is not a message.
 */
.pill--invalid {
  background: var(--error-bg, rgba(200, 30, 30, 0.1));
  color: var(--error-fg, #a4000f);
}

.pill--invalid .pill__text {
  text-decoration: underline dotted currentcolor;
  text-underline-offset: 2px;
}

.pill__warning {
  font-size: 0.9em;
}

.pill__avatar {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  color: #fff;
  font-size: 8px;
  font-weight: 700;
  flex: none;
}

.recipient-input__text {
  flex: 1;
  min-width: 8ch;
  border: 0;
  padding: 3px 2px;
  background: none;
  font: inherit;
  color: inherit;
}

.recipient-input__text:focus { outline: none; }

.autocomplete {
  position: absolute;
  z-index: 10;
  left: 0;
  right: 0;
  margin: 2px 0 0;
  background: var(--panel, #fff);
  border: 1px solid var(--border, #cfcfcf);
  border-radius: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}

.autocomplete__options {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 19rem;
  overflow-y: auto;
}

.autocomplete__option {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 6px 10px;
  cursor: pointer;
}

/* The same hover/selected pair the message list uses, so the two lists
   read as one system. Active sits above hover. */
.autocomplete__option:hover {
  background: var(--rowHover, rgba(0, 96, 223, 0.08));
}

.autocomplete__option--active {
  background: var(--rowActive, rgba(0, 96, 223, 0.12));
}

/* The message list's sender circle at list size: initials on a hue hashed
   from the address (senderAvatarStyle), one color per person everywhere. */
.ac-avatar {
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

.ac-lines {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.ac-name {
  font-weight: 600;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-email {
  font-size: 12px;
  line-height: 1.3;
  color: var(--muted, #6b7280);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ac-context {
  font-size: 11px;
  line-height: 1.3;
  color: var(--muted, #6b7280);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A row with no display name shows the address as its one line. */
.ac-email--primary {
  font-size: inherit;
  color: inherit;
  font-weight: 600;
}

/* Why the row is here: the typed text, wherever it landed. */
.ac-match {
  color: var(--accent, #0060df);
}

.ac-meta {
  font-size: 11px;
  color: var(--muted, #6b7280);
  flex: none;
}

.autocomplete__browse {
  margin: 0;
  border-top: 1px solid var(--border, #cfcfcf);
}

.autocomplete__browse button {
  width: 100%;
  text-align: left;
  border: 0;
  background: none;
  padding: 6px 10px;
  font: inherit;
  color: var(--accent, #0060df);
  cursor: pointer;
}

.autocomplete__empty {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  font-size: 12px;
  color: var(--muted, #6b7280);
}

.autocomplete__empty-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.autocomplete__keys {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 5px 10px;
  border-top: 1px solid var(--border, #cfcfcf);
  font-size: 11px;
  color: var(--muted, #6b7280);
}

.autocomplete__count {
  margin-left: auto;
}

.ac-key-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
}

.ac-key-hint kbd {
  font: inherit;
  font-size: 10px;
  line-height: 16px;
  padding: 0 5px;
  border: 1px solid var(--border, #cfcfcf);
  border-radius: 4px;
  color: var(--text, #111827);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
</style>
