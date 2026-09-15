import { ref } from 'vue';

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

export type MessageTransferMode = 'move' | 'copy' | null;
export type MessageDropState = 'move' | 'copy' | 'invalid' | null;

type DropTargetDragEvent = ListDragEvent & {
  currentTarget?: EventTarget | null;
  relatedTarget?: EventTarget | null;
};

export interface UseMessageDropTargetOptions {
  /** The folder this surface represents; null while it has none. */
  targetFolderId: () => number | null;
  /** The transfer the folder list would allow for the same source/target pair. */
  transferMode: (targetFolderId: number, sourceFolderId: number | null) => MessageTransferMode;
  drop: (
    ids: number[],
    sourceFolderId: number | null,
    mode: Exclude<MessageTransferMode, null>,
  ) => Promise<unknown> | unknown;
}

/**
 * Drag-over/drop handlers for one surface that stands for a folder (a
 * message list column). A drag from the folder it shows is a no-op:
 * no highlight, `dropEffect` none, nothing runs on drop. Anything else
 * follows `transferMode`, with `invalid` shown for a refused pair.
 */
export function useMessageDropTarget(options: UseMessageDropTargetOptions) {
  const dropState = ref<MessageDropState>(null);

  function currentMode(): MessageDropState {
    const target = options.targetFolderId();
    const source = messageDragDrop.sourceId.value;
    if (target == null) return 'invalid';
    if (source != null && Number(source) === Number(target)) return null;
    return options.transferMode(target, source) ?? 'invalid';
  }

  function effectFor(state: MessageDropState): MessageTransferMode {
    return state === 'move' || state === 'copy' ? state : null;
  }

  function onDragEnter(event: DropTargetDragEvent) {
    if (!messageDragDrop.hasDrag(event)) return;
    dropState.value = currentMode();
    setDropEffect(event, effectFor(dropState.value));
  }

  function onDragOver(event: DropTargetDragEvent) {
    if (!messageDragDrop.hasDrag(event)) return;
    dropState.value = currentMode();
    setDropEffect(event, effectFor(dropState.value));
  }

  function onDragLeave(event: DropTargetDragEvent) {
    const container = event.currentTarget;
    const related = event.relatedTarget;
    if (container instanceof Node && related instanceof Node && container.contains(related)) return;
    dropState.value = null;
  }

  async function onDrop(event: DropTargetDragEvent) {
    if (!messageDragDrop.hasDrag(event)) return;
    event.preventDefault?.();
    dropState.value = null;
    const payload = readMessageDrop(event);
    const target = options.targetFolderId();
    try {
      if (!payload?.ids?.length || target == null) return;
      if (payload.sourceFolderId != null && Number(payload.sourceFolderId) === Number(target)) return;
      const mode = options.transferMode(target, payload.sourceFolderId);
      if (!mode) return;
      await options.drop(payload.ids, payload.sourceFolderId, mode);
    } catch (err) {
      console.warn('[message-drop] drop failed', err);
    } finally {
      messageDragDrop.endDrag();
    }
  }

  return {
    dropState,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
  };
}
