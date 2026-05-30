<script setup lang="ts">
import {
  computed,
  nextTick,
  watch,
  ref,
  onMounted,
  onUnmounted,
} from 'vue';
import DOMPurify from 'dompurify';
import {
  Trash2, Paperclip,
  MailOpen, Mail, X, ArrowLeft, Sun, Moon,
} from '@lucide/vue';

import { useMailStore } from '../stores/mail-store';
import { useComposeStore } from '../stores/compose-store';
import { invokeThunderbirdShortcut } from '../composables/useThunderbirdShortcuts';
import {
  ALLOWED_URI_REGEXP,
  IFRAME_SANDBOX,
  buildMessageSrcDoc,
  isInlineImageType,
  normalizeContentId,
  referencedContentIds,
  sanitizeMessageHtml,
} from '../utils/message-html';
import { adaptHtmlForDarkMode } from '../utils/dark-email';
import { plaintextToHtml } from '../utils/plaintext-html';
import archiveIcon from '../assets/icons/tb-folder-archive.svg?raw';
import forwardIcon from '../assets/icons/tb-forward.svg?raw';
import replyIcon from '../assets/icons/tb-reply.svg?raw';
import replyAllIcon from '../assets/icons/tb-reply-all.svg?raw';

// Minimum logical width we lay HTML email out at before scaling down.
// Reflowing typical marketing HTML below this gets visually messy
// (image-heavy headers collapse, multi-column tables stack awkwardly,
// inline buttons overlap). Below this shell width we therefore treat
// content as if it has at least this width and apply CSS zoom to fit,
// even when scrollWidth would technically not overflow.
const MIN_EMAIL_LAYOUT_WIDTH = 400;

defineProps<{
  spotlightActions?: boolean;
}>();

const mailStore = useMailStore();
const composeStore = useComposeStore();

const bodyRef = ref(null);
const htmlShellRef = ref(null);
const iframeRef = ref(null);
const iframeSrcDoc = ref('');
const iframeHeight = ref(120);
const effectiveColorScheme = ref(getEffectiveColorScheme());
// Allow the user to disable dark mode in the message view only,
// independently of the global theme toggle. Resets when the open message
// changes so it's not a sticky preference.
const forceLightBody = ref(false);

// App theme, unless this one message has been escaped to light.
const bodyColorScheme = computed(() =>
  (effectiveColorScheme.value === 'dark' && forceLightBody.value)
    ? 'light'
    : effectiveColorScheme.value);

const body = computed(() => mailStore.messageBody);
const referencedInlineContentIds = computed(() => referencedContentIds(body.value?.html ?? ''));

// Render plaintext bodies the way Thunderbird Desktop does: keep the
// original line breaks/whitespace (white-space: pre-wrap), linkify URLs
// and addresses, and tag quoted lines. The converter only emits escaped
// text plus our own anchor/span tags, but we still sanitize for defence
// in depth (and to keep target/rel on the generated links).
const textHtml = computed(() => {
  const raw = body.value?.text;
  if (!raw) return '';
  return DOMPurify.sanitize(plaintextToHtml(raw), {
    ALLOWED_URI_REGEXP,
    ADD_ATTR: ['target'],
  });
});
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
// from "read the focused message" to a scrollable list of every
// checked row plus bulk actions.
const selectionCount = computed(() => mailStore.selectedIds.size);
const isMultiSelecting = computed(() => selectionCount.value >= 1);
let resizeObserver = null;
let iframeMeasurementCleanup = null;
let themeMediaQuery = null;
let themeMutationObserver = null;
// Monotonic guard so an async inline-image render can detect that a newer
// body/scheme render has superseded it.
let renderToken = 0;

// Walk the folder list in display order so the summary matches the
// message list top-to-bottom, not arbitrary Set iteration order.
const selectedMessages = computed(() => {
  if (!mailStore.selectedIds.size) return [];
  const out = [];
  for (const row of mailStore.messages) {
    if (row?.id != null && mailStore.selectedIds.has(row.id)) {
      out.push(row);
    }
  }
  return out;
});

