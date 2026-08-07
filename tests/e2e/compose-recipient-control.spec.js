import {
  expect,
  resetSharedSession,
  test,
} from './helpers/shared-session.js';
import {
  localStackEnabled,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import {
  clearRecipients,
  composeSubject,
  waitForIdentities,
  invalidRecipients,
  recipientAddresses,
  recipientInput,
  recipientPills,
} from './helpers/compose.js';

/**
 * The recipient control from the keyboard and from a screen reader's point
 * of view (CS-3.8, CS-3.9, CS-3.11, CS-3.16).
 *
 * Component tests cover the same behaviours against a mounted component,
 * which is where a failure is easiest to read. These exist because the
 * things that break here break only in a browser: focus that lands on the
 * document instead of the next control, a key the dialog swallows before
 * the control sees it, and a paste, which no component test performs with
 * a real clipboard.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

function sendButton(page) {
  return page.locator('.compose-dialog button.primary', { hasText: /^Send$/ });
}

async function openCompose(page) {
  await page.keyboard.press('ControlOrMeta+n');
  await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 10_000 });
  await waitForIdentities(page);
}

async function closeCompose(page) {
  const dialog = page.locator('.compose-dialog');
  if (await dialog.count() === 0) return;
  await page.locator('.compose-dialog header button.icon').click().catch(() => {});
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
}

/**
 * Put a contact in the book and return the word that finds it.
 *
 * A test that needs the suggestion list to open has to seed something
 * findable first. The e2e account is seeded with mail, not with an address
 * book, and suggestions come only from contacts and from addresses the user
 * has written to — never from received mail (CS-3.3). Part of the account's
 * own address will not do either: an owned address is suppressed until it is
 * typed in full (CS-3.7).
 *
 * Leaves the app in Mail, where the callers expect to be.
 */
async function seedFindableContact(page, word) {
  const stamp = Date.now();
  const name = `${word} Person ${stamp}`;
  const email = `${word.toLowerCase()}-${stamp}@example.org`;
  await page.getByRole('button', { name: 'Contacts', exact: true }).click();
  await expect(page.locator('.contacts')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Add contact' }).click();
  const form = page.locator('.contacts__form');
  await expect(form).toBeVisible();
  await form.locator('input[type="text"]').first().fill(name);
  await form.locator('input[type="email"]').first().fill(email);
  await form.getByRole('button', { name: /^save contact$/i }).click();
  await expect(page.locator('.contacts__row').filter({ hasText: name }))
    .toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Mail', exact: true }).click();
  return { name, email, term: word.toLowerCase() };
}

/** Undo `seedFindableContact`; the shared session resets, the server does not. */
async function forgetContact(page, name) {
  await page.getByRole('button', { name: 'Contacts', exact: true }).click().catch(() => {});
  await page.locator('.contacts__row').filter({ hasText: name })
    .getByRole('button', { name: /^Remove / })
    .click({ timeout: 10_000 })
    .catch(() => {});
  await page.getByRole('button', { name: 'Mail', exact: true }).click().catch(() => {});
}

/**
 * Paste into the focused recipient field.
 *
 * A real Ctrl+V needs clipboard permissions that differ between the two
 * browsers, so the clipboard payload is delivered as the event the control
 * actually handles.
 */
async function pasteIntoTo(page, text) {
  await page.locator('.compose-dialog #compose-to').evaluate((input, pasted) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasted);
    const event = new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    // Firefox ignores the constructor's clipboardData and substitutes an
    // empty one, which reads to the control as an empty clipboard. The
    // payload is therefore checked rather than the property, and attached
    // where it is missing: a real paste always carries one, so this is the
    // stand-in catching up rather than the control needing to know.
    if (event.clipboardData?.getData('text/plain') !== pasted) {
      Object.defineProperty(event, 'clipboardData', { value: data, configurable: true });
    }
    input.dispatchEvent(event);
  }, text);
}

