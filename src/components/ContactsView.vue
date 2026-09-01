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

import { addressBookErrorMessage } from '../constants/addressbook-errors';
import { useContactsStore } from '../stores/contacts-store';
import { useSettingsStore } from '../stores/settings-store';
import {
  useContactsWorkspaceActions,
  type DetailState,
  type DetailSubject,
} from '../composables/useContactsWorkspaceActions';
import {
  DIRECTORY_COLUMN_MIN_WIDTHS,
  useDirectoryColumnResize,
} from '../composables/useDirectoryColumnResize';
import type {
  DetailFailureState,
  DetailPaneHandle,
} from '../composables/useDetailPaneEditor';
import type {
  AddressbookRow,
  ContactDetail,
  ContactTrashDetail,
  IdentityRow,
} from '../types';
import { resolveComposeIdentityIndex } from '../utils/compose-identity';
import { addressBookDeleteDisabledReason } from '../utils/address-book-policy';
import { contactMutationFieldsFromDetail } from '../utils/contact-fields';
import { copyableContactPhoto } from '../utils/contact-photo';
import { normalizeContactUid } from '../utils/contact-uid';
import { nextCopyName } from '../utils/copy-name';
import AppIconButton from './AppIconButton.vue';
import AddressBookDeleteDialog from './contacts/AddressBookDeleteDialog.vue';
import AddressBookDetailPane from './contacts/AddressBookDetailPane.vue';
import ContactDetailPane from './contacts/ContactDetailPane.vue';
import ContactTrashDetailPane from './contacts/ContactTrashDetailPane.vue';
import BulkOperationOverlay from './BulkOperationOverlay.vue';
import ContactsConfirmationDialog from './contacts/ContactsConfirmationDialog.vue';
import ContactsRail from './contacts/ContactsRail.vue';
import DirectoryDetailShell from './contacts/DirectoryDetailShell.vue';
import DirectoryList from './contacts/DirectoryList.vue';
import IdentityDetailPane from './contacts/IdentityDetailPane.vue';
import RestoreContactDestinationDialog from './contacts/RestoreContactDestinationDialog.vue';
import {
  addressBookDisplayName,
  contactEntry,
  identityEntry,
  trashEntry,
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

interface DirectoryListHandle {
  focusSelected: () => Promise<void>;
}

interface ContactSavedPayload {
  detail: ContactDetail | null;
  key: string | null;
  uid: string | null;
}

const contactsStore = useContactsStore();
const settingsStore = useSettingsStore();
const {
  addressbooks,
  canCreateAddressBook,
  contacts,
  deletingAddressBookIds,
  deletingTrashIds,
  deletingIdentityIds,
  deletingIds,
  identities,
  movingIds,
  restoringTrashIds,
  trash,
} = storeToRefs(contactsStore);

const kind = ref<DirectoryKind>('contacts');
const selectedBookId = ref<number | null>(null);
const selectedKey = ref<string | null>(null);
const selectedContactIds = ref<Set<number>>(new Set());
const contactDetail = ref<ContactDetail | null>(null);
const trashDetail = ref<ContactTrashDetail | null>(null);
const identityDetail = ref<IdentityRow | null>(null);
const addressBookDetail = ref<AddressbookRow | null>(null);
const detailSubject = ref<DetailSubject>('entry');
const detailState = ref<DetailState>('empty');
const detailError = ref<string | null>(null);
const detailFailureState = ref<DetailFailureState | null>(null);
const editorDirty = ref(false);
const loadingDirectory = ref(true);
const directoryError = ref<string | null>(null);
const operationNotice = ref('');
const settingPrimaryIdentityId = ref<number | null>(null);
const resetSequence = ref(0);
const windowWidth = ref(typeof window === 'undefined' ? 1024 : window.innerWidth);
const mobilePane = ref<DirectoryMobilePane>('list');
const contactsEl = ref<HTMLElement | null>(null);
const contactPaneEl = ref<DetailPaneHandle | null>(null);
const identityPaneEl = ref<DetailPaneHandle | null>(null);
const addressBookPaneEl = ref<DetailPaneHandle | null>(null);
const trashPaneEl = ref<{ focusDetail: () => Promise<void> } | null>(null);
const directoryListEl = ref<DirectoryListHandle | null>(null);
let detailReadToken = 0;
let mounted = true;
const CONTACTS_RESIZE_STORAGE_KEY = 'stormbox.contactsColumnWidths.v1';

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

const selectedBook = computed(() =>
  addressbooks.value.find((book) => book.id === selectedBookId.value) ?? null);
const addressBookDetailDeleteReason = computed(() => {
  if (!addressBookDetail.value) return null;
  const reason = addressBookDeleteDisabledReason(
    addressBookDetail.value,
    addressbooks.value,
  );
  return reason ? addressBookErrorMessage(reason) : null;
});
const hasBulkSelection = computed(() => selectedContactIds.value.size > 0);
const selectedContacts = computed(() => {
  const selected = selectedContactIds.value;
  return contacts.value.filter((contact) => selected.has(contact.id));
});
const selectedTrash = computed(() => {
  const selected = selectedContactIds.value;
  return trash.value.filter((entry) => selected.has(entry.id));
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
    .map((book) => ({ id: book.id, name: addressBookDisplayName(book) }));
});
function contactsCanBeDeleted(rows: typeof contacts.value): boolean {
  if (rows.length === 0) return false;
  if (selectedBookId.value != null) return writableBook(selectedBookId.value);
  return rows.every((contact) =>
    contact.addressbook_ids.length > 0
    && contact.addressbook_ids.every(writableBook));
}
const canDeleteSelection = computed(() =>
  kind.value === 'trash'
    ? selectedTrash.value.length > 0
    : contactsCanBeDeleted(selectedContacts.value));
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
  if (kind.value === 'trash') {
    return trash.value.map(trashEntry);
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
    : (entry.kind === 'trash' ? entry.trash.primary_email ?? '' : entry.identity.email);
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
const primaryIdentity = computed(() => {
  if (identities.value.length === 0) return null;
  const index = resolveComposeIdentityIndex(identities.value, {
    primaryIdentityRemoteId: settingsStore.get('primaryIdentityRemoteId'),
  });
  return identities.value[index] ?? null;
});
const primaryIdentityId = computed(() => primaryIdentity.value?.id ?? null);
const selectedIdentityIsPrimary = computed(() =>
  selectedIdentity.value != null && selectedIdentity.value.id === primaryIdentityId.value);

const listTitle = computed(() => {
  if (kind.value === 'identities') return 'Identities';
  if (kind.value === 'trash') return 'Trash';
  return selectedBook.value
    ? addressBookDisplayName(selectedBook.value)
    : 'All contacts';
});

const addLabel = computed(() =>
  kind.value === 'identities' ? 'Add identity' : 'Add contact');

const emptyMessage = computed(() => {
  if (props.filterQuery.trim()) return 'No matches.';
  if (kind.value === 'identities') return 'No identities yet.';
  if (kind.value === 'trash') return 'Trash is empty.';
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
    .map(addressBookDisplayName);
});
const trashAddressbookNames = computed(() => {
  const ids = new Set(trashDetail.value?.original_addressbook_ids ?? []);
  return addressbooks.value
    .filter((book) => book.remote_id != null && ids.has(book.remote_id))
    .map(addressBookDisplayName);
});

const createAddressbookIds = computed(() =>
  kind.value === 'contacts' && selectedBookId.value != null ? [selectedBookId.value] : []);

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
  if (detailSubject.value === 'addressbook') {
    return addressBookDetail.value != null
      && deletingAddressBookIds.value.includes(addressBookDetail.value.id);
  }
  const entry = selectedEntry.value;
  if (!entry) return false;
  return entry.kind === 'contact'
    ? deletingIds.value.includes(entry.id) || movingIds.value.includes(entry.id)
    : (entry.kind === 'trash'
      ? deletingTrashIds.value.includes(entry.id) || restoringTrashIds.value.includes(entry.id)
      : deletingIdentityIds.value.includes(entry.id));
});

