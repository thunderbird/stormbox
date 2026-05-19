<script setup>
import {
  computed,
  watch,
  ref,
  onMounted,
  onUnmounted,
} from 'vue';
import DOMPurify from 'dompurify';
import {
  ArrowLeft, CornerUpLeft, Trash2, Paperclip,
  MailOpen, Mail, X,
} from 'lucide-vue-next';

import { useMailStore } from '../stores/mail-store.js';
import { useComposeStore } from '../stores/compose-store.js';
import {
  ALLOWED_URI_REGEXP,
  IFRAME_SANDBOX,
  buildMessageSrcDoc,
} from '../utils/message-html.js';

const mailStore = useMailStore();
const composeStore = useComposeStore();

const iframeRef = ref(null);
const iframeSrcDoc = ref('');
const iframeHeight = ref(120);
const effectiveColorScheme = ref(getEffectiveColorScheme());

const body = computed(() => mailStore.messageBody);
const message = computed(() =>
  // The messages array is positional and can carry explicit `undefined`
  // slots (sparse query_view_items, mid-shrink, etc.) — guard the slot
  // access so find() doesn't throw on a hole.
  mailStore.messages.find((m) => m?.id === mailStore.selectedMessageId) ?? null,
);

// Selection summary mode: clicking a row only opens it for reading
// (Fastmail model — `selectedMessageId` is the viewer pointer). The
// "selected" set is independent and driven only by the checkbox
// column. The moment the user checks even one row, this pane swaps
// from "read the focused message" to "act on the N selected ones"
// and shows a preview header for the focused row so the user can
// still see what they were last reading.
const selectionCount = computed(() => mailStore.selectedIds.size);
const isMultiSelecting = computed(() => selectionCount.value >= 1);

watch([body, effectiveColorScheme], ([next, colorScheme]) => {
  if (!next?.html) {
    iframeSrcDoc.value = '';
    iframeHeight.value = 120;
    return;
  }
  const sanitized = DOMPurify.sanitize(next.html, {
    ALLOWED_URI_REGEXP,
  });
  const nextSrcDoc = buildMessageSrcDoc(sanitized, { colorScheme });
  // Only reset the height when the srcdoc actually changes. The
  // mail-store fires `refreshMessageBody` twice per `selectMessage`
  // call (once immediately, once after the body-prefetch queue
  // resolves) — both runs assign a fresh body object with the same
  // content. Vue's reactive setter sees a new object reference and
  // re-runs this watch, but the computed srcdoc string is identical.
  // Setting `srcdoc` to the same string is a no-op in the DOM (the
  // iframe doesn't reload, so `load` never refires), and an
  // unconditional `iframeHeight = 120` reset would clobber the height
  // measure() already set — leaving the iframe stuck at 120 px on
  // every fresh open.
  if (nextSrcDoc === iframeSrcDoc.value) return;
  iframeSrcDoc.value = nextSrcDoc;
  iframeHeight.value = 120;
}, { immediate: true });

let resizeObserver = null;
let themeMediaQuery = null;
let themeMutationObserver = null;

function getEffectiveColorScheme() {
  if (typeof document !== 'undefined') {
    const theme = document.documentElement.getAttribute('data-theme');
    if (theme === 'dark' || theme === 'light') return theme;
  }

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  // The app's CSS defaults to dark unless a light preference/theme wins.
  return 'dark';
}

function updateEffectiveColorScheme() {
  effectiveColorScheme.value = getEffectiveColorScheme();
}

function teardownResizeObserver() {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
}

function teardownThemeObservers() {
  if (themeMediaQuery) {
    if (typeof themeMediaQuery.removeEventListener === 'function') {
      themeMediaQuery.removeEventListener('change', updateEffectiveColorScheme);
    } else if (typeof themeMediaQuery.removeListener === 'function') {
      themeMediaQuery.removeListener(updateEffectiveColorScheme);
    }
    themeMediaQuery = null;
  }

  if (themeMutationObserver) {
    themeMutationObserver.disconnect();
    themeMutationObserver = null;
  }
}

