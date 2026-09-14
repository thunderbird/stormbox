import { describe, expect, it } from 'vitest';

import {
  compileRules,
  isManagedRulesScript,
  MANAGED_SCRIPT_MARKER,
  parseManagedRules,
  parseVisualRules,
  RuleValidationError,
  uniqueManagedScriptName,
} from '../../../src/sieve/rules';
import type { MailRuleDocument, SieveRuleCapabilities } from '../../../src/sieve/rules';

const ALL_CAPABILITIES: SieveRuleCapabilities = {
  sieveExtensions: ['copy', 'fileinto', 'imap4flags', 'mailbox', 'mailboxid'],
  maxSizeScript: 100_000,
  maxNumberRedirects: 4,
};

function document(): MailRuleDocument {
  return {
    version: 2,
    rules: [{
      id: 'rule-1',
      name: 'File important mail',
      enabled: true,
      match: 'all',
      conditions: [
        {
          id: 'condition-1', type: 'condition', negated: false,
          field: 'from', operator: 'contains', value: '@example.com',
        },
        {
          id: 'condition-2', type: 'condition', negated: false,
          field: 'subject', operator: 'matches', value: '*invoice*',
        },
      ],
      actions: [
        {
          id: 'action-1', type: 'move', mailboxId: 'mailbox-42', mailboxName: 'Finance/Invoices',
        },
        { id: 'action-2', type: 'markRead' },
        { id: 'action-3', type: 'star' },
        { id: 'action-4', type: 'redirect', address: 'archive@example.net' },
      ],
      stopProcessing: true,
    }],
  };
}

