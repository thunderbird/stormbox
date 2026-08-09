import { DB_RPC } from '../../../../../db/protocol';
import { callJmap, pickResponse } from '../../invoke';
import { maxObjectsInGet, maxObjectsInSet } from '../../limits';
import {
  EMAIL_LIST_PROPERTIES,
  persistEmails,
  syncFolderWindow,
  syncFolderWindowChanges,
} from '../../messages';
import { JMAP_CAPS } from '../../transport';
import { finishMessageBatch } from '../batch';
import { extractMethodError } from '../errors';
import { chunks } from '../jmap';
import { collectMessageIds } from '../messages-shared';
import { resolveFolderContexts, resolveMessageContextsByAccount } from '../resolve';

async function runCopyToFolders({ transport, handlers, row, request, useWebSocket }) {
  const messageIds = collectMessageIds(row, request);
  const addLocalIds = (request.addFolderIds ?? []).map(Number).filter(Number.isFinite);
  if (messageIds.length === 0) {
    return { ok: false, error: { type: 'unknownMessage', terminal: true } };
  }
  if (addLocalIds.length === 0 || (request.removeFolderIds ?? []).length > 0) {
    return { ok: false, error: { type: 'invalidCopyDestination', terminal: true } };
  }
  const destinations = await resolveFolderContexts(handlers, addLocalIds);
  if (destinations.size !== new Set(addLocalIds).size) {
    return { ok: false, error: { type: 'unknownFolder', terminal: true } };
  }
  const destinationAccounts = new Set(
    [...destinations.values()].map((folder) => folder.account_id),
  );
  if (destinationAccounts.size !== 1) {
    return { ok: false, error: { type: 'mixedDestinationAccounts', terminal: true } };
  }
  const destination = [...destinations.values()][0];
  const destinationAccount = {
    id: destination.account_id,
    remote_account_id: destination.remote_account_id,
  };
  const destinationMailboxIds = Object.fromEntries(
    addLocalIds.map((id) => [destinations.get(id)!.remote_id, true]),
  );
  const bySourceAccount = await resolveMessageContextsByAccount(handlers, messageIds);
  if (bySourceAccount.size === 0) {
    return { ok: false, error: { type: 'unknownMessage', terminal: true } };
  }
  const succeededIds: number[] = [];
  const errors: Record<string, any> = {};
  const copied: Record<string, { remoteId: string; sourceId: number }> = {};
  const copiedRemoteIds: string[] = [];
  const existingCopies: Array<{ remoteId: string; sourceId: number }> = [];
  let lastResponse;

  for (const messages of bySourceAccount.values()) {
    const sourceAccount = messages[0]?.account;
    if (!sourceAccount || sourceAccount.id === destinationAccount.id) {
      for (const message of messages) {
        errors[String(message.localId)] = { type: 'sameAccountCopy' };
      }
      continue;
    }
    for (const chunk of chunks(messages, maxObjectsInSet(transport))) {
      const creationToMessage = new Map<string, any>();
      const create: Record<string, any> = {};
      for (const message of chunk) {
        // RFC 8620 permits any unique creation id. Using the source
        // Email id also interoperates with Stalwart 0.15, whose copy
        // implementation incorrectly resolves the source from the
        // creation-map key rather than the object's `id` property.
        const creationId = message.remoteId;
        creationToMessage.set(creationId, message);
        // Intentionally omit keywords and receivedAt. RFC 8621 Email/copy
        // inherits omitted properties from the authoritative source Email.
        create[creationId] = {
          id: message.remoteId,
          mailboxIds: destinationMailboxIds,
        };
      }
      let raw;
      try {
        raw = await callJmap(transport, {
          using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
          methodCalls: [['Email/copy', {
            fromAccountId: sourceAccount.remote_account_id,
            accountId: destinationAccount.remote_account_id,
            create,
            onSuccessDestroyOriginal: false,
          }, 'c1']],
          useWebSocket,
        });
      } catch (error) {
        const failure = {
          type: 'transport',
          message: error?.message ?? String(error),
        };
        for (const message of chunk) errors[String(message.localId)] = failure;
        continue;
      }
      lastResponse = raw;
      let response = pickResponse(raw, 'Email/copy');
      if (!response) {
        const failure = extractMethodError(raw, { count: chunk.length });
        for (const message of chunk) errors[String(message.localId)] = failure;
        continue;
      }
      // Stalwart 0.15 incorrectly resolves the source Email from the
      // creation-map key and rejects the RFC-required `id` property.
      // Retry its legacy shape only after an explicit all-object
      // invalidProperties(id) response, which proves nothing copied.
      if (requiresLegacyEmailCopyShape(response, [...creationToMessage.keys()])) {
        const legacyCreate = Object.fromEntries(
          [...creationToMessage.keys()].map((creationId) => [
            creationId,
            { mailboxIds: destinationMailboxIds },
          ]),
        );
        raw = await callJmap(transport, {
          using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
          methodCalls: [['Email/copy', {
            fromAccountId: sourceAccount.remote_account_id,
            accountId: destinationAccount.remote_account_id,
            create: legacyCreate,
            onSuccessDestroyOriginal: false,
          }, 'c1-legacy']],
          useWebSocket,
        });
        lastResponse = raw;
        response = pickResponse(raw, 'Email/copy');
        if (!response) {
          const failure = extractMethodError(raw, { count: chunk.length });
          for (const message of chunk) errors[String(message.localId)] = failure;
          continue;
        }
      }

      for (const [creationId, message] of creationToMessage) {
        const createdId = response.created?.[creationId]?.id;
        const failure = response.notCreated?.[creationId];
        const existingId = failure?.type === 'alreadyExists'
          ? failure.existingId
          : null;
        const destinationRemoteId = createdId ?? existingId;
        if (!destinationRemoteId) {
          errors[String(message.localId)] = {
            type: 'notCreated',
            detail: failure ?? { response },
          };
          continue;
        }
        if (existingId) {
          existingCopies.push({
            remoteId: existingId,
            sourceId: message.localId,
          });
          continue;
        }
        copiedRemoteIds.push(destinationRemoteId);
        succeededIds.push(message.localId);
        copied[String(message.localId)] = {
          remoteId: destinationRemoteId,
          sourceId: message.localId,
        };
      }
    }
  }

  if (existingCopies.length > 0) {
    const reconciled = await ensureExistingCopiesInDestination({
      transport,
      account: destinationAccount,
      copies: existingCopies,
      destinationMailboxIds: Object.keys(destinationMailboxIds),
      useWebSocket,
    });
    for (const copy of reconciled.confirmed) {
      copiedRemoteIds.push(copy.remoteId);
      succeededIds.push(copy.sourceId);
      copied[String(copy.sourceId)] = {
        remoteId: copy.remoteId,
        sourceId: copy.sourceId,
      };
    }
    Object.assign(errors, reconciled.errors);
  }

  if (copiedRemoteIds.length > 0) {
    const reconciliation = await fetchAndPersistCopiedEmails({
      transport,
      account: destinationAccount,
      handlers,
      remoteIds: copiedRemoteIds,
      useWebSocket,
    });
    const sourceIdsByRemoteId = new Map<string, number[]>();
    for (const entry of Object.values(copied)) {
      const sourceIds = sourceIdsByRemoteId.get(entry.remoteId) ?? [];
      sourceIds.push(entry.sourceId);
      sourceIdsByRemoteId.set(entry.remoteId, sourceIds);
    }
    for (const [remoteId, failure] of Object.entries(reconciliation.errors)) {
      for (const sourceId of sourceIdsByRemoteId.get(remoteId) ?? []) {
        errors[String(sourceId)] = failure;
      }
    }
    try {
      await reconcileCopiedDestinationViews({
        transport,
        account: destinationAccount,
        handlers,
        destinationFolderIds: addLocalIds,
        useWebSocket,
      });
    } catch (error) {
      for (const sourceId of succeededIds) {
        if (errors[String(sourceId)]) continue;
        errors[String(sourceId)] = {
          type: 'copyViewReconcileFailed',
          message: error?.message ?? String(error),
        };
      }
    }
    try {
      await refreshCopiedDestinationCounters({
        transport,
        account: destinationAccount,
        handlers,
        destinationMailboxIds: Object.keys(destinationMailboxIds),
        useWebSocket,
      });
    } catch (error) {
      for (const sourceId of succeededIds) {
        if (errors[String(sourceId)]) continue;
        errors[String(sourceId)] = {
          type: 'copyCounterReconcileFailed',
          message: error?.message ?? String(error),
        };
      }
    }
  }

  const result = finishMessageBatch(
    succeededIds,
    errors,
    lastResponse,
    { preventRetryAfterSuccess: true },
  );
  result.result.copied = copied;
  return result;
}

