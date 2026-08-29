<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { storeToRefs } from 'pinia';
import { ArrowLeft } from '@lucide/vue';

import {
  useContactsStore,
  type ContactBatchActionResult,
} from '../stores/contacts-store';
import {
  DIRECTORY_COLUMN_MIN_WIDTHS,
  useDirectoryColumnResize,
} from '../composables/useDirectoryColumnResize';
import type {
  AddressbookRow,
  ContactDetail,
  IdentityRow,
} from '../types';
import AppIconButton from './AppIconButton.vue';
import ContactDetailPane from './contacts/ContactDetailPane.vue';
import BulkOperationOverlay from './BulkOperationOverlay.vue';
import ContactsConfirmationDialog from './contacts/ContactsConfirmationDialog.vue';
import ContactsRail from './contacts/ContactsRail.vue';
import DirectoryDetailShell from './contacts/DirectoryDetailShell.vue';
import DirectoryList from './contacts/DirectoryList.vue';
import IdentityDetailPane from './contacts/IdentityDetailPane.vue';
import {
  contactEntry,
  identityEntry,
  identityMayDelete,
  type ContactsConfirmationChoice,
  type ContactsConfirmationKind,
  type DirectoryEntry,
  type DirectoryKind,
  type DirectoryLayout,
  type DirectoryMobilePane,
} from './contacts/directory-types';

const props = withDefaults(defineProps<{
  filterQuery?: string;
}>(), {
  filterQuery: '',
});

const emit = defineEmits<{
  restoreFilter: [value: string];
}>();

type DetailState =
  | 'create'
  | 'deleting'
  | 'edit'
  | 'empty'
  | 'error'
  | 'loading'
  | 'view';
type DetailFailureState = 'save-error' | 'validation-error';

interface ContactPaneHandle {
  focusDetail: () => Promise<void>;
  save: () => Promise<boolean>;
}

interface IdentityPaneHandle {
  focusDetail: () => Promise<void>;
  save: () => Promise<boolean>;
}

interface DirectoryListHandle {
  focusSelected: () => Promise<void>;
}

interface PendingConfirmation {
  count: number;
  kind: ContactsConfirmationKind;
  permanentCount: number;
  resolve: (choice: ContactsConfirmationChoice) => void;
  scopeLabel: string;
  subject: string;
}

interface ContactSavedPayload {
  detail: ContactDetail | null;
  key: string | null;
}

const contactsStore = useContactsStore();
const {
  addressbooks,
  contacts,
  deletingIdentityIds,
  deletingIds,
  identities,
  movingIds,
} = storeToRefs(contactsStore);

const kind = ref<DirectoryKind>('contacts');
const selectedBookId = ref<number | null>(null);
const selectedKey = ref<string | null>(null);
const selectedContactIds = ref<Set<number>>(new Set());
const contactDetail = ref<ContactDetail | null>(null);
const identityDetail = ref<IdentityRow | null>(null);
const detailState = ref<DetailState>('empty');
const detailError = ref<string | null>(null);
const detailFailureState = ref<DetailFailureState | null>(null);
const editorDirty = ref(false);
const loadingDirectory = ref(true);
const directoryError = ref<string | null>(null);
const operationNotice = ref('');
const resetSequence = ref(0);
const windowWidth = ref(typeof window === 'undefined' ? 1024 : window.innerWidth);
const mobilePane = ref<DirectoryMobilePane>('list');
const contactsEl = ref<HTMLElement | null>(null);
const contactPaneEl = ref<ContactPaneHandle | null>(null);
const identityPaneEl = ref<IdentityPaneHandle | null>(null);
const directoryListEl = ref<DirectoryListHandle | null>(null);
const confirmation = ref<PendingConfirmation | null>(null);
const confirmationBusy = ref(false);
const deletingKey = ref<string | null>(null);
let focusAfterConfirmation = false;
let externalDecisionActive = false;
let detailReadToken = 0;
let mounted = true;
const CONTACTS_RESIZE_STORAGE_KEY = 'stormbox.contactsColumnWidths.v1';
const CONTACT_BATCH_OVERLAY_THRESHOLD = 500;
const contactBatchOverlay = ref({
  active: false,
  label: '',
  total: 0,
});

async function withContactBatchOverlay<T>(
  label: string,
  count: number,
  operation: () => Promise<T>,
): Promise<T> {
  if (count > CONTACT_BATCH_OVERLAY_THRESHOLD) {
    contactBatchOverlay.value = { active: true, label, total: count };
  }
  try {
    return await operation();
  } finally {
    contactBatchOverlay.value = { active: false, label: '', total: 0 };
  }
}

