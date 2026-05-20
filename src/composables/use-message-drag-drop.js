import { computed, ref } from 'vue';

export const MESSAGE_DRAG_MIME = 'application/x-stormbox-message-ids';

const draggedIds = ref([]);
const sourceFolderId = ref(null);

const isDragging = computed(() => draggedIds.value.length > 0);

function normalizeIds(ids) {
  const raw = Array.isArray(ids) ? ids : [ids];
  const normalized = raw
    .map(Number)
    .filter((id) => Number.isFinite(id));
  return [...new Set(normalized)];
}

function idsForDrag(messageId, selectedIds) {
  const rowId = Number(messageId);
  if (!Number.isFinite(rowId)) return [];
  const selected = selectedIds instanceof Set
    ? selectedIds
    : new Set(Array.isArray(selectedIds) ? selectedIds : []);
  return selected.has(rowId) ? normalizeIds([...selected]) : [rowId];
}

function startMessageDrag(event, {
  messageId,
  selectedIds,
  sourceFolderId: sourceId,
} = {}) {
  const ids = idsForDrag(messageId, selectedIds);
  if (ids.length === 0) {
    event?.preventDefault?.();
    return [];
  }

  draggedIds.value = ids;
  sourceFolderId.value = Number.isFinite(Number(sourceId)) ? Number(sourceId) : null;

  const payload = JSON.stringify({
    ids,
    sourceFolderId: sourceFolderId.value,
  });
  const transfer = event?.dataTransfer;
  if (transfer) {
    transfer.effectAllowed = 'move';
    transfer.setData(MESSAGE_DRAG_MIME, payload);
    transfer.setData('text/plain', `${ids.length} ${ids.length === 1 ? 'message' : 'messages'}`);
    setDragImage(transfer, ids.length);
  }
  return ids;
}

function endMessageDrag() {
  draggedIds.value = [];
  sourceFolderId.value = null;
}

function hasMessageDrag(event) {
  if (isDragging.value) return true;
  const types = event?.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes(MESSAGE_DRAG_MIME);
}

function readMessageDrop(event) {
  const transfer = event?.dataTransfer;
  const raw = transfer?.getData(MESSAGE_DRAG_MIME);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const ids = normalizeIds(parsed?.ids);
      if (ids.length > 0) {
        return {
          ids,
          sourceFolderId: Number.isFinite(Number(parsed?.sourceFolderId))
            ? Number(parsed.sourceFolderId)
            : null,
        };
      }
    } catch {
      // Fall back to the in-memory state below. Some browsers expose
      // custom data only on drop, so parse errors should not strand
      // an otherwise valid same-window drag.
    }
  }
  const ids = normalizeIds(draggedIds.value);
  if (ids.length === 0) return null;
  return { ids, sourceFolderId: sourceFolderId.value };
}

function setDropEffect(event, allowed) {
  if (!hasMessageDrag(event)) return false;
  event?.preventDefault?.();
  if (event?.dataTransfer) {
    event.dataTransfer.dropEffect = allowed ? 'move' : 'none';
  }
  return true;
}

function setDragImage(transfer, count) {
  if (typeof document === 'undefined' || typeof transfer.setDragImage !== 'function') return;
  const el = document.createElement('div');
  el.className = 'stormbox-message-drag-image';
  el.textContent = `${count} ${count === 1 ? 'message' : 'messages'}`;
  el.style.cssText = [
    'position: fixed',
    'top: -1000px',
    'left: -1000px',
    'padding: 6px 10px',
    'border-radius: 999px',
    'background: rgba(32, 33, 36, 0.92)',
    'color: white',
    'font: 12px system-ui, sans-serif',
    'box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22)',
    'pointer-events: none',
    'z-index: 2147483647',
  ].join(';');
  document.body.appendChild(el);
  transfer.setDragImage(el, 12, 12);
  setTimeout(() => el.remove(), 0);
}

export function useMessageDragDrop() {
  return {
    draggedIds,
    sourceFolderId,
    isDragging,
    startMessageDrag,
    endMessageDrag,
    hasMessageDrag,
    readMessageDrop,
    setDropEffect,
  };
}
