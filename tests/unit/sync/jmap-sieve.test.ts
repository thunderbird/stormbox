import { describe, expect, it } from 'vitest';

import {
  compileRules,
  emptyRuleDocument,
  MANAGED_SCRIPT_MARKER,
  MANAGED_SCRIPT_NAME,
  SIEVE_CAPABILITY,
} from '../../../src/sieve/rules';
import type { MailRuleDocument } from '../../../src/sieve/rules';
import {
  getMailRules,
  runSetSieveRules,
} from '../../../src/sync/backends/jmap/sieve';
import { JMAP_CAPS } from '../../../src/sync/backends/jmap/transport';
import { MockTransport } from './_mock-transport';

const EXTENSIONS = ['copy', 'fileinto', 'imap4flags', 'mailboxid'];
const ACCOUNT = { remote_account_id: 'acct-1' };

function session() {
  return {
    capabilities: {
      [JMAP_CAPS.CORE]: {},
      [SIEVE_CAPABILITY]: { implementation: 'test' },
    },
    primaryAccounts: { [SIEVE_CAPABILITY]: 'acct-1' },
    accounts: {
      'acct-1': {
        accountCapabilities: {
          [SIEVE_CAPABILITY]: {
            sieveExtensions: EXTENSIONS,
            maxSizeScript: 64_000,
            maxNumberRedirects: 4,
          },
        },
      },
    },
  };
}

function ruleDocument(): MailRuleDocument {
  return {
    version: 2,
    rules: [{
      id: 'rule-1',
      name: 'Read receipts',
      enabled: true,
      match: 'all',
      conditions: [{
        id: 'condition-1', type: 'condition', negated: false,
        field: 'subject', operator: 'contains', value: 'Receipt',
      }],
      actions: [{ id: 'action-1', type: 'markRead' }],
      stopProcessing: true,
    }],
  };
}

function managedSource(document = ruleDocument()) {
  return compileRules(document, {
    sieveExtensions: EXTENSIONS,
    maxSizeScript: 64_000,
    maxNumberRedirects: 4,
  });
}