function isReferencedInlinePart(part) {
  const cid = normalizeContentId(part?.cid);
  return !!cid && referencedInlineContentIds.value.has(cid);
}

const visibleAttachments = computed(() => {
  const attachments = body.value?.attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.filter((part) => !isReferencedInlinePart(part));
});

function applyHtmlSrcDoc(html, colorScheme) {
  const nextSrcDoc = buildMessageSrcDoc(html, { colorScheme });
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
  teardownResizeObserver();
  iframeSrcDoc.value = nextSrcDoc;
  iframeHeight.value = initialIframeHeight();
  nextTick(() => {
    if (iframeSrcDoc.value === nextSrcDoc) {
      iframeHeight.value = Math.max(iframeHeight.value, initialIframeHeight());
    }
  });
}

// Resolve inline `cid:` image references to data: URLs. We only fetch
// parts that (a) belong to this message, (b) are an allowed raster image
// type, and (c) are actually referenced by the body. Any other cid is
// left untouched — it renders broken and never triggers a request.
async function resolveCidImageUrls(next) {
  const map = new Map<string, string>();
  const html = next?.html;
  const parts = next?.attachments;
  if (!html || !Array.isArray(parts)) return map;
  const referenced = referencedContentIds(html);
  for (const part of parts) {
    const cid = normalizeContentId(part?.cid);
    const blobId = part?.blob_id;
    if (!cid || !blobId || !isInlineImageType(part?.mime_type)) continue;
    if (!referenced.has(cid)) continue;
    const url = await mailStore.loadInlineImageUrl(blobId, part.mime_type, part.name);
    if (url) map.set(cid, url);
  }
  return map;
}

async function renderHtmlBody(next, colorScheme) {
  if (!next?.html) {
    teardownResizeObserver();
    iframeSrcDoc.value = '';
    iframeHeight.value = 120;
    return;
  }
  // Guard against a newer body/scheme starting to render while we await
  // inline-image blob downloads, so a fast selection change can't paint
  // a stale message.
  const myToken = (renderToken += 1);
  const cidUrls = await resolveCidImageUrls(next);
  if (myToken !== renderToken) return;
  // Adapt for dark before building the srcdoc, so the first paint is already
  // dark-correct and never flashes the un-themed email (see dark-email.ts).
  const safeHtml = sanitizeMessageHtml(next.html, cidUrls);
  const themedHtml = colorScheme === 'dark' ? adaptHtmlForDarkMode(safeHtml) : safeHtml;
  applyHtmlSrcDoc(themedHtml, colorScheme);
}

watch([body, bodyColorScheme], ([next, colorScheme]) => {
  void renderHtmlBody(next, colorScheme);
}, { immediate: true });

watch(() => mailStore.selectedMessageId, () => {
  forceLightBody.value = false;
});

// Only offered in dark mode for HTML bodies; plain text already follows the
// readable app theme.
const canForceLightBody = computed(() =>
  effectiveColorScheme.value === 'dark' && !!iframeSrcDoc.value);

function toggleBodyLightMode() {
  forceLightBody.value = !forceLightBody.value;
}

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
  iframeMeasurementCleanup?.();
  iframeMeasurementCleanup = null;
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