onMounted(() => {
  updateEffectiveColorScheme();

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    themeMediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    if (typeof themeMediaQuery.addEventListener === 'function') {
      themeMediaQuery.addEventListener('change', updateEffectiveColorScheme);
    } else if (typeof themeMediaQuery.addListener === 'function') {
      themeMediaQuery.addListener(updateEffectiveColorScheme);
    }
  }

  if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
    themeMutationObserver = new MutationObserver(updateEffectiveColorScheme);
    themeMutationObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }
});

onUnmounted(() => {
  teardownResizeObserver();
  teardownThemeObservers();
  iframeSrcDoc.value = '';
});

function onIframeLoad() {
  teardownResizeObserver();
  const iframe = iframeRef.value;
  if (!iframe) return;
  const doc = iframe.contentDocument;
  if (!doc?.body) return;

  // Open links in a new tab. Without allow-scripts the iframe cannot
  // do navigation on its own anyway, but anchor clicks still bubble
  // up to the parent's default handling — which would replace the
  // whole webmail tab. target=_blank + rel=noopener fixes that.
  doc.querySelectorAll('a[href]').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });

  const measure = () => {
    const docEl = doc.documentElement;
    const bodyEl = doc.body;
    // documentElement.scrollHeight catches content that overflows
    // the body (e.g. when an email sets html { height:100% }).
    let next = Math.max(docEl.scrollHeight, bodyEl.scrollHeight);

    // If the email's design is wider than the message-view pane, the
    // iframe will paint a horizontal scrollbar. We don't shrink the
    // email — the user explicitly asked to let a 640-px email be
    // 640-px and just put whitespace around it — but the horizontal
    // scrollbar eats ~17px of the iframe's content area, which would
    // otherwise force a vertical scrollbar INSIDE the iframe (we're
    // already growing the iframe to scrollHeight, so there should
    // never be a need for one). Add a small buffer so the
    // scrollbar has room without clipping the last line.
    const horizOverflow =
      (docEl.scrollWidth ?? 0) > (docEl.clientWidth ?? 0)
      || (bodyEl.scrollWidth ?? 0) > (bodyEl.clientWidth ?? 0);
    if (horizOverflow) next += 18;

    if (next && next !== iframeHeight.value) {
      iframeHeight.value = next;
    }
  };
  measure();

  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(doc.documentElement);
    resizeObserver.observe(doc.body);
  }
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  return Number.isNaN(d.valueOf()) ? '' : d.toLocaleString();
}

function backToList() {
  mailStore.selectMessage(null);
}

async function reply() {
  if (!message.value) return;
  composeStore.prepareReply({
    to: message.value.from_text ?? '',
    subject: makeReplySubject(message.value.subject),
    text: body.value?.text ?? '',
    html: body.value?.html ?? '',
  });
}

function makeReplySubject(subject) {
  const s = (subject ?? '').trim();
  if (/^re:/i.test(s)) return s;
  return s ? `Re: ${s}` : 'Re: (no subject)';
}

async function destroy() {
  if (!message.value) return;
  try {
    await mailStore.destroyMessage(message.value.id);
  } catch (err) {
    // The store has already populated mailStore.error with a
    // human-readable string in describeMutationFailure. Suppress the
    // unhandled-rejection so Vue does not log "Unhandled error during
    // execution of native event handler"; we have already surfaced
    // the failure to the user via mailStore.error.
    console.warn('[message-view] delete failed', err?.message ?? err);
  }
}

async function bulkMarkRead() {
  await mailStore.markManySeen([...mailStore.selectedIds], true);
}

async function bulkMarkUnread() {
  await mailStore.markManySeen([...mailStore.selectedIds], false);
}

async function bulkDelete() {
  const ids = [...mailStore.selectedIds];
  if (ids.length === 0) return;
  try {
    await mailStore.destroyMessages(ids);
  } catch (err) {
    console.warn('[message-view] bulk delete failed', err?.message ?? err);
  }
}

