import { createListDragDrop } from './useListDragDrop';
import type { ListDragEvent } from './useListDragDrop';

export const CONTACT_DRAG_MIME = 'application/x-stormbox-contact-ids';

const contactDragDrop = createListDragDrop<number, number>({
  dragImageClass: 'stormbox-contact-drag-image',
  effectAllowed: 'move',
  itemLabel: 'contact',
  mimeType: CONTACT_DRAG_MIME,
  normalizeId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  },
  normalizeSourceId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  },
  sourcePayloadKey: 'sourceAddressbookId',
});

function startContactDrag(event: ListDragEvent, {
  contactId,
  selectedIds,
  sourceAddressbookId,
}: {
  contactId?: number;
  selectedIds?: number[] | Set<number>;
  sourceAddressbookId?: number | null;
} = {}) {
  return contactDragDrop.startDrag(event, {
    itemId: contactId,
    selectedIds,
    sourceId: sourceAddressbookId,
  });
}

function readContactDrop(event?: ListDragEvent | null) {
  const payload = contactDragDrop.readDrop(event);
  return payload
    ? { ids: payload.ids, sourceAddressbookId: payload.sourceId }
    : null;
}

function setContactDropEffect(
  event: ListDragEvent,
  mode: DataTransfer['dropEffect'] | null,
) {
  return contactDragDrop.setDropEffect(event, mode);
}

export function useContactDragDrop() {
  return {
    draggedContactIds: contactDragDrop.draggedIds,
    endContactDrag: contactDragDrop.endDrag,
    hasContactDrag: contactDragDrop.hasDrag,
    isDraggingContacts: contactDragDrop.isDragging,
    readContactDrop,
    setContactDropEffect,
    sourceAddressbookId: contactDragDrop.sourceId,
    startContactDrag,
  };
}
