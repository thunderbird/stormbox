<script setup lang="ts">
import {
  computed,
  nextTick,
  ref,
  watch,
} from 'vue';
import { ArrowLeft, Pencil, Trash2 } from '@lucide/vue';

import {
  IDENTITY_ERROR,
  type IdentityError,
} from '../../constants/identity-errors';
import {
  type IdentityCreateInput,
  type IdentityUpdateInput,
  useContactsStore,
} from '../../stores/contacts-store';
import type {
  IdentityAddress,
  IdentityMutableFields,
  IdentityRow,
} from '../../types';
import {
  createIdentityOperationId,
  parseIdentityMailbox,
  textSignatureToHtml,
  utf8ByteLength,
  validateIdentitySignatures,
} from '../../utils/identity-fields';
import {
  isSemanticallyEmptyRichTextHtml,
  sanitizeRichTextHtml,
} from '../../utils/rich-text';
import AppButton from '../AppButton.vue';
import AppIconButton from '../AppIconButton.vue';
import RichTextEditor from '../RichTextEditor.vue';
import IdentityAddressRepeater from './IdentityAddressRepeater.vue';
import { identityMayDelete } from './directory-types';

type IdentityDetailPaneMode = 'create' | 'edit' | 'view';

interface IdentityAddressFormRow {
  formKey: string;
  originalName: string | null;
  name: string;
  email: string;
}

interface RichTextUpdate {
  html: string;
  text: string;
}

const props = withDefaults(defineProps<{
  deleting?: boolean;
  identity: IdentityRow | null;
  mode: IdentityDetailPaneMode;
}>(), {
  deleting: false,
});

const emit = defineEmits<{
  back: [];
  cancel: [];
  dirtyChange: [dirty: boolean];
  edit: [];
  requestDelete: [];
  saved: [key: string | null];
  stateChange: [state: 'save-error' | 'validation-error' | null];
}>();

const contactsStore = useContactsStore();
const headingEl = ref<HTMLHeadingElement | null>(null);
const nameEl = ref<HTMLInputElement | null>(null);
const name = ref('');
const originalName = ref('');
const nameTouched = ref(false);
const email = ref('');
const replyToRows = ref<IdentityAddressFormRow[]>([]);
const bccRows = ref<IdentityAddressFormRow[]>([]);
const replyToTouched = ref(false);
const bccTouched = ref(false);
const signatureHtml = ref('');
const signatureText = ref('');
const signatureTouched = ref(false);
const operationId = ref(createIdentityOperationId());
const initialSerialized = ref('');
const localError = ref<string | null>(null);
const saveAttempted = ref(false);

const editing = computed(() => props.mode === 'create' || props.mode === 'edit');
const title = computed(() => {
  if (props.mode === 'create') return 'New identity';
  if (props.mode === 'edit') return 'Edit identity';
  return props.identity?.name?.trim() || '(no name)';
});
const mayDelete = computed(() =>
  props.identity != null && identityMayDelete(props.identity));

function addressRows(
  addresses: IdentityAddress[] | null | undefined,
  kind: 'bcc' | 'reply-to',
): IdentityAddressFormRow[] {
  return (addresses ?? []).map((address, index) => ({
    formKey: `${kind}:${index}:${createIdentityOperationId()}`,
    originalName: address.name,
    name: address.name ?? '',
    email: address.email,
  }));
}

function canonicalName(): string {
  if (name.value === originalName.value) return originalName.value;
  return name.value.trim();
}

function canonicalAddresses(rows: IdentityAddressFormRow[]): IdentityAddress[] {
  return rows.map((row) => ({
    name: row.name === (row.originalName ?? '')
      ? row.originalName
      : row.name.trim() || null,
    email: row.email.trim(),
  }));
}

function signatureInitialHtml(identity: IdentityRow | null): string {
  if (!identity) return '';
  const html = identity.html_signature ?? '';
  const text = identity.text_signature ?? '';
  return text && isSemanticallyEmptyRichTextHtml(html)
    ? textSignatureToHtml(text)
    : html;
}