function clearBulkSelection() {
  mailStore.clearSelection();
}
</script>

<template>
  <section class="message-view" aria-label="Message detail">
    <div
      v-if="isMultiSelecting"
      class="message-view__bulk"
      aria-label="Selection summary"
    >
      <header class="message-view__bulk-header">
        <h2 class="message-view__bulk-title">
          {{ selectionCount }} {{ selectionCount === 1 ? 'message' : 'messages' }} selected
        </h2>
        <div class="message-view__bulk-actions">
          <button class="message-view__action" type="button" @click="bulkMarkRead" title="Mark as read">
            <MailOpen :size="16" :stroke-width="1.75" />
          </button>
          <button class="message-view__action" type="button" @click="bulkMarkUnread" title="Mark as unread">
            <Mail :size="16" :stroke-width="1.75" />
          </button>
          <button class="message-view__action message-view__action--danger" type="button" @click="bulkDelete" title="Delete">
            <Trash2 :size="16" :stroke-width="1.75" />
          </button>
          <button class="message-view__action message-view__action--ghost" type="button" @click="clearBulkSelection" title="Clear selection">
            <X :size="16" :stroke-width="1.75" />
          </button>
        </div>
      </header>
      <!-- The focused row's header is still shown so the user can see
           what they were last reading. Fastmail does the same: a
           "1 conversation selected" / "10 conversations selected"
           summary with the most recently viewed message's header
           inline. -->
      <article v-if="message" class="message-view__bulk-preview">
        <div class="message-view__bulk-from">{{ message.from_text }}</div>
        <div class="message-view__bulk-subject">{{ message.subject || '(no subject)' }}</div>
        <div class="message-view__bulk-date">{{ fmtDate(message.received_at) }}</div>
        <p v-if="message.preview" class="message-view__bulk-snippet">{{ message.preview }}</p>
      </article>
    </div>
    <div v-else-if="!message" class="message-view__empty">
      <p>Select a message to read it.</p>
    </div>
    <article v-else class="message-view__article">
      <header class="message-view__header">
        <button class="message-view__icon-btn" type="button" @click="backToList" aria-label="Back to list">
          <ArrowLeft :size="16" :stroke-width="1.75" />
        </button>
        <div class="message-view__title">
          <h2>{{ message.subject || '(no subject)' }}</h2>
          <p class="message-view__meta">
            <span class="message-view__from">{{ message.from_text }}</span>
            <span class="message-view__date">{{ fmtDate(message.received_at) }}</span>
          </p>
        </div>
        <div class="message-view__actions">
          <button class="message-view__action" type="button" @click="reply" title="Reply">
            <CornerUpLeft :size="16" :stroke-width="1.75" />
            <span>Reply</span>
          </button>
          <button class="message-view__action message-view__action--danger" type="button" @click="destroy" title="Delete">
            <Trash2 :size="16" :stroke-width="1.75" />
          </button>
        </div>
      </header>
      <div class="message-view__body">
        <iframe
          v-if="iframeSrcDoc"
          ref="iframeRef"
          class="message-view__html-frame"
          :srcdoc="iframeSrcDoc"
          :sandbox="IFRAME_SANDBOX"
          :style="{ height: `${iframeHeight}px` }"
          title="Message body"
          @load="onIframeLoad"
        />
        <pre v-else-if="body?.text" class="message-view__text">{{ body.text }}</pre>
        <p v-else class="message-view__placeholder">Loading message…</p>
        <ul v-if="body?.attachments?.length" class="message-view__attachments">
          <li v-for="a in body.attachments" :key="a.part_id">
            <Paperclip :size="14" :stroke-width="1.75" class="message-view__att-icon" />
            <span class="att-name">{{ a.name || '(unnamed)' }}</span>
            <span class="att-meta">{{ a.mime_type || '?' }}{{ a.size ? ` · ${Math.ceil(a.size / 1024)} KB` : '' }}</span>
          </li>
        </ul>
      </div>
    </article>
  </section>
</template>

