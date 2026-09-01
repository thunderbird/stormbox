import {
  computed,
  ref,
  watch,
  type ComputedRef,
  type Ref,
  type WatchSource,
} from 'vue';

export type DetailFailureState = 'save-error' | 'validation-error';

export interface DetailPaneHandle {
  focusDetail: () => Promise<void>;
  save: () => Promise<boolean>;
}

export interface UseDetailPaneEditorOptions {
  additionalDirty?: () => boolean;
  changeSource: WatchSource<unknown>;
  clearValidationErrors?: () => void;
  editing: ComputedRef<boolean>;
  emitDirtyChange: (dirty: boolean) => void;
  emitStateChange: (state: DetailFailureState | null) => void;
  resetForm: () => void;
  resetSource: WatchSource<unknown>;
  snapshot: () => string;
}

export interface DetailPaneEditor {
  beginSave: () => void;
  clearFailure: () => void;
  dirty: ComputedRef<boolean>;
  localError: Ref<string | null>;
  markSaved: () => void;
  reportFailure: (
    state: DetailFailureState,
    message?: string | null,
  ) => void;
  saveAttempted: Ref<boolean>;
}

export function useDetailPaneEditor({
  additionalDirty,
  changeSource,
  clearValidationErrors,
  editing,
  emitDirtyChange,
  emitStateChange,
  resetForm,
  resetSource,
  snapshot,
}: UseDetailPaneEditorOptions): DetailPaneEditor {
  const initialSerialized = ref('');
  const saveAttempted = ref(false);
  const localError = ref<string | null>(null);
  const dirty = computed(() =>
    editing.value
    && (additionalDirty?.() === true || snapshot() !== initialSerialized.value));

  function clearFailure(): void {
    saveAttempted.value = false;
    localError.value = null;
    clearValidationErrors?.();
    emitStateChange(null);
  }

  function resetEditor(): void {
    resetForm();
    initialSerialized.value = snapshot();
    clearFailure();
    emitDirtyChange(false);
  }

  function beginSave(): void {
    saveAttempted.value = true;
    localError.value = null;
    clearValidationErrors?.();
  }

  function reportFailure(
    state: DetailFailureState,
    message: string | null = null,
  ): void {
    localError.value = message;
    emitStateChange(state);
  }

  function markSaved(): void {
    initialSerialized.value = snapshot();
    saveAttempted.value = false;
    localError.value = null;
    clearValidationErrors?.();
    emitDirtyChange(false);
    emitStateChange(null);
  }

  watch(resetSource, resetEditor, { immediate: true });
  watch(
    changeSource,
    () => {
      emitDirtyChange(dirty.value);
      if (saveAttempted.value || localError.value !== null) clearFailure();
    },
    { deep: true },
  );

  return {
    beginSave,
    clearFailure,
    dirty,
    localError,
    markSaved,
    reportFailure,
    saveAttempted,
  };
}