function formSnapshot(): string {
  return JSON.stringify({
    name: name.value,
    email: email.value,
    replyTo: replyToRows.value.map(({ formKey: _formKey, ...row }) => row),
    bcc: bccRows.value.map(({ formKey: _formKey, ...row }) => row),
    signatureHtml: signatureHtml.value,
    signatureText: signatureText.value,
  });
}

const dirty = computed(() =>
  editing.value && formSnapshot() !== initialSerialized.value);

function resetEditor(): void {
  const identity = props.mode === 'create' ? null : props.identity;
  originalName.value = identity?.name ?? '';
  name.value = identity?.name ?? '';
  email.value = identity?.email ?? '';
  replyToRows.value = addressRows(identity?.reply_to, 'reply-to');
  bccRows.value = addressRows(identity?.bcc, 'bcc');
  replyToTouched.value = false;
  bccTouched.value = false;
  nameTouched.value = false;
  signatureHtml.value = signatureInitialHtml(identity);
  signatureText.value = identity?.text_signature ?? '';
  signatureTouched.value = false;
  operationId.value = createIdentityOperationId();
  initialSerialized.value = formSnapshot();
  saveAttempted.value = false;
  localError.value = null;
  emit('dirtyChange', false);
  emit('stateChange', null);
  if (editing.value) void nextTick(() => nameEl.value?.focus());
}

watch(
  () => [props.mode, props.identity?.id] as const,
  resetEditor,
  { immediate: true },
);

watch(dirty, (value) => {
  emit('dirtyChange', value);
  if (value) emit('stateChange', null);
});

function rowErrors(
  rows: IdentityAddressFormRow[],
  touched: boolean,
): Record<string, string> {
  if (!touched && !saveAttempted.value) return {};
  const errors: Record<string, string> = {};
  for (const row of rows) {
    if (/[\r\n]/.test(row.name)) {
      errors[row.formKey] = 'Display names cannot contain a line break.';
    } else if (!row.email.trim()) {
      errors[row.formKey] = 'Enter an email address or remove this row.';
    } else if (!parseIdentityMailbox(row.email)) {
      errors[row.formKey] = 'Enter one mailbox address without a group or list.';
    }
  }
  return errors;
}

const replyToErrors = computed(() =>
  rowErrors(replyToRows.value, replyToTouched.value));
const bccErrors = computed(() =>
  rowErrors(bccRows.value, bccTouched.value));
const emailError = computed(() => {
  if (props.mode !== 'create' || !saveAttempted.value) return null;
  return parseIdentityMailbox(email.value)
    ? null
    : 'Enter a valid email address.';
});
const signatureIssue = computed(() => {
  if (!signatureTouched.value) return null;
  return validateIdentitySignatures(signatureHtml.value, signatureText.value);
});
const signatureError = computed(() => {
  if (signatureIssue.value === 'invalid') {
    return 'Use a small PNG, JPEG, GIF, or WebP data image in the signature.';
  }
  if (signatureIssue.value !== 'too-large') return null;
  const htmlBytes = utf8ByteLength(signatureHtml.value);
  const textBytes = utf8ByteLength(signatureText.value);
  return `Signature HTML is ${htmlBytes} bytes and plain text is ${textBytes} bytes. `
    + 'Each must be under 2,048 UTF-8 bytes.';
});
const hasValidationErrors = computed(() =>
  emailError.value !== null
  || Object.keys(replyToErrors.value).length > 0
  || Object.keys(bccErrors.value).length > 0
  || signatureError.value !== null);

watch(hasValidationErrors, (invalid) => {
  if (invalid) emit('stateChange', 'validation-error');
  else if (editing.value) emit('stateChange', null);
});

watch(
  [name, email, replyToRows, bccRows, signatureHtml, signatureText],
  () => {
    if (!saveAttempted.value && !localError.value) return;
    saveAttempted.value = false;
    localError.value = null;
    emit('stateChange', null);
  },
  { deep: true },
);