function initialIframeHeight() {
  return Math.max(120, bodyRef.value?.clientHeight ?? 0);
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

  const onIframeKeyDown = (event: KeyboardEvent) => {
    invokeThunderbirdShortcut(event);
  };
  doc.addEventListener('keydown', onIframeKeyDown, true);

  let active = true;
  let rafScheduled = false;
  const docEl = doc.documentElement;
  const bodyEl = doc.body;

  // Apply a fit ratio against the *current* iframe viewport. We
  // deliberately re-measure on every call (and never observe the
  // iframe document directly): caching a "natural" width from one
  // viewport size and re-using it at another viewport produced
  // unpredictable zoom values for responsive content, because text
  // and other reflowable elements report scrollWidth == viewport at
  // the moment of measurement rather than their true min-content
  // width.
  //
  // Clearing `zoom` before measuring ensures scrollWidth reflects the
  // content's preferred width at the current viewport, independent of
  // any prior fit we applied. The browser only commits one frame per
  // animation tick, so the transient zoom=1 reset is not visible.
  //
  // The approach is the CSS `zoom` model used by Gmail's mobile web
  // viewer, not `transform: scale` from the host — `zoom` participates
  // in layout, so the iframe document's scaled metrics stay consistent
  // and a ResizeObserver scoped to the host shell does not feed back
  // on its own writes.
  const applyFit = () => {
    if (!active) return;
    const shellEl = htmlShellRef.value;
    const shellWidth = shellEl?.clientWidth ?? 0;
    if (shellWidth <= 0) return;
    docEl.style.zoom = '';
    const contentWidth = Math.max(
      docEl.scrollWidth,
      bodyEl.scrollWidth,
      1,
    );
    const contentHeight = Math.max(
      docEl.scrollHeight,
      bodyEl.scrollHeight,
      initialIframeHeight(),
    );
    // Clamp the effective content width: even if the document reflowed
    // to fit a very narrow viewport, fall back to MIN_EMAIL_LAYOUT_WIDTH
    // so the email still renders at a sensible layout size and zooms
    // down rather than reflowing into something cramped.
    const effectiveWidth = Math.max(contentWidth, MIN_EMAIL_LAYOUT_WIDTH);
    const ratio = effectiveWidth > shellWidth ? shellWidth / effectiveWidth : 1;
    docEl.style.zoom = ratio === 1 ? '' : String(ratio);
    const nextHeight = Math.max(120, Math.ceil(contentHeight * ratio));
    if (nextHeight !== iframeHeight.value) {
      iframeHeight.value = nextHeight;
    }
  };

  // MDN guidance for ResizeObserver feedback safety: defer the
  // callback to a rAF and skip re-entrant scheduling.
  const scheduleApplyFit = () => {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      applyFit();
    });
  };

  applyFit();

  const cleanups: Array<() => void> = [];
  const scheduleApplyFitAfter = (delay: number | 'raf') => {
    if (delay === 'raf') {
      if (typeof requestAnimationFrame !== 'function') return;
      const id = requestAnimationFrame(applyFit);
      cleanups.push(() => cancelAnimationFrame(id));
      return;
    }
    const id = window.setTimeout(applyFit, delay);
    cleanups.push(() => clearTimeout(id));
  };

  // Late-arriving inline content (fonts, images, slow stylesheets) may
  // grow the iframe document after the initial measurement. Re-apply a
  // few times so the height and zoom settle correctly.
  scheduleApplyFitAfter('raf');
  scheduleApplyFitAfter(150);
  scheduleApplyFitAfter(600);

  for (const img of Array.from(doc.images ?? []) as HTMLImageElement[]) {
    if (img.complete) continue;
    img.addEventListener('load', applyFit, { once: true });
    img.addEventListener('error', applyFit, { once: true });
    cleanups.push(() => {
      img.removeEventListener('load', applyFit);
      img.removeEventListener('error', applyFit);
    });
  }

  if (doc.fonts?.ready) {
    doc.fonts.ready.then(applyFit).catch(() => {});
  }

  iframeMeasurementCleanup = () => {
    active = false;
    doc.removeEventListener('keydown', onIframeKeyDown, true);
    for (const cleanup of cleanups) cleanup();
  };

  if (typeof ResizeObserver === 'function' && htmlShellRef.value) {
    resizeObserver = new ResizeObserver(scheduleApplyFit);
    resizeObserver.observe(htmlShellRef.value);
  }
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  return Number.isNaN(d.valueOf()) ? '' : d.toLocaleString();
}

function shortFrom(text) {
  if (!text) return '(no sender)';
  const m = text.match(/^(.+?)\s*<.+>$/);
  return m ? m[1].replace(/^"|"$/g, '') : text;
}

function fmtListDate(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.valueOf())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
}

// The stored body HTML references inline images by cid:, which only
// resolve within the original message. For reply/forward, inline those
// images as data: URLs in the quote so the compose send pipeline
// re-uploads them as fresh cid attachments on the new message; otherwise
// the quoted image is a dangling cid: reference.
async function quoteBody() {
  const b = body.value;
  if (!b?.html) return b ?? {};
  const cidUrls = await resolveCidImageUrls(b);
  if (cidUrls.size === 0) return b;
  return { ...b, html: sanitizeMessageHtml(b.html, cidUrls) };
}