test.describe('Recipient control', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage);
  });

  test('addresses a message from the keyboard alone', async ({ sharedPage: page }) => {
    try {
      await openCompose(page);
      const field = recipientInput(page, 'To');
      await field.click();

      // Typing and committing, without ever leaving the keyboard.
      await page.keyboard.type('alice@example.org');
      await page.keyboard.press('Enter');
      await expect(recipientPills(page, 'To')).toHaveCount(1);
      expect(await recipientAddresses(page, 'To')).toEqual(['alice@example.org']);
      await expect(field, 'the field is empty and ready for the next one')
        .toHaveValue('');

      // A comma means the same thing as Enter.
      await page.keyboard.type('bob@example.org,');
      await expect(recipientPills(page, 'To')).toHaveCount(2);

      // Backspace against a pill reopens it rather than destroying it: a
      // recipient is nearly always being corrected, not abandoned.
      await page.keyboard.press('Backspace');
      await expect(recipientPills(page, 'To')).toHaveCount(1);
      await expect(field).toHaveValue('bob@example.org');
      await page.keyboard.press('Enter');
      await expect(recipientPills(page, 'To')).toHaveCount(2);

      // A comma inside a display name is part of the name. Typed here as
      // real keystrokes, since whether the control can tell the two apart
      // depends on where the browser reports the caret.
      await page.keyboard.type('"Smith, Alice" <smith@example.org>');
      await expect(recipientPills(page, 'To'), 'the name is not cut at its comma')
        .toHaveCount(2);
      await page.keyboard.press('Enter');
      await expect(recipientPills(page, 'To')).toHaveCount(3);
      await expect(recipientPills(page, 'To').nth(2).locator('.pill__text'))
        .toHaveText('Smith, Alice');

      // Tab commits what is in the field on the way out of it.
      await page.keyboard.type('carol@example.org');
      await page.keyboard.press('Tab');
      await expect(recipientPills(page, 'To')).toHaveCount(4);
      expect(await recipientAddresses(page, 'To')).toEqual([
        'alice@example.org',
        'bob@example.org',
        'smith@example.org',
        'carol@example.org',
      ]);
    } finally {
      await closeCompose(page);
    }
  });

  test('exposes the combobox to a screen reader', async ({ sharedPage: page }) => {
    const seeded = await seedFindableContact(page, 'Zephyr');
    try {
      await openCompose(page);
      const field = recipientInput(page, 'To');
      await field.click();
      await expect(field).toHaveAttribute('role', 'combobox');
      await expect(field).toHaveAttribute('aria-expanded', 'false');

      await page.keyboard.type(seeded.term);
      const listbox = page.locator('.compose-dialog #compose-to-listbox');
      await expect(field, 'typing opens the list').toHaveAttribute('aria-expanded', 'true');
      await expect(listbox).toHaveAttribute('role', 'listbox');
      const count = await listbox.locator('[role="option"]').count();
      expect(count, 'the seeded account has at least one match').toBeGreaterThan(0);
      expect(count, 'the list is bounded (CS-3.12)').toBeLessThanOrEqual(10);

      // How many there are has to be said, not shown, for a reader that
      // cannot see a list appear below the field.
      await expect(page.locator('.compose-dialog #compose-to-status'))
        .toHaveText(/\d+ suggestions? available/);

      await page.keyboard.press('ArrowDown');
      await expect(field).toHaveAttribute('aria-activedescendant', /compose-to-option-\d+/);
      const active = await field.getAttribute('aria-activedescendant');
      await expect(page.locator(`#${active}`)).toHaveAttribute('aria-selected', 'true');

      // Escape closes the list and leaves the message alone.
      await page.keyboard.press('Escape');
      await expect(field).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('.compose-dialog'), 'the draft survives dismissing a list')
        .toBeVisible();

      await page.keyboard.press('Enter');
      await expect(recipientPills(page, 'To')).toHaveCount(1);
      const pill = recipientPills(page, 'To').first();
      await expect(pill.locator('.pill__label')).toHaveAttribute('aria-label', /Activate to edit/);
      await expect(pill.locator('.pill__remove')).toHaveAttribute('aria-label', /^Remove /);

      // Removing a pill must leave focus somewhere a keyboard can carry on
      // from, not on the document body.
      await pill.locator('.pill__remove').click();
      await expect(recipientPills(page, 'To')).toHaveCount(0);
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        return { tag: el?.tagName ?? null, id: el?.id ?? null };
      });
      expect(focused.tag, 'focus stays in the control').not.toBe('BODY');
      expect(focused.id).toBe('compose-to');
    } finally {
      await closeCompose(page);
      await forgetContact(page, seeded.name);
    }
  });

  test('leaves Escape able to close the message', async ({ sharedPage: page }) => {
    // A list left open on a field the user has moved away from used to make
    // the whole dialog unclosable: the shortcut handler stands down for an
    // expanded combobox, and the control only receives the key when it has
    // focus, so Escape reached nothing at all.
    const seeded = await seedFindableContact(page, 'Quilla');
    try {
      await openCompose(page);
      const field = recipientInput(page, 'To');
      await field.click();
      await page.keyboard.type(seeded.term);
      await expect(field).toHaveAttribute('aria-expanded', 'true');

      // Focus leaves by keyboard because it cannot leave by mouse: the list is
      // drawn over the rows beneath it, so a click aimed at Subject lands on a
      // suggestion. Tab is the gesture that gets out of the field with the
      // list up.
      await page.keyboard.press('Tab');
      await expect(field).not.toBeFocused();
      await expect(
        page.locator('.compose-dialog [role="combobox"][aria-expanded="true"]'),
        'leaving a field takes its list with it',
      ).toHaveCount(0);

      await page.keyboard.press('Escape');
      await expect(page.locator('.compose-dialog')).toBeHidden({ timeout: 10_000 });
    } finally {
      await closeCompose(page);
      await forgetContact(page, seeded.name);
    }
  });

  test('commits a pasted list, and keeps what it could not read', async ({ sharedPage: page }) => {
    try {
      await openCompose(page);
      await recipientInput(page, 'To').click();

      await pasteIntoTo(page, [
        '"Smith, Alice" <alice@example.org>',
        'bob@example.org',
        'https://example.org/not-an-address',
        'carol@example.org',
      ].join('\n'));

      // Every address arrives as its own recipient, the display name
      // survives the comma inside it, and the fragment neither disappears
      // nor becomes an address (CS-3.11, CS-2.4).
      await expect(recipientPills(page, 'To')).toHaveCount(4);
      expect(await recipientAddresses(page, 'To'))
        .toEqual(['alice@example.org', 'bob@example.org', 'carol@example.org']);
      await expect(invalidRecipients(page, 'To'))
        .toHaveText(['https://example.org/not-an-address']);

      // A draft holding one refuses to send, and says which entry it is.
      await composeSubject(page).fill(`Recipient control paste ${Date.now()}`);
      await sendButton(page).click();
      const error = page.locator('.compose-dialog .compose-error');
      await expect(error).toBeVisible({ timeout: 10_000 });
      await expect(error).toContainText('not-an-address');
      await expect(page.locator('.compose-dialog'), 'the draft is kept').toBeVisible();

      // The fix happens in place: the pill reopens as the text it was
      // pasted as, and correcting it clears the way to send (CS-3.16).
      await invalidRecipients(page, 'To').click();
      await expect(recipientInput(page, 'To'))
        .toHaveValue('https://example.org/not-an-address');
      await recipientInput(page, 'To').fill('dave@example.org');
      await recipientInput(page, 'To').press('Enter');
      await expect(invalidRecipients(page, 'To')).toHaveCount(0);
      expect(await recipientAddresses(page, 'To')).toContain('dave@example.org');
    } finally {
      await closeCompose(page);
    }
  });

  test('offers the address book to a name that cannot be typed', async ({ sharedPage: page }) => {
    // The contact is created here rather than assumed: the e2e account is
    // seeded with mail, not with an address book, and a browse test against
    // an empty book proves nothing.
    const stamp = Date.now();
    const contactName = `Zzyzx Browse ${stamp}`;
    const contactEmail = `browse-${stamp}@example.org`;
    try {
      await page.getByRole('button', { name: 'Contacts', exact: true }).click();
      await expect(page.locator('.contacts')).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Add contact' }).click();
      const form = page.locator('.contacts__form');
      await expect(form).toBeVisible();
      await form.locator('input[type="text"]').first().fill(contactName);
      await form.locator('input[type="email"]').first().fill(contactEmail);
      await form.getByRole('button', { name: /^save contact$/i }).click();
      await expect(page.locator('.contacts__row').filter({ hasText: contactName }))
        .toBeVisible({ timeout: 30_000 });

      await page.getByRole('button', { name: 'Mail', exact: true }).click();
      await openCompose(page);
      await clearRecipients(page, 'To');
      const field = recipientInput(page, 'To');
      await field.click();

      // Down on an empty field is the combobox gesture for "show me the
      // list", which here is the address book rather than ten matches: the
      // typeahead matches on the address, so a name nobody can spell has no
      // prefix to find it by (CS-3.12).
      await page.keyboard.press('ArrowDown');
      const status = page.locator('.compose-dialog #compose-to-status');
      await expect(status).toHaveText(/Showing \d+ contacts/);
      const listbox = page.locator('.compose-dialog #compose-to-listbox');
      await expect(listbox.locator('[role="option"]').filter({ hasText: contactName }))
        .toHaveCount(1);

      // The field is a plain text combobox now — no dropdown chevron. The
      // pointer path to the full book is the "Browse all contacts" footer
      // the typed panel carries; typing part of the address opens it.
      await page.keyboard.press('Escape');
      await expect(listbox).toBeHidden();
      await field.click();
      await field.pressSequentially('brow');
      await expect(page.locator('.compose-dialog .autocomplete__browse button'))
        .toBeVisible();
      await page.locator('.compose-dialog .autocomplete__browse button').click();
      await expect(status).toHaveText(/Showing \d+ contacts/);

      await listbox.locator('[role="option"]').filter({ hasText: contactName }).click();
      await expect(recipientPills(page, 'To')).toHaveCount(1);
      expect(await recipientAddresses(page, 'To')).toEqual([contactEmail]);
    } finally {
      await closeCompose(page);
      // Leave the book as it was found, and the app in Mail: the shared
      // session is reset per test but the server's cards are not.
      await page.getByRole('button', { name: 'Contacts', exact: true }).click()
        .catch(() => {});
      await page.locator('.contacts__row').filter({ hasText: contactName })
        .getByRole('button', { name: /^Remove / })
        .click({ timeout: 10_000 })
        .catch(() => {});
      await page.getByRole('button', { name: 'Mail', exact: true }).click().catch(() => {});
    }
  });
});