function handleSignatureUpdate(content: RichTextUpdate): void {
  const containsImage = /<img\b/iu.test(content.html);
  signatureHtml.value = content.text === '' && !containsImage ? '' : content.html;
  signatureText.value = content.text;
  signatureTouched.value = true;
}

function mutableFields(): IdentityMutableFields {
  const fields: IdentityMutableFields = {};
  const nextName = canonicalName();
  if (props.mode === 'create') {
    if (nameTouched.value) fields.name = nextName;
  } else if (nameTouched.value && nextName !== props.identity?.name) {
    fields.name = nextName;
  }

  const replyToAddresses = canonicalAddresses(replyToRows.value);
  const nextReplyTo = replyToAddresses.length > 0 ? replyToAddresses : null;
  if (
    replyToTouched.value
    && (
      props.mode === 'create'
      || JSON.stringify(nextReplyTo) !== JSON.stringify(props.identity?.reply_to ?? null)
    )
  ) {
    fields.replyTo = nextReplyTo;
  }

  const bccAddresses = canonicalAddresses(bccRows.value);
  const nextBcc = bccAddresses.length > 0 ? bccAddresses : null;
  if (
    bccTouched.value
    && (
      props.mode === 'create'
      || JSON.stringify(nextBcc) !== JSON.stringify(props.identity?.bcc ?? null)
    )
  ) {
    fields.bcc = nextBcc;
  }

  if (
    signatureTouched.value
    && (
      props.mode === 'create'
      || signatureHtml.value !== props.identity?.html_signature
      || signatureText.value !== props.identity?.text_signature
    )
  ) {
    fields.htmlSignature = signatureHtml.value;
    fields.textSignature = signatureText.value;
  }
  return fields;
}

const validationErrors = new Set<IdentityError>([
  IDENTITY_ERROR.INVALID_NAME,
  IDENTITY_ERROR.INVALID_EMAIL,
  IDENTITY_ERROR.INVALID_REPLY_TO,
  IDENTITY_ERROR.INVALID_BCC,
  IDENTITY_ERROR.INVALID_SIGNATURE,
  IDENTITY_ERROR.SIGNATURE_TOO_LARGE,
  IDENTITY_ERROR.IMMUTABLE_FIELD,
]);

async function save(): Promise<boolean> {
  if (!editing.value || contactsStore.saving) return false;
  saveAttempted.value = true;
  if (hasValidationErrors.value) {
    localError.value = 'Correct the highlighted identity fields.';
    emit('stateChange', 'validation-error');
    return false;
  }

  const fields = mutableFields();
  let result;
  if (props.mode === 'create') {
    const input: IdentityCreateInput = {
      operationId: operationId.value,
      email: email.value,
      ...fields,
    };
    result = await contactsStore.createIdentity(input);
  } else if (props.identity) {
    const input: IdentityUpdateInput = {
      operationId: operationId.value,
      remoteId: props.identity.remote_id,
      ...fields,
    };
    result = await contactsStore.updateIdentity(input);
  } else {
    localError.value = 'This identity is no longer available.';
    emit('stateChange', 'save-error');
    return false;
  }
  if (result.ok === false) {
    emit(
      'stateChange',
      validationErrors.has(result.error) ? 'validation-error' : 'save-error',
    );
    return false;
  }

  initialSerialized.value = formSnapshot();
  emit('dirtyChange', false);
  emit('stateChange', null);
  emit('saved', `identity:${result.identity.id}`);
  return true;
}

const displayReplyTo = computed(() => props.identity?.reply_to ?? []);
const displayBcc = computed(() => props.identity?.bcc ?? []);
const displaySignatureHtml = computed(() =>
  sanitizeRichTextHtml(signatureInitialHtml(props.identity)));

async function focusDetail(): Promise<void> {
  await nextTick();
  headingEl.value?.focus();
}

defineExpose({ focusDetail, save });
</script>

