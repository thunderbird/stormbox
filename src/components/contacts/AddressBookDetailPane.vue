<script setup lang="ts">
import {
  ArrowLeft,
  Pencil,
  Trash2,
} from '@lucide/vue';
import {
  computed,
  nextTick,
  ref,
  watch,
} from 'vue';

import {
  ADDRESSBOOK_ERROR,
  addressBookErrorMessage,
  type AddressBookError,
} from '../../constants/addressbook-errors';
import {
  type AddressBookSaveResult,
  useContactsStore,
} from '../../stores/contacts-store';
import type {
  AddressBookMutableFields,
  AddressbookRow,
} from '../../types';
import AppButton from '../AppButton.vue';
import AppIconButton from '../AppIconButton.vue';
import { addressBookDisplayName } from './directory-types';

type AddressBookDetailPaneMode = 'create' | 'edit' | 'view';
type DetailFailureState = 'save-error' | 'validation-error';

const props = withDefaults(defineProps<{
  addressbook: AddressbookRow | null;
  deleting?: boolean;
  deleteDisabledReason?: string | null;
  mode: AddressBookDetailPaneMode;
}>(), {
  deleting: false,
  deleteDisabledReason: null,
});

const emit = defineEmits<{
  back: [];
  cancel: [];
  dirtyChange: [dirty: boolean];
  edit: [];
  requestDelete: [];
  saved: [addressbook: AddressbookRow];
  stateChange: [state: DetailFailureState | null];
}>();

const contactsStore = useContactsStore();
const headingEl = ref<HTMLHeadingElement | null>(null);
const nameEl = ref<HTMLInputElement | null>(null);
const name = ref('');
const description = ref('');
const setAsDefault = ref(false);
const initialSerialized = ref('');
const saveAttempted = ref(false);
const localError = ref<string | null>(null);
const structuredError = ref<AddressBookError | null>(null);

const editing = computed(() => props.mode === 'create' || props.mode === 'edit');
const title = computed(() => {
  if (props.mode === 'create') return 'Create address book';
  if (props.mode === 'edit') return 'Edit address book';
  return props.addressbook
    ? addressBookDisplayName(props.addressbook)
    : 'Address book';
});

function formSnapshot(): string {
  return JSON.stringify({
    name: name.value,
    description: description.value,
    setAsDefault: setAsDefault.value,
  });
}

const dirty = computed(() =>
  editing.value && formSnapshot() !== initialSerialized.value);
const nameError = computed(() => {
  if (!saveAttempted.value) return null;
  const trimmed = name.value.trim();
  if (!trimmed) return 'Enter an address book name.';
  if (/[\r\n]/u.test(name.value)) return 'Address book names cannot contain a line break.';
  return null;
});

const displayError = computed(() => {
  if (!saveAttempted.value) return null;
  if (localError.value) return localError.value;
  if (contactsStore.error) return contactsStore.error;
  return structuredError.value
    ? addressBookErrorMessage(structuredError.value)
    : null;
});

function resetEditor(): void {
  const book = props.mode === 'create' ? null : props.addressbook;
  name.value = book?.name ?? '';
  description.value = book?.description ?? '';
  setAsDefault.value = book?.is_default === 1;
  initialSerialized.value = formSnapshot();
  saveAttempted.value = false;
  localError.value = null;
  structuredError.value = null;
  emit('dirtyChange', false);
  emit('stateChange', null);
  if (editing.value) void nextTick(() => nameEl.value?.focus());
}

watch(
  () => [props.mode, props.addressbook?.id] as const,
  resetEditor,
  { immediate: true },
);

watch(dirty, (value) => {
  emit('dirtyChange', value);
  if (value) {
    saveAttempted.value = false;
    localError.value = null;
    structuredError.value = null;
    emit('stateChange', null);
  }
});

function canonicalDescription(): string | null {
  return description.value === '' ? null : description.value;
}

function updateFields(): AddressBookMutableFields {
  const book = props.addressbook;
  if (!book) return {};
  const fields: AddressBookMutableFields = {};
  const nextName = name.value.trim();
  const nextDescription = canonicalDescription();
  if (nextName !== book.name) fields.name = nextName;
  if (nextDescription !== book.description) fields.description = nextDescription;
  if (book.is_default !== 1 && setAsDefault.value) fields.setAsDefault = true;
  return fields;
}