const layout = computed<DirectoryLayout>(() => {
  if (windowWidth.value < 640) return 'phone';
  if (windowWidth.value < 1024) return 'tablet';
  return 'desktop';
});

const bookCounts = computed(() => {
  const counts = new Map<number, number>();
  for (const contact of contacts.value) {
    for (const bookId of contact.addressbook_ids ?? []) {
      counts.set(bookId, (counts.get(bookId) ?? 0) + 1);
    }
  }
  return counts;
});

function bookLabel(book: AddressbookRow): string {
  if (book.is_default) return 'Personal';
  return book.name?.trim() || 'Address book';
}

const selectedBook = computed(() =>
  addressbooks.value.find((book) => book.id === selectedBookId.value) ?? null);
const hasBulkSelection = computed(() => selectedContactIds.value.size > 0);
const selectedContacts = computed(() => {
  const selected = selectedContactIds.value;
  return contacts.value.filter((contact) => selected.has(contact.id));
});

function writableBook(id: number): boolean {
  const book = addressbooks.value.find((candidate) => candidate.id === id);
  return Boolean(book && book.may_write === 1);
}

const canDragContacts = computed(() =>
  kind.value === 'contacts'
  && selectedBookId.value != null
  && writableBook(selectedBookId.value));
const moveTargets = computed(() => {
  if (!canDragContacts.value) return [];
  return addressbooks.value
    .filter((book) =>
      book.id !== selectedBookId.value
      && book.may_write === 1)
    .map((book) => ({ id: book.id, name: bookLabel(book) }));
});
function contactsCanBeDeleted(rows: typeof contacts.value): boolean {
  if (rows.length === 0) return false;
  if (selectedBookId.value != null) return writableBook(selectedBookId.value);
  return rows.every((contact) =>
    contact.addressbook_ids.length > 0
    && contact.addressbook_ids.every(writableBook));
}
const canDeleteSelection = computed(() =>
  contactsCanBeDeleted(selectedContacts.value));
const deleteDisabledReason = computed(() => {
  if (selectedContactIds.value.size === 0) return '';
  if (canDeleteSelection.value) return '';
  return selectedBookId.value == null
    ? 'One or more contacts belongs to an address book that cannot be changed'
    : 'This address book cannot be changed';
});

const availableEntries = computed<DirectoryEntry[]>(() => {
  if (kind.value === 'identities') {
    return identities.value.map(identityEntry);
  }
  const scoped = selectedBookId.value == null
    ? contacts.value
    : contacts.value.filter((contact) =>
      contact.addressbook_ids.includes(selectedBookId.value!));
  return scoped.map(contactEntry);
});

function entryMatchesFilter(entry: DirectoryEntry, query: string): boolean {
  const term = query.trim().toLowerCase();
  const email = entry.kind === 'contact'
    ? entry.contact.email ?? ''
    : entry.identity.email;
  return !term
    || entry.name.toLowerCase().includes(term)
    || email.toLowerCase().includes(term);
}

const filteredEntries = computed(() =>
  availableEntries.value.filter((entry) =>
    entryMatchesFilter(entry, props.filterQuery)));

const selectedEntry = computed(() =>
  availableEntries.value.find((entry) => entry.key === selectedKey.value) ?? null);
const selectedIdentity = computed(() => {
  if (selectedEntry.value?.kind === 'identity') return selectedEntry.value.identity;
  return identityDetail.value;
});

const listTitle = computed(() => {
  if (kind.value === 'identities') return 'Identities';
  return selectedBook.value ? bookLabel(selectedBook.value) : 'All contacts';
});

const addLabel = computed(() =>
  kind.value === 'identities' ? 'Add identity' : 'Add contact');

const emptyMessage = computed(() => {
  if (props.filterQuery.trim()) return 'No matches.';
  if (kind.value === 'identities') return 'No identities yet.';
  if (selectedBookId.value != null) return 'No contacts in this address book.';
  return 'No contacts yet.';
});
const listError = computed(() => directoryError.value);

const listResetToken = computed(() => [
  kind.value,
  selectedBookId.value ?? 'all',
  props.filterQuery,
  resetSequence.value,
].join(':'));

const selectedAddressbookNames = computed(() => {
  const ids = new Set(contactDetail.value?.addressbook_ids ?? []);
  return addressbooks.value
    .filter((book) => ids.has(book.id))
    .map(bookLabel);
});

const createAddressbookIds = computed(() =>
  selectedBookId.value == null ? [] : [selectedBookId.value]);

const detailDisplayState = computed(() =>
  detailFailureState.value ?? detailState.value);
const showDetailView = computed(() =>
  detailDisplayState.value !== 'empty' && !hasBulkSelection.value);
