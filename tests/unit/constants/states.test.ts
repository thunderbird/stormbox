import { describe, expect, it } from 'vitest';

import {
  ADDRESSBOOK_PHASE,
  CONTACT_PHASE,
  CREATE_EMAILS_PHASE,
  IDENTITY_PHASE,
  MUTATION_RECOVERY_POLICIES,
  MUTATION_TYPE,
  SEND_PHASE,
} from '../../../src/constants/states';
import { MUTATION_TYPES } from '../../../src/sync/backends/jmap/outbox';

describe('mutation registries', () => {
  it('exposes one frozen mutation-type object through both public names', () => {
    expect(MUTATION_TYPES).toBe(MUTATION_TYPE);
    expect(Object.isFrozen(MUTATION_TYPE)).toBe(true);
  });

  it('keeps contact create recovery in the shared phase registry', () => {
    expect(CONTACT_PHASE.CREATE_PENDING).toBe('contact_create_pending');
  });

  it('records replay and completion phases next to each guarded mutation', () => {
    expect(MUTATION_RECOVERY_POLICIES).toEqual([
      {
        mutationType: MUTATION_TYPE.SEND,
        replayablePhases: [SEND_PHASE.QUEUED, SEND_PHASE.CREATED],
        completedPhases: [SEND_PHASE.SUBMITTED, SEND_PHASE.CACHE_PENDING],
      },
      {
        mutationType: MUTATION_TYPE.CREATE_IDENTITY,
        replayablePhases: [IDENTITY_PHASE.CREATE_SUBMITTING],
        completedPhases: [SEND_PHASE.CACHE_PENDING],
      },
      {
        mutationType: MUTATION_TYPE.CREATE_ADDRESSBOOK,
        replayablePhases: [ADDRESSBOOK_PHASE.CREATE_SUBMITTING],
        completedPhases: [ADDRESSBOOK_PHASE.CACHE_PENDING],
      },
      {
        mutationType: MUTATION_TYPE.DESTROY_ADDRESSBOOK,
        replayablePhases: [ADDRESSBOOK_PHASE.DESTROY_SUBMITTING],
        completedPhases: [ADDRESSBOOK_PHASE.CACHE_PENDING],
      },
      {
        // Email/set create has no idempotency key: nothing is replayable.
        mutationType: MUTATION_TYPE.CREATE_EMAILS,
        replayablePhases: [],
        completedPhases: [CREATE_EMAILS_PHASE.CACHE_PENDING],
      },
    ]);
  });
});