const {
  addressBookDeleteBusy,
  addressBookDeleteInventory,
  addressBookDeleteStale,
  addressBookDeleteTarget,
  confirmation,
  confirmationBusy,
  contactBatchOverlay,
  deletingKey,
  restoreDestinationIds,
  chooseConfirmation,
  chooseRestoreDestination,
  closeAddressBookDeleteDialog,
  confirmAddressBookDelete,
  deleteSelectedTrashForever,
  deleteSelection,
  deleteTrashSelectionForever,
  finishMissingAddressBook,
  leaveEditor,
  moveContactBatch,
  moveSelection,
  prepareNavigation,
  requestAddressBookDelete,
  requestDelete,
  resolveExternalChange,
  restoreDetailFocus,
  restoreSelectedTrash,
  restoreTrashSelection,
} = useContactsWorkspaceActions({
  contactsStore,
  addressbooks,
  contacts,
  trash,
  kind,
  selectedBookId,
  selectedKey,
  selectedContactIds,
  detailState,
  detailSubject,
  detailFailureState,
  editorDirty,
  addressBookDetail,
  operationNotice,
  resetSequence,
  selectedBook,
  selectedEntry,
  availableEntries,
  filteredEntries,
  deleteDisabledReason,
  contactsCanBeDeleted,
  clearSelection,
  loadContact,
  selectEntryWithoutGuard,
  restoreEntryDetailFromAddressBook,
  restoreListFocus,
  focusDetailPane,
  saveActiveEditor,
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

async function saveActiveEditor(): Promise<boolean> {
  if (detailSubject.value === 'addressbook') {
    return await addressBookPaneEl.value?.save() === true;
  }
  switch (kind.value) {
    case 'contacts':
      return await contactPaneEl.value?.save() === true;
    case 'identities':
      return await identityPaneEl.value?.save() === true;
    case 'trash':
      return false;
    default: {
      const exhaustive: never = kind.value;
      return exhaustive;
    }
  }
}

function clearSelection(): void {
  detailReadToken += 1;
  selectedKey.value = null;
  contactDetail.value = null;
  trashDetail.value = null;
  identityDetail.value = null;
  addressBookDetail.value = null;
  detailSubject.value = 'entry';
  detailError.value = null;
  detailFailureState.value = null;
  detailState.value = 'empty';
  editorDirty.value = false;
  mobilePane.value = 'list';
}

function restoreEntryDetailFromAddressBook(): void {
  addressBookDetail.value = null;
  detailSubject.value = 'entry';
  editorDirty.value = false;
  detailFailureState.value = null;
  detailError.value = null;
  const entry = selectedEntry.value;
  if (
    entry?.kind === 'contact'
    && contactDetail.value?.id === entry.id
  ) {
    detailState.value = 'view';
    mobilePane.value = 'detail';
    return;
  }
  if (
    entry?.kind === 'identity'
    && identityDetail.value?.id === entry.id
  ) {
    detailState.value = 'view';
    mobilePane.value = 'detail';
    return;
  }
  if (
    entry?.kind === 'trash'
    && trashDetail.value?.id === entry.id
  ) {
    detailState.value = 'view';
    mobilePane.value = 'detail';
    return;
  }
  clearSelection();
}

function clearBulkSelection(): void {
  if (selectedContactIds.value.size === 0) return;
  selectedContactIds.value = new Set();
}

async function changeBulkSelection(next: Set<number>): Promise<void> {
  if (kind.value === 'identities') return;
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

async function loadTrash(entry: Extract<DirectoryEntry, { kind: 'trash' }>): Promise<void> {
  const token = ++detailReadToken;
  contactDetail.value = null;
  trashDetail.value = null;
  identityDetail.value = null;
  detailError.value = null;
  detailFailureState.value = null;
  detailState.value = 'loading';
  try {
    const detail = await contactsStore.getContactTrash(entry.id);
    if (token !== detailReadToken || selectedKey.value !== entry.key) return;
    if (!detail) {
      detailState.value = 'error';
      detailError.value = 'This trashed contact is no longer available.';
      return;
    }
    trashDetail.value = detail;
    detailState.value = 'view';
  } catch (error) {
    if (token !== detailReadToken || selectedKey.value !== entry.key) return;
    detailState.value = 'error';
    detailError.value = error instanceof Error ? error.message : String(error);
  }
}

async function selectEntryWithoutGuard(entry: DirectoryEntry): Promise<void> {
  detailSubject.value = 'entry';
  addressBookDetail.value = null;
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
  if (entry.kind === 'trash') {
    await loadTrash(entry);
    if (layout.value === 'phone' && detailState.value === 'view') {
      await focusDetailPane();
    }
    return;
  }
  detailReadToken += 1;
  contactDetail.value = null;
  trashDetail.value = null;
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

async function selectTrash(): Promise<void> {
  if (kind.value === 'trash') return;
  if (!await prepareNavigation()) return;
  kind.value = 'trash';
  selectedBookId.value = null;
  clearBulkSelection();
  operationNotice.value = '';
  clearSelection();
  resetSequence.value += 1;
  loadingDirectory.value = true;
  directoryError.value = null;
  try {
    contactsStore.error = null;
    await contactsStore.refreshTrash();
    if (trash.value.length === 0 && contactsStore.error) {
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
  if (requestedKind === 'trash') return;
  if (!await prepareNavigation()) return;
  if (requestedKind !== kind.value) {
    kind.value = requestedKind;
    if (requestedKind === 'contacts') selectedBookId.value = null;
    resetSequence.value += 1;
  }
  clearBulkSelection();
  operationNotice.value = '';
  detailReadToken += 1;
  detailSubject.value = 'entry';
  addressBookDetail.value = null;
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
  if (
    detailSubject.value === 'addressbook'
    && addressBookDetail.value?.may_write === 1
    && detailState.value === 'view'
  ) {
    editorDirty.value = false;
    detailFailureState.value = null;
    detailState.value = 'edit';
    mobilePane.value = 'detail';
    return;
  }
  if (
    !selectedEntry.value
    || selectedEntry.value.kind === 'trash'
    || detailState.value !== 'view'
  ) return;
  editorDirty.value = false;
  detailFailureState.value = null;
  detailState.value = 'edit';
  mobilePane.value = 'detail';
}

async function openAddressBookCreate(): Promise<void> {
  if (!canCreateAddressBook.value || !await prepareNavigation()) return;
  kind.value = 'contacts';
  clearBulkSelection();
  operationNotice.value = '';
  detailReadToken += 1;
  addressBookDetail.value = null;
  detailSubject.value = 'addressbook';
  detailError.value = null;
  detailFailureState.value = null;
  editorDirty.value = false;
  detailState.value = 'create';
  mobilePane.value = 'detail';
}

async function openAddressBookEdit(book: AddressbookRow): Promise<void> {
  if (book.may_write !== 1 || !await prepareNavigation()) return;
  clearBulkSelection();
  operationNotice.value = '';
  addressBookDetail.value = book;
  detailSubject.value = 'addressbook';
  detailError.value = null;
  detailFailureState.value = null;
  editorDirty.value = false;
  detailState.value = 'edit';
  mobilePane.value = 'detail';
  if (layout.value === 'phone') await focusDetailPane();
}

async function restoreListFocus(): Promise<void> {
  await nextTick();
  await directoryListEl.value?.focusSelected();
}

async function focusDetailPane(): Promise<void> {
  await nextTick();
  if (detailSubject.value === 'addressbook') {
    await addressBookPaneEl.value?.focusDetail();
    return;
  }
  switch (kind.value) {
    case 'contacts':
      await contactPaneEl.value?.focusDetail();
      return;
    case 'identities':
      await identityPaneEl.value?.focusDetail();
      return;
    case 'trash':
      await trashPaneEl.value?.focusDetail();
      return;
    default: {
      const exhaustive: never = kind.value;
      return exhaustive;
    }
  }
}

function cancelEditor(): void {
  if (detailSubject.value === 'addressbook') {
    restoreEntryDetailFromAddressBook();
    if (layout.value === 'phone' && detailState.value === 'empty') {
      mobilePane.value = 'list';
      void restoreListFocus();
    } else {
      restoreDetailFocus();
    }
    return;
  }
  leaveEditor();
  if (layout.value === 'phone') mobilePane.value = 'list';
  void restoreListFocus();
}

function onDetailStateChange(state: DetailFailureState | null): void {
  detailFailureState.value = state;
}

async function closeDetail(): Promise<void> {
  const closingAddressBook = detailSubject.value === 'addressbook';
  if (!await prepareNavigation()) return;
  if (closingAddressBook) {
    if (detailSubject.value === 'addressbook') {
      restoreEntryDetailFromAddressBook();
    }
    if (detailState.value === 'empty') await restoreListFocus();
    else restoreDetailFocus();
    return;
  }
  if (layout.value === 'phone') {
    mobilePane.value = 'list';
    await restoreListFocus();
    return;
  }
  clearSelection();
  await restoreListFocus();
}

async function onContactSaved(payload: ContactSavedPayload): Promise<void> {
  editorDirty.value = false;
  detailFailureState.value = null;
  let key = payload.key;
  let entry = key == null
    ? null
    : availableEntries.value.find((candidate) => candidate.key === key) ?? null;
  if (!payload.detail && (!entry || entry.kind !== 'contact')) {
    await contactsStore.refreshContacts();
    entry = key == null
      ? null
      : availableEntries.value.find((candidate) => candidate.key === key) ?? null;
    if ((!entry || entry.kind !== 'contact') && payload.uid) {
      const uid = normalizeContactUid(payload.uid);
      if (uid) {
        entry = availableEntries.value.find((candidate) =>
          candidate.kind === 'contact'
          && normalizeContactUid(candidate.contact.uid) === uid) ?? null;
      }
      if (entry?.kind === 'contact') key = entry.key;
    }
  }
  if (!key) {
    clearSelection();
    detailState.value = 'error';
    detailError.value = 'The contact was saved, but its cached detail is unavailable.';
    return;
  }
  selectedKey.value = key;
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

function onAddressBookSaved(book: AddressbookRow): void {
  const created = detailState.value === 'create';
  editorDirty.value = false;
  detailFailureState.value = null;
  addressBookDetail.value = book;
  detailSubject.value = 'addressbook';
  detailState.value = 'view';
  detailError.value = null;
  kind.value = 'contacts';
  mobilePane.value = 'detail';
  if (created) {
    selectedBookId.value = book.id;
    clearBulkSelection();
    resetSequence.value += 1;
  }
  restoreDetailFocus();
}

async function duplicateSelectedContact(): Promise<void> {
  const source = contactDetail.value;
  if (!source || detailState.value !== 'view' || contactsStore.saving) return;
  const sourceKey = selectedKey.value;
  const sourceName =
    source.full_name?.trim() || source.display_name?.trim() || 'Unnamed contact';
  const contact = {
    ...contactMutationFieldsFromDetail(source),
    fullName: nextCopyName(
      sourceName,
      contacts.value.map((candidate) => candidate.display_name ?? ''),
    ),
    photo: copyableContactPhoto(source.photo),
  };
  const result = await contactsStore.createContactResult({
    contact,
    addressbookIds: [...source.addressbook_ids],
    allowDuplicate: true,
  });
  if (!result.ok) {
    operationNotice.value = contactsStore.error || 'The contact could not be duplicated.';
    return;
  }
  if (kind.value !== 'contacts' || selectedKey.value !== sourceKey) {
    operationNotice.value = 'Contact duplicated.';
    return;
  }
  operationNotice.value = '';
  await onContactSaved({
    detail: result.detail,
    key: result.contactId == null ? null : `contact:${result.contactId}`,
    uid: result.uid,
  });
}

async function duplicateSelectedIdentity(): Promise<void> {
  const source = selectedIdentity.value;
  if (!source || detailState.value !== 'view' || contactsStore.saving) return;
  const sourceKey = selectedKey.value;
  const sourceName = source.name.trim() || source.email;
  const result = await contactsStore.createIdentity({
    name: nextCopyName(
      sourceName,
      identities.value.map((identity) => identity.name),
    ),
    email: source.email,
    replyTo: source.reply_to?.map((address) => ({ ...address })) ?? null,
    bcc: source.bcc?.map((address) => ({ ...address })) ?? null,
    textSignature: source.text_signature,
    htmlSignature: source.html_signature,
  });
  if (!result.ok) {
    operationNotice.value = contactsStore.error || 'The identity could not be duplicated.';
    return;
  }
  if (kind.value !== 'identities' || selectedKey.value !== sourceKey) {
    operationNotice.value = 'Identity duplicated.';
    return;
  }
  operationNotice.value = '';
  onIdentitySaved(`identity:${result.identity.id}`);
}

async function setSelectedIdentityPrimary(): Promise<void> {
  const identity = selectedIdentity.value;
  if (!identity || selectedIdentityIsPrimary.value || settingPrimaryIdentityId.value != null) {
    return;
  }
  settingPrimaryIdentityId.value = identity.id;
  try {
    await settingsStore.update({ primaryIdentityRemoteId: identity.remote_id });
    operationNotice.value = `${identity.name.trim() || identity.email} is now the Primary identity.`;
  } catch (error) {
    operationNotice.value = error instanceof Error
      ? error.message
      : 'The Primary identity could not be updated.';
  } finally {
    settingPrimaryIdentityId.value = null;
  }
}

async function retryDetail(): Promise<void> {
  const entry = selectedEntry.value;
  if (entry?.kind === 'contact') await loadContact(entry);
  if (entry?.kind === 'trash') await loadTrash(entry);
}

async function requestLeave(): Promise<boolean> {
  return prepareNavigation();
}

async function requestFilterChange(next: string): Promise<boolean> {
  const entry = selectedEntry.value;
  if (!entry || entryMatchesFilter(entry, next)) return true;
  return prepareNavigation();
}

watch(
  () => props.filterQuery,
  (next) => {
    clearBulkSelection();
    operationNotice.value = '';
    resetSequence.value += 1;
    const entry = selectedEntry.value;
    if (!entry || entryMatchesFilter(entry, next)) return;
    clearSelection();
  },
);

watch(
  () => filteredEntries.value
    .flatMap((entry) => entry.kind === 'identity' ? [] : [entry.id])
    .join(','),
  () => {
    if (selectedContactIds.value.size === 0) return;
    const availableIds = new Set(filteredEntries.value.flatMap(
      (entry) => entry.kind === 'identity' ? [] : [entry.id],
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
    addressbooks.value.map((book) => book.id).join(','),
    contactsStore.saving,
  ] as const,
  ([, saving]) => {
    if (saving) return;
    const editedBook = detailSubject.value === 'addressbook'
      ? addressBookDetail.value
      : null;
    if (
      editedBook
      && !addressbooks.value.some((book) => book.id === editedBook.id)
      && !deletingAddressBookIds.value.includes(editedBook.id)
    ) {
      void resolveExternalChange(
        'external-addressbook-change',
        () => finishMissingAddressBook(editedBook.id),
        () => !addressbooks.value.some((book) => book.id === editedBook.id),
      );
      return;
    }
    if (
      selectedBookId.value != null
      && !addressbooks.value.some((book) => book.id === selectedBookId.value)
      && !deletingAddressBookIds.value.includes(selectedBookId.value)
    ) {
      selectedBookId.value = null;
      resetSequence.value += 1;
      operationNotice.value = 'The selected address book no longer exists.';
      if (
        detailSubject.value === 'entry'
        && selectedKey.value
        && !availableEntries.value.some((entry) => entry.key === selectedKey.value)
      ) {
        clearSelection();
      }
    }
    if (
      addressBookDeleteTarget.value
      && !addressbooks.value.some(
        (book) => book.id === addressBookDeleteTarget.value?.id,
      )
      && !addressBookDeleteBusy.value
    ) {
      closeAddressBookDeleteDialog();
    }
  },
  { flush: 'sync' },
);

watch(
  () => [
    availableEntries.value.map((entry) => entry.key).join('\u0000'),
    contactsStore.saving,
  ] as const,
  ([, saving]) => {
    if (saving) return;
    if (detailSubject.value === 'addressbook') return;
    if (!selectedKey.value || selectedKey.value === deletingKey.value) return;
    if (availableEntries.value.some((entry) => entry.key === selectedKey.value)) return;
    void resolveExternalChange(
      'external-change',
      clearSelection,
      () => !availableEntries.value.some(
        (entry) => entry.key === selectedKey.value,
      ),
    );
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
      :can-create-address-book="canCreateAddressBook"
      :contact-count="contacts.length"
      :identity-count="identities.length"
      :trash-count="trash.length"
      :kind="kind"
      :selected-book-id="selectedBookId"
      @add-contact="openCreate('contacts')"
      @create-address-book="openAddressBookCreate"
      @move-contacts="moveContactBatch"
      @select-book="selectBook"
      @select-identities="selectIdentities"
      @select-trash="selectTrash"
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
          :addressbooks="addressbooks"
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
          :primary-identity-id="primaryIdentityId"
          :reset-token="listResetToken"
          :selected-contact-ids="selectedContactIds"
          :selected-key="selectedKey"
          :source-addressbook-id="selectedBookId"
          :title="listTitle"
          @add="openCreate"
          @delete-address-book="requestAddressBookDelete"
          @delete-selection="deleteSelection"
          @delete-forever-selection="deleteTrashSelectionForever"
          @edit-address-book="openAddressBookEdit"
          @move-selection="moveSelection"
          @restore-selection="restoreTrashSelection"
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
          <AddressBookDetailPane
            v-if="
              detailSubject === 'addressbook'
                && (
                  detailState === 'create'
                    || (
                      addressBookDetail
                        && (
                          detailState === 'view'
                            || detailState === 'edit'
                            || detailState === 'deleting'
                        )
                    )
                )
            "
            ref="addressBookPaneEl"
            :addressbook="addressBookDetail"
            :deleting="selectedIsDeleting || detailState === 'deleting'"
            :delete-disabled-reason="addressBookDetailDeleteReason"
            :mode="
              detailState === 'create'
                ? 'create'
                : (detailState === 'edit' ? 'edit' : 'view')
            "
            @back="closeDetail"
            @cancel="cancelEditor"
            @dirty-change="editorDirty = $event"
            @edit="openEdit"
            @request-delete="
              addressBookDetail && requestAddressBookDelete(addressBookDetail)
            "
            @saved="onAddressBookSaved"
            @state-change="onDetailStateChange"
          />

          <ContactDetailPane
            v-if="
              detailSubject === 'entry'
                && kind === 'contacts'
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
            @duplicate="duplicateSelectedContact"
            @edit="openEdit"
            @request-delete="requestDelete"
            @saved="onContactSaved"
            @state-change="onDetailStateChange"
          />

          <IdentityDetailPane
            v-else-if="
              detailSubject === 'entry'
                && kind === 'identities'
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
            :primary="selectedIdentityIsPrimary"
            :setting-primary="settingPrimaryIdentityId === selectedIdentity?.id"
            :mode="
              detailState === 'create'
                ? 'create'
                : (detailState === 'edit' ? 'edit' : 'view')
            "
            @back="closeDetail"
            @cancel="cancelEditor"
            @dirty-change="editorDirty = $event"
            @duplicate="duplicateSelectedIdentity"
            @edit="openEdit"
            @request-delete="requestDelete"
            @saved="onIdentitySaved"
            @set-primary="setSelectedIdentityPrimary"
            @state-change="onDetailStateChange"
          />

          <ContactTrashDetailPane
            v-else-if="
              detailSubject === 'entry'
                && kind === 'trash'
                && selectedEntry?.kind === 'trash'
                && (
                  detailState === 'loading'
                    || detailState === 'view'
                    || detailState === 'deleting'
                    || detailState === 'error'
                )
            "
            ref="trashPaneEl"
            :addressbook-names="trashAddressbookNames"
            :busy="selectedIsDeleting || detailState === 'deleting'"
            :detail="trashDetail"
            :error="detailState === 'error'
              ? (detailError || 'This trashed contact could not be loaded.')
              : null"
            :loading="detailState === 'loading'"
            @back="closeDetail"
            @delete-forever="deleteSelectedTrashForever"
            @restore="restoreSelectedTrash"
            @retry="retryDetail"
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
              v-if="
                selectedEntry?.kind === 'contact'
                  || selectedEntry?.kind === 'trash'
              "
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

    <AddressBookDeleteDialog
      v-if="addressBookDeleteTarget && addressBookDeleteInventory"
      :addressbook="addressBookDeleteTarget"
      :busy="addressBookDeleteBusy"
      :inventory="addressBookDeleteInventory"
      :stale="addressBookDeleteStale"
      @cancel="closeAddressBookDeleteDialog"
      @confirm="confirmAddressBookDelete"
    />

    <RestoreContactDestinationDialog
      v-if="restoreDestinationIds.length > 0"
      :addressbooks="addressbooks.filter((book) => book.may_write === 1)"
      :busy="contactsStore.saving"
      :count="restoreDestinationIds.length"
      @cancel="restoreDestinationIds = []"
      @choose="chooseRestoreDestination"
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