async function save(): Promise<boolean> {
  if (!editing.value || contactsStore.saving) return false;
  saveAttempted.value = true;
  localError.value = null;
  structuredError.value = null;
  if (nameError.value) {
    emit('stateChange', 'validation-error');
    await nextTick();
    nameEl.value?.focus();
    return false;
  }

  let result: AddressBookSaveResult;
  if (props.mode === 'create') {
    result = await contactsStore.createAddressBook({
      name: name.value,
      description: canonicalDescription(),
      setAsDefault: setAsDefault.value,
    });
  } else if (props.addressbook) {
    result = await contactsStore.updateAddressBook({
      addressbookId: props.addressbook.id,
      ...updateFields(),
    });
  } else {
    localError.value = 'This address book is no longer available.';
    emit('stateChange', 'save-error');
    return false;
  }

  if (result.ok === false) {
    structuredError.value = result.error;
    emit(
      'stateChange',
      result.error === ADDRESSBOOK_ERROR.INVALID_NAME
        || result.error === ADDRESSBOOK_ERROR.INVALID_ARGUMENTS
        ? 'validation-error'
        : 'save-error',
    );
    return false;
  }

  name.value = result.addressbook.name ?? '';
  description.value = result.addressbook.description ?? '';
  setAsDefault.value = result.addressbook.is_default === 1;
  initialSerialized.value = formSnapshot();
  emit('dirtyChange', false);
  emit('stateChange', null);
  emit('saved', result.addressbook);
  return true;
}

async function focusDetail(): Promise<void> {
  await nextTick();
  if (editing.value) nameEl.value?.focus();
  else headingEl.value?.focus();
}

defineExpose({ focusDetail, save });
</script>

<template>
  <article class="address-book-detail">
    <header class="address-book-detail__header">
      <AppIconButton
        class="address-book-detail__back"
        :disabled="deleting || contactsStore.saving"
        title="Back"
        aria-label="Back"
        @click="emit('back')"
      >
        <ArrowLeft :size="18" :stroke-width="1.65" aria-hidden="true" />
      </AppIconButton>
      <template v-if="mode === 'view' && addressbook">
        <AppIconButton
          :disabled="deleting || addressbook.may_write !== 1"
          :title="addressbook.may_write === 1
            ? 'Edit address book'
            : 'You don’t have permission to edit this address book.'"
          aria-label="Edit address book"
          @click="emit('edit')"
        >
          <Pencil :size="18" :stroke-width="1.65" aria-hidden="true" />
        </AppIconButton>
        <AppIconButton
          danger
          :disabled="deleting || contactsStore.saving || deleteDisabledReason !== null"
          :title="deleteDisabledReason || 'Delete address book'"
          aria-label="Delete address book"
          @click="emit('requestDelete')"
        >
          <Trash2 :size="18" :stroke-width="1.65" aria-hidden="true" />
        </AppIconButton>
      </template>
    </header>

    <form
      v-if="editing"
      class="address-book-detail__editor"
      novalidate
      @submit.prevent="save"
    >
      <h2>{{ title }}</h2>
      <label class="address-book-detail__field">
        <span>Name</span>
        <input
          ref="nameEl"
          v-model="name"
          type="text"
          autocomplete="off"
          required
          :aria-describedby="nameError ? 'address-book-name-error' : undefined"
          :aria-invalid="nameError ? 'true' : undefined"
        />
        <small
          v-if="nameError"
          id="address-book-name-error"
          class="address-book-detail__field-error"
          role="alert"
        >
          {{ nameError }}
        </small>
      </label>

      <label class="address-book-detail__field">
        <span>Description <small>(optional)</small></span>
        <textarea v-model="description" rows="4" />
      </label>

      <label class="address-book-detail__checkbox">
        <input
          v-model="setAsDefault"
          type="checkbox"
          :disabled="addressbook?.is_default === 1"
        />
        <span>Set as default</span>
      </label>
      <small
        v-if="addressbook?.is_default === 1"
        class="address-book-detail__hint"
      >
        This is already the default address book.
      </small>

      <p v-if="displayError" class="address-book-detail__error" role="alert">
        {{ displayError }}
      </p>

      <footer class="address-book-detail__footer">
        <AppButton
          variant="outline"
          :disabled="contactsStore.saving"
          @click="emit('cancel')"
        >
          Cancel
        </AppButton>
        <AppButton
          class="address-book-detail__save"
          form-action="submit"
          :disabled="contactsStore.saving"
        >
          {{ contactsStore.saving ? 'Saving…' : 'Save address book' }}
        </AppButton>
      </footer>
    </form>

    <div v-else-if="addressbook" class="address-book-detail__body">
      <h2
        ref="headingEl"
        class="address-book-detail__display-name"
        tabindex="-1"
      >
        {{ addressBookDisplayName(addressbook) }}
      </h2>
      <div v-if="addressbook.is_default === 1" class="address-book-detail__statuses">
        <span class="address-book-detail__badge">
          Personal
        </span>
      </div>
      <section>
        <h3>Description</h3>
        <p>{{ addressbook.description || '(not set)' }}</p>
      </section>
      <p v-if="addressbook.may_write !== 1" class="address-book-detail__protected">
        The mail server does not allow this address book to be edited.
      </p>
    </div>
  </article>