function requiresLegacyEmailCopyShape(
  response: any,
  creationIds: string[],
): boolean {
  if (creationIds.length === 0 || Object.keys(response.created ?? {}).length > 0) {
    return false;
  }
  return creationIds.every((creationId) => {
    const failure = response.notCreated?.[creationId];
    return failure?.type === 'invalidProperties'
      && Array.isArray(failure.properties)
      && failure.properties.includes('id');
  });
}

async function ensureExistingCopiesInDestination({
  transport,
  account,
  copies,
  destinationMailboxIds,
  useWebSocket,
}: {
  transport: any;
  account: { id: number; remote_account_id: string };
  copies: Array<{ remoteId: string; sourceId: number }>;
  destinationMailboxIds: string[];
  useWebSocket: boolean;
}) {
  const confirmed: Array<{ remoteId: string; sourceId: number }> = [];
  const errors: Record<string, any> = {};
  const copiesByRemoteId = new Map<
    string,
    Array<{ remoteId: string; sourceId: number }>
  >();
  for (const copy of copies) {
    const grouped = copiesByRemoteId.get(copy.remoteId) ?? [];
    grouped.push(copy);
    copiesByRemoteId.set(copy.remoteId, grouped);
  }
  const confirmCopies = (remoteId: string) => {
    confirmed.push(...(copiesByRemoteId.get(remoteId) ?? []));
  };
  const failCopies = (remoteId: string, failure: any) => {
    for (const copy of copiesByRemoteId.get(remoteId) ?? []) {
      errors[String(copy.sourceId)] = failure;
    }
  };

  for (const ids of chunks([...copiesByRemoteId.keys()], maxObjectsInGet(transport))) {
    let raw;
    try {
      raw = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
        methodCalls: [['Email/get', {
          accountId: account.remote_account_id,
          ids,
          properties: ['id', 'mailboxIds'],
        }, 'g-existing-copy']],
        useWebSocket,
      });
    } catch (error) {
      const failure = {
        type: 'alreadyExistsReconcileFailed',
        message: error?.message ?? String(error),
      };
      for (const id of ids) failCopies(id, failure);
      continue;
    }
    const response = pickResponse(raw, 'Email/get');
    if (!response) {
      const failure = extractMethodError(raw, { count: ids.length });
      for (const id of ids) failCopies(id, failure);
      continue;
    }

    const returned = new Map<
      string,
      { id: string; mailboxIds?: Record<string, boolean> }
    >(
      (response.list ?? []).map((email) => [email.id, email]),
    );
    const update: Record<string, { mailboxIds: Record<string, true> }> = {};
    for (const id of ids) {
      const email = returned.get(id);
      if (!email) {
        failCopies(id, {
          type: 'alreadyExistsReconcileFailed',
          detail: { type: 'notFound' },
        });
        continue;
      }
      if (destinationMailboxIds.every((mailboxId) =>
        email.mailboxIds?.[mailboxId] === true)) {
        confirmCopies(id);
        continue;
      }
      const mailboxIds: Record<string, true> = {};
      for (const [mailboxId, included] of Object.entries(email.mailboxIds ?? {})) {
        if (included === true) mailboxIds[mailboxId] = true;
      }
      for (const mailboxId of destinationMailboxIds) mailboxIds[mailboxId] = true;
      update[id] = { mailboxIds };
    }

    for (const updateIds of chunks(Object.keys(update), maxObjectsInSet(transport))) {
      const chunkUpdate = Object.fromEntries(
        updateIds.map((id) => [id, update[id]]),
      );
      let setRaw;
      try {
        setRaw = await callJmap(transport, {
          using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
          methodCalls: [['Email/set', {
            accountId: account.remote_account_id,
            update: chunkUpdate,
          }, 's-existing-copy']],
          useWebSocket,
        });
      } catch (error) {
        const failure = {
          type: 'alreadyExistsReconcileFailed',
          message: error?.message ?? String(error),
        };
        for (const id of updateIds) failCopies(id, failure);
        continue;
      }
      const setResponse = pickResponse(setRaw, 'Email/set');
      if (!setResponse) {
        const failure = extractMethodError(setRaw, { count: updateIds.length });
        for (const id of updateIds) failCopies(id, failure);
        continue;
      }
      for (const id of updateIds) {
        if (Object.prototype.hasOwnProperty.call(setResponse.updated ?? {}, id)) {
          confirmCopies(id);
        } else {
          failCopies(id, {
            type: 'notUpdated',
            detail: setResponse.notUpdated?.[id] ?? null,
          });
        }
      }
    }
  }

  return { confirmed, errors };
}

