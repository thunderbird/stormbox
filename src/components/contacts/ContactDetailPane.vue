<script setup lang="ts">
import {
  computed,
  nextTick,
  ref,
  watch,
} from 'vue';
import { ArrowLeft, Pencil, Trash2 } from '@lucide/vue';

import { useContactsStore } from '../../stores/contacts-store';
import type {
  ContactDetail,
  ContactDetailResource,
  ContactMutationFields,
} from '../../types';
import {
  contactMutationFieldsFromDetail,
  isHttpContactWebsite,
} from '../../utils/contact-fields';
import AppButton from '../AppButton.vue';
import AppIconButton from '../AppIconButton.vue';
import ContactAffiliationsEditor from './ContactAffiliationsEditor.vue';
import ContactDateSection from './ContactDateSection.vue';
import ContactNotesSection from './ContactNotesSection.vue';
import ContactResourceSection from './ContactResourceSection.vue';
import {
  contactAnniversaryKindLabel,
  contactEditorFields,
  contactResourceLabel,
  createContactEditorModel,
  formatContactDate,
  type ContactEditorModel,
  type ContactEditorResource,
  type ContactResourceKind,
} from './contact-editor';

type ContactDetailPaneMode = 'create' | 'edit' | 'loading' | 'view';

interface ContactSavedPayload {
  detail: ContactDetail | null;
  key: string | null;
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
  edit: [];
  requestDelete: [];
  saved: [payload: ContactSavedPayload];
  stateChange: [state: 'save-error' | 'validation-error' | null];
}>();

const contactsStore = useContactsStore();
const formEl = ref<HTMLFormElement | null>(null);
const fullNameEl = ref<HTMLInputElement | null>(null);
const headingEl = ref<HTMLHeadingElement | null>(null);
const model = ref<ContactEditorModel>(createContactEditorModel(props.detail));
const initialSerialized = ref('');
const initialFields = ref<ContactMutationFields | null>(null);
const localError = ref<string | null>(null);
const fieldErrors = ref<Record<string, string>>({});
const saveAttempted = ref(false);
const editing = computed(() => props.mode === 'create' || props.mode === 'edit');
const title = computed(() => {
  if (props.mode === 'create') return 'New contact';
  if (props.mode === 'edit') return 'Edit contact';
  return props.detail?.full_name?.trim()
    || props.detail?.display_name?.trim()
    || '(no name)';
});
const displayError = computed(() =>
  localError.value || (saveAttempted.value ? contactsStore.error : null));
const firstErrorFieldKey = computed(() => Object.keys(fieldErrors.value)[0] ?? null);
const dirty = computed(() =>
  editing.value && JSON.stringify(model.value) !== initialSerialized.value);

function resetEditor(): void {
  const detail = props.mode === 'create' ? null : props.detail;
  model.value = createContactEditorModel(detail);
  initialFields.value = props.mode === 'edit' && detail
    ? contactMutationFieldsFromDetail(detail)
    : null;
  initialSerialized.value = JSON.stringify(model.value);
  localError.value = null;
  fieldErrors.value = {};
  saveAttempted.value = false;
  emit('dirtyChange', false);
  emit('stateChange', null);
  if (editing.value) {
    void nextTick(() => fullNameEl.value?.focus());
  }
}

watch(
  () => [props.mode, props.detail?.id] as const,
  resetEditor,
  { immediate: true },
);

watch(
  model,
  () => {
    const value = dirty.value;
    emit('dirtyChange', value);
    if (saveAttempted.value) {
      saveAttempted.value = false;
      localError.value = null;
      fieldErrors.value = {};
      emit('stateChange', null);
    }
  },
  { deep: true },
);

function labelFor(
  kind: ContactResourceKind,
  resource: ContactDetailResource,
): string {
  return contactResourceLabel(kind, {
    ...resource,
    formKey: resource.mapKey ?? '',
  } as ContactEditorResource);
}

function titlesForOrganization(
  organizationMapKey: string | null,
): ContactDetail['titles'] {
  if (!props.detail) return [];
  return props.detail.titles.filter((title) =>
    organizationMapKey != null
      && title.organizationMapKey === organizationMapKey);
}

