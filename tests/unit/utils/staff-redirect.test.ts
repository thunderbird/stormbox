import { describe, expect, it } from 'vitest';

import {
  STAFF_AUTO_LOGIN_PARAM,
  hasAutoLoginFlag,
  staffRedirectUrl,
  withoutAutoLoginFlag,
} from '../../../src/utils/staff-redirect';

const STAFF_APP = 'https://alpha-app.thundermail.com';

describe('staffRedirectUrl', () => {
  it('moves the current path, query and hash onto the staff app origin with the auto-login flag', () => {
    const target = staffRedirectUrl(
      STAFF_APP,
      'https://webmail.thundermail.com/inbox?view=compact#msg-1',
    );
    expect(target).toBe('https://alpha-app.thundermail.com/inbox?view=compact&auto-login=1#msg-1');
  });

  it('adds the flag to a bare origin', () => {
    expect(staffRedirectUrl(STAFF_APP, 'https://webmail.thundermail.com/'))
      .toBe('https://alpha-app.thundermail.com/?auto-login=1');
  });

  it('does not redirect when the page is already on the staff app origin', () => {
    expect(staffRedirectUrl(STAFF_APP, 'https://alpha-app.thundermail.com/inbox')).toBeNull();
  });

  it('does not redirect when no staff app is configured or the value is unparseable', () => {
    expect(staffRedirectUrl('', 'https://webmail.thundermail.com/')).toBeNull();
    expect(staffRedirectUrl('not a url', 'https://webmail.thundermail.com/')).toBeNull();
  });

  it('does not duplicate the flag when it is already present', () => {
    const target = staffRedirectUrl(STAFF_APP, `https://webmail.thundermail.com/?${STAFF_AUTO_LOGIN_PARAM}=1`);
    expect(target).toBe('https://alpha-app.thundermail.com/?auto-login=1');
  });
});

describe('auto-login flag helpers', () => {
  it('detects the flag in a query string', () => {
    expect(hasAutoLoginFlag('?auto-login=1')).toBe(true);
    expect(hasAutoLoginFlag('?auto-login')).toBe(true);
    expect(hasAutoLoginFlag('?app-password')).toBe(false);
    expect(hasAutoLoginFlag('')).toBe(false);
  });

  it('strips only the flag from an href', () => {
    expect(withoutAutoLoginFlag('https://alpha-app.thundermail.com/inbox?auto-login=1&view=compact#m'))
      .toBe('https://alpha-app.thundermail.com/inbox?view=compact#m');
    expect(withoutAutoLoginFlag('https://alpha-app.thundermail.com/?auto-login=1'))
      .toBe('https://alpha-app.thundermail.com/');
  });
});
