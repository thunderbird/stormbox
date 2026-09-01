/**
 * The contacts workspace's actions: confirmations, dirty-editor navigation,
 * batch delete/move/restore, trash, address-book deletion, and the
 * external-change resolution they share. ContactsView keeps the template,
 * layout, selection, and column-resize concerns and hands the composable
 * the state those actions read and write.
 */

import { ref, type ComputedRef, type Ref } from 'vue';

import type { DetailFailureState } from './useDetailPaneEditor';
import {
  ADDRESSBOOK_ERROR,
  addressBookErrorMessage,
} from '../constants/addressbook-errors';
import type {
  ContactBatchActionResult,
  useContactsStore,
} from '../stores/contacts-store';
import type {
  AddressBookInventory,
  AddressbookRow,
  ContactListRow,
  ContactTrashListRow,
} from '../types';
import { addressBookDeleteDisabledReason } from '../utils/address-book-policy';
import {
  addressBookDisplayName,
  identityMayDelete,
  type ContactsConfirmationChoice,
  type ContactsConfirmationKind,
  type DirectoryEntry,
  type DirectoryKind,
} from '../components/contacts/directory-types';

export type DetailState =
  | 'create'
  | 'deleting'
  | 'edit'
  | 'empty'
  | 'error'
  | 'loading'
  | 'view';
export type DetailSubject = 'addressbook' | 'entry';
type ExternalChangeConfirmationKind = Extract<
  ContactsConfirmationKind,
  'external-addressbook-change' | 'external-change'
>;
type ContactDirectoryEntry = Extract<DirectoryEntry, { kind: 'contact' }>;

export interface PendingConfirmation {
  count: number;
  kind: ContactsConfirmationKind;
  permanentCount: number;
  resolve: (choice: ContactsConfirmationChoice) => void;
  scopeLabel: string;
  subject: string;
}

export interface ContactsWorkspaceActionsContext {
  contactsStore: ReturnType<typeof useContactsStore>;
  addressbooks: Ref<AddressbookRow[]>;
  contacts: Ref<ContactListRow[]>;
  trash: Ref<ContactTrashListRow[]>;
  kind: Ref<DirectoryKind>;
  selectedBookId: Ref<number | null>;
  selectedKey: Ref<string | null>;
  selectedContactIds: Ref<Set<number>>;
  detailState: Ref<DetailState>;
  detailSubject: Ref<DetailSubject>;
  detailFailureState: Ref<DetailFailureState | null>;
  editorDirty: Ref<boolean>;
  addressBookDetail: Ref<AddressbookRow | null>;
  operationNotice: Ref<string>;
  resetSequence: Ref<number>;
  selectedBook: ComputedRef<AddressbookRow | null>;
  selectedEntry: ComputedRef<DirectoryEntry | null>;
  availableEntries: ComputedRef<DirectoryEntry[]>;
  filteredEntries: ComputedRef<DirectoryEntry[]>;
  deleteDisabledReason: ComputedRef<string>;
  contactsCanBeDeleted(rows: ContactListRow[]): boolean;
  clearSelection(): void;
  loadContact(entry: ContactDirectoryEntry): Promise<void>;
  selectEntryWithoutGuard(entry: DirectoryEntry): Promise<void>;
  restoreEntryDetailFromAddressBook(): void;
  restoreListFocus(): Promise<void>;
  focusDetailPane(): Promise<void>;
  saveActiveEditor(): Promise<boolean>;
}

const CONTACT_BATCH_OVERLAY_THRESHOLD = 500;