async function fetchAndPersistCopiedEmails({
  transport,
  account,
  handlers,
  remoteIds,
  useWebSocket,
}: {
  transport: any;
  account: { id: number; remote_account_id: string };
  handlers: Record<string, (params: any) => Promise<any>>;
  remoteIds: string[];
  useWebSocket: boolean;
}) {
  const errors: Record<string, any> = {};
  for (const ids of chunks([...new Set(remoteIds)], maxObjectsInGet(transport))) {
    try {
      const raw = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
        methodCalls: [['Email/get', {
          accountId: account.remote_account_id,
          ids,
          properties: EMAIL_LIST_PROPERTIES,
        }, 'g-copy']],
        useWebSocket,
      });
      const response = pickResponse(raw, 'Email/get');
      const emails = response?.list ?? [];
      if (emails.length > 0) {
        await persistEmails({ account, emails, handlers });
      }
      const returned = new Set(emails.map((email) => email.id));
      for (const id of ids) {
        if (returned.has(id)) continue;
        errors[id] = {
          type: 'copyReconcileFailed',
          detail: response?.notFound?.includes(id) ? { type: 'notFound' } : null,
        };
      }
    } catch (error) {
      for (const id of ids) {
        errors[id] = {
          type: 'copyReconcileFailed',
          message: error?.message ?? String(error),
        };
      }
    }
  }
  return { errors };
}

