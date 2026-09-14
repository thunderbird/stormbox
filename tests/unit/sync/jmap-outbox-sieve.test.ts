import { describe, expect, it } from 'vitest';

import type { MailRuleDocument } from '../../../src/sieve/rules';
import { SIEVE_CAPABILITY } from '../../../src/sieve/rules';
import {
  MUTATION_TYPES,
  processMutationRow,
} from '../../../src/sync/backends/jmap/outbox';
import { JMAP_CAPS } from '../../../src/sync/backends/jmap/transport';
import { MockTransport } from './_mock-transport';

const DOCUMENT: MailRuleDocument = {
  version: 2,
  rules: [{
    id: 'rule-1',
    name: 'Discard automated noise',
    enabled: true,
    match: 'all',
    conditions: [{
      id: 'condition-1', type: 'condition', negated: false,
      field: 'from', operator: 'contains', value: 'noise@example.net',
    }],
    actions: [{ id: 'action-1', type: 'discard' }],
    stopProcessing: true,
  }],
};

function sieveTransport() {
  const transport = new MockTransport({
    capabilities: { [JMAP_CAPS.CORE]: {}, [SIEVE_CAPABILITY]: {} },
    primaryAccounts: { [SIEVE_CAPABILITY]: 'acct-1' },
    accounts: {
      'acct-1': {
        accountCapabilities: {
          [SIEVE_CAPABILITY]: { sieveExtensions: [], maxSizeScript: 64_000 },
        },
      },
    },
  });
  transport.handle('SieveScript/get', () => ({
    accountId: 'acct-1', state: 'state-1', list: [],
  }));
  transport.handle('SieveScript/validate', () => ({ accountId: 'acct-1', error: null }));
  transport.handle('SieveScript/set', () => ({
    accountId: 'acct-1',
    newState: 'state-2',
    created: { stormbox: { id: 'managed-1', blobId: 'blob-1' } },
  }));
  return transport;
}

describe('Sieve outbox dispatch', () => {
  it('dispatches the durable rules mutation through upload, validation, and set', async () => {
    const transport = sieveTransport();
    const result = await processMutationRow({
      transport,
      account: { id: 1, remote_account_id: 'acct-1' },
      handlers: {},
      row: {
        mutation_type: MUTATION_TYPES.SET_SIEVE_RULES,
        request_json: JSON.stringify({ document: DOCUMENT, expectedState: 'state-1' }),
      },
    });

    expect(result).toMatchObject({ ok: true, result: { scriptId: 'managed-1' } });
    expect(transport.uploads).toHaveLength(1);
    expect(transport.requests.map(({ methodCalls }) => methodCalls[0][0]))
      .toEqual(['SieveScript/get', 'SieveScript/validate', 'SieveScript/set']);
  });

  it('classifies malformed durable payloads as terminal', async () => {
    const result = await processMutationRow({
      transport: sieveTransport(),
      account: { id: 1, remote_account_id: 'acct-1' },
      handlers: {},
      row: {
        mutation_type: MUTATION_TYPES.SET_SIEVE_RULES,
        request_json: '{not-json',
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        type: 'invalidArguments',
        message: 'The durable mutation payload is not valid JSON.',
        terminal: true,
      },
    });
  });
});
