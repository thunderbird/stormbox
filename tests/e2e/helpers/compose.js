/**
 * Locators and gestures for the compose dialog's recipient fields.
 *
 * Recipients are a pill control, not a text box: what is committed lives in
 * pills, and the input holds only the entry being typed. That makes the two
 * obvious mistakes for a test `fill()` without committing, which sends
 * nothing, and `inputValue()` to read the recipients, which reads the empty
 * buffer. Every spec goes through here so neither is written twice.
 *
 * Each field is found by the id its label points at, rather than by an
 * anchored match on the row's text: a committed pill puts a name in that
 * text, and `/^To$/` stops matching the moment a recipient exists.
 */

import { expect } from '@playwright/test';

const FIELD_IDS = { To: 'compose-to', Cc: 'compose-cc', Bcc: 'compose-bcc' };

function fieldId(label) {
  const id = FIELD_IDS[label];
  if (!id) throw new Error(`no recipient field called ${label}`);
  return id;
}

export function composeRow(page, label) {
  return page.locator(`.compose-dialog .row:has(#${fieldId(label)})`);
}

/** The subject, which is an ordinary text box and stays one. */
export function composeSubject(page) {
  return page.locator('.compose-dialog .row')
    .filter({ hasText: /^Subject$/ })
    .locator('input');
}

/** The text input of a recipient field: what is being typed, not what is committed. */
export function recipientInput(page, label) {
  return page.locator(`.compose-dialog #${fieldId(label)}`);
}

export function recipientPills(page, label) {
  return composeRow(page, label).locator('.pill');
}

/**
 * The addresses committed in a field, lower-cased.
 *
 * Read from each pill's remove label, which is where the address is: the
 * visible text is a display name, and two people called Alice are not
 * distinguishable by it. That label rather than the pill's own because this
 * one ends at the address — the other continues into a sentence, and
 * `alice@example.org.` is what a match then returns. Invalid entries are
 * excluded: their text is not an address even when it contains an `@`, and
 * `invalidRecipients` is where they are asserted.
 */
export async function recipientAddresses(page, label) {
  const labels = await composeRow(page, label)
    .locator('.pill:not(.pill--invalid) .pill__remove')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label') ?? ''));
  return labels
    .flatMap((text) => text.match(/[^\s<>,"']+@[^\s<>,"']+/g) ?? [])
    .map((address) => address.toLowerCase());
}

/** The text of every entry a field is holding as invalid. */
export function invalidRecipients(page, label) {
  return composeRow(page, label).locator('.pill--invalid .pill__text');
}

/**
 * Type a recipient list into a field and commit it, as pressing Enter does.
 *
 * Blur commits too, so a spec that fills and clicks Send is usually
 * correct by accident; committing here keeps the two apart, so a test that
 * then asserts on the pills is asserting on what the draft holds.
 */
export async function fillRecipient(page, label, value) {
  const input = recipientInput(page, label);
  await input.click();
  await input.fill(value);
  if (value !== '') await input.press('Enter');
}

/** Remove every committed recipient from a field. */
export async function clearRecipients(page, label) {
  const pills = recipientPills(page, label);
  for (let remaining = await pills.count(); remaining > 0; remaining -= 1) {
    await pills.first().locator('.pill__remove').click();
  }
  await recipientInput(page, label).fill('');
}

/**
 * Wait for identity sync, without which send() has no From address. The
 * identity rows render inside the From dropdown whether or not it is
 * open, so counting them needs no clicks.
 */
export async function waitForIdentities(page) {
  await expect.poll(
    async () => page.locator('.compose-dialog [data-compose-from] .app-dropdown__item').count(),
    { timeout: 30_000, message: 'identity sync should populate the From picker' },
  ).toBeGreaterThan(0);
}