async function reply() {
  if (!message.value) return;
  composeStore.prepareReplyFromMessage(message.value, await quoteBody());
}

async function replyAll() {
  if (!message.value) return;
  composeStore.prepareReplyAll(message.value, await quoteBody());
}

async function forward() {
  if (!message.value) return;
  composeStore.prepareForward(message.value, await quoteBody());
}

async function archive() {
  if (!message.value) return;
  try {
    await mailStore.archiveMessages([message.value.id]);
  } catch (err) {
    console.warn('[message-view] archive failed', err?.message ?? err);
  }
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

async function bulkArchive() {
  const ids = [...mailStore.selectedIds];
  if (ids.length === 0) return;
  try {
    await mailStore.archiveMessages(ids);
  } catch (err) {
    console.warn('[message-view] bulk archive failed', err?.message ?? err);
  }
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

function closeMessageView() {
  mailStore.selectMessage(null);
  mailStore.clearSelection();
}
</script>

<template>
  <section
    class="message-view"
    :class="{ 'message-view--spotlight-actions': spotlightActions }"
    aria-label="Message detail"
  >
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
          <button class="message-view__action" type="button" @click="bulkArchive" title="Archive" aria-label="Archive">
            <span class="message-view__toolbar-icon message-view__toolbar-icon--folder" aria-hidden="true" v-html="archiveIcon" />
          </button>
          <button class="message-view__action" type="button" @click="bulkMarkRead" title="Mark as read" aria-label="Mark as read">
            <MailOpen :size="16" :stroke-width="1.75" />
          </button>
          <button class="message-view__action" type="button" @click="bulkMarkUnread" title="Mark as unread" aria-label="Mark as unread">
            <Mail :size="16" :stroke-width="1.75" />
          </button>
          <button class="message-view__action message-view__action--danger" type="button" @click="bulkDelete" title="Delete" aria-label="Delete">
            <Trash2 class="message-view__toolbar-icon" :size="18" :stroke-width="1.65" />
          </button>
          <button class="message-view__action message-view__action--ghost" type="button" @click="clearBulkSelection" title="Clear selection" aria-label="Clear selection">
            <X :size="16" :stroke-width="1.75" />
          </button>
        </div>
      </header>
      <ol class="message-view__bulk-list" role="list">
        <li
          v-for="row in selectedMessages"
          :key="row.id"
          class="message-view__bulk-item"
        >
          <div class="message-view__bulk-item-row1">
            <span class="message-view__bulk-item-from">{{ shortFrom(row.from_text) }}</span>
            <span class="message-view__bulk-item-date">{{ fmtListDate(row.received_at) }}</span>
          </div>
          <div class="message-view__bulk-item-subject">{{ row.subject || '(no subject)' }}</div>
          <p v-if="row.preview" class="message-view__bulk-item-preview">{{ row.preview }}</p>
        </li>
      </ol>
    </div>
    <article v-else-if="spotlightActions" class="message-view__article">
      <header class="message-view__header">
        <button class="message-view__action message-view__action--ghost message-view__action--back" type="button" title="Back" aria-label="Back">
          <ArrowLeft class="message-view__toolbar-icon" :size="18" :stroke-width="1.65" />
        </button>
        <button class="message-view__action" type="button" title="Archive (A)" aria-label="Archive">
          <span class="message-view__toolbar-icon message-view__toolbar-icon--folder" aria-hidden="true" v-html="archiveIcon" />
        </button>
        <button class="message-view__action message-view__action--danger" type="button" title="Delete (Del)" aria-label="Delete">
          <Trash2 class="message-view__toolbar-icon" :size="18" :stroke-width="1.65" />
        </button>
        <button class="message-view__action message-view__action--compose-spotlight" type="button" title="Reply (Ctrl+R)" aria-label="Reply">
          <span class="message-view__toolbar-icon message-view__toolbar-icon--shape" aria-hidden="true" v-html="replyIcon" />
        </button>
        <button class="message-view__action message-view__action--compose-spotlight" type="button" title="Reply All (Ctrl+Shift+R)" aria-label="Reply All">
          <span class="message-view__toolbar-icon message-view__toolbar-icon--shape" aria-hidden="true" v-html="replyAllIcon" />
        </button>
        <button class="message-view__action message-view__action--compose-spotlight" type="button" title="Forward (Ctrl+L)" aria-label="Forward">
          <span class="message-view__toolbar-icon message-view__toolbar-icon--shape" aria-hidden="true" v-html="forwardIcon" />
        </button>
      </header>
      <div class="message-view__empty">
        <p>Select a message to read it.</p>
      </div>
    </article>
    <div v-else-if="!message" class="message-view__empty">
      <p>Select a message to read it.</p>
    </div>
    <article v-else class="message-view__article">
      <header class="message-view__header">
        <button class="message-view__action message-view__action--ghost message-view__action--back" type="button" @click="closeMessageView" title="Back" aria-label="Back">
          <ArrowLeft class="message-view__toolbar-icon" :size="18" :stroke-width="1.65" />
        </button>
        <button class="message-view__action" type="button" @click="archive" title="Archive (A)" aria-label="Archive">
          <span class="message-view__toolbar-icon message-view__toolbar-icon--folder" aria-hidden="true" v-html="archiveIcon" />
        </button>
        <button class="message-view__action message-view__action--danger" type="button" @click="destroy" title="Delete (Del)" aria-label="Delete">
          <Trash2 class="message-view__toolbar-icon" :size="18" :stroke-width="1.65" />
        </button>
        <button class="message-view__action message-view__action--compose-spotlight" type="button" @click="reply" title="Reply (Ctrl+R)" aria-label="Reply">
          <span class="message-view__toolbar-icon message-view__toolbar-icon--shape" aria-hidden="true" v-html="replyIcon" />
        </button>
        <button class="message-view__action message-view__action--compose-spotlight" type="button" @click="replyAll" title="Reply All (Ctrl+Shift+R)" aria-label="Reply All">
          <span class="message-view__toolbar-icon message-view__toolbar-icon--shape" aria-hidden="true" v-html="replyAllIcon" />
        </button>
        <button class="message-view__action message-view__action--compose-spotlight" type="button" @click="forward" title="Forward (Ctrl+L)" aria-label="Forward">
          <span class="message-view__toolbar-icon message-view__toolbar-icon--shape" aria-hidden="true" v-html="forwardIcon" />
        </button>
        <button
          v-if="canForceLightBody"
          class="message-view__action message-view__action--view-mode"
          type="button"
          :aria-pressed="forceLightBody"
          :title="forceLightBody ? 'View this message in dark mode' : 'View this message in light mode'"
          :aria-label="forceLightBody ? 'View this message in dark mode' : 'View this message in light mode'"
          @click="toggleBodyLightMode"
        >
          <Moon v-if="forceLightBody" :size="16" :stroke-width="1.75" />
          <Sun v-else :size="16" :stroke-width="1.75" />
        </button>
      </header>
      <section class="message-view__details" aria-label="Message header">
        <dl class="message-view__metadata">
          <div class="message-view__metadata-row">
            <dt>From</dt>
            <dd>{{ message.from_text || '(no sender)' }}</dd>
          </div>
          <div v-if="message.to_text" class="message-view__metadata-row">
            <dt>To</dt>
            <dd>{{ message.to_text }}</dd>
          </div>
          <div class="message-view__metadata-row message-view__title">
            <dt>Subject</dt>
            <dd><h2>{{ message.subject || '(no subject)' }}</h2></dd>
          </div>
          <div class="message-view__metadata-row">
            <dt>Date</dt>
            <dd class="message-view__date">{{ fmtDate(message.received_at) }}</dd>
          </div>
        </dl>
      </section>
      <div ref="bodyRef" class="message-view__body">
        <div
          v-if="iframeSrcDoc"
          ref="htmlShellRef"
          class="message-view__html-shell"
        >
          <iframe
            ref="iframeRef"
            class="message-view__html-frame"
            :srcdoc="iframeSrcDoc"
            :sandbox="IFRAME_SANDBOX"
            :style="{ height: `${iframeHeight}px` }"
            title="Message body"
            @load="onIframeLoad"
          />
        </div>
        <div v-else-if="textHtml" class="message-view__text" v-html="textHtml" />
        <p v-else class="message-view__placeholder">Loading message…</p>
        <ul v-if="visibleAttachments.length" class="message-view__attachments">
          <li v-for="a in visibleAttachments" :key="a.part_id">
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
  grid-template-rows: auto auto 1fr;
  min-width: 0;
  min-height: 0;
  width: 100%;
  --message-content-inset: 20px;
  --message-content-trailing-inset: 16px;
  --message-html-edge-inset: 8px;
  --message-toolbar-edge-inset: 12px;
  --message-header-label-width: 56px;
}
.message-view__empty {
  display: grid;
  place-items: center;
  height: 100%;
  color: var(--muted);
}
.message-view__bulk {
  display: grid;
  grid-template-rows: auto 1fr;
  height: 100%;
  min-width: 0;
  min-height: 0;
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
  font-size: 20px;
  font-weight: 600;
  text-align: center;
}
.message-view__bulk-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.message-view__bulk-list {
  margin: 0;
  padding: 8px 0;
  list-style: none;
  overflow-y: auto;
  min-height: 0;
}
.message-view__bulk-item {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.message-view__bulk-item:last-child {
  border-bottom: none;
}
.message-view__bulk-item-row1 {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 2px;
}
.message-view__bulk-item-from {
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.message-view__bulk-item-date {
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.message-view__bulk-item-subject {
  font-weight: 600;
  font-size: 14px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.message-view__bulk-item-preview {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.45;
}
.message-view__header {
  display: flex;
  gap: 6px;
  align-items: center;
  justify-content: flex-start;
  min-width: 0;
  min-height: 57px;
  padding: 11px var(--message-toolbar-edge-inset);
  overflow: hidden;
  border-bottom: 1px solid var(--border);
}
.message-view__details {
  min-width: 0;
  padding: 12px var(--message-content-trailing-inset) 12px var(--message-content-inset);
  border-bottom: 1px solid var(--border-soft);
  background: color-mix(in srgb, var(--panel) 92%, var(--panel2));
}
.message-view__metadata {
  display: grid;
  grid-template-columns: var(--message-header-label-width) minmax(0, 1fr);
  min-width: 0;
  column-gap: 12px;
  row-gap: 7px;
  margin: 0;
  font-size: 13px;
}
.message-view__metadata-row {
  display: contents;
}
.message-view__metadata dt {
  color: var(--muted);
  font-weight: 600;
  text-align: left;
}
.message-view__metadata dd {
  min-width: 0;
  margin: 0;
  color: var(--text);
  overflow-wrap: anywhere;
  white-space: normal;
}
.message-view__title h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
  white-space: normal;
}
.message-view__date { font-variant-numeric: tabular-nums; }
.message-view__action {
  display: inline-grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--muted);
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: 8px;
  cursor: pointer;
  font: inherit;
  flex-shrink: 0;
}
.message-view__action:hover { background: var(--rowHover); color: var(--text); }
.message-view__action--danger:hover { background: rgba(255, 107, 107, 0.12); color: #ff6b6b; }
.message-view__action--ghost { color: var(--muted); }
.message-view__action--back { margin-right: 12px; }
/* View option, not a mail action — sits at the trailing edge. */
.message-view__action--view-mode { margin-left: auto; }
.message-view__action--view-mode[aria-pressed="true"] {
  background: var(--rowHover);
  color: var(--text);
}
.message-view--spotlight-actions .message-view__action--compose-spotlight {
  position: relative;
  z-index: 130;
  color: var(--text);
  background: color-mix(in srgb, var(--accent) 18%, var(--panel2));
  animation: message-action-spotlight-pulse 3.2s ease-in-out infinite;
}
.message-view__toolbar-icon {
  width: 18px;
  height: 18px;
  display: block;
  fill: none;
  stroke: currentColor;
  shape-rendering: geometricPrecision;
}
.message-view__toolbar-icon--shape {
  width: 20px;
  height: 20px;
  fill: currentColor;
  stroke: none;
}
.message-view__toolbar-icon--shape :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
.message-view__toolbar-icon--shape :deep([fill="context-fill"]) {
  fill: transparent;
}
.message-view__toolbar-icon--shape :deep([fill="context-stroke"]) {
  fill: currentColor;
}
.message-view__toolbar-icon--folder {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: none;
}
.message-view__toolbar-icon--folder :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
.message-view__toolbar-icon--folder :deep([fill="context-fill"]) {
  fill: color-mix(in srgb, currentColor 20%, transparent);
}
.message-view__toolbar-icon--folder :deep([fill="context-stroke"]) {
  fill: currentColor;
}

.message-view__body {
  /* The iframe is the sole rendering path for HTML message bodies.
   * It carries its own document, so alignment is applied to the frame
   * itself instead of rewriting the email's internal layout. The iframe
   * document owns the canvas color so simple HTML can follow the app
   * theme while styled emails keep their own design. */
  padding: 0;
  overflow-y: auto;
  overflow-x: hidden;
  min-width: 0;
  min-height: 0;
}
.message-view__html-shell {
  margin-left: var(--message-html-edge-inset);
  margin-right: var(--message-html-edge-inset);
}
.message-view__html-frame {
  display: block;
  width: 100%;
  border: 0;
  /* Height is driven imperatively from onIframeLoad once the document
   * has laid out; min-height is the floor for the first paint when
   * the body viewport is not measurable yet. Fit-to-width for emails
   * with fixed widths is handled by CSS `zoom` on the iframe document
   * (set from onIframeLoad), not by an outer transform — that keeps the
   * iframe's outer box and content in the same coordinate space so a
   * ResizeObserver on the host shell cannot feedback-loop with itself. */
  min-height: 120px;
  background: var(--panel);
}
.message-view__text {
  margin: 0;
  padding: 18px 22px 18px var(--message-content-inset);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.55;
  /* Preserve the message's own line breaks and spacing (issue #25)
   * while still wrapping long lines and unbreakable tokens (URLs) so
   * the reading pane never needs horizontal scrolling. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--text);
}
.message-view__text :deep(a) {
  color: var(--accent);
}
/* Quoted text, styled like Thunderbird Desktop: the `>` markers are
 * stripped and each nesting level gets a coloured left bar from the
 * Tango palette (comm-central messageQuotes.css), cycling every five
 * levels. The quoted text itself is not recoloured. */
.message-view__text :deep(blockquote.pt-quote) {
  margin: 1ex 0;
  padding: 0.4ex 1ex;
  border-inline-start: 2px solid rgb(114, 159, 207); /* Sky Blue 1 */
}
.message-view__text :deep(blockquote.pt-quote--l2) {
  border-inline-start-color: rgb(173, 127, 168); /* Plum 1 */
}
.message-view__text :deep(blockquote.pt-quote--l3) {
  border-inline-start-color: rgb(138, 226, 52); /* Chameleon 1 */
}
.message-view__text :deep(blockquote.pt-quote--l4) {
  border-inline-start-color: rgb(252, 175, 62); /* Orange 1 */
}
.message-view__text :deep(blockquote.pt-quote--l5) {
  border-inline-start-color: rgb(233, 185, 110); /* Chocolate 1 */
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

@media (max-width: 639px) {
  .message-view__article {
    --message-content-inset: 5px;
    --message-content-trailing-inset: 5px;
    --message-html-edge-inset: 5px;
    --message-toolbar-edge-inset: 5px;
  }
}

@keyframes message-action-spotlight-pulse {
  0%, 100% {
    box-shadow:
      0 0 0 5px color-mix(in srgb, var(--accent) 24%, transparent),
      0 0 0 1px color-mix(in srgb, var(--accent) 86%, #fff),
      0 10px 24px color-mix(in srgb, #000 24%, transparent);
    filter: brightness(1.12);
  }
  50% {
    filter: brightness(1.22);
  }
}
</style>
