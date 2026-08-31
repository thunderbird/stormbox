import { describe, expect, it } from 'vitest';

import {
  mergeSettingsDocuments,
  normalizeSettingsDocument,
} from '../../../src/constants/settings-document';

describe('settings document timezone projection', () => {
  it('preserves a timezone as an opaque synced setting', () => {
    expect(normalizeSettingsDocument({
      settings: { timeZone: 'America/Los_Angeles' },
      updatedAt: { timeZone: 12.9 },
    })).toMatchObject({
      settings: { timeZone: 'America/Los_Angeles' },
      updatedAt: { timeZone: 12 },
    });
  });

  it('selects the newest timezone without replacing an equally new remote choice', () => {
    expect(mergeSettingsDocuments(
      {
        settings: { timeZone: 'Europe/London' },
        updatedAt: { timeZone: 20 },
      },
      {
        settings: { timeZone: 'Pacific/Auckland' },
        updatedAt: { timeZone: 20 },
      },
    )).toEqual({
      document: {
        owner: 'stormbox',
        documentType: 'user-settings',
        version: 1,
        settings: { timeZone: 'Pacific/Auckland' },
        updatedAt: { timeZone: 20 },
      },
      localNewer: false,
    });
  });
});