const {
  activeResizePane,
  clampColumnWidths,
  columnStyle,
  listWidth,
  maxListWidth,
  maxRailWidth,
  onResizeHandleKeydown,
  railWidth,
  startColumnResize,
} = useDirectoryColumnResize({
  detailVisible: showDetailView,
  layout,
  rootEl: contactsEl,
  storageKey: CONTACTS_RESIZE_STORAGE_KEY,
});

const selectedIsDeleting = computed(() => {
  const entry = selectedEntry.value;
  if (!entry) return false;
  return entry.kind === 'contact'
    ? deletingIds.value.includes(entry.id) || movingIds.value.includes(entry.id)
    : deletingIdentityIds.value.includes(entry.id);
});

function onResize(): void {
  const wasPhone = layout.value === 'phone';
  const nextWidth = window.innerWidth;
  windowWidth.value = nextWidth;
  if (!wasPhone && nextWidth < 640) {
    mobilePane.value = detailState.value === 'empty' ? 'list' : 'detail';
  }
  void nextTick(clampColumnWidths);
}

onMounted(async () => {
  mounted = true;
  window.addEventListener('resize', onResize);
  loadingDirectory.value = true;
  directoryError.value = null;
  try {
    contactsStore.error = null;
    await contactsStore.attach();
    await contactsStore.listContacts();
    if (contacts.value.length === 0 && contactsStore.error) {
      directoryError.value = contactsStore.error;
    }
  } catch (error) {
    directoryError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (mounted) {
      loadingDirectory.value = false;
      await restoreListFocus();
    }
  }
});

onBeforeUnmount(() => {
  mounted = false;
  detailReadToken += 1;
  window.removeEventListener('resize', onResize);
  if (confirmation.value) {
    confirmation.value.resolve('cancel');
    confirmation.value = null;
  }
});

function askConfirmation(
  kindValue: ContactsConfirmationKind,
  subject = '',
  {
    count = 1,
    permanentCount = 0,
    scopeLabel = '',
  }: {
    count?: number;
    permanentCount?: number;
    scopeLabel?: string;
  } = {},
): Promise<ContactsConfirmationChoice> {
  if (confirmation.value) return Promise.resolve('cancel');
  return new Promise((resolve) => {
    confirmation.value = {
      count,
      kind: kindValue,
      permanentCount,
      scopeLabel,
      subject,
      resolve,
    };
  });
}

function chooseConfirmation(choice: ContactsConfirmationChoice): void {
  const pending = confirmation.value;
  if (!pending || confirmationBusy.value) return;
  if (choice === 'save') {
    confirmationBusy.value = true;
    pending.resolve(choice);
    return;
  }
  confirmation.value = null;
  pending.resolve(choice);
}

function finishBusyConfirmation(): void {
  confirmationBusy.value = false;
  confirmation.value = null;
  if (focusAfterConfirmation) {
    focusAfterConfirmation = false;
    void focusDetailPane();
  }
}

function leaveEditor(): void {
  if (detailState.value !== 'create' && detailState.value !== 'edit') return;
  editorDirty.value = false;
  detailFailureState.value = null;
  detailState.value = selectedEntry.value ? 'view' : 'empty';
}

async function prepareNavigation(): Promise<boolean> {
  if (detailState.value === 'deleting' || contactsStore.saving) return false;
  if (detailState.value !== 'create' && detailState.value !== 'edit') return true;
  if (!editorDirty.value) {
    leaveEditor();
    return true;
  }

  const choice = await askConfirmation('unsaved');
  switch (choice) {
    case 'cancel':
      return false;
    case 'discard':
      leaveEditor();
      return true;
    case 'save': {
      try {
        const saved = kind.value === 'contacts'
          ? await contactPaneEl.value?.save()
          : await identityPaneEl.value?.save();
        return saved === true;
      } finally {
        finishBusyConfirmation();
      }
    }
    case 'delete':
      return false;
    default: {
      const exhaustive: never = choice;
      return exhaustive;
    }
  }
}

function clearSelection(): void {
  detailReadToken += 1;
  selectedKey.value = null;
  contactDetail.value = null;
  identityDetail.value = null;
  detailError.value = null;
  detailFailureState.value = null;
  detailState.value = 'empty';
  editorDirty.value = false;
  mobilePane.value = 'list';
}

function clearBulkSelection(): void {
  if (selectedContactIds.value.size === 0) return;
  selectedContactIds.value = new Set();
}

async function changeBulkSelection(next: Set<number>): Promise<void> {
  if (kind.value !== 'contacts') return;
  if (
    next.size > 0
    && selectedContactIds.value.size === 0
    && !(await prepareNavigation())
  ) {
    return;
  }
  selectedContactIds.value = new Set(next);
  operationNotice.value = '';
  if (next.size > 0 && layout.value === 'phone') mobilePane.value = 'list';
}

