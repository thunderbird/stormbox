import { describe, expect, it } from 'vitest';

import {
  REMEMBER_ME_SESSION_LIFETIME_SECONDS,
  withRememberMeSessionLifetimes,
} from '../../fixtures/configure-keycloak.mjs';

describe('withRememberMeSessionLifetimes', () => {
  it('spans 90 days so remember-me sessions outlive browser restarts', () => {
    expect(REMEMBER_ME_SESSION_LIFETIME_SECONDS).toBe(90 * 24 * 60 * 60);
  });

  it('enables remember-me and sets both remember-me SSO lifespans', () => {
    const realm = withRememberMeSessionLifetimes({ realm: 'tbpro' });
    expect(realm.rememberMe).toBe(true);
    expect(realm.ssoSessionIdleTimeoutRememberMe).toBe(REMEMBER_ME_SESSION_LIFETIME_SECONDS);
    expect(realm.ssoSessionMaxLifespanRememberMe).toBe(REMEMBER_ME_SESSION_LIFETIME_SECONDS);
  });

  it('overrides unset (0) lifespans without touching unrelated realm fields', () => {
    const input = {
      realm: 'tbpro',
      rememberMe: false,
      ssoSessionIdleTimeoutRememberMe: 0,
      ssoSessionMaxLifespanRememberMe: 0,
      ssoSessionIdleTimeout: 1800,
      ssoSessionMaxLifespan: 36000,
      attributes: { frontendUrl: 'https://localhost:3000' },
    };
    const realm = withRememberMeSessionLifetimes(input);
    expect(realm.ssoSessionIdleTimeoutRememberMe).toBe(REMEMBER_ME_SESSION_LIFETIME_SECONDS);
    expect(realm.ssoSessionMaxLifespanRememberMe).toBe(REMEMBER_ME_SESSION_LIFETIME_SECONDS);
    // Standard (non-remember-me) session policy stays whatever the
    // realm already had; only the checkbox-opt-in path is extended.
    expect(realm.ssoSessionIdleTimeout).toBe(1800);
    expect(realm.ssoSessionMaxLifespan).toBe(36000);
    expect(realm.attributes).toEqual({ frontendUrl: 'https://localhost:3000' });
  });

  it('returns a copy instead of mutating the fetched realm representation', () => {
    const input = { realm: 'tbpro', rememberMe: false };
    const realm = withRememberMeSessionLifetimes(input);
    expect(realm).not.toBe(input);
    expect(input.rememberMe).toBe(false);
    expect(input).not.toHaveProperty('ssoSessionIdleTimeoutRememberMe');
  });
});
