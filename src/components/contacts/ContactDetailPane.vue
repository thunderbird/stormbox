<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  watch,
} from 'vue';
import {
  ArrowLeft,
  Copy,
  Pencil,
  Trash2,
} from '@lucide/vue';

import { useDetailPaneEditor } from '../../composables/useDetailPaneEditor';
import { useContactsStore } from '../../stores/contacts-store';
import type {
  ContactDetail,
  ContactMutationFields,
} from '../../types';
import { contactMutationFieldsFromDetail } from '../../utils/contact-fields';
import {
  CONTACT_PHOTO_ACCEPT,
  readContactPhotoFile,
} from '../../utils/contact-photo';
import { createContactMapKey } from '../../utils/contact-uid';
import AppButton from '../AppButton.vue';
import AppIconButton from '../AppIconButton.vue';
import ContactAffiliationsEditor from './ContactAffiliationsEditor.vue';
import ContactAvatar from './ContactAvatar.vue';
import ContactDateSection from './ContactDateSection.vue';
import ContactDetailsView from './ContactDetailsView.vue';
import ContactNotesSection from './ContactNotesSection.vue';
import ContactResourceSection from './ContactResourceSection.vue';
import {
  contactEditorFields,
  createContactEditorModel,
  type ContactEditorModel,
} from './contact-editor';

type ContactDetailPaneMode = 'create' | 'edit' | 'loading' | 'view';

interface ContactSavedPayload {
  detail: ContactDetail | null;
  key: string | null;
  uid: string | null;
}

const props = withDefaults(defineProps<{
  addressbookNames: string[];
  createAddressbookIds: number[];
  deleting?: boolean;
  detail: ContactDetail | null;
  mode: ContactDetailPaneMode;
}>(), {
  deleting: false,
});

const emit = defineEmits<{
  back: [];
  cancel: [];
  dirtyChange: [dirty: boolean];
  duplicate: [];
  edit: [];
  requestDelete: [];
  saved: [payload: ContactSavedPayload];
  stateChange: [state: 'save-error' | 'validation-error' | null];
}>();

const contactsStore = useContactsStore();
const formEl = ref<HTMLFormElement | null>(null);
const errorEl = ref<HTMLParagraphElement | null>(null);
const fullNameEl = ref<HTMLInputElement | null>(null);
const photoInputEl = ref<HTMLInputElement | null>(null);
const detailViewEl = ref<{ focusHeading: () => Promise<void> } | null>(null);
const model = ref<ContactEditorModel>(createContactEditorModel(props.detail));
const initialFields = ref<ContactMutationFields | null>(null);
const createRetryUid = ref<string | null>(null);
const fieldErrors = ref<Record<string, string>>({});
const photoReading = ref(false);
let photoReadGeneration = 0;
const editing = computed(() => props.mode === 'create' || props.mode === 'edit');
const preferredEmail = computed(() =>
  model.value.emails.find((email) => email.isPreferred)?.value
    ?? model.value.emails.find((email) => email.value.trim())?.value
    ?? null);
const photoAccept = CONTACT_PHOTO_ACCEPT.join(',');

function resetForm(): void {
  photoReadGeneration += 1;
  photoReading.value = false;
  const detail = props.mode === 'create' ? null : props.detail;
  model.value = createContactEditorModel(detail);
  createRetryUid.value = null;
  initialFields.value = props.mode === 'edit' && detail
    ? contactMutationFieldsFromDetail(detail)
    : null;
  if (photoInputEl.value) photoInputEl.value.value = '';
  if (editing.value) {
    void nextTick(() => fullNameEl.value?.focus());
  }
}

const {
  beginSave,
  clearFailure,
  dirty,
  localError,
  markSaved,
  reportFailure,
  saveAttempted,
} = useDetailPaneEditor({
  additionalDirty: () => photoReading.value,
  changeSource: () => model.value,
  clearValidationErrors: () => {
    fieldErrors.value = {};
  },
  editing,
  emitDirtyChange: (value) => emit('dirtyChange', value),
  emitStateChange: (state) => emit('stateChange', state),
  resetForm,
  resetSource: () => [props.mode, props.detail?.id] as const,
  snapshot: () => JSON.stringify(model.value),
});
const displayError = computed(() =>
  localError.value || (saveAttempted.value ? contactsStore.error : null));
const firstErrorFieldKey = computed(() => Object.keys(fieldErrors.value)[0] ?? null);

// The form scrolls while Save stays in its sticky footer, so a form-level
// error at the top must be brought into view when it appears.
watch(
  () => (firstErrorFieldKey.value ? null : displayError.value),
  (message) => {
    if (!message) return;
    void nextTick(() => errorEl.value?.scrollIntoView?.({ block: 'nearest' }));
  },
);

function choosePhoto(): void {
  photoInputEl.value?.click();
}