async function loadContact(entry: Extract<DirectoryEntry, { kind: 'contact' }>): Promise<void> {
  const token = ++detailReadToken;
  identityDetail.value = null;
  detailError.value = null;
  detailFailureState.value = null;
  detailState.value = 'loading';
  try {
    const detail = await contactsStore.getContact(entry.id);
    if (token !== detailReadToken || selectedKey.value !== entry.key) return;
    if (!detail) {
      detailState.value = 'error';
      detailError.value = 'This contact is no longer available.';
      return;
    }
    contactDetail.value = detail;
    detailState.value = 'view';
  } catch (error) {
    if (token !== detailReadToken || selectedKey.value !== entry.key) return;
    detailState.value = 'error';
    detailError.value = error instanceof Error ? error.message : String(error);
  }
}

async function selectEntryWithoutGuard(entry: DirectoryEntry): Promise<void> {
  selectedKey.value = entry.key;
  editorDirty.value = false;
  mobilePane.value = 'detail';
  if (entry.kind === 'contact') {
    await loadContact(entry);
    if (layout.value === 'phone' && detailState.value === 'view') {
      await focusDetailPane();
    }
    return;
  }
  detailReadToken += 1;
  contactDetail.value = null;
  identityDetail.value = entry.identity;
  detailError.value = null;
  detailFailureState.value = null;
  detailState.value = 'view';
  if (layout.value === 'phone') await focusDetailPane();
}

async function selectEntry(entry: DirectoryEntry): Promise<void> {
  clearBulkSelection();
  operationNotice.value = '';
  if (entry.key === selectedKey.value) {
    mobilePane.value = 'detail';
    if (layout.value === 'phone') await focusDetailPane();
    return;
  }
  if (!await prepareNavigation()) return;
  await selectEntryWithoutGuard(entry);
}

async function selectBook(id: number | null): Promise<void> {
  if (kind.value === 'contacts' && selectedBookId.value === id) return;
  if (!await prepareNavigation()) return;
  kind.value = 'contacts';
  selectedBookId.value = id;
  clearBulkSelection();
  operationNotice.value = '';
  clearSelection();
  resetSequence.value += 1;
  await restoreListFocus();
}

async function selectIdentities(): Promise<void> {
  if (kind.value === 'identities') return;
  if (!await prepareNavigation()) return;
  kind.value = 'identities';
  clearBulkSelection();
  operationNotice.value = '';
  clearSelection();
  resetSequence.value += 1;
  loadingDirectory.value = true;
  directoryError.value = null;
  try {
    contactsStore.error = null;
    await contactsStore.listIdentities({ refreshServer: true });
    if (identities.value.length === 0 && contactsStore.error) {
      directoryError.value = contactsStore.error;
    }
  } catch (error) {
    directoryError.value = error instanceof Error ? error.message : String(error);
  } finally {
    loadingDirectory.value = false;
  }
  await restoreListFocus();
}

async function openCreate(requestedKind: DirectoryKind = kind.value): Promise<void> {
  if (!await prepareNavigation()) return;
  if (requestedKind !== kind.value) {
    kind.value = requestedKind;
    if (requestedKind === 'contacts') selectedBookId.value = null;
    resetSequence.value += 1;
  }
  clearBulkSelection();
  operationNotice.value = '';
  detailReadToken += 1;
  selectedKey.value = null;
  contactDetail.value = null;
  identityDetail.value = null;
  detailError.value = null;
  detailFailureState.value = null;
  editorDirty.value = false;
  detailState.value = 'create';
  mobilePane.value = 'detail';
}

function openEdit(): void {
  if (!selectedEntry.value || detailState.value !== 'view') return;
  editorDirty.value = false;
  detailFailureState.value = null;
  detailState.value = 'edit';
  mobilePane.value = 'detail';
}

async function restoreListFocus(): Promise<void> {
  await nextTick();
  await directoryListEl.value?.focusSelected();
}

async function focusDetailPane(): Promise<void> {
  await nextTick();
  if (kind.value === 'contacts') {
    await contactPaneEl.value?.focusDetail();
  } else {
    await identityPaneEl.value?.focusDetail();
  }
}

function restoreDetailFocus(): void {
  if (confirmationBusy.value) {
    focusAfterConfirmation = true;
    return;
  }
  void focusDetailPane();
}

function cancelEditor(): void {
  leaveEditor();
  if (layout.value === 'phone') mobilePane.value = 'list';
  void restoreListFocus();
}

function onDetailStateChange(state: DetailFailureState | null): void {
  detailFailureState.value = state;
}

async function closeDetail(): Promise<void> {
  if (!await prepareNavigation()) return;
  clearSelection();
  await restoreListFocus();
}