<template>
  <article class="identity-detail">
    <header class="identity-detail__header">
      <AppIconButton
        class="identity-detail__action--back"
        :disabled="deleting || contactsStore.saving"
        title="Back"
        aria-label="Back"
        @click="emit('back')"
      >
        <ArrowLeft :size="18" :stroke-width="1.65" aria-hidden="true" />
      </AppIconButton>
      <template v-if="mode === 'view' && identity">
        <AppIconButton
          :disabled="deleting"
          title="Edit"
          aria-label="Edit"
          @click="emit('edit')"
        >
          <Pencil :size="18" :stroke-width="1.65" aria-hidden="true" />
        </AppIconButton>
        <AppIconButton
          class="identity-detail__delete"
          danger
          :disabled="deleting || !mayDelete"
          :title="mayDelete ? 'Delete identity' : 'This identity cannot be deleted'"
          aria-label="Delete"
          @click="emit('requestDelete')"
        >
          <Trash2 :size="18" :stroke-width="1.65" aria-hidden="true" />
        </AppIconButton>
      </template>
    </header>

    <form
      v-if="editing"
      class="identity-detail__editor contacts__form"
      novalidate
      @submit.prevent="save"
    >
      <label class="identity-detail__field">
        <span>Display name</span>
        <input
          ref="nameEl"
          v-model="name"
          class="identity-detail__input"
          type="text"
          autocomplete="name"
          @input="nameTouched = true"
        />
      </label>
      <label class="identity-detail__field">
        <span>{{ mode === 'edit' ? 'Email (cannot be changed)' : 'Email' }}</span>
        <input
          v-model="email"
          class="identity-detail__input"
          type="email"
          autocomplete="email"
          :aria-describedby="emailError ? 'identity-email-error' : undefined"
          :aria-invalid="emailError ? 'true' : undefined"
          :readonly="mode === 'edit'"
        />
        <small
          v-if="emailError"
          id="identity-email-error"
          class="identity-detail__field-error"
          role="alert"
        >
          {{ emailError }}
        </small>
      </label>

      <IdentityAddressRepeater
        kind="replyTo"
        :errors="replyToErrors"
        :rows="replyToRows"
        @touched="replyToTouched = true"
        @update="replyToRows = $event"
      />
      <IdentityAddressRepeater
        kind="bcc"
        :errors="bccErrors"
        :rows="bccRows"
        @touched="bccTouched = true"
        @update="bccRows = $event"
      />

      <section class="identity-detail__signature">
        <div class="identity-detail__section-heading">
          <span>Signature</span>
          <small id="identity-signature-help">
            HTML and plain text must each be under 2,048 bytes.
          </small>
        </div>
        <RichTextEditor
          accessible-label="Identity signature"
          :aria-describedby="signatureError
            ? 'identity-signature-help identity-signature-error'
            : 'identity-signature-help'"
          :aria-invalid="signatureError !== null"
          :content-key="operationId"
          :initial-html="signatureHtml"
          :max-serialized-utf8-bytes="2047"
          @update="handleSignatureUpdate"
        />
        <p
          v-if="signatureError"
          id="identity-signature-error"
          class="identity-detail__field-error"
          role="alert"
        >
          {{ signatureError }}
        </p>
      </section>

      <p
        v-if="saveAttempted && (localError || contactsStore.error)"
        class="identity-detail__error"
        role="alert"
      >
        {{ localError || contactsStore.error }}
      </p>

      <footer class="identity-detail__footer">
        <AppButton
          variant="outline"
          :disabled="contactsStore.saving"
          @click="emit('cancel')"
        >
          Cancel
        </AppButton>
        <AppButton
          form-action="submit"
          :disabled="contactsStore.saving || hasValidationErrors"
        >
          {{ contactsStore.saving ? 'Saving…' : 'Save identity' }}
        </AppButton>
      </footer>
    </form>

    <div v-else-if="identity" class="identity-detail__body">
      <h2
        ref="headingEl"
        class="identity-detail__display-name"
        tabindex="-1"
      >
        {{ title }}
      </h2>

      <section>
        <h3>Email address</h3>
        <p><a :href="`mailto:${identity.email}`">{{ identity.email }}</a></p>
      </section>
      <section>
        <h3>Reply-To addresses</h3>
        <p v-if="displayReplyTo.length === 0">(not set)</p>
        <ul v-else class="identity-detail__addresses">
          <li v-for="(address, index) in displayReplyTo" :key="`reply-to:${index}`">
            <span v-if="address.name">{{ address.name }} · </span>
            <a :href="`mailto:${address.email}`">{{ address.email }}</a>
          </li>
        </ul>
      </section>
      <section>
        <h3>Automatic Bcc addresses</h3>
        <p v-if="displayBcc.length === 0">(not set)</p>
        <ul v-else class="identity-detail__addresses">
          <li v-for="(address, index) in displayBcc" :key="`bcc:${index}`">
            <span v-if="address.name">{{ address.name }} · </span>
            <a :href="`mailto:${address.email}`">{{ address.email }}</a>
          </li>
        </ul>
      </section>
      <section>
        <h3>Signature</h3>
        <div
          v-if="displaySignatureHtml"
          class="identity-detail__signature-preview"
          v-html="displaySignatureHtml"
        />
        <p v-else>(not set)</p>
      </section>
      <p v-if="!mayDelete" class="identity-detail__protected">
        This identity is managed by the server and cannot be deleted.
      </p>
    </div>
  </article>
