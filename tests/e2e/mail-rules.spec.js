import {
  connectJmap,
  downloadBlob,
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
  localStackEnabled,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import { waitForPendingMutations } from './helpers/ui.js';

test.skip(!localStackEnabled, skipLocalStackMessage);

const CORE = 'urn:ietf:params:jmap:core';
const SIEVE = 'urn:ietf:params:jmap:sieve';
const MANAGED_MARKER = '# stormbox-managed: mail-rules/v2';
const RULE_NAME = 'MailRulesE2E visual rule';
const CONDITION_VALUE = 'MailRulesE2E';

async function sieveRequest(jmap, calls) {
  return jmapRequest(jmap, calls, [CORE, SIEVE]);
}

async function listScripts(jmap) {
  const payload = await sieveRequest(jmap, [[
    'SieveScript/get',
    {
      accountId: jmap.accountId,
      ids: null,
      properties: ['id', 'name', 'blobId', 'isActive'],
    },
    'getScripts',
  ]]);
  return pickResponse(payload, 'SieveScript/get')?.list ?? [];
}

async function restoreScripts(jmap, before) {
  const current = await listScripts(jmap);
  const beforeById = new Map(before.map((script) => [script.id, script]));
  const currentById = new Map(current.map((script) => [script.id, script]));
  const update = {};
  for (const script of before) {
    const live = currentById.get(script.id);
    if (live && live.blobId !== script.blobId) {
      update[script.id] = { blobId: script.blobId };
    }
  }
  const activeBefore = before.find((script) => script.isActive)?.id ?? null;
  await sieveRequest(jmap, [[
    'SieveScript/set',
    {
      accountId: jmap.accountId,
      ...(Object.keys(update).length > 0 ? { update } : {}),
      ...(activeBefore
        ? { onSuccessActivateScript: activeBefore }
        : { onSuccessDeactivateScript: true }),
    },
    'restoreScripts',
  ]]);

  const createdIds = current
    .map((script) => script.id)
    .filter((id) => !beforeById.has(id));
  if (createdIds.length > 0) {
    await sieveRequest(jmap, [[
      'SieveScript/set',
      {
        accountId: jmap.accountId,
        destroy: createdIds,
        ...(activeBefore
          ? { onSuccessActivateScript: activeBefore }
          : { onSuccessDeactivateScript: true }),
      },
      'removeCreatedScripts',
    ]]);
  }
}

async function openRulesDialog(page) {
  await page.locator('.account-menu__button').click();
  await page.getByRole('menuitem', { name: 'Mail Rules' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mail Rules' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog).not.toContainText('Loading server rules…', { timeout: 15_000 });
  return dialog;
}

test.describe('JMAP Sieve mail rules e2e', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage);
  });

  test('visual rule round-trips through the outbox and active server script', async ({ sharedPage: page }, testInfo) => {
    const jmap = await connectJmap();
    expect(jmap.session.capabilities?.[SIEVE]).toBeTruthy();
    expect(jmap.session.accounts?.[jmap.accountId]?.accountCapabilities?.[SIEVE]).toBeTruthy();
    const before = await listScripts(jmap);

    try {
      let dialog = await openRulesDialog(page);
      await expect(dialog).not.toContainText('server-side rules are unavailable');
      await dialog.locator('[data-mail-rules-add]').click();
      const rule = dialog.locator('.mail-rule').last();
      await rule.locator('input[aria-label="Rule name"]').fill(RULE_NAME);
      await rule.locator('input[aria-label="Condition value"]').fill(CONDITION_VALUE);
      await rule.getByRole('button', { name: 'Group' }).click();
      const nestedGroup = rule.locator('.condition-group--nested');
      await nestedGroup.locator('summary[aria-label="Nested condition match mode"]').click();
      await nestedGroup.locator('[data-rule-option="any"]').click();
      await nestedGroup.getByLabel('Condition value').fill('lead@example.com');
      await nestedGroup.getByRole('button', { name: 'Condition', exact: true }).click();
      await nestedGroup.getByLabel('Condition value').nth(1).fill('manager@example.com');
      await dialog.locator('[data-mail-rules-save]').click();

      await expect(dialog).toContainText('Rules saved, validated, and activated.', { timeout: 20_000 });
      await waitForPendingMutations(page);
      await expect.poll(
        async () => page.evaluate(async () => {
          const rows = await globalThis.__repo.call('db.query', {
            sql: `SELECT COUNT(*) AS count
                    FROM pending_mutations
                   WHERE mutation_type = 'setSieveRules'`,
            params: [],
          });
          return Number(rows?.[0]?.count ?? -1);
        }),
        { timeout: 10_000, message: 'Sieve mutation should leave no durable outbox row' },
      ).toBe(0);

      const scripts = await listScripts(jmap);
      const active = scripts.find((script) => script.isActive);
      expect(active).toBeTruthy();
      const source = (await downloadBlob(jmap, {
        blobId: active.blobId,
        type: 'application/sieve',
        name: 'mail-rules.siv',
      })).toString('utf8');
      expect(source).toContain(MANAGED_MARKER);
      expect(source).toContain(CONDITION_VALUE);
      expect(source).toContain('anyof (address :contains "From" "lead@example.com", address :contains "From" "manager@example.com")');

      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 5_000 });
      dialog = await openRulesDialog(page);
      const savedRule = dialog.locator('.mail-rule').last();
      await expect(savedRule.locator('input[aria-label="Rule name"]')).toHaveValue(RULE_NAME);
      await expect(savedRule.locator('input[aria-label="Condition value"]').first()).toHaveValue(CONDITION_VALUE);
      await expect(savedRule.locator('.condition-group--nested')).toHaveCount(1);
      await dialog.getByRole('button', { name: 'Source' }).click();
      await expect(dialog.getByRole('textbox', { name: 'Sieve source' }))
        .toHaveValue(new RegExp(CONDITION_VALUE));
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    } finally {
      await restoreScripts(jmap, before);
      await attachConsoleTail(testInfo, consoleLinesFor(page));
    }
  });
});