async function reconcileCopiedDestinationViews({
  transport,
  account,
  handlers,
  destinationFolderIds,
  useWebSocket,
}) {
  if (destinationFolderIds.length === 0) return;
  const rows = await handlers[DB_RPC.QUERY]({
    sql: `SELECT qv.*, f.remote_id, f.account_id
            FROM query_views qv
            JOIN folders f ON f.id = qv.folder_id
           WHERE qv.account_id = ?
             AND qv.folder_id IN (${destinationFolderIds.map(() => '?').join(',')})
             AND qv.view_type = 'mailbox-window'`,
    params: [account.id, ...destinationFolderIds],
  });
  for (const view of rows) {
    const sortProp = JSON.parse(view.sort_json ?? '[]')?.[0]?.property ?? 'receivedAt';
    const folder = {
      id: Number(view.folder_id),
      account_id: Number(view.account_id),
      remote_id: view.remote_id,
    };
    const delta = view.query_state
      ? await syncFolderWindowChanges({
        transport,
        account,
        folder,
        handlers,
        sinceQueryState: view.query_state,
        sortProp,
        collapseThreads: !!view.collapse_threads,
        useWebSocket,
      })
      : { needsFullSync: true };
    if (delta.needsFullSync) {
      await syncFolderWindow({
        transport,
        account,
        folder,
        handlers,
        sortProp,
        position: 0,
        limit: 100,
        collapseThreads: !!view.collapse_threads,
        useWebSocket,
      });
    }
  }
}

async function refreshCopiedDestinationCounters({
  transport,
  account,
  handlers,
  destinationMailboxIds,
  useWebSocket,
}) {
  for (const ids of chunks(
    [...new Set(destinationMailboxIds)],
    maxObjectsInGet(transport),
  )) {
    const raw = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
      methodCalls: [['Mailbox/get', {
        accountId: account.remote_account_id,
        ids,
        properties: [
          'id',
          'totalEmails',
          'unreadEmails',
          'totalThreads',
          'unreadThreads',
        ],
      }, 'g-copy-mailboxes']],
      useWebSocket,
    });
    const response = pickResponse(raw, 'Mailbox/get');
    if (!response) {
      throw new Error('Mailbox/get failed while refreshing copy destination');
    }
    const returned = new Set((response.list ?? []).map((folder) => folder.id));
    if (ids.some((id) => !returned.has(id))) {
      throw new Error('Mailbox/get omitted a copied destination folder');
    }
    await handlers[DB_RPC.FOLDER_UPDATE_COUNTS_MANY]({
      accountId: account.id,
      folders: (response.list ?? []).map((folder) => ({
        remoteId: folder.id,
        totalEmails: folder.totalEmails,
        unreadEmails: folder.unreadEmails,
        totalThreads: folder.totalThreads,
        unreadThreads: folder.unreadThreads,
      })),
    });
  }
}

export { runCopyToFolders };