async function onContactSaved(payload: ContactSavedPayload): Promise<void> {
  editorDirty.value = false;
  detailFailureState.value = null;
  if (!payload.key) {
    clearSelection();
    detailState.value = 'error';
    detailError.value = 'The contact was saved, but its cached detail is unavailable.';
    return;
  }
  selectedKey.value = payload.key;
  identityDetail.value = null;
  mobilePane.value = 'detail';
  if (payload.detail) {
    detailReadToken += 1;
    contactDetail.value = payload.detail;
    detailError.value = null;
    detailState.value = 'view';
    restoreDetailFocus();
    return;
  }
  const entry = availableEntries.value.find((candidate) =>
    candidate.key === payload.key);
  if (entry?.kind === 'contact') {
    await loadContact(entry);
    return;
  }
  detailState.value = 'error';
  detailError.value = 'The contact was saved, but its cached detail is unavailable.';
}

function onIdentitySaved(key: string | null): void {
  editorDirty.value = false;
  detailFailureState.value = null;
  if (!key) {
    clearSelection();
    detailState.value = 'error';
    detailError.value = 'The identity was saved, but its cached detail is unavailable.';
    return;
  }
  const entry = availableEntries.value.find((candidate) => candidate.key === key);
  if (!entry || entry.kind !== 'identity') {
    clearSelection();
    detailState.value = 'error';
    detailError.value = 'The identity was saved, but its cached detail is unavailable.';
    return;
  }
  selectedKey.value = key;
  identityDetail.value = entry.identity;
  detailState.value = 'view';
  detailError.value = null;
  mobilePane.value = 'detail';
  restoreDetailFocus();
}

function permanentDeletionCount(contactIds: number[]): number {
  const requested = new Set(contactIds);
  if (selectedBookId.value == null) return requested.size;
  return contacts.value.reduce((count, contact) =>
    requested.has(contact.id) && contact.addressbook_ids.length <= 1
      ? count + 1
      : count, 0);
}

function contactBatchNotice(
  action: 'delete' | 'move',
  result: ContactBatchActionResult,
): string {
  const succeeded = result.succeededContactIds.length;
  const failed = result.failures.length;
  const verb = action === 'move' ? 'moved' : 'deleted';
  if (failed === 0) {
    return `${succeeded} contact${succeeded === 1 ? '' : 's'} ${verb}.`;
  }
  return `${succeeded} contact${succeeded === 1 ? '' : 's'} ${verb}; ${failed} failed and remain selected.`;
}

function retainFailedSelection(
  result: ContactBatchActionResult,
  requestedIds: number[],
): void {
  const availableIds = new Set(availableEntries.value.flatMap(
    (entry) => entry.kind === 'contact' ? [entry.contact.id] : [],
  ));
  const requested = new Set(requestedIds);
  const retained = [...selectedContactIds.value].filter(
    (id) => !requested.has(id) && availableIds.has(id),
  );
  for (const failure of result.failures) {
    if (availableIds.has(failure.contactId)) retained.push(failure.contactId);
  }
  selectedContactIds.value = new Set(retained);
}

async function deleteContactBatch(
  contactIds: number[],
  detailEntry?: Extract<DirectoryEntry, { kind: 'contact' }>,
): Promise<void> {
  const rows = contacts.value.filter((contact) => contactIds.includes(contact.id));
  if (!contactsCanBeDeleted(rows)) {
    operationNotice.value = deleteDisabledReason.value
      || 'These contacts cannot be changed.';
    return;
  }
  const count = rows.length;
  if (count === 0) return;
  const scoped = selectedBookId.value != null;
  const choice = await askConfirmation(
    scoped ? 'delete-contacts-scoped' : 'delete-contacts-global',
    '',
    {
      count,
      permanentCount: permanentDeletionCount(contactIds),
      scopeLabel: selectedBook.value ? bookLabel(selectedBook.value) : '',
    },
  );
  if (choice !== 'delete') return;

  const index = detailEntry
    ? filteredEntries.value.findIndex((candidate) => candidate.key === detailEntry.key)
    : -1;
  const nextKey = index >= 0 ? filteredEntries.value[index + 1]?.key ?? null : null;
  const previousKey = index >= 0 ? filteredEntries.value[index - 1]?.key ?? null : null;
  if (detailEntry) {
    deletingKey.value = detailEntry.key;
    detailState.value = 'deleting';
  }
  const result = await withContactBatchOverlay(
    'Deleting contacts',
    contactIds.length,
    () => contactsStore.deleteContacts(contactIds, selectedBookId.value),
  );
  deletingKey.value = null;
  operationNotice.value = contactBatchNotice('delete', result);
  retainFailedSelection(result, contactIds);

  if (detailEntry && result.failures.some(
    (failure) => failure.contactId === detailEntry.id,
  )) {
    selectedKey.value = detailEntry.key;
    await loadContact(detailEntry);
    return;
  }
  if (
    detailEntry
    || (
      selectedEntry.value?.kind === 'contact'
      && result.succeededContactIds.includes(selectedEntry.value.id)
      && !availableEntries.value.some((entry) => entry.key === selectedEntry.value?.key)
    )
  ) {
    const replacement = availableEntries.value.find((candidate) =>
      candidate.key === nextKey)
      ?? availableEntries.value.find((candidate) => candidate.key === previousKey)
      ?? null;
    clearSelection();
    if (detailEntry && replacement) await selectEntryWithoutGuard(replacement);
  }
}

