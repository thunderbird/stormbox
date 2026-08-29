import { createListDragDrop } from './useListDragDrop';
import type { ListDragEvent } from './useListDragDrop';

export const MESSAGE_DRAG_MIME = 'application/x-stormbox-message-ids';

const messageDragDrop = createListDragDrop<number, number>({
  dragImageClass: 'stormbox-message-drag-image',
  effectAllowed: 'copyMove',
  itemLabel: 'message',
  mimeType: MESSAGE_DRAG_MIME,
  normalizeId(value) {
    const id = Number(value);
    return Number.isFinite(id) ? id : null;
  },
  normalizeSourceId(value) {
    const id = Number(value);
    return Number.isFinite(id) ? id : null;
  },
  sourcePayloadKey: 'sourceFolderId',
});

function startMessageDrag(event: ListDragEvent, {
  messageId,
  selectedIds,
  sourceFolderId,
}: {
  messageId?: number;
  selectedIds?: number[] | Set<number>;
  sourceFolderId?: number | null;
} = {}) {
  return messageDragDrop.startDrag(event, {
    itemId: messageId,
    selectedIds,
    sourceId: sourceFolderId,
  });
}

function readMessageDrop(event?: ListDragEvent | null) {
  const payload = messageDragDrop.readDrop(event);
  return payload
    ? { ids: payload.ids, sourceFolderId: payload.sourceId }
    : null;
}

function setDropEffect(
  event: ListDragEvent,
  mode: DataTransfer['dropEffect'] | null,
) {
  return messageDragDrop.setDropEffect(event, mode);
}

export function useMessageDragDrop() {
  return {
    draggedIds: messageDragDrop.draggedIds,
    sourceFolderId: messageDragDrop.sourceId,
    isDragging: messageDragDrop.isDragging,
    startMessageDrag,
    endMessageDrag: messageDragDrop.endDrag,
    hasMessageDrag: messageDragDrop.hasDrag,
    readMessageDrop,
    setDropEffect,
  };
}
