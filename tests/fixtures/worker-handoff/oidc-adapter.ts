import { createLoginOrGoToAuthServer } from '../../../node_modules/oidc-spa/src/core/loginOrGoToAuthServer';

// Replace discovery and the IdP boundary; keep oidc-spa's login implementation.
const { loginOrGoToAuthServer } = createLoginOrGoToAuthServer({
  configId: 'database-recovery-reproduction',
  oidcClientTsUserManager: {
    async signinRedirect() {
      sessionStorage.setItem('fixture.redirect', JSON.stringify({
        databaseUnavailable: (window as any).testAuth.databaseUnavailable,
        status: (window as any).testAuth.status,
      }));
      location.assign('./oidc-destination.html');
    },
  } as any,
  homeUrl: `${location.origin}/`,
  stateUrlParamValue_instance: 'fixture',
  transformUrlBeforeRedirect: undefined,
  getExtraQueryParams: undefined,
  getExtraTokenParams: undefined,
  evtInitializationOutcomeUserNotLoggedIn: { subscribe: () => ({ unsubscribe() {} }) } as any,
  log: undefined,
});

const oidc = {
  isUserLoggedIn: false,
  login() {
    (window as any).testLoginStarted = true;
    return loginOrGoToAuthServer({
      action: 'login',
      redirectUrl: location.href,
      extraQueryParams_local: undefined,
      transformUrlBeforeRedirect_local: undefined,
      doNavigateBackToLastPublicUrlIfTheTheUserNavigateBack: false,
      doForceReloadOnBfCache: false,
      interaction: 'directly redirect if active session show login otherwise',
      preRedirectHook: undefined,
    });
  },
};

export async function initOidc() { return oidc; }
export function getOidc() { return oidc; }