export function useContactsWorkspaceActions(context: ContactsWorkspaceActionsContext) {
  const {
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
  } = context;

  const confirmation = ref<PendingConfirmation | null>(null);
  const confirmationBusy = ref(false);
  const deletingKey = ref<string | null>(null);
  const restoreDestinationIds = ref<number[]>([]);
  const addressBookDeleteTarget = ref<AddressbookRow | null>(null);
  const addressBookDeleteInventory = ref<AddressBookInventory | null>(null);
  const addressBookDeleteBusy = ref(false);
  const addressBookDeleteStale = ref(false);
  const contactBatchOverlay = ref({
    active: false,
    label: '',
    total: 0,
  });
  let focusAfterConfirmation = false;
  let externalDecisionActive = false;

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

  function restoreDetailFocus(): void {
    if (confirmationBusy.value) {
      focusAfterConfirmation = true;
      return;
    }
    void focusDetailPane();
  }

  function leaveEditor(): void {
    if (detailState.value !== 'create' && detailState.value !== 'edit') return;
    editorDirty.value = false;
    detailFailureState.value = null;
    if (detailSubject.value === 'addressbook') {
      if (addressBookDetail.value) {
        detailState.value = 'view';
      } else {
        restoreEntryDetailFromAddressBook();
      }
      return;
    }
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
          return await saveActiveEditor();
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
    detailEntry?: ContactDirectoryEntry,
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
    const permanentCount = permanentDeletionCount(contactIds);
    if (scoped && permanentCount < count) {
      const choice = await askConfirmation('delete-contacts-scoped', '', {
        count,
        permanentCount,
        scopeLabel: selectedBook.value
          ? addressBookDisplayName(selectedBook.value)
          : '',
      });
      if (choice !== 'delete') return;
    }

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

  function retainTrashSelection(
    requestedIds: number[],
    retainedIds: number[],
  ): void {
    const requested = new Set(requestedIds);
    const available = new Set(trash.value.map((entry) => entry.id));
    selectedContactIds.value = new Set([
      ...[...selectedContactIds.value].filter(
        (id) => !requested.has(id) && available.has(id),
      ),
      ...retainedIds.filter((id) => available.has(id)),
    ]);
  }

  async function restoreTrashBatch(
    trashIds: number[],
    destinationAddressbookId: number | null = null,
  ): Promise<void> {
    const requested = [...new Set(trashIds)];
    if (requested.length === 0) return;
    const result = await withContactBatchOverlay(
      'Restoring contacts',
      requested.length,
      () => contactsStore.restoreContactTrash(requested, destinationAddressbookId),
    );
    const retained = [
      ...result.failures.map((failure) => failure.trashId),
      ...result.destinationRequiredTrashIds,
    ];
    retainTrashSelection(requested, retained);
    if (result.destinationRequiredTrashIds.length > 0) {
      restoreDestinationIds.value = result.destinationRequiredTrashIds;
      operationNotice.value = 'Choose a writable address book to finish restoring.';
    } else if (result.failures.length > 0) {
      operationNotice.value = `${result.succeededTrashIds.length} restored; ${result.failures.length} failed.`;
    } else {
      operationNotice.value = `${result.succeededTrashIds.length} contact${
        result.succeededTrashIds.length === 1 ? '' : 's'
      } restored.`;
    }
    if (
      selectedEntry.value?.kind === 'trash'
      && result.succeededTrashIds.includes(selectedEntry.value.id)
    ) {
      clearSelection();
    }
  }

  async function deleteTrashForeverBatch(trashIds: number[]): Promise<void> {
    const requested = [...new Set(trashIds)];
    if (requested.length === 0) return;
    const choice = await askConfirmation('delete-contact-trash', '', {
      count: requested.length,
    });
    if (choice !== 'delete') return;
    const result = await withContactBatchOverlay(
      'Deleting contacts forever',
      requested.length,
      () => contactsStore.deleteContactTrashForever(requested),
    );
    retainTrashSelection(
      requested,
      result.failures.map((failure) => failure.trashId),
    );
    operationNotice.value = result.failures.length === 0
      ? `${result.succeededTrashIds.length} contact${
        result.succeededTrashIds.length === 1 ? '' : 's'
      } deleted forever.`
      : `${result.succeededTrashIds.length} deleted; ${result.failures.length} failed.`;
    if (
      selectedEntry.value?.kind === 'trash'
      && result.succeededTrashIds.includes(selectedEntry.value.id)
    ) {
      clearSelection();
    }
  }

  function restoreTrashSelection(): void {
    void restoreTrashBatch([...selectedContactIds.value]);
  }

  function deleteTrashSelectionForever(): void {
    void deleteTrashForeverBatch([...selectedContactIds.value]);
  }

  function restoreSelectedTrash(): void {
    const entry = selectedEntry.value;
    if (entry?.kind === 'trash') void restoreTrashBatch([entry.id]);
  }

  function deleteSelectedTrashForever(): void {
    const entry = selectedEntry.value;
    if (entry?.kind === 'trash') void deleteTrashForeverBatch([entry.id]);
  }

  function chooseRestoreDestination(addressbookId: number): void {
    const ids = restoreDestinationIds.value;
    restoreDestinationIds.value = [];
    void restoreTrashBatch(ids, addressbookId);
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

  function closeAddressBookDeleteDialog(): void {
    if (addressBookDeleteBusy.value) return;
    addressBookDeleteTarget.value = null;
    addressBookDeleteInventory.value = null;
    addressBookDeleteStale.value = false;
  }

  async function requestAddressBookDelete(book: AddressbookRow): Promise<void> {
    const reason = addressBookDeleteDisabledReason(book, addressbooks.value);
    if (reason) {
      operationNotice.value = addressBookErrorMessage(reason);
      return;
    }
    addressBookDeleteBusy.value = true;
    operationNotice.value = '';
    const result = await contactsStore.inventoryAddressBook(book.id);
    addressBookDeleteBusy.value = false;
    if (!result.ok) {
      operationNotice.value = contactsStore.error || 'The address book could not be reviewed.';
      return;
    }
    const current = addressbooks.value.find((candidate) => candidate.id === book.id);
    if (!current) {
      operationNotice.value = 'This address book no longer exists.';
      return;
    }
    addressBookDeleteTarget.value = current;
    addressBookDeleteInventory.value = result.inventory;
    addressBookDeleteStale.value = false;
  }

  async function confirmAddressBookDelete(): Promise<void> {
    const book = addressBookDeleteTarget.value;
    const inventory = addressBookDeleteInventory.value;
    if (!book || !inventory || addressBookDeleteBusy.value) return;
    addressBookDeleteBusy.value = true;
    const result = await contactsStore.deleteAddressBook({
      addressbookId: book.id,
      confirmationInventory: inventory,
    });
    if (
      result.ok === false
      && result.error === ADDRESSBOOK_ERROR.CONFIRMATION_STALE
    ) {
      const refreshed = await contactsStore.inventoryAddressBook(book.id);
      addressBookDeleteBusy.value = false;
      if (refreshed.ok) {
        addressBookDeleteInventory.value = refreshed.inventory;
        addressBookDeleteStale.value = true;
        return;
      }
      operationNotice.value = contactsStore.error || 'The address book could not be reviewed again.';
      closeAddressBookDeleteDialog();
      return;
    }
    addressBookDeleteBusy.value = false;
    if (!result.ok) {
      operationNotice.value = contactsStore.error || 'The address book could not be deleted.';
      closeAddressBookDeleteDialog();
      return;
    }

    addressBookDeleteTarget.value = null;
    addressBookDeleteInventory.value = null;
    addressBookDeleteStale.value = false;
    operationNotice.value = `${addressBookDisplayName(book)} deleted.`;
    kind.value = 'contacts';
    selectedBookId.value = null;
    addressBookDetail.value = null;
    detailSubject.value = 'entry';
    resetSequence.value += 1;
    restoreEntryDetailFromAddressBook();
    if (detailState.value === 'empty') await restoreListFocus();
    else restoreDetailFocus();
  }

  async function requestDelete(): Promise<void> {
    const entry = selectedEntry.value;
    if (!entry || detailState.value !== 'view') return;
    if (entry.kind === 'contact') {
      await deleteContactBatch([entry.id], entry);
      return;
    }
    if (entry.kind === 'trash') {
      await deleteTrashForeverBatch([entry.id]);
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

  async function resolveExternalChange(
    confirmationKind: ExternalChangeConfirmationKind,
    resolveMissing: () => void,
    remainsMissing: () => boolean,
  ): Promise<void> {
    if (externalDecisionActive) return;
    if (
      detailState.value !== 'create'
      && detailState.value !== 'edit'
    ) {
      resolveMissing();
      return;
    }
    if (!editorDirty.value) {
      resolveMissing();
      return;
    }

    externalDecisionActive = true;
    try {
      const choice = await askConfirmation(confirmationKind);
      switch (choice) {
        case 'cancel':
          return;
        case 'discard':
          resolveMissing();
          return;
        case 'save': {
          let saved = false;
          try {
            saved = await saveActiveEditor();
          } finally {
            finishBusyConfirmation();
          }
          if (saved && remainsMissing()) resolveMissing();
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

  function finishMissingAddressBook(addressbookId: number): void {
    if (selectedBookId.value === addressbookId) {
      selectedBookId.value = null;
      resetSequence.value += 1;
    }
    operationNotice.value = 'The selected address book no longer exists.';
    restoreEntryDetailFromAddressBook();
    if (detailState.value === 'empty') void restoreListFocus();
    else restoreDetailFocus();
  }

  return {
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
  };
}
