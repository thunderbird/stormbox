export const STORMBOX_TARGET_ENV = String(process.env.STORMBOX_TARGET_ENV ?? '');
export const STORMBOX_BASE_URL = String(process.env.STORMBOX_BASE_URL ?? '');

export const ACCTS_OIDC_EMAIL = String(process.env.ACCTS_OIDC_EMAIL ?? '');
export const ACCTS_OIDC_PWORD = String(process.env.ACCTS_OIDC_PWORD ?? '');
export const PRIMARY_THUNDERMAIL_EMAIL = String(process.env.PRIMARY_THUNDERMAIL_EMAIL ?? '');

// Direct JMAP access is used only by BrowserStack test-data cleanup against
// deployed stage or production Thundermail. The password is the dedicated
// account's Thundermail app password, not its TB Accounts sign-in password.
export const THUNDERMAIL_JMAP_USERNAME = String(process.env.THUNDERMAIL_JMAP_USERNAME ?? '');
export const THUNDERMAIL_JMAP_APP_PASSWORD = String(
  process.env.THUNDERMAIL_JMAP_APP_PASSWORD ?? '',
);
export const THUNDERMAIL_JMAP_URL = String(process.env.THUNDERMAIL_JMAP_URL ?? '');

export const PLAYWRIGHT_TAG_DESKTOP = '@stormbox-desktop';
export const PLAYWRIGHT_TAG_MOBILE = '@stormbox-mobile';
export const PLAYWRIGHT_TAG_DESKTOP_SMOKE = '@stormbox-smoke-desktop';
export const PLAYWRIGHT_TAG_MOBILE_SMOKE = '@stormbox-smoke-mobile';

export const TIMEOUT_2_SECONDS = 2_000;
export const TIMEOUT_5_SECONDS = 5_000;
export const TIMEOUT_10_SECONDS = 10_000;
export const TIMEOUT_30_SECONDS = 30_000;
export const TIMEOUT_60_SECONDS = 60_000;

export const FOLDER_NAMES_TO_EXERCISE = [
  'Inbox',
  'Drafts',
  'Sent Items',
  'Archives',
  'Junk Mail',
  'Deleted Items',
];