async function moveContactBatch({
  contactIds,
  sourceAddressbookId,
  targetAddressbookId,
}: {
  contactIds: number[];
  sourceAddressbookId: number;
  targetAddressbookId: number;
}): Promise<void> {
  const selected = selectedEntry.value;
  if (
    selected?.kind === 'contact'
    && contactIds.includes(selected.id)
    && !(await prepareNavigation())
  ) {
    return;
  }
  const result = await withContactBatchOverlay(
    'Moving contacts',
    contactIds.length,
    () => contactsStore.moveContacts(
      contactIds,
      sourceAddressbookId,
      targetAddressbookId,
    ),
  );
  operationNotice.value = contactBatchNotice('move', result);
  retainFailedSelection(result, contactIds);
  if (
    selected?.kind === 'contact'
    && result.succeededContactIds.includes(selected.id)
    && !availableEntries.value.some((entry) => entry.key === selected.key)
  ) {
    clearSelection();
  }
}

function moveSelection(targetAddressbookId: number): void {
  if (selectedBookId.value == null) return;
  void moveContactBatch({
    contactIds: [...selectedContactIds.value],
    sourceAddressbookId: selectedBookId.value,
    targetAddressbookId,
  });
}

function deleteSelection(): void {
  void deleteContactBatch([...selectedContactIds.value]);
}

async function requestDelete(): Promise<void> {
  const entry = selectedEntry.value;
  if (!entry || detailState.value !== 'view') return;
  if (entry.kind === 'contact') {
    await deleteContactBatch([entry.id], entry);
    return;
  }
  if (!identityMayDelete(entry.identity)) return;
  const choice = await askConfirmation('delete-identity', entry.name);
  if (choice !== 'delete') return;
  const index = filteredEntries.value.findIndex((candidate) =>
    candidate.key === entry.key);
  const nextKey = filteredEntries.value[index + 1]?.key ?? null;
  const previousKey = filteredEntries.value[index - 1]?.key ?? null;
  deletingKey.value = entry.key;
  detailState.value = 'deleting';
  const result = await contactsStore.deleteIdentity(entry.identity);
  deletingKey.value = null;
  if (!result.ok) {
    selectedKey.value = entry.key;
    detailState.value = 'view';
    return;
  }
  const replacement = availableEntries.value.find((candidate) =>
    candidate.key === nextKey)
    ?? availableEntries.value.find((candidate) => candidate.key === previousKey)
    ?? null;
  clearSelection();
  if (replacement) await selectEntryWithoutGuard(replacement);
}

async function retryDetail(): Promise<void> {
  const entry = selectedEntry.value;
  if (entry?.kind === 'contact') await loadContact(entry);
}

async function requestLeave(): Promise<boolean> {
  return prepareNavigation();
}

async function requestFilterChange(next: string): Promise<boolean> {
  clearBulkSelection();
  operationNotice.value = '';
  const entry = selectedEntry.value;
  if (!entry || entryMatchesFilter(entry, next)) return true;
  if (!await prepareNavigation()) return false;
  clearSelection();
  return true;
}

async function resolveExternalChange(): Promise<void> {
  if (externalDecisionActive) return;
  if (
    detailState.value !== 'create'
    && detailState.value !== 'edit'
  ) {
    clearSelection();
    return;
  }
  if (!editorDirty.value) {
    clearSelection();
    return;
  }

  externalDecisionActive = true;
  try {
    const choice = await askConfirmation('external-change');
    switch (choice) {
      case 'cancel':
        return;
      case 'discard':
        clearSelection();
        return;
      case 'save': {
        let saved = false;
        try {
          saved = kind.value === 'contacts'
            ? await contactPaneEl.value?.save() === true
            : await identityPaneEl.value?.save() === true;
        } finally {
          finishBusyConfirmation();
        }
        if (
          saved
          && !availableEntries.value.some((entry) => entry.key === selectedKey.value)
        ) {
          clearSelection();
        }
        return;
      }
      case 'delete':
        return;
      default: {
        const exhaustive: never = choice;
        return exhaustive;
      }
    }
  } finally {
    externalDecisionActive = false;
  }
}

