import {
  connectJmap,
  jmapRequest,
  pickResponse,
} from './helpers/jmap-client.js';
import {
  attachConsoleTail,
  consoleLinesFor,
  expect,
  resetSharedSession,
  test,
} from './helpers/shared-session.js';
import {
  discardCompose,
  waitForIdentities,
} from './helpers/compose.js';
import {
  localStackEnabled,
  skipLocalStackMessage,
  STACK_STALWART_API_AUTH,
  STACK_STALWART_API_URL,
  STACK_STALWART_PRINCIPAL,
} from './helpers/stack-env.js';

test.skip(!localStackEnabled, skipLocalStackMessage);

const VIRTUAL_CONTACT_COUNT = 10_000;
const VIRTUAL_CONTACT_PREFIX = 'c504-browser-virtual';

async function patchPrincipalEmails(action, address) {
  const response = await fetch(
    `${STACK_STALWART_API_URL}/api/principal/${encodeURIComponent(STACK_STALWART_PRINCIPAL)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: STACK_STALWART_API_AUTH,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ action, field: 'emails', value: address }]),
    },
  );
  expect(response.ok, `principal ${action} for ${address} should succeed`).toBe(true);
}

async function identitySet(jmap, params) {
  const result = await jmapRequest(jmap, [[
    'Identity/set',
    { accountId: jmap.accountId, ...params },
    'identity-set',
  ]]);
  return pickResponse(result, 'Identity/set') ?? {};
}

async function directIdentity(jmap, email) {
  const result = await jmapRequest(jmap, [[
    'Identity/get',
    { accountId: jmap.accountId },
    'identity-get',
  ]]);
  return (pickResponse(result, 'Identity/get')?.list ?? [])
    .find((identity) => identity.email === email) ?? null;
}

async function refreshIdentityCache(page) {
  await page.evaluate(async () => {
    const accounts = await globalThis.__repo.listAccounts();
    await globalThis.__repo.ensureIdentities(accounts[0].id);
  });
}

async function chooseFrom(composer, address) {
  const picker = composer.locator('[data-compose-from]');
  await picker.locator('summary').click();
  await picker.locator('.app-dropdown__item').filter({ hasText: address }).click();
  await expect(picker.locator('summary')).toContainText(address);
}

async function placeCaretBesideOrigin(editor, side) {
  await editor.evaluate((root, position) => {
    const origin = root.querySelector('[data-stormbox-origin="identity-signature"]');
    if (!origin) throw new Error('Signature origin is missing');
    root.focus();
    const range = document.createRange();
    if (position === 'before') range.setStartBefore(origin);
    else range.setStartAfter(origin);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, side);
}

async function addVirtualContacts(page) {
  await page.evaluate(async ({ count, prefix }) => {
    const accounts = await globalThis.__repo.listAccounts();
    const contacts = Array.from({ length: count }, (_, index) => ({
      remoteId: `${prefix}-${index}`,
      uid: `urn:uuid:${prefix}-${index}`,
      displayName: `C504 Virtual ${String(index).padStart(5, '0')}`,
      fullName: `C504 Virtual ${String(index).padStart(5, '0')}`,
      emails: [],
      phones: [],
      links: [],
      anniversaries: [],
      notes: [],
      organizations: [],
      titles: [],
    }));
    await globalThis.__repo.upsertContacts(accounts[0].id, contacts);
  }, { count: VIRTUAL_CONTACT_COUNT, prefix: VIRTUAL_CONTACT_PREFIX });
}

async function removeVirtualContacts(page) {
  await page.evaluate(async ({ count, prefix }) => {
    const accounts = await globalThis.__repo.listAccounts();
    const remoteIds = Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
    for (let offset = 0; offset < remoteIds.length; offset += 500) {
      await globalThis.__repo.call('contact.deleteLocal', {
        accountId: accounts[0].id,
        remoteIds: remoteIds.slice(offset, offset + 500),
      });
    }
  }, { count: VIRTUAL_CONTACT_COUNT, prefix: VIRTUAL_CONTACT_PREFIX });
}

async function directoryMetrics(page) {
  return page.locator('.directory-list__viewport').evaluate((viewport) => {
    const activeId = viewport.getAttribute('aria-activedescendant');
    const active = activeId ? document.getElementById(activeId) : null;
    const header = viewport.previousElementSibling;
    const rect = viewport.getBoundingClientRect();
    return {
      activePosition: Number(active?.getAttribute('aria-posinset') ?? 0),
      bottom: rect.bottom,
      clientHeight: viewport.clientHeight,
      documentOverflow: document.documentElement.scrollWidth
        - document.documentElement.clientWidth,
      headerTop: header?.getBoundingClientRect().top ?? -1,
      rendered: viewport.querySelectorAll('[role="option"]').length,
      scrollHeight: viewport.scrollHeight,
      scrollTop: viewport.scrollTop,
      total: Number(viewport.querySelector('[role="option"]')?.getAttribute('aria-setsize') ?? 0),
      viewportHeight: window.innerHeight,
      windowScrollY: window.scrollY,
    };
  });
}

async function verifyDirectoryViewport(page, width, expectedLayout) {
  await page.setViewportSize({ width, height: 900 });
  const contacts = page.locator('.contacts');
  await expect(contacts).toHaveAttribute('data-layout', expectedLayout);
  const list = page.locator('.directory-list__viewport');
  await expect.poll(async () => (await directoryMetrics(page)).total, {
    timeout: 60_000,
    message: 'the 10k local directory should reach the virtual list',
  }).toBeGreaterThanOrEqual(VIRTUAL_CONTACT_COUNT);

  const before = await directoryMetrics(page);
  await list.focus();
  await list.press('End');
  await expect.poll(async () => (await directoryMetrics(page)).activePosition, {
    timeout: 10_000,
    message: `End should reach the final contact at ${width}px`,
  }).toBe(before.total);
  const atEnd = await directoryMetrics(page);
  expect(atEnd.scrollTop).toBeGreaterThan(0);
  expect(atEnd.rendered).toBeLessThan(100);
  expect(atEnd.scrollHeight).toBeGreaterThan(atEnd.clientHeight);
  expect(atEnd.bottom).toBeLessThanOrEqual(atEnd.viewportHeight + 1);
  expect(atEnd.headerTop).toBeCloseTo(before.headerTop, 0);
  expect(atEnd.documentOverflow).toBeLessThanOrEqual(0);
  expect(atEnd.windowScrollY).toBe(0);

  await list.press('Home');
  await expect.poll(async () => (await directoryMetrics(page)).activePosition, {
    timeout: 10_000,
    message: `Home should return to the first contact at ${width}px`,
  }).toBe(1);
  expect((await directoryMetrics(page)).scrollTop).toBeLessThanOrEqual(1);
}

async function verifyIdentityEditorWidth(page, width) {
  await page.setViewportSize({ width, height: 900 });
  const contacts = page.locator('.contacts');
  await expect(contacts).toHaveAttribute('data-layout', width < 640 ? 'phone' : 'tablet');
  const detail = page.locator('.identity-detail');
  if (await detail.count() === 0) {
    const primaryRow = page.locator('.directory-list__row')
      .filter({ hasText: STACK_STALWART_PRINCIPAL });
    await expect(primaryRow).toBeVisible();
    await primaryRow.click();
  }
  await expect(detail).toContainText(STACK_STALWART_PRINCIPAL);
  const edit = detail.getByRole('button', { name: 'Edit', exact: true });
  await expect(edit).toBeVisible();
  await edit.click();
  const form = page.locator('.identity-detail__editor');
  await expect(form).toBeVisible();

  const metrics = await form.evaluate((element) => {
    const richEditor = element.querySelector('.rich-text-editor');
    const toolbar = element.querySelector('.compose-toolbar');
    const save = Array.from(element.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Save identity'));
    return {
      documentOverflow: document.documentElement.scrollWidth
        - document.documentElement.clientWidth,
      formOverflow: element.scrollWidth - element.clientWidth,
      richOverflow: richEditor ? richEditor.scrollWidth - richEditor.clientWidth : -1,
      saveRight: save?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
      toolbarGroups: toolbar?.querySelectorAll('[data-toolbar-group]').length ?? 0,
      viewportWidth: window.innerWidth,
    };
  });
  expect(metrics.documentOverflow).toBeLessThanOrEqual(0);
  expect(metrics.formOverflow).toBeLessThanOrEqual(0);
  expect(metrics.richOverflow).toBeLessThanOrEqual(0);
  expect(metrics.saveRight).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.toolbarGroups).toBeLessThan(5);
  await expect(form.locator('.toolbar-more')).toBeVisible();
  await form.getByRole('button', { name: 'Cancel' }).click();
}

test.describe('C504 browser review regressions', () => {
  test.beforeEach(async ({ sharedPage: page }) => {
    await resetSharedSession(page);
  });

  test('strips Squire housekeeping ZWSP without damaging Unicode text', async ({
    sharedPage: page,
  }, testInfo) => {
    const jmap = await connectJmap();
    const stamp = Date.now();
    const alias = `c504-zwsp-${stamp}@example.org`;
    const signatureText = `Unicode family 👨‍👩‍👧‍👦 ${stamp}`;
    let identityId = null;

    try {
      await patchPrincipalEmails('addItem', alias);
      await page.getByRole('button', { name: 'Contacts', exact: true }).click();
      await page.getByRole('button', { name: 'Manage identities' }).click();
      await page.getByRole('button', { name: 'Add identity' }).click();
      const form = page.locator('.identity-detail__editor');
      await form.getByLabel('Display name', { exact: true }).fill('C504 ZWSP probe');
      await form.getByLabel('Email', { exact: true }).fill(alias);
      const editor = form.locator('.editor[contenteditable]');
      await editor.click();
      await page.keyboard.type(signatureText);
      await page.keyboard.press('Enter');
      await form.getByRole('button', { name: 'Bold', exact: true }).click();
      expect(await editor.textContent()).toContain('\u200B');
      await form.getByRole('button', { name: 'Save identity' }).evaluate((button) => {
        button.click();
      });
      await expect(form).toHaveCount(0);

      let wireIdentity;
      await expect.poll(async () => {
        wireIdentity = await directIdentity(jmap, alias);
        identityId = wireIdentity?.id ?? null;
        return wireIdentity;
      }, {
        timeout: 30_000,
        message: 'the ZWSP probe identity should reach the server',
      }).not.toBeNull();
      expect(wireIdentity.textSignature).toBe(signatureText);
      expect(wireIdentity.textSignature).not.toContain('\u200B');
      expect(wireIdentity.htmlSignature).not.toContain('\u200B');
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      if (!identityId) {
        identityId = (await directIdentity(jmap, alias).catch(() => null))?.id ?? null;
      }
      if (identityId) {
        await identitySet(jmap, { destroy: [identityId] }).catch(() => {});
      }
      await patchPrincipalEmails('removeItem', alias).catch(() => {});
    }
  });

  test('keeps virtual directory, signatures, and identity editor bounded', async ({
    sharedPage: page,
  }, testInfo) => {
    test.setTimeout(300_000);
    const jmap = await connectJmap();
    const stamp = Date.now();
    const alias = `c504-unsigned-${stamp}@example.org`;
    const signatureText = `C504 rich signature ${stamp}`;
    const richSignature = `<div>C504 <strong>rich</strong> signature ${stamp}</div>`;
    const primary = await directIdentity(jmap, STACK_STALWART_PRINCIPAL);
    expect(primary, 'the local-stack principal identity should exist').not.toBeNull();
    const originalSignature = {
      htmlSignature: primary.htmlSignature ?? '',
      textSignature: primary.textSignature ?? '',
    };
    let aliasIdentityId = null;
    let primaryChanged = false;
    let virtualContactsAdded = false;

    try {
      await patchPrincipalEmails('addItem', alias);
      const created = await identitySet(jmap, {
        create: {
          c504: {
            name: 'C504 unsigned identity',
            email: alias,
          },
        },
      });
      aliasIdentityId = created.created?.c504?.id ?? null;
      expect(aliasIdentityId, `unsigned identity creation should succeed: ${JSON.stringify(created)}`)
        .toBeTruthy();

      const updated = await identitySet(jmap, {
        update: {
          [primary.id]: {
            htmlSignature: richSignature,
            textSignature: signatureText,
          },
        },
      });
      expect(updated.notUpdated?.[primary.id]).toBeUndefined();
      primaryChanged = true;
      await refreshIdentityCache(page);

      await page.keyboard.press('ControlOrMeta+n');
      let composer = page.locator('.compose-dialog--expanded');
      await expect(composer).toBeVisible();
      await waitForIdentities(page);
      await chooseFrom(composer, STACK_STALWART_PRINCIPAL);
      await discardCompose(page);

      await page.keyboard.press('ControlOrMeta+n');
      composer = page.locator('.compose-dialog--expanded');
      await expect(composer).toBeVisible();
      const picker = composer.locator('[data-compose-from] summary');
      await expect(picker).toContainText(STACK_STALWART_PRINCIPAL);
      const editor = composer.locator('.editor[contenteditable]').first();
      const origin = editor.locator('[data-stormbox-origin="identity-signature"]');
      await expect(origin).toHaveCount(1);
      await expect(origin).toContainText(signatureText);
      await expect(origin.locator('strong, b')).toContainText('rich');
      const initialChildren = await editor.evaluate((element) =>
        Array.from(element.children, (child) => ({
          html: child.innerHTML,
          origin: child.getAttribute('data-stormbox-origin'),
        })));
      expect(initialChildren[0]?.origin).toBeNull();
      expect(initialChildren[0]?.html.toLowerCase()).toContain('<br');
      expect(initialChildren[1]?.origin).toBe('identity-signature');

      await placeCaretBesideOrigin(editor, 'before');
      await page.keyboard.type('Before tracked signature. ');
      await expect(origin).not.toHaveAttribute('data-stormbox-origin-touched', 'true');
      await placeCaretBesideOrigin(editor, 'after');
      await page.keyboard.type(' After tracked signature.');
      await expect(origin).toHaveCount(1);
      await expect(origin).not.toHaveAttribute('data-stormbox-origin-touched', 'true');
      expect(await origin.evaluate((element) => getComputedStyle(element).display)).toBe('block');

      await chooseFrom(composer, alias);
      await expect(origin).toHaveCount(0);
      await expect(editor).toContainText('Before tracked signature.');
      await expect(editor).toContainText('After tracked signature.');
      await expect(editor).not.toContainText(signatureText);

      await chooseFrom(composer, STACK_STALWART_PRINCIPAL);
      await expect(origin).toHaveCount(1);
      await expect(origin.locator('strong, b')).toContainText('rich');
      await expect(editor).toContainText('Before tracked signature.');
      await expect(editor).toContainText('After tracked signature.');
      await discardCompose(page);

      await page.getByRole('button', { name: 'Contacts', exact: true }).click();
      await expect(page.locator('.contacts')).toBeVisible();
      virtualContactsAdded = true;
      await addVirtualContacts(page);
      await verifyDirectoryViewport(page, 1440, 'desktop');
      await verifyDirectoryViewport(page, 900, 'tablet');

      await page.getByRole('button', { name: 'Manage identities' }).click();
      await verifyIdentityEditorWidth(page, 737);
      await verifyIdentityEditorWidth(page, 390);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      if (await page.locator('.compose-dialog--expanded').count()) {
        await discardCompose(page).catch(() => {});
      }
      if (virtualContactsAdded) await removeVirtualContacts(page).catch(() => {});
      if (primaryChanged) {
        await identitySet(jmap, {
          update: { [primary.id]: originalSignature },
        }).catch(() => {});
      }
      if (aliasIdentityId) {
        await identitySet(jmap, { destroy: [aliasIdentityId] }).catch(() => {});
      }
      await patchPrincipalEmails('removeItem', alias).catch(() => {});
      await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
    }
  });
});