const unlinkedTitles = computed(() => {
  if (!props.detail) return [];
  const organizationKeys = new Set(
    props.detail.organizations
      .map((organization) => organization.mapKey)
      .filter((mapKey): mapKey is string => Boolean(mapKey)),
  );
  return props.detail.titles.filter((title) =>
    title.organizationMapKey == null
    || !organizationKeys.has(title.organizationMapKey));
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
  if (!editing.value || contactsStore.saving) return false;
  saveAttempted.value = true;
  localError.value = null;
  const result = contactEditorFields(model.value);
  if (!result.fields) {
    localError.value = result.error;
    fieldErrors.value = result.errors;
    emit('stateChange', 'validation-error');
    if (result.errorFieldKey) await focusFirstInvalidField(result.errorFieldKey);
    return false;
  }

  let contactId: number | null = null;
  let detail: ContactDetail | null = null;
  let ok: boolean;
  if (props.mode === 'create') {
    const created = await contactsStore.createContactResult({
      contact: result.fields,
      addressbookIds: props.createAddressbookIds,
    });
    ok = created.ok;
    if (created.ok) {
      contactId = created.contactId;
      detail = created.detail;
    }
  } else if (props.detail) {
    if (!initialFields.value) {
      localError.value = 'Contact details changed. Close and reopen the editor before saving.';
      emit('stateChange', 'save-error');
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
    emit(
      'stateChange',
      contactsStore.error?.startsWith('Enter ')
        ? 'validation-error'
        : 'save-error',
    );
    return false;
  }

  initialSerialized.value = JSON.stringify(model.value);
  if (props.mode === 'edit') initialFields.value = result.fields;
  emit('dirtyChange', false);
  emit('stateChange', null);
  emit('saved', {
    detail,
    key: contactId == null ? null : `contact:${contactId}`,
  });
  return true;
}

async function focusDetail(): Promise<void> {
  await nextTick();
  headingEl.value?.focus();
}

defineExpose({ focusDetail, save });
</script>

<template>
  <article class="contact-detail">
    <header class="contact-detail__header">
      <AppIconButton
        class="contact-detail__action--back"
        :disabled="deleting || contactsStore.saving"
        title="Back"
        aria-label="Back"
        @click="emit('back')"
      >
        <ArrowLeft :size="18" :stroke-width="1.65" aria-hidden="true" />
      </AppIconButton>
      <template v-if="(mode === 'view' || mode === 'loading') && detail">
        <AppIconButton
          :disabled="deleting"
          title="Edit"
          aria-label="Edit"
          @click="emit('edit')"
        >
          <Pencil :size="18" :stroke-width="1.65" aria-hidden="true" />
        </AppIconButton>
        <AppIconButton
          class="contact-detail__delete"
          danger
          :disabled="deleting"
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

      <p
        v-if="displayError && !firstErrorFieldKey"
        class="contact-detail__error"
        role="alert"
      >
        {{ displayError }}
      </p>

      <footer class="contact-detail__footer">
        <span v-if="mode === 'create'" class="contact-detail__hint">
          Email is optional.
        </span>
        <span v-else />
        <div class="contact-detail__footer-actions">
          <AppButton
            variant="outline"
            :disabled="contactsStore.saving"
            @click="emit('cancel')"
          >
            Cancel
          </AppButton>
          <AppButton
            form-action="submit"
            :disabled="contactsStore.saving"
          >
            {{ contactsStore.saving ? 'Saving…' : 'Save contact' }}
          </AppButton>
        </div>
      </footer>
    </form>

    <div v-else-if="detail" class="contact-detail__body">
      <h2
        ref="headingEl"
        class="contact-detail__display-name"
        tabindex="-1"
      >
        {{ title }}
      </h2>

      <section v-if="detail.emails.length > 0">
        <h3>Email addresses</h3>
        <dl>
          <template v-for="email in detail.emails" :key="email.mapKey ?? email.position">
            <dt>{{ labelFor('email', email) }}</dt>
            <dd>
              <a :href="`mailto:${email.value}`">{{ email.value }}</a>
              <span v-if="email.isPreferred" class="contact-detail__primary">Primary</span>
            </dd>
          </template>
        </dl>
      </section>

      <section v-if="detail.phones.length > 0">
        <h3>Phone numbers</h3>
        <dl>
          <template v-for="phone in detail.phones" :key="phone.mapKey ?? phone.position">
            <dt>{{ labelFor('phone', phone) }}</dt>
            <dd><a :href="`tel:${phone.value}`">{{ phone.value }}</a></dd>
          </template>
        </dl>
      </section>

      <section v-if="detail.links.length > 0">
        <h3>Websites</h3>
        <dl>
          <template v-for="link in detail.links" :key="link.mapKey ?? link.position">
            <dt>{{ labelFor('website', link) }}</dt>
            <dd>
              <a
                v-if="isHttpContactWebsite(link.value)"
                :href="link.value"
                target="_blank"
                rel="noopener noreferrer"
              >{{ link.value }}</a>
              <span v-else>{{ link.value }}</span>
            </dd>
          </template>
        </dl>
      </section>

      <section v-if="detail.anniversaries.length > 0">
        <h3>Dates</h3>
        <dl>
          <template
            v-for="anniversary in detail.anniversaries"
            :key="anniversary.mapKey ?? anniversary.position"
          >
            <dt>{{ contactAnniversaryKindLabel(anniversary.kind) }}</dt>
            <dd>{{ formatContactDate(anniversary.date) }}</dd>
          </template>
        </dl>
      </section>

      <section v-if="detail.notes.length > 0">
        <h3>Notes</h3>
        <p
          v-for="note in detail.notes"
          :key="note.mapKey ?? note.position"
          class="contact-detail__note"
        >
          {{ note.value }}
        </p>
      </section>

      <section v-if="detail.organizations.length > 0 || unlinkedTitles.length > 0">
        <h3>Work affiliations</h3>
        <div
          v-for="organization in detail.organizations"
          :key="organization.mapKey ?? organization.position"
          class="contact-detail__affiliation"
        >
          <strong>{{ organization.name || 'Work' }}</strong>
          <p v-if="organization.units.length > 0">
            {{ organization.units.map((unit) => unit.value).join(' · ') }}
          </p>
          <p
            v-for="title in titlesForOrganization(organization.mapKey)"
            :key="title.mapKey ?? title.position"
          >
            {{ title.kind === 'title' ? 'Title' : 'Role' }}: {{ title.value }}
          </p>
        </div>
        <p
          v-for="title in unlinkedTitles"
          :key="title.mapKey ?? title.position"
          class="contact-detail__affiliation"
        >
          {{ title.kind === 'title' ? 'Title' : 'Role' }}: {{ title.value }}
        </p>
      </section>

      <section>
        <h3>Address books</h3>
        <p>{{ addressbookNames.length > 0 ? addressbookNames.join(', ') : 'None' }}</p>
      </section>

      <p
        v-if="
          detail.emails.length === 0
            && detail.phones.length === 0
            && detail.links.length === 0
            && detail.anniversaries.length === 0
            && detail.notes.length === 0
            && detail.organizations.length === 0
            && detail.titles.length === 0
        "
        class="contact-detail__empty"
      >
        No additional contact details.
      </p>
    </div>
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

.contact-detail__display-name {
  min-width: 0;
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  text-align: center;
  overflow-wrap: anywhere;
}

.contact-detail__display-name:focus-visible {
  border-radius: 3px;
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.contact-detail__footer-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}

.contact-detail__body,
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

.contact-detail__body {
  display: grid;
  align-content: start;
  gap: 20px;
  padding: 20px;
}

.contact-detail__body > *,
.contact-detail__editor > :not(.contact-detail__footer) {
  width: min(100%, 480px);
  justify-self: center;
}

.contact-detail__body section {
  min-width: 0;
}

.contact-detail__body h3 {
  margin: 0 0 8px;
  color: var(--muted, #6b7388);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.contact-detail__body dl {
  display: grid;
  grid-template-columns: minmax(80px, 0.35fr) minmax(0, 1fr);
  gap: 7px 12px;
  margin: 0;
}

.contact-detail__body dt {
  color: var(--muted, #6b7388);
  font-size: 12px;
}

.contact-detail__body dd,
.contact-detail__body p {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.contact-detail__body a {
  color: var(--accent);
}

.contact-detail__primary {
  margin-left: 7px;
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}

.contact-detail__note {
  white-space: pre-wrap;
}

.contact-detail__affiliation {
  margin-bottom: 9px !important;
  padding: 10px 12px;
  border: 1px solid var(--border-soft, #eef0f5);
  border-radius: 8px;
}

.contact-detail__affiliation p {
  margin-top: 3px;
  color: var(--muted, #6b7388);
  font-size: 12px;
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

.contact-detail__hint,
.contact-detail__empty {
  color: var(--muted, #6b7388);
  font-size: 12px;
}

</style>