async function onPhotoSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const generation = ++photoReadGeneration;
  const previousPhoto = model.value.photo;
  photoReading.value = true;
  emit('dirtyChange', true);
  localError.value = null;
  try {
    const photo = await readContactPhotoFile(file);
    if (generation !== photoReadGeneration) return;
    model.value.photo = {
      mapKey: previousPhoto?.mapKey ?? createContactMapKey('photo'),
      uri: photo.uri,
      blobId: null,
      mediaType: photo.mediaType,
      pref: previousPhoto ? previousPhoto.pref : 1,
    };
    clearFailure();
  } catch (error: any) {
    if (generation !== photoReadGeneration) return;
    reportFailure(
      'validation-error',
      error?.message ?? 'Could not read the selected image.',
    );
  } finally {
    if (generation === photoReadGeneration) {
      photoReading.value = false;
      emit('dirtyChange', dirty.value);
    }
  }
}

function removePhoto(): void {
  photoReadGeneration += 1;
  photoReading.value = false;
  model.value.photo = null;
  clearFailure();
}

onBeforeUnmount(() => {
  photoReadGeneration += 1;
  photoReading.value = false;
});

async function focusFirstInvalidField(fieldKey: string): Promise<void> {
  await nextTick();
  const row = Array.from(
    formEl.value?.querySelectorAll<HTMLElement>('[data-field-key]') ?? [],
  ).find((element) => element.dataset.fieldKey === fieldKey);
  const field = row?.querySelector<HTMLElement>('[aria-invalid="true"]');
  field?.scrollIntoView?.({ block: 'nearest' });
  field?.focus();
}

async function save(): Promise<boolean> {
  if (!editing.value || contactsStore.saving || photoReading.value) return false;
  beginSave();
  const result = contactEditorFields(model.value);
  if (!result.fields) {
    fieldErrors.value = result.errors;
    reportFailure('validation-error', result.error);
    if (result.errorFieldKey) await focusFirstInvalidField(result.errorFieldKey);
    return false;
  }

  let contactId: number | null = null;
  let detail: ContactDetail | null = null;
  let uid: string | null = null;
  let ok: boolean;
  if (props.mode === 'create') {
    const created = await contactsStore.createContactResult({
      contact: result.fields,
      addressbookIds: props.createAddressbookIds,
      ...(createRetryUid.value ? { uid: createRetryUid.value } : {}),
    });
    createRetryUid.value = created.uid;
    ok = created.ok;
    if (created.ok) {
      contactId = created.contactId;
      detail = created.detail;
      uid = created.uid;
    }
  } else if (props.detail) {
    if (!initialFields.value) {
      reportFailure(
        'save-error',
        'Contact details changed. Close and reopen the editor before saving.',
      );
      return false;
    }
    contactId = props.detail.id;
    ok = await contactsStore.updateContact({
      contactId: props.detail.id,
      baseline: initialFields.value,
      contact: result.fields,
    });
    if (ok) detail = await contactsStore.getContact(contactId);
  } else {
    ok = false;
  }
  if (!ok) {
    reportFailure(
      contactsStore.error?.startsWith('Enter ')
        ? 'validation-error'
        : 'save-error',
    );
    return false;
  }

  if (props.mode === 'edit') initialFields.value = result.fields;
  markSaved();
  emit('saved', {
    detail,
    key: contactId == null ? null : `contact:${contactId}`,
    uid,
  });
  return true;
}

async function focusDetail(): Promise<void> {
  await nextTick();
  await detailViewEl.value?.focusHeading();
}

defineExpose({ focusDetail, save });
</script>

