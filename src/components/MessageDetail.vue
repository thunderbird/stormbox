<script>
import { computed } from 'vue'
import DOMPurify from 'dompurify'

export default {
  name: 'MessageDetail',
  props: {
    detail: Object,
    attachments: Array,
    bodyHtml: String,
    bodyText: String
  },
  emits: ['back-to-list', 'reply', 'delete', 'download'],
  setup(props) {
    const fmtSize = (n) => {
      if (n == null) return "";
      const u = ["B", "KB", "MB", "GB"];
      let i = 0, x = Number(n);
      while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
      return `${x.toFixed(i ? 1 : 0)} ${u[i]}`;
    }

    const safeBody = computed(() => {
      const fallback = (() => {
        const esc = s => String(s || "").replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
        return `<pre style="white-space:pre-wrap;margin:0">${esc(props.bodyText || "")}</pre>`;
      })();

      let html = props.bodyHtml || fallback;

      const purifier = (typeof window !== 'undefined' && (window.DOMPurify || window.dompurify)) ||
        (typeof DOMPurify !== 'undefined' ? DOMPurify : null);

      if (!purifier) return html;

      try {
        return purifier.sanitize(html, {
          ALLOW_UNKNOWN_PROTOCOLS: true,
          ADD_ATTR: ["target", "download", "rel"]
        });
      } catch {
        return fallback;
      }
    });

    return {
      fmtSize,
      safeBody
    }
  }
}
</script>

<template>
  <div class="detail">
    <!-- Read panel -->
    <div class="head">
      <div class="detailbar">
        <button id="backToList" class="btn-ghost backbtn" title="Back" @click="$emit('back-to-list')">
          ←
        </button>

        <div class="actbtns">
          <button id="replyBtn" class="btn-primary" title="Reply" @click="$emit('reply')">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;">
              <path d="M10 19l-7-7 7-7" />
              <path d="M20 18v-1a4 4 0 0 0-4-4H3" />
            </svg>
            Reply
          </button>
          <button id="deleteBtn" class="btn-primary" title="Delete" @click="$emit('delete')">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
            </svg>
            Delete
          </button>
        </div>

        <span></span>
      </div>
      <div class="midline"></div>
      <h2 id="d-subject">{{ detail.subject || '(select a message)' }}</h2>

      <div class="grid" style="margin-top:8px">
        <div>From</div>
        <div class="v">{{ detail.from }}</div>
        <div>To</div>
        <div class="v">{{ detail.to }}</div>
        <div>CC</div>
        <div class="v">{{ detail.cc }}</div>
        <div>Date</div>
        <div class="v">{{ detail.date }}</div>
        <div>Flags</div>
        <div class="v">{{ detail.flags }}</div>
        <div>Size</div>
        <div class="v">{{ detail.size }}</div>
        <div>ID</div>
        <div class="v">{{ detail.id }}</div>
      </div>
    </div>

    <!-- Email body (sanitized HTML or text) -->
    <div class="preview" id="d-preview" v-html="safeBody"></div>

    <div id="attachments" class="attachments" :class="{ visible: attachments.length }">
      <div class="atitle">Attachments</div>
      <div class="attlist" id="attlist">
        <div v-for="a in attachments" :key="a.blobId" class="att">
          <div class="meta">
            <div class="name" :title="a.name">{{ a.name }}</div>
            <div class="type">{{ a.type }}</div>
          </div>
          <div class="size">{{ fmtSize(a.size) }}</div>
          <div><button @click="$emit('download', a)">Download</button></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail {
  display: grid;
  grid-template-rows: auto auto 1fr auto;
  background: var(--panel);
  min-height: 0;
  overflow: hidden;
}

.detail>* {
  min-height: 0;
}

.head {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
  max-height: 32vh;
  overflow: auto;
}

.detailbar {
  display: grid;
  grid-template-columns: auto auto 1fr;
  align-items: center;
  gap: .6rem;
}

.actbtns {
  display: flex;
  gap: .5rem;
  align-items: center;
}

/* Buttons */
.btn-ghost {
  padding: .35rem .6rem;
  border: 1px solid var(--border);
  border-radius: .6rem;
  background: transparent;
  color: #9aa3b2;
  cursor: pointer;
}

.btn-ghost:hover {
  background: #14182a;
  color: #e6e8ef;
}

.btn-primary {
  padding: .55rem .9rem;
  border: 0;
  border-radius: .6rem;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}

.btn-primary:hover {
  filter: brightness(1.08);
}

.backbtn {
  font-size: 18px;
  line-height: 1;
}

.midline {
  border-bottom: 1px solid var(--border);
  margin: 8px 0;
}

.head h2 {
  margin: 0;
  font-size: 16px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grid {
  display: grid;
  grid-template-columns: 100px 1fr;
  row-gap: 6px;
  column-gap: 10px;
  color: var(--muted);
  font-size: 13px;
}

.grid .v {
  color: var(--text);
  overflow-wrap: anywhere;
}

/* Email HTML/text viewer */
.preview {
  padding: 14px 16px;
  overflow: auto;
  min-height: 0;
  white-space: normal;
  color: #d8dbe6;
  word-break: break-word;
  overscroll-behavior: contain;
}

.preview img {
  max-width: 100%;
  height: auto;
}

.preview table {
  max-width: 100%;
  display: block;
  overflow: auto;
}

/* Attachments */
.attachments {
  padding: 8px 16px 14px;
  border-top: 1px solid var(--border);
  display: none;
  max-height: 35vh;
  overflow: auto;
}

.attachments.visible {
  display: block;
}

.attachments .atitle {
  color: var(--muted);
  font-size: 12px;
  margin: 0 0 8px 0;
}

.attlist {
  display: grid;
  gap: 6px;
}

.att {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border: 1px solid var(--border);
  background: #0e1220;
  border-radius: .5rem;
  padding: 8px 10px;
}

.att .meta {
  display: flex;
  gap: 10px;
  align-items: center;
  min-width: 0;
}

.att .name {
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 360px;
}

.att .type {
  color: var(--muted);
  font-size: 12px;
}

.att .size {
  color: var(--muted);
  font-size: 12px;
}

.att button {
  border: 0;
  background: var(--accent);
  color: #fff;
  border-radius: .45rem;
  padding: .35rem .6rem;
  cursor: pointer;
}
</style>
