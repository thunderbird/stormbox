import { describe, expect, it } from 'vitest';

import { accountsUrlForHostname } from '../../src/defines.js';

describe('accountsUrlForHostname', () => {
  it('uses Thunderbird Accounts stage for dev hosts', () => {
    expect(accountsUrlForHostname('localhost')).toBe('https://accounts-stage.tb.pro');
    expect(accountsUrlForHostname('127.0.0.1')).toBe('https://accounts-stage.tb.pro');
    expect(accountsUrlForHostname('sancus.thunderbird.net')).toBe('https://accounts-stage.tb.pro');
  });

  it('uses Thunderbird Accounts production for the production webmail host', () => {
    expect(accountsUrlForHostname('webmail.thundermail.com')).toBe('https://accounts.tb.pro');
  });

  it('uses Thunderbird Accounts stage for hosted non-production webmail', () => {
    expect(accountsUrlForHostname('webmail.stage-thundermail.com')).toBe('https://accounts-stage.tb.pro');
  });
});
