import { describe, expect, it, vi } from 'vitest';

import {
  readScheduleCapability,
  refreshScheduleCapability,
  requireScheduleCapability,
} from '../../../src/sync/backends/jmap/schedule-capability';
import { JMAP_CAPS } from '../../../src/sync/backends/jmap/transport';

const account = { remote_account_id: 'acct-1' };

function transportWith(capability: unknown): any {
  return {
    session: {
      accounts: {
        'acct-1': {
          accountCapabilities: capability === undefined
            ? {}
            : { [JMAP_CAPS.SUBMISSION]: capability },
        },
      },
    },
  };
}

describe('scheduled-send capability', () => {
  it('requires submission, FUTURERELEASE, and a positive safe numeric limit', () => {
    expect(readScheduleCapability(transportWith({
      submissionExtensions: { FUTURERELEASE: [] },
      maxDelayedSend: 2_592_000,
    }), account)).toEqual({
      supported: true,
      maxDelayedSend: 2_592_000,
      serverClockReference: null,
    });

    for (const capability of [
      undefined,
      null,
      [],
      {},
      { submissionExtensions: { FUTURERELEASE: [] }, maxDelayedSend: 0 },
      { submissionExtensions: { FUTURERELEASE: [] }, maxDelayedSend: -1 },
      { submissionExtensions: { FUTURERELEASE: [] }, maxDelayedSend: 60.5 },
      { submissionExtensions: { FUTURERELEASE: [] }, maxDelayedSend: '60' },
      { submissionExtensions: ['FUTURERELEASE'], maxDelayedSend: 60 },
      { submissionExtensions: {}, maxDelayedSend: 60 },
    ]) {
      expect(readScheduleCapability(transportWith(capability), account)).toEqual({
        supported: false,
        maxDelayedSend: 0,
        serverClockReference: null,
      });
    }
  });

  it('refreshes the live session before returning capability state', async () => {
    const transport = transportWith({});
    transport.fetchSession = vi.fn(async ({ force }) => {
      expect(force).toBe(true);
      transport.session.accounts['acct-1'].accountCapabilities[JMAP_CAPS.SUBMISSION] = {
        submissionExtensions: { FUTURERELEASE: [] },
        maxDelayedSend: 600,
      };
      return transport.session;
    });

    await expect(refreshScheduleCapability(transport, account)).resolves.toEqual({
      supported: true,
      maxDelayedSend: 600,
      serverClockReference: null,
    });
    expect(transport.fetchSession).toHaveBeenCalledTimes(1);
  });

  it('returns the server clock reference captured with the live capability', () => {
    const transport = transportWith({
      submissionExtensions: { FUTURERELEASE: [] },
      maxDelayedSend: 600,
    });
    transport.serverClockReference = {
      capturedAtMs: 1_000,
      lowerOffsetMs: 2_000,
      uncertaintyMs: 999,
    };

    expect(readScheduleCapability(transport, account)).toEqual({
      supported: true,
      maxDelayedSend: 600,
      serverClockReference: {
        capturedAtMs: 1_000,
        lowerOffsetMs: 2_000,
        uncertaintyMs: 999,
      },
    });
  });

  it('turns an unsupported live capability into the durable terminal error', async () => {
    await expect(requireScheduleCapability(transportWith({
      submissionExtensions: {},
      maxDelayedSend: 600,
    }), account)).rejects.toMatchObject({
      type: 'scheduleCapabilityUnavailable',
      terminal: true,
    });
  });
});