watch(
  () => props.filterQuery,
  async (next, previous) => {
    clearBulkSelection();
    operationNotice.value = '';
    resetSequence.value += 1;
    const entry = selectedEntry.value;
    if (!entry || entryMatchesFilter(entry, next)) return;
    if (!await prepareNavigation()) {
      emit('restoreFilter', previous);
      return;
    }
    clearSelection();
  },
);

watch(
  () => filteredEntries.value
    .flatMap((entry) => entry.kind === 'contact' ? [entry.id] : [])
    .join(','),
  () => {
    if (selectedContactIds.value.size === 0) return;
    const availableIds = new Set(filteredEntries.value.flatMap(
      (entry) => entry.kind === 'contact' ? [entry.id] : [],
    ));
    const retained = new Set(
      [...selectedContactIds.value].filter((id) => availableIds.has(id)),
    );
    if (retained.size !== selectedContactIds.value.size) {
      selectedContactIds.value = retained;
    }
  },
);

watch(
  () => [
    availableEntries.value.map((entry) => entry.key).join('\u0000'),
    contactsStore.saving,
  ] as const,
  ([, saving]) => {
    if (saving) return;
    if (!selectedKey.value || selectedKey.value === deletingKey.value) return;
    if (availableEntries.value.some((entry) => entry.key === selectedKey.value)) return;
    void resolveExternalChange();
  },
);

defineExpose({
  requestFilterChange,
  requestLeave,
});
</script>