describe('mail-rule Sieve compiler', () => {
  it('emits a capability-aware script and round-trips the visual model', () => {
    const input = document();
    const source = compileRules(input, ALL_CAPABILITIES);

    expect(source).toContain(MANAGED_SCRIPT_MARKER);
    expect(source).toContain('require ["copy", "fileinto", "imap4flags", "mailbox", "mailboxid"];');
    expect(source).toContain('if allof (address :contains "From" "@example.com", header :matches "Subject" "*invoice*") {');
    expect(source).toContain('fileinto :mailboxid "mailbox-42" "Finance/Invoices";');
    expect(source).toContain('addflag "\\\\Seen";');
    expect(source).toContain('addflag "\\\\Flagged";');
    expect(source).toContain('redirect :copy "archive@example.net";');
    expect(source).toContain('  stop;');
    expect(isManagedRulesScript(source)).toBe(true);
    expect(withoutIds(parseManagedRules(source))).toEqual(withoutIds(input));
  });

  it('escapes user strings and round-trips disabled rules through a false branch', () => {
    const input = document();
    input.rules[0].conditions = [{
      id: 'condition-escape',
      type: 'condition',
      negated: false,
      field: 'subject',
      operator: 'contains',
      value: 'say "hi" \\ there',
    }];
    input.rules.push({
      id: 'rule-disabled',
      name: 'Disabled executable marker',
      enabled: false,
      match: 'all',
      conditions: [{
        id: 'condition-disabled', type: 'condition', negated: false,
        field: 'subject', operator: 'is', value: 'DO-NOT-EMIT',
      }],
      actions: [{ id: 'action-disabled', type: 'discard' }],
      stopProcessing: true,
    });

    const source = compileRules(input, ALL_CAPABILITIES);
    expect(source).toContain('header :contains "Subject" "say \\"hi\\" \\\\ there"');
    expect(source).toContain('# Disabled rule: Disabled executable marker');
    expect(withoutIds(parseManagedRules(source))).toEqual(withoutIds(input));
  });

  it('uses a path-only fallback when mailboxid is unavailable', () => {
    const source = compileRules(document(), {
      ...ALL_CAPABILITIES,
      sieveExtensions: ['copy', 'fileinto', 'imap4flags'],
    });
    expect(source).toContain('fileinto "Finance/Invoices";');
    expect(source).not.toContain(':mailboxid');
  });

  it('declares Stalwart’s advertised mailbox compatibility capability for mailboxid', () => {
    const input = document();
    input.rules[0].actions = [input.rules[0].actions[0]];

    const source = compileRules(input, {
      ...ALL_CAPABILITIES,
      sieveExtensions: ['fileinto', 'mailbox', 'mailboxid'],
    });
    expect(source).toContain('require ["fileinto", "mailbox", "mailboxid"];');

    const standardsOnlySource = compileRules(input, {
      ...ALL_CAPABILITIES,
      sieveExtensions: ['fileinto', 'mailboxid'],
    });
    expect(standardsOnlySource).toContain('require ["fileinto", "mailboxid"];');
    expect(standardsOnlySource).not.toContain('"mailbox",');
  });

  it('rejects missing action extensions, invalid headers, and oversized scripts', () => {
    expect(() => compileRules(document(), { sieveExtensions: [] }))
      .toThrow(/fileinto/);

    const invalidHeader = document();
    invalidHeader.rules[0].conditions = [{
      id: 'condition-header',
      type: 'condition',
      negated: false,
      field: 'header',
      headerName: 'Bad:Header',
      operator: 'contains',
      value: 'x',
    }];
    expect(() => compileRules(invalidHeader, ALL_CAPABILITIES))
      .toThrow(RuleValidationError);

    expect(() => compileRules(document(), {
      ...ALL_CAPABILITIES,
      maxSizeScript: 10,
    })).toThrow(/server limit is 10/);
  });

  it('checks redirect limits along executable paths', () => {
    const input = document();
    input.rules[0].actions = [{
      id: 'redirect-1', type: 'redirect', address: 'one@example.net',
    }];
    input.rules.push({
      id: 'rule-2',
      name: 'Second redirect',
      enabled: true,
      match: 'all',
      conditions: [{
        id: 'condition-2a', type: 'condition', negated: false,
        field: 'subject', operator: 'contains', value: 'two',
      }],
      actions: [{ id: 'redirect-2', type: 'redirect', address: 'two@example.net' }],
      stopProcessing: false,
    });

    expect(() => compileRules(input, { ...ALL_CAPABILITIES, maxNumberRedirects: 1 }))
      .not.toThrow();

    input.rules[0].stopProcessing = false;
    expect(() => compileRules(input, { ...ALL_CAPABILITIES, maxNumberRedirects: 1 }))
      .toThrow(/can redirect 2 messages/);
  });

  it('rejects corrupt managed metadata without claiming foreign scripts', () => {
    expect(parseManagedRules('require ["fileinto"];\r\nkeep;')).toBeNull();
    expect(() => parseManagedRules('# stormbox-managed: mail-rules/v1\r\n# stormbox-data: !!!'))
      .toThrow(/metadata is missing or malformed/);
  });

  it('migrates version 1 managed metadata to the source-backed model', () => {
    const legacy = {
      version: 1,
      rules: [
        {
          id: 'legacy-rule',
          name: 'Legacy receipts',
          enabled: true,
          match: 'all',
          conditions: [{
            id: 'legacy-condition', field: 'subject', operator: 'contains', value: 'Receipt',
          }],
          actions: [{ id: 'legacy-action', type: 'markRead' }],
          stopProcessing: true,
        },
        {
          id: 'legacy-disabled',
          name: 'Disabled legacy rule',
          enabled: false,
          match: 'all',
          conditions: [{
            id: 'legacy-disabled-condition', field: 'from', operator: 'is', value: 'later@example.com',
          }],
          actions: [{ id: 'legacy-disabled-action', type: 'discard' }],
          stopProcessing: true,
        },
      ],
    };
    const encoded = Buffer.from(JSON.stringify(legacy)).toString('base64url');
    const matchingSource = [
      '# Stormbox managed mail rules. Edit these rules in Stormbox.',
      '# stormbox-managed: mail-rules/v1',
      `# stormbox-data: ${encoded}`,
      'require ["imap4flags"];',
      '# Rule: Legacy receipts',
      'if header :contains "Subject" "Receipt" {',
      '  addflag "\\\\Seen";',
      '  stop;',
      '}',
      '',
    ].join('\r\n');
    const parsed = parseManagedRules(matchingSource);

    expect(parsed).toMatchObject({
      version: 2,
      rules: [
        {
          name: 'Legacy receipts',
          conditions: [{ type: 'condition', negated: false, value: 'Receipt' }],
        },
        { name: 'Disabled legacy rule', enabled: false },
      ],
    });

    expect(() => parseManagedRules(matchingSource.replace(
      '  addflag "\\\\Seen";',
      '  discard;',
    ))).toThrow(/metadata differs from its executable Sieve/);
  });

  it('keeps executable path-only folder routing authoritative during version 1 migration', () => {
    const legacy = {
      version: 1,
      rules: [{
        id: 'legacy-rule',
        name: 'Archive receipts',
        enabled: true,
        match: 'all',
        conditions: [{
          id: 'legacy-condition', field: 'subject', operator: 'contains', value: 'Receipt',
        }],
        actions: [{
          id: 'legacy-action', type: 'move', mailboxId: 'mailbox-archive', mailboxName: 'Archive',
        }],
        stopProcessing: true,
      }],
    };
    const encoded = Buffer.from(JSON.stringify(legacy)).toString('base64url');
    const parsed = parseManagedRules([
      '# Stormbox managed mail rules. Edit these rules in Stormbox.',
      '# stormbox-managed: mail-rules/v1',
      `# stormbox-data: ${encoded}`,
      'require ["fileinto"];',
      '# Rule: Archive receipts',
      'if header :contains "Subject" "Receipt" {',
      '  fileinto "Archive";',
      '  stop;',
      '}',
      '',
    ].join('\r\n'));

    expect(parsed?.rules[0].actions[0]).toMatchObject({
      type: 'move', mailboxId: '', mailboxName: 'Archive',
    });
    const compiled = compileRules(parsed, ALL_CAPABILITIES);
    expect(compiled).toContain('fileinto "Archive";');
    expect(compiled).not.toContain(':mailboxid');
  });

  it('parses a compatible existing script and nested Boolean groups from source', () => {
    const source = [
      'require ["imap4flags"];',
      '# Rule: Priority project mail',
      'if allof (anyof (address :is "From" "lead@example.com", header :contains "Subject" "Project"), not header :contains "X-Spam" "yes") {',
      '  addflag "\\\\Flagged";',
      '  stop;',
      '}',
      '',
    ].join('\r\n');

    const parsed = parseVisualRules(source);
    expect(parsed.rules[0]).toMatchObject({
      name: 'Priority project mail',
      match: 'all',
      conditions: [
        {
          type: 'group',
          match: 'any',
          negated: false,
          conditions: [
            { type: 'condition', field: 'from', operator: 'is', value: 'lead@example.com' },
            { type: 'condition', field: 'subject', operator: 'contains', value: 'Project' },
          ],
        },
        {
          type: 'condition', field: 'header', headerName: 'X-Spam',
          operator: 'contains', value: 'yes', negated: true,
        },
      ],
      actions: [{ type: 'star' }],
      stopProcessing: true,
    });
    expect(compileRules(parsed, ALL_CAPABILITIES))
      .toContain('allof (anyof (address :is "From" "lead@example.com", header :contains "Subject" "Project"), not header :contains "X-Spam" "yes")');
  });

  it('accepts implicit and explicit default match arguments', () => {
    const source = [
      'require ["imap4flags"];',
      'if allof (',
      '  header "Subject" "Status",',
      '  address :comparator "i;ascii-casemap" :all :contains "From" "@example.com"',
      ') {',
      '  addflag "\\\\Seen";',
      '}',
      '',
    ].join('\r\n');

    expect(parseVisualRules(source).rules[0].conditions).toMatchObject([
      { type: 'condition', field: 'subject', operator: 'is', value: 'Status' },
      { type: 'condition', field: 'from', operator: 'contains', value: '@example.com' },
    ]);
  });

  it('preserves significant whitespace in source-derived match values', () => {
    const parsed = parseVisualRules([
      'if header :is "Subject" " urgent " {',
      '  discard;',
      '}',
      '',
    ].join('\r\n'));

    expect(parsed.rules[0].conditions[0]).toMatchObject({ value: ' urgent ' });
    expect(compileRules(parsed, ALL_CAPABILITIES)).toContain('"Subject" " urgent "');
  });

  it('rejects required extensions that can change otherwise representable source semantics', () => {
    expect(() => parseVisualRules([
      'require ["encoded-character"];',
      'if header :is "Subject" "${hex:41}" {',
      '  discard;',
      '}',
      '',
    ].join('\r\n'))).toThrow(/encoded-character.+not safe to rewrite visually/);
  });

  it('chooses a non-conflicting managed script name', () => {
    expect(uniqueManagedScriptName(['Personal filters'])).toBe('Stormbox Mail Rules');
    expect(uniqueManagedScriptName(['Stormbox Mail Rules', 'Stormbox Mail Rules 2']))
      .toBe('Stormbox Mail Rules 3');
  });
});

function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'id')
    .map(([key, item]) => [key, withoutIds(item)]));
}
