import {
  computed,
  shallowRef,
} from 'vue';

type DragIdInput<Id> = Id | readonly Id[] | Set<Id> | null | undefined;

export interface ListDataTransfer {
  dropEffect: string;
  effectAllowed: string;
  getData: (type: string) => string;
  setData: (type: string, value: string) => void;
  setDragImage?: (image: Element, x: number, y: number) => void;
  types: ArrayLike<string>;
}

export interface ListDragEvent {
  dataTransfer?: ListDataTransfer | null;
  preventDefault?: () => void;
}

export interface ListDragDropConfig<Id, SourceId> {
  dragImageClass: string;
  effectAllowed: DataTransfer['effectAllowed'];
  itemLabel: string;
  mimeType: string;
  normalizeId: (value: unknown) => Id | null;
  normalizeSourceId: (value: unknown) => SourceId | null;
  sourcePayloadKey: string;
}

export interface ListDragStart<Id, SourceId> {
  itemId: Id | null | undefined;
  selectedIds?: DragIdInput<Id>;
  sourceId?: SourceId | null;
}

function pluralLabel(label: string, count: number): string {
  return count === 1 ? label : `${label}s`;
}

export function createListDragDrop<Id, SourceId>(
  config: ListDragDropConfig<Id, SourceId>,
) {
  const draggedIds = shallowRef<Id[]>([]);
  const sourceId = shallowRef<SourceId | null>(null);
  const isDragging = computed(() => draggedIds.value.length > 0);

  function normalizeIds(values: unknown): Id[] {
    const raw = Array.isArray(values)
      ? values
      : (values instanceof Set ? [...values] : [values]);
    const normalized: Id[] = [];
    const seen = new Set<Id>();
    for (const value of raw) {
      const id = config.normalizeId(value);
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      normalized.push(id);
    }
    return normalized;
  }

  function idsForDrag(itemId: Id | null | undefined, selectedIds: DragIdInput<Id>): Id[] {
    const rowId = config.normalizeId(itemId);
    if (rowId == null) return [];
    const selected = new Set(normalizeIds(selectedIds));
    return selected.has(rowId) ? [...selected] : [rowId];
  }

  function dragLabel(count: number): string {
    return `${count} ${pluralLabel(config.itemLabel, count)}`;
  }

  function setDragImage(transfer: ListDataTransfer, count: number): void {
    if (typeof document === 'undefined' || typeof transfer.setDragImage !== 'function') return;
    const el = document.createElement('div');
    el.className = config.dragImageClass;
    el.textContent = dragLabel(count);
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

  function startDrag(
    event: ListDragEvent | null | undefined,
    input: ListDragStart<Id, SourceId>,
  ): Id[] {
    const ids = idsForDrag(input.itemId, input.selectedIds);
    if (ids.length === 0) {
      event?.preventDefault?.();
      return [];
    }

    draggedIds.value = ids;
    sourceId.value = config.normalizeSourceId(input.sourceId);
    const transfer = event?.dataTransfer;
    if (transfer) {
      const payload = {
        ids,
        [config.sourcePayloadKey]: sourceId.value,
      };
      transfer.effectAllowed = config.effectAllowed;
      transfer.setData(config.mimeType, JSON.stringify(payload));
      transfer.setData('text/plain', dragLabel(ids.length));
      setDragImage(transfer, ids.length);
    }
    return ids;
  }

  function endDrag(): void {
    draggedIds.value = [];
    sourceId.value = null;
  }

  function hasDrag(event?: ListDragEvent | null): boolean {
    if (isDragging.value) return true;
    const types = event?.dataTransfer?.types;
    return types ? Array.from(types).includes(config.mimeType) : false;
  }

  function readDrop(event?: ListDragEvent | null): {
    ids: Id[];
    sourceId: SourceId | null;
  } | null {
    const raw = event?.dataTransfer?.getData(config.mimeType);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const ids = normalizeIds(parsed.ids);
        if (ids.length > 0) {
          return {
            ids,
            sourceId: config.normalizeSourceId(parsed[config.sourcePayloadKey]),
          };
        }
      } catch {
        // Same-window state remains available when custom drag data is unreadable.
      }
    }

    const ids = normalizeIds(draggedIds.value);
    return ids.length > 0 ? { ids, sourceId: sourceId.value } : null;
  }

  function setDropEffect(
    event: ListDragEvent | null | undefined,
    mode: DataTransfer['dropEffect'] | null,
  ): boolean {
    if (!hasDrag(event)) return false;
    event?.preventDefault?.();
    if (event?.dataTransfer) event.dataTransfer.dropEffect = mode ?? 'none';
    return true;
  }

  return {
    draggedIds,
    endDrag,
    hasDrag,
    isDragging,
    readDrop,
    setDropEffect,
    sourceId,
    startDrag,
  };
}