<template>
  <section
    ref="contactsEl"
    class="contacts"
    :class="`contacts--${layout}`"
    :data-layout="layout"
    :data-detail-state="detailDisplayState"
    :style="columnStyle"
  >
    <ContactsRail
      :addressbooks="addressbooks"
      :book-counts="bookCounts"
      :contact-count="contacts.length"
      :identity-count="identities.length"
      :kind="kind"
      :selected-book-id="selectedBookId"
      @add-contact="openCreate('contacts')"
      @move-contacts="moveContactBatch"
      @select-book="selectBook"
      @select-identities="selectIdentities"
    />

    <div
      v-if="layout === 'desktop'"
      class="column-resizer contacts__column-resizer contacts__column-resizer--rail"
      :class="{ 'is-active': activeResizePane === 'rail' }"
      role="separator"
      aria-label="Resize address book list"
      aria-orientation="vertical"
      :aria-valuemin="DIRECTORY_COLUMN_MIN_WIDTHS.rail"
      :aria-valuemax="maxRailWidth(listWidth)"
      :aria-valuenow="railWidth"
      tabindex="0"
      @pointerdown="startColumnResize('rail', $event)"
      @keydown="onResizeHandleKeydown('rail', $event)"
    />

    <DirectoryDetailShell
      :detail-visible="showDetailView"
      :layout="layout"
      :mobile-pane="mobilePane"
    >
      <template #list>
        <DirectoryList
          ref="directoryListEl"
          :add-label="addLabel"
          :can-delete-selection="canDeleteSelection"
          :can-drag-contacts="canDragContacts"
          :delete-disabled-reason="deleteDisabledReason"
          :empty-message="emptyMessage"
          :entries="filteredEntries"
          :error="listError"
          :list-kind="kind"
          :loading="loadingDirectory"
          :move-targets="moveTargets"
          :notice="operationNotice"
          :reset-token="listResetToken"
          :selected-contact-ids="selectedContactIds"
          :selected-key="selectedKey"
          :source-addressbook-id="selectedBookId"
          :title="listTitle"
          @add="openCreate"
          @delete-selection="deleteSelection"
          @move-selection="moveSelection"
          @select="selectEntry"
          @selection-change="changeBulkSelection"
        />
      </template>

      <template #separator>
        <div
          class="column-resizer contacts__column-resizer contacts__column-resizer--list"
          :class="{ 'is-active': activeResizePane === 'list' }"
          role="separator"
          aria-label="Resize contact list"
          aria-orientation="vertical"
          :aria-valuemin="DIRECTORY_COLUMN_MIN_WIDTHS.list"
          :aria-valuemax="maxListWidth(railWidth)"
          :aria-valuenow="listWidth"
          tabindex="0"
          @pointerdown="startColumnResize('list', $event)"
          @keydown="onResizeHandleKeydown('list', $event)"
        />
      </template>

      <template #detail>
        <div class="contacts__detail-wrap">
          <ContactDetailPane
            v-if="
              kind === 'contacts'
                && (
                  detailState === 'create'
                    || detailState === 'loading'
                    || (
                      contactDetail
                        && (
                          detailState === 'view'
                            || detailState === 'edit'
                            || detailState === 'deleting'
                        )
                    )
                )
            "
            ref="contactPaneEl"
            :addressbook-names="selectedAddressbookNames"
            :create-addressbook-ids="createAddressbookIds"
            :deleting="selectedIsDeleting || detailState === 'deleting'"
            :detail="contactDetail"
            :mode="
              detailState === 'create'
                ? 'create'
                : (
                  detailState === 'edit'
                    ? 'edit'
                    : (detailState === 'loading' ? 'loading' : 'view')
                )
            "
            @back="closeDetail"
            @cancel="cancelEditor"
            @dirty-change="editorDirty = $event"
            @edit="openEdit"
            @request-delete="requestDelete"
            @saved="onContactSaved"
            @state-change="onDetailStateChange"
          />

          <IdentityDetailPane
            v-else-if="
              kind === 'identities'
                && (
                  detailState === 'create'
                    || (
                      selectedIdentity
                        && (
                          detailState === 'view'
                            || detailState === 'edit'
                            || detailState === 'deleting'
                        )
                    )
                )
            "
            ref="identityPaneEl"
            :deleting="selectedIsDeleting || detailState === 'deleting'"
            :identity="selectedIdentity"
            :mode="
              detailState === 'create'
                ? 'create'
                : (detailState === 'edit' ? 'edit' : 'view')
            "
            @back="closeDetail"
            @cancel="cancelEditor"
            @dirty-change="editorDirty = $event"
            @edit="openEdit"
            @request-delete="requestDelete"
            @saved="onIdentitySaved"
            @state-change="onDetailStateChange"
          />

          <div
            v-else-if="detailState === 'error'"
            class="contacts__detail-status"
            role="alert"
          >
            <header class="contacts__detail-status-bar">
              <AppIconButton
                title="Back"
                aria-label="Back"
                @click="closeDetail"
              >
                <ArrowLeft :size="18" :stroke-width="1.65" aria-hidden="true" />
              </AppIconButton>
            </header>
            <p>{{ detailError || 'This directory entry could not be loaded.' }}</p>
            <button
              v-if="selectedEntry?.kind === 'contact'"
              type="button"
              @click="retryDetail"
            >
              Try again
            </button>
          </div>
          </div>
      </template>
    </DirectoryDetailShell>

    <BulkOperationOverlay
      :active="contactBatchOverlay.active"
      item-label="contacts"
      :label="contactBatchOverlay.label"
      singular-item-label="contact"
      :total="contactBatchOverlay.total"
    />

    <ContactsConfirmationDialog
      v-if="confirmation"
      :kind="confirmation.kind"
      :busy="confirmationBusy"
      :count="confirmation.count"
      :permanent-count="confirmation.permanentCount"
      :scope-label="confirmation.scopeLabel"
      :subject="confirmation.subject"
      @choose="chooseConfirmation"
    />
  </section>
</template>

<style scoped>
.contacts {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-columns:
    minmax(
      var(--directory-rail-min-width, 180px),
      var(--contacts-rail-width, 240px)
    )
    var(--contacts-column-resizer-width, 6px)
    minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  background: var(--surface, #fff);
}

.contacts > :deep(.contacts-rail) {
  grid-column: 1;
  border-right: 0;
}

.contacts__column-resizer--rail {
  grid-column: 2;
}

.contacts > :deep(.directory-shell) {
  grid-column: 3;
}

.contacts :deep(.directory-list) {
  border-right: 0;
}

.contacts__column-resizer {
  width: 100%;
  height: 100%;
}

.contacts__detail-wrap {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
}

.contacts__detail-status {
  display: grid;
  height: 100%;
  min-height: 0;
  grid-template-rows: auto 1fr;
  color: var(--muted, #6b7388);
  text-align: center;
}

.contacts__detail-status-bar {
  display: flex;
  min-height: 57px;
  align-items: center;
  padding: 11px 12px;
  border-bottom: 1px solid var(--border, #e3e6ee);
}

.contacts__detail-status p {
  align-self: center;
  margin: 0;
}

.contacts__detail-status button {
  min-height: 34px;
  padding: 6px 12px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 6px;
  background: var(--panel, #fff);
  color: var(--text, #1a1d24);
  font: inherit;
  cursor: pointer;
}

@media (max-width: 1023px) {
  .contacts {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }

  .contacts > :deep(.contacts-rail) {
    grid-column: 1;
    grid-row: 1;
  }

  .contacts > :deep(.directory-shell) {
    grid-column: 1;
    grid-row: 2;
  }
}
</style>