<template>
  <article class="contact-detail">
    <header class="contact-detail__header">
      <AppIconButton
        class="contact-detail__action--back"
        :disabled="deleting || contactsStore.saving || photoReading"
        title="Back"
        aria-label="Back"
        @click="emit('back')"
      >
        <ArrowLeft :size="18" :stroke-width="1.65" aria-hidden="true" />
      </AppIconButton>
      <!-- While the next contact loads, `detail` is still the previous one and
           the owner ignores these actions, so they read as unavailable rather
           than as controls for a contact that is no longer shown. -->
      <template v-if="(mode === 'view' || mode === 'loading') && detail">
        <AppIconButton
          :disabled="deleting || mode === 'loading'"
          title="Edit"
          aria-label="Edit"
          @click="emit('edit')"
        >
          <Pencil :size="18" :stroke-width="1.65" aria-hidden="true" />
        </AppIconButton>
        <AppIconButton
          :disabled="deleting || contactsStore.saving || mode === 'loading'"
          title="Duplicate contact"
          aria-label="Duplicate contact"
          @click="emit('duplicate')"
        >
          <Copy :size="18" :stroke-width="1.65" aria-hidden="true" />
        </AppIconButton>
        <AppIconButton
          class="contact-detail__delete"
          danger
          :disabled="deleting || mode === 'loading'"
          title="Delete"
          aria-label="Delete"
          @click="emit('requestDelete')"
        >
          <Trash2 :size="18" :stroke-width="1.65" aria-hidden="true" />
        </AppIconButton>
      </template>
    </header>

    <div
      v-if="mode === 'loading'"
      class="contact-detail__loading"
      role="status"
    >
      <p>Loading contact…</p>
    </div>

    <form
      v-else-if="editing"
      ref="formEl"
      class="contact-detail__editor contacts__form"
      novalidate
      @submit.prevent="save"
    >
      <p
        v-if="displayError && !firstErrorFieldKey"
        ref="errorEl"
        class="contact-detail__error"
        role="alert"
      >
        {{ displayError }}
      </p>

      <div class="contact-detail__photo-editor">
        <ContactAvatar
          :email="preferredEmail"
          :name="model.fullName"
          :photo="model.photo"
          size="large"
        />
        <input
          ref="photoInputEl"
          class="contact-detail__photo-input"
          type="file"
          :accept="photoAccept"
          :disabled="photoReading"
          tabindex="-1"
          @change="onPhotoSelected"
        />
        <div class="contact-detail__photo-actions">
          <AppButton
            variant="outline"
            :disabled="photoReading"
            @click="choosePhoto"
          >
            {{ photoReading ? 'Reading photo…' : (model.photo ? 'Replace photo' : 'Upload photo') }}
          </AppButton>
          <AppButton
            v-if="model.photo"
            variant="outline"
            :disabled="photoReading"
            @click="removePhoto"
          >
            Remove
          </AppButton>
        </div>
      </div>

      <label class="contact-detail__field">
        <span>Full or display name</span>
        <input
          ref="fullNameEl"
          v-model="model.fullName"
          class="contact-editor__input"
          type="text"
          autocomplete="name"
          placeholder="Optional"
        />
      </label>

      <ContactResourceSection
        v-model="model.emails"
        :errors="fieldErrors"
        kind="email"
      />
      <ContactResourceSection
        v-model="model.phones"
        :errors="fieldErrors"
        kind="phone"
      />
      <ContactResourceSection
        v-model="model.links"
        :errors="fieldErrors"
        kind="website"
      />
      <ContactDateSection
        v-model="model.anniversaries"
        :errors="fieldErrors"
      />
      <ContactNotesSection v-model="model.notes" />
      <ContactAffiliationsEditor
        v-model:organizations="model.organizations"
        v-model:titles="model.titles"
      />

      <footer class="contact-detail__footer">
        <span v-if="mode === 'create'" class="contact-detail__hint">
          Email is optional.
        </span>
        <span v-else />
        <div class="contact-detail__footer-actions">
          <AppButton
            variant="outline"
            :disabled="contactsStore.saving || photoReading"
            @click="emit('cancel')"
          >
            Cancel
          </AppButton>
          <AppButton
            form-action="submit"
            :disabled="contactsStore.saving || photoReading"
          >
            {{ contactsStore.saving ? 'Saving…' : 'Save contact' }}
          </AppButton>
        </div>
      </footer>
    </form>

    <ContactDetailsView
      v-else-if="detail"
      ref="detailViewEl"
      :addressbook-names="addressbookNames"
      :detail="detail"
    />
  </article>
</template>

<style scoped>
.contact-detail {
  display: flex;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--surface, #fff);
}

.contact-detail__header {
  display: flex;
  min-width: 0;
  min-height: 57px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  padding: 11px 12px;
  overflow: hidden;
  border-bottom: 1px solid var(--border, #e3e6ee);
}

.contact-detail__action--back {
  margin-right: 12px;
}

.contact-detail__footer-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}

.contact-detail__editor,
.contact-detail__loading {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
}

.contact-detail__loading {
  display: grid;
  place-items: center;
  color: var(--muted, #6b7388);
}

.contact-detail__loading p {
  margin: 0;
}

.contact-detail__editor > :not(.contact-detail__footer) {
  width: min(100%, 480px);
  justify-self: center;
}

.contact-detail__editor {
  display: grid;
  align-content: start;
  gap: 22px;
  padding: 18px;
}

.contact-detail__field {
  display: grid;
  gap: 5px;
}

.contact-detail__photo-editor {
  display: grid;
  justify-items: center;
  gap: 10px;
}

.contact-detail__photo-input {
  display: none;
}

.contact-detail__photo-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}

.contact-detail__field > span {
  color: var(--muted, #6b7388);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.contact-detail__editor :deep(.contact-editor__input) {
  min-width: 0;
  min-height: 34px;
  padding: 6px 9px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 6px;
  background: var(--panel, #fff);
  color: var(--text, #1a1d24);
  font: inherit;
  font-size: 13px;
}

.contact-detail__editor :deep(.contact-editor__input:focus-visible) {
  border-color: var(--accent);
  outline: none;
}

.contact-detail__error {
  margin: 0;
  color: #c93838;
  font-size: 13px;
}

.contact-detail__footer {
  position: sticky;
  bottom: -18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 -18px -18px;
  padding: 12px 18px;
  border-top: 1px solid var(--border, #e3e6ee);
  background: var(--surface, #fff);
}

.contact-detail__hint {
  color: var(--muted, #6b7388);
  font-size: 12px;
}

</style>