<style scoped>
.message-view {
  /* The article (when a message is selected) or the empty placeholder
   * is the sole grid item here, and we want it to fill the column.
   * The header/body split lives one level down, on .message-view__article. */
  background: var(--panel);
  display: grid;
  grid-template-rows: 1fr;
  min-width: 0;
  min-height: 0;
  height: 100%;
}
.message-view__article {
  /* This is where the actual auto-header + 1fr-body split happens.
   * Without this, the body wrapper has unconstrained height (its
   * height = its content's height) and the overflow-y: auto rule
   * below has no overflow to act on — which is what made tall
   * marketing emails (e.g. PledgeBox) impossible to scroll. */
  display: grid;
  grid-template-rows: auto 1fr;
  min-height: 0;
}
.message-view__empty {
  display: grid;
  place-items: center;
  height: 100%;
  color: var(--muted);
}
.message-view__bulk {
  display: grid;
  grid-template-rows: auto auto 1fr;
  height: 100%;
  color: var(--text);
}
.message-view__bulk-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.message-view__bulk-title {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  text-align: center;
}
.message-view__bulk-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.message-view__bulk-preview {
  margin: 24px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto auto;
  column-gap: 12px;
  row-gap: 2px;
}
.message-view__bulk-from {
  grid-column: 1;
  grid-row: 1;
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.message-view__bulk-date {
  grid-column: 2;
  grid-row: 1;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.message-view__bulk-subject {
  grid-column: 1 / -1;
  grid-row: 2;
  font-weight: 600;
  font-size: 14px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.message-view__bulk-snippet {
  grid-column: 1 / -1;
  grid-row: 3;
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--muted);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.45;
}
.message-view__header {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.message-view__icon-btn {
  background: transparent;
  border: 0;
  border-radius: 8px;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  color: var(--muted);
  cursor: pointer;
  flex-shrink: 0;
}
.message-view__icon-btn:hover { background: var(--rowHover); color: var(--text); }
.message-view__title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.message-view__title h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.message-view__meta {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  display: flex;
  gap: 12px;
  align-items: baseline;
}
.message-view__from {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.message-view__date { flex-shrink: 0; font-variant-numeric: tabular-nums; }
.message-view__actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.message-view__action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: var(--text);
  padding: 7px 11px;
  border-radius: 8px;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
}
.message-view__action:hover { background: var(--rowHover); }
.message-view__action--danger:hover { background: rgba(255, 107, 107, 0.12); color: #ff6b6b; }
.message-view__action--ghost { color: var(--muted); }

.message-view__body {
  /* The iframe is the sole rendering path for HTML message bodies.
   * It carries its own document, so the body wrapper does not impose
   * any padding or width on it — that would re-introduce the
   * "every email looks the same width" feel by clipping the email's
   * intended layout. The iframe document owns the canvas color so
   * simple HTML can follow the app theme while styled emails keep
   * their own design. */
  padding: 0;
  overflow-y: auto;
  min-height: 0;
}
.message-view__html-frame {
  display: block;
  width: 100%;
  border: 0;
  /* Height is driven imperatively from onIframeLoad once the document
   * has laid out; min-height is just an initial reservation while the
   * srcdoc loads to keep the layout from jumping. The iframe's own
   * scrolling="auto" default takes care of the horizontal scrollbar
   * if the email is wider than the pane. */
  min-height: 120px;
  background: var(--panel);
}
.message-view__text {
  margin: 0;
  padding: 18px 22px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  color: var(--text);
}
.message-view__attachments {
  list-style: none;
  margin: 0;
  padding: 12px 22px 18px;
  border-top: 1px solid var(--border-soft);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.message-view__attachments li {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  padding: 6px 8px;
  border-radius: 6px;
}
.message-view__attachments li:hover { background: var(--rowHover); }
.message-view__att-icon { color: var(--muted); }
.att-name { font-weight: 500; color: var(--text); }
.att-meta { color: var(--muted); font-size: 12px; }
.message-view__placeholder { margin: 0; padding: 18px 22px; color: var(--muted); }
</style>