</template>

<style scoped>
.address-book-detail {
  display: flex;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--surface, #fff);
}

.address-book-detail__header {
  display: flex;
  min-height: 57px;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  padding: 11px 12px;
  border-bottom: 1px solid var(--border, #e3e6ee);
}

.address-book-detail__back {
  margin-right: 12px;
}

.address-book-detail__editor,
.address-book-detail__body {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 20px;
}

.address-book-detail__editor {
  display: grid;
  align-content: start;
  gap: 18px;
}

.address-book-detail__editor h2,
.address-book-detail__display-name {
  margin: 0;
  font-size: 20px;
  text-align: center;
  overflow-wrap: anywhere;
}

.address-book-detail__display-name:focus-visible {
  border-radius: 3px;
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.address-book-detail__field {
  display: grid;
  gap: 5px;
}

.address-book-detail__field > span,
.address-book-detail__body h3 {
  color: var(--muted, #6b7388);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.address-book-detail__field small {
  font-weight: 500;
  text-transform: none;
}

.address-book-detail__field input,
.address-book-detail__field textarea {
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 6px;
  background: var(--panel, #fff);
  color: var(--text, #1a1d24);
  font: inherit;
  font-size: 13px;
}

.address-book-detail__field input:focus-visible,
.address-book-detail__field textarea:focus-visible {
  border-color: var(--accent);
  outline: none;
}

.address-book-detail__field textarea {
  resize: vertical;
}

.address-book-detail__checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
}

.address-book-detail__checkbox input {
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: var(--accent);
}

.address-book-detail__hint,
.address-book-detail__field-error,
.address-book-detail__error {
  margin: -10px 0 0;
  font-size: 12px;
}

.address-book-detail__hint {
  color: var(--muted, #6b7388);
}

.address-book-detail__field-error,
.address-book-detail__error {
  color: #c93838;
}

.address-book-detail__footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--border-soft, #eef0f5);
}

.address-book-detail__save {
  white-space: nowrap;
}

.address-book-detail__body {
  display: grid;
  align-content: start;
  gap: 20px;
}

.address-book-detail__statuses {
  display: flex;
  justify-content: center;
  gap: 8px;
  color: var(--text, #1a1d24);
  font-size: 12px;
}

.address-book-detail__badge {
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  font-weight: 700;
}

.address-book-detail__body h3 {
  margin: 0 0 6px;
}

.address-book-detail__body p {
  margin: 0;
  white-space: pre-wrap;
}

.address-book-detail__protected {
  padding: 10px 12px;
  border: 1px solid var(--border-soft, #eef0f5);
  border-radius: 8px;
  color: var(--muted, #6b7388);
  font-size: 12px;
}
</style>