describe('JMAP Sieve rules backend', () => {
  it('reports unsupported accounts without issuing a JMAP method call', async () => {
    const transport = new MockTransport();
    const result = await getMailRules({ transport, account: ACCOUNT });

    expect(result.supported).toBe(false);
    expect(result.document).toEqual(emptyRuleDocument());
    expect(transport.requests).toHaveLength(0);
  });

  it('uses an incompatible active script as the authoritative source', async () => {
    const transport = new MockTransport(session());
    transport.handle('SieveScript/get', () => ({
      accountId: 'acct-1',
      state: 'sieve-state-1',
      list: [
        {
          id: 'foreign', name: 'Handwritten filters', blobId: 'blob-foreign', isActive: true,
        },
        {
          id: 'managed', name: MANAGED_SCRIPT_NAME, blobId: 'blob-managed', isActive: false,
        },
      ],
      notFound: [],
    }));
    transport.handleDownload(({ blobId }) => (
      blobId === 'blob-managed' ? managedSource() : 'vacation "Away";\r\n'
    ));

    const result = await getMailRules({ transport, account: ACCOUNT });

    expect(result.supported).toBe(true);
    expect(result.state).toBe('sieve-state-1');
    expect(result.document).toEqual(emptyRuleDocument());
    expect(result.managedScript).toBeNull();
    expect(result.editableScript).toMatchObject({ id: 'foreign', isActive: true });
    expect(result.source).toBe('vacation "Away";\r\n');
    expect(result.visualizationError)
      .toBe('Top-level “vacation” is not represented by the visual editor at line 1.');
    expect(result.capabilities.sieveExtensions).toEqual(EXTENSIONS);
  });

  it('visualizes and updates a compatible existing active script in place', async () => {
    const transport = new MockTransport(session());
    let setRequest: any = null;
    transport.handle('SieveScript/get', () => ({
      accountId: 'acct-1',
      state: 'sieve-state-1',
      list: [{
        id: 'personal', name: 'Personal filters', blobId: 'blob-personal', isActive: true,
      }],
    }));
    transport.handleDownload(() => [
      'require ["imap4flags"];',
      '# Rule: Important projects',
      'if allof (anyof (address :contains "From" "@example.com", header :contains "Subject" "Project"), not header :contains "X-Spam" "yes") {',
      '  addflag "\\\\Flagged";',
      '  stop;',
      '}',
      '',
    ].join('\r\n'));
    transport.handle('SieveScript/validate', () => ({ accountId: 'acct-1', error: null }));
    transport.handle('SieveScript/set', (params) => {
      setRequest = params;
      return {
        accountId: 'acct-1', oldState: 'sieve-state-1', newState: 'sieve-state-2',
        updated: { personal: null },
      };
    });

    const loaded = await getMailRules({ transport, account: ACCOUNT });
    expect(loaded.managedScript).toBeNull();
    expect(loaded.editableScript).toMatchObject({ id: 'personal', isActive: true });
    expect(loaded.visualizationError).toBeNull();
    expect(loaded.source).toContain('# Rule: Important projects');
    expect(loaded.document.rules[0]).toMatchObject({
      name: 'Important projects',
      match: 'all',
      conditions: [{ type: 'group', match: 'any' }, { type: 'condition', negated: true }],
    });

    const result = await runSetSieveRules({
      transport,
      account: ACCOUNT,
      request: { document: loaded.document, expectedState: 'sieve-state-1' },
    });
    expect(result.ok).toBe(true);
    expect(setRequest).toMatchObject({
      update: { personal: { blobId: 'blob-1' } },
      onSuccessActivateScript: 'personal',
    });
    expect(setRequest.create).toBeUndefined();
    expect(new TextDecoder().decode(transport.uploads[0].body))
      .not.toContain(MANAGED_SCRIPT_MARKER);
  });

  it('prefers a compatible active script over an inactive managed script', async () => {
    const transport = new MockTransport(session());
    transport.handle('SieveScript/get', () => ({
      accountId: 'acct-1',
      state: 'sieve-state-1',
      list: [
        {
          id: 'personal', name: 'Personal filters', blobId: 'blob-personal', isActive: true,
        },
        {
          id: 'managed', name: MANAGED_SCRIPT_NAME, blobId: 'blob-managed', isActive: false,
        },
      ],
    }));
    transport.handleDownload(({ blobId }) => (
      blobId === 'blob-managed'
        ? managedSource()
        : 'if header :contains "Subject" "Active" { discard; stop; }\r\n'
    ));

    const loaded = await getMailRules({ transport, account: ACCOUNT });
    expect(loaded.editableScript).toMatchObject({ id: 'personal', isActive: true });
    expect(loaded.managedScript).toBeNull();
    expect(loaded.visualizationError).toBeNull();
    expect(loaded.document.rules[0]).toMatchObject({
      conditions: [{ value: 'Active' }],
      actions: [{ type: 'discard' }],
    });
  });

  it('validates and updates an incompatible active script from raw source', async () => {
    const transport = new MockTransport(session());
    let setRequest: any = null;
    transport.handle('SieveScript/get', () => ({
      accountId: 'acct-1',
      state: 'sieve-state-1',
      list: [{
        id: 'foreign', name: 'Handwritten filters', blobId: 'blob-foreign', isActive: true,
      }],
      notFound: [],
    }));
    transport.handleDownload(() => 'vacation "Away";\r\n');
    transport.handle('SieveScript/validate', () => ({ accountId: 'acct-1', error: null }));
    transport.handle('SieveScript/set', (params) => {
      setRequest = params;
      return {
        accountId: 'acct-1',
        oldState: 'sieve-state-1',
        newState: 'sieve-state-2',
        updated: { foreign: null },
      };
    });

    const source = 'vacation "Back Monday";\r\n';
    const result = await runSetSieveRules({
      transport,
      account: ACCOUNT,
      request: { mode: 'source', source, expectedState: 'sieve-state-1' },
    });

    expect(result).toMatchObject({
      ok: true,
      result: { scriptId: 'foreign', state: 'sieve-state-2' },
    });
    expect(transport.uploads).toHaveLength(1);
    expect(transport.uploads[0]).toMatchObject({
      accountId: 'acct-1', type: 'application/sieve',
    });
    expect(new TextDecoder().decode(transport.uploads[0].body)).toBe(source);
    expect(setRequest).toMatchObject({
      accountId: 'acct-1',
      ifInState: 'sieve-state-1',
      onSuccessActivateScript: 'foreign',
      update: { foreign: { blobId: 'blob-1' } },
    });
    expect(setRequest.create).toBeUndefined();
    expect(setRequest.destroy).toBeUndefined();
  });

  it('updates the owned script and never creates or destroys another script', async () => {
    const transport = new MockTransport(session());
    let setRequest: any = null;
    transport.handle('SieveScript/get', () => ({
      accountId: 'acct-1',
      state: 'sieve-state-7',
      list: [
        {
          id: 'managed', name: MANAGED_SCRIPT_NAME, blobId: 'blob-managed', isActive: true,
        },
        {
          id: 'foreign', name: 'Saved elsewhere', blobId: 'blob-foreign', isActive: false,
        },
      ],
    }));
    transport.handleDownload(({ blobId }) => (
      blobId === 'blob-managed' ? managedSource() : 'keep;\r\n'
    ));
    transport.handle('SieveScript/validate', () => ({ accountId: 'acct-1', error: null }));
    transport.handle('SieveScript/set', (params) => {
      setRequest = params;
      return {
        accountId: 'acct-1', oldState: 'sieve-state-7', newState: 'sieve-state-8', updated: { managed: null },
      };
    });

    const result = await runSetSieveRules({
      transport,
      account: ACCOUNT,
      request: { document: ruleDocument(), expectedState: 'sieve-state-7' },
    });

    expect(result.ok).toBe(true);
    expect(setRequest).toMatchObject({
      update: { managed: { blobId: 'blob-1' } },
      onSuccessActivateScript: 'managed',
    });
    expect(setRequest.create).toBeUndefined();
    expect(setRequest.destroy).toBeUndefined();
  });

  it('stops on state conflicts and server validation errors', async () => {
    const conflictTransport = new MockTransport(session());
    conflictTransport.handle('SieveScript/get', () => ({
      accountId: 'acct-1', state: 'changed', list: [],
    }));
    const conflict = await runSetSieveRules({
      transport: conflictTransport,
      account: ACCOUNT,
      request: { document: ruleDocument(), expectedState: 'loaded-state' },
    });
    expect(conflict).toMatchObject({
      ok: false, error: { type: 'sieveStateMismatch', terminal: true },
    });
    expect(conflictTransport.uploads).toHaveLength(0);

    const validationTransport = new MockTransport(session());
    validationTransport.handle('SieveScript/get', () => ({
      accountId: 'acct-1', state: 'sieve-state-1', list: [],
    }));
    validationTransport.handle('SieveScript/validate', () => ({
      accountId: 'acct-1',
      error: { type: 'invalidSieve', description: 'line 4: invalid command' },
    }));
    const validation = await runSetSieveRules({
      transport: validationTransport,
      account: ACCOUNT,
      request: { document: ruleDocument(), expectedState: 'sieve-state-1' },
    });
    expect(validation).toMatchObject({
      ok: false,
      error: { type: 'invalidSieve', message: 'line 4: invalid command', terminal: true },
    });
    expect(validationTransport.requests.some(({ methodCalls }) =>
      methodCalls[0][0] === 'SieveScript/set')).toBe(false);
  });
});

function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'id')
    .map(([key, item]) => [key, withoutIds(item)]));
}