</template>

<style scoped>
.identity-detail {
  display: flex;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--surface, #fff);
}

.identity-detail__header {
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

.identity-detail__action--back {
  margin-right: 12px;
}

.identity-detail__display-name {
  min-width: 0;
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  text-align: center;
  overflow-wrap: anywhere;
}

.identity-detail__display-name:focus-visible {
  border-radius: 3px;
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.identity-detail__footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.identity-detail__body,
.identity-detail__editor {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 20px;
}

.identity-detail__body {
  display: grid;
  align-content: start;
  gap: 20px;
}

.identity-detail__body h3 {
  margin: 0 0 6px;
  color: var(--muted, #6b7388);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.identity-detail__body p,
.identity-detail__addresses {
  margin: 0;
}

.identity-detail__addresses {
  display: grid;
  gap: 5px;
  padding-left: 18px;
}

.identity-detail__body a {
  color: var(--accent);
}

.identity-detail__protected {
  padding: 10px 12px;
  border: 1px solid var(--border-soft, #eef0f5);
  border-radius: 8px;
  color: var(--muted, #6b7388);
  font-size: 12px;
}

.identity-detail__editor {
  display: grid;
  align-content: start;
  gap: 18px;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr);
}

.identity-detail__field {
  display: grid;
  gap: 5px;
}

.identity-detail__field > span,
.identity-detail__section-heading > span {
  color: var(--muted, #6b7388);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.identity-detail__input {
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

.identity-detail__input:read-only {
  color: var(--muted, #6b7388);
  background: var(--panel2, #f5f6fa);
}

.identity-detail__input:focus-visible {
  border-color: var(--accent);
  outline: none;
}

.identity-detail__signature {
  display: grid;
  gap: 8px;
  min-width: 0;
  min-height: 280px;
  grid-template-columns: minmax(0, 1fr);
}

.identity-detail__signature :deep(.rich-text-editor) {
  min-width: 0;
  min-height: 230px;
}

.identity-detail__section-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.identity-detail__section-heading small {
  color: var(--muted, #6b7388);
  font-size: 11px;
}

.identity-detail__signature-preview {
  overflow-wrap: anywhere;
}

.identity-detail__signature-preview :deep(img) {
  max-width: 100%;
  height: auto;
}

.identity-detail__error,
.identity-detail__field-error {
  margin: 0;
  color: #c93838;
  font-size: 13px;
}

.identity-detail__footer {
  justify-content: flex-end;
  padding-top: 12px;
  border-top: 1px solid var(--border-soft, #eef0f5);
}

@media (max-width: 760px) {
  .identity-detail__section-heading {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
