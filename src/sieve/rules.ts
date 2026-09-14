import { parseSieve } from './parser';
import type {
  SieveCommand, SieveIfStatement, SieveStatement, SieveTest, SieveValue,
} from './parser';

export const SIEVE_CAPABILITY = 'urn:ietf:params:jmap:sieve';
export const MANAGED_SCRIPT_NAME = 'Stormbox Mail Rules';
export const MANAGED_SCRIPT_MARKER = '# stormbox-managed: mail-rules/v2';

const LEGACY_MANAGED_SCRIPT_MARKER = '# stormbox-managed: mail-rules/v1';
const DATA_PREFIX = '# stormbox-data: ';
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const MAX_TEST_DEPTH = 20;
const MAX_TEST_NODES = 500;
const VISUAL_REQUIRE_EXTENSIONS = new Set([
  'copy',
  'fileinto',
  'imap4flags',
  'mailbox',
  'mailboxid',
]);

export type RuleMatch = 'all' | 'any';
export type RuleField = 'from' | 'to' | 'toCc' | 'subject' | 'header';
export type RuleOperator = 'is' | 'contains' | 'matches';

export interface MailRuleCondition {
  id: string;
  type: 'condition';
  negated: boolean;
  field: RuleField;
  operator: RuleOperator;
  value: string;
  headerName?: string;
}

export interface MailRuleConditionGroup {
  id: string;
  type: 'group';
  negated: boolean;
  match: RuleMatch;
  conditions: MailRuleTest[];
}

export type MailRuleTest = MailRuleCondition | MailRuleConditionGroup;

export type MailRuleAction =
  | { id: string; type: 'move'; mailboxId: string; mailboxName: string }
  | { id: string; type: 'markRead' }
  | { id: string; type: 'star' }
  | { id: string; type: 'redirect'; address: string }
  | { id: string; type: 'discard' };

export interface MailRule {
  id: string;
  name: string;
  enabled: boolean;
  match: RuleMatch;
  conditions: MailRuleTest[];
  actions: MailRuleAction[];
  stopProcessing: boolean;
}

export interface MailRuleDocument {
  version: 2;
  rules: MailRule[];
}

export interface SieveRuleCapabilities {
  sieveExtensions: string[];
  maxSizeScript?: number | null;
  maxNumberRedirects?: number | null;
}

export interface CompileRulesOptions {
  managed?: boolean;
}

export class RuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleValidationError';
  }
}

export function emptyRuleDocument(): MailRuleDocument {
  return { version: 2, rules: [] };
}

export function newRuleId(prefix = 'rule'): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createEmptyRule(): MailRule {
  return {
    id: newRuleId(),
    name: 'New rule',
    enabled: true,
    match: 'all',
    conditions: [{
      id: newRuleId('condition'),
      type: 'condition',
      negated: false,
      field: 'from',
      operator: 'contains',
      value: '',
    }],
    actions: [{ id: newRuleId('action'), type: 'markRead' }],
    stopProcessing: true,
  };
}

export function cloneRuleDocument(document: MailRuleDocument): MailRuleDocument {
  return {
    version: 2,
    rules: document.rules.map((rule) => ({
      ...rule,
      conditions: rule.conditions.map(cloneRuleTest),
      actions: rule.actions.map((action) => ({ ...action })),
    })),
  };
}

function cloneRuleTest(test: MailRuleTest): MailRuleTest {
  if (test.type === 'condition') return { ...test };
  return { ...test, conditions: test.conditions.map(cloneRuleTest) };
}

export function normalizeRuleDocument(input: unknown): MailRuleDocument {
  if (
    !isRecord(input)
    || (input.version !== 1 && input.version !== 2)
    || !Array.isArray(input.rules)
  ) {
    throw new RuleValidationError('The managed rule data has an unsupported format.');
  }

  const seenRuleIds = new Set<string>();
  const rules = input.rules.map((value, ruleIndex) => {
    if (!isRecord(value)) {
      throw new RuleValidationError(`Rule ${ruleIndex + 1} is malformed.`);
    }
    const id = requiredId(value.id, `Rule ${ruleIndex + 1}`, seenRuleIds);
    const name = requiredText(value.name, `Rule ${ruleIndex + 1} needs a name.`);
    rejectControlCharacters(name, `Rule ${ruleIndex + 1} name`);
    const match = value.match === 'all' || value.match === 'any' ? value.match : null;
    if (!match) throw new RuleValidationError(`Rule “${name}” has an invalid match mode.`);
    if (!Array.isArray(value.conditions) || value.conditions.length === 0) {
      throw new RuleValidationError(`Rule “${name}” needs at least one condition.`);
    }
    if (!Array.isArray(value.actions) || value.actions.length === 0) {
      throw new RuleValidationError(`Rule “${name}” needs at least one action.`);
    }

    const testContext = { seenIds: new Set<string>(), nodes: 0 };
    const conditions = value.conditions.map((condition, conditionIndex) =>
      normalizeRuleTest(condition, name, `${conditionIndex + 1}`, testContext, 1));
    const seenActionIds = new Set<string>();
    const actions = value.actions.map((action, actionIndex) =>
      normalizeAction(action, name, actionIndex, seenActionIds));

    return {
      id,
      name,
      enabled: value.enabled !== false,
      match,
      conditions,
      actions,
      stopProcessing: value.stopProcessing === true,
    } satisfies MailRule;
  });

  return { version: 2, rules };
}

export function isManagedRulesScript(script: string): boolean {
  return script.split(/\r?\n/).some((line) => {
    const value = line.trimEnd();
    return value === MANAGED_SCRIPT_MARKER || value === LEGACY_MANAGED_SCRIPT_MARKER;
  });
}

/**
 * Return null for an unmarked script. Version 2 is reconstructed from
 * executable source; version 1 metadata is retained as a migration path.
 */
export function parseManagedRules(script: string): MailRuleDocument | null {
  if (!isManagedRulesScript(script)) return null;
  if (script.split(/\r?\n/).some((line) => line.trimEnd() === MANAGED_SCRIPT_MARKER)) {
    return parseVisualRules(script);
  }
  const chunks = script
    .split(/\r?\n/)
    .filter((line) => line.startsWith(DATA_PREFIX))
    .map((line) => line.slice(DATA_PREFIX.length).trim());
  if (chunks.length === 0 || chunks.some((chunk) => !/^[A-Za-z0-9_-]+$/.test(chunk))) {
    throw new RuleValidationError('The Stormbox rule metadata is missing or malformed.');
  }
  let legacyDocument: MailRuleDocument;
  try {
    const json = new TextDecoder().decode(decodeBase64Url(chunks.join('')));
    legacyDocument = normalizeRuleDocument(JSON.parse(json));
  } catch (error) {
    if (error instanceof RuleValidationError) throw error;
    throw new RuleValidationError('The Stormbox rule metadata could not be decoded.');
  }

  const executableDocument = parseVisualRules(script);
  const enabledLegacyDocument: MailRuleDocument = {
    version: 2,
    rules: legacyDocument.rules.filter((rule) => rule.enabled),
  };
  if (!sameRuleSemantics(enabledLegacyDocument, executableDocument)) {
    throw new RuleValidationError(
      'The legacy Stormbox metadata differs from its executable Sieve. Preserve the script and resolve the mismatch before saving.',
    );
  }
  let executableIndex = 0;
  return normalizeRuleDocument({
    version: 2,
    rules: legacyDocument.rules.map((rule) => (
      rule.enabled ? executableDocument.rules[executableIndex++] : rule
    )),
  });
}

/** Parse any script that can be represented without changing its executable semantics. */
export function parseRulesSource(script: string): MailRuleDocument {
  if (!isManagedRulesScript(script)) return parseVisualRules(script);
  const document = parseManagedRules(script);
  if (!document) {
    throw new RuleValidationError('The Stormbox-managed script could not be read.');
  }
  return document;
}

export function parseVisualRules(script: string): MailRuleDocument {
  const parsed = parseSieve(script);
  for (const statement of parsed.statements) {
    if (statement.type !== 'command' || statement.name !== 'require') continue;
    if (statement.arguments.length !== 1) {
      throw notVisualizable(script, statement, 'The require command is malformed');
    }
    const extensions = stringValues(statement.arguments[0]);
    const unsupported = extensions.find((extension) =>
      !VISUAL_REQUIRE_EXTENSIONS.has(extension.toLowerCase()));
    if (extensions.length === 0 || unsupported) {
      throw notVisualizable(
        script,
        statement,
        `Required extension “${unsupported ?? 'unknown'}” is not safe to rewrite visually`,
      );
    }
  }
  const rules: MailRule[] = [];
  const statements = parsed.statements.filter((statement) =>
    statement.type !== 'command' || statement.name !== 'require');

  if (
    statements.length === 1
    && statements[0].type === 'command'
    && statements[0].name === 'keep'
    && statements[0].arguments.length === 0
  ) return emptyRuleDocument();

  for (const statement of statements) {
    if (statement.type !== 'if') {
      throw notVisualizable(script, statement, `Top-level “${statement.name}” is not represented by the visual editor`);
    }
    rules.push(ruleFromIf(script, statement, rules.length));
  }

  return normalizeRuleDocument({ version: 2, rules });
}

function ruleFromIf(source: string, statement: SieveIfStatement, index: number): MailRule {
  let visualStatement = statement;
  let enabled = true;
  if (isFalseTest(statement.branches[0]?.test)) {
    const commands = statement.branches[0]?.commands ?? [];
    if (
      statement.branches.length !== 1
      || statement.elseCommands
      || commands.length !== 1
      || commands[0].type !== 'if'
    ) {
      throw notVisualizable(source, statement, 'This false branch is not a generated disabled rule');
    }
    enabled = false;
    visualStatement = commands[0];
  }

  if (visualStatement.branches.length !== 1 || visualStatement.elseCommands) {
    throw notVisualizable(source, visualStatement, 'elsif and else branches are not represented yet');
  }

  const root = testFromSieve(source, visualStatement.branches[0].test);
  const { actions, stopProcessing } = actionsFromCommands(
    source,
    visualStatement.branches[0].commands,
  );
  const label = ruleLabel(statement.comments, index, enabled);
  return {
    id: newRuleId(),
    name: label,
    enabled,
    match: root.type === 'group' && !root.negated ? root.match : 'all',
    conditions: root.type === 'group' && !root.negated ? root.conditions : [root],
    actions,
    stopProcessing,
  };
}

function testFromSieve(source: string, test: SieveTest): MailRuleTest {
  if (test.type === 'not') {
    const visual = testFromSieve(source, test.test);
    visual.negated = !visual.negated;
    return visual;
  }
  if (test.type === 'allof' || test.type === 'anyof') {
    return {
      id: newRuleId('group'),
      type: 'group',
      negated: false,
      match: test.type === 'allof' ? 'all' : 'any',
      conditions: test.tests.map((child) => testFromSieve(source, child)),
    };
  }
  if (test.type !== 'call') {
    throw notVisualizable(source, test, `Test “${test.type}” is not represented by the visual editor`);
  }

  if (!['address', 'header'].includes(test.name)) {
    throw notVisualizable(source, test, `Test “${test.name}” is not represented by the visual editor`);
  }
  const { operator, positional } = visualMatchArguments(source, test);

  const headers = stringValues(positional[0]);
  const values = stringValues(positional[1]);
  if (headers.length === 0 || values.length === 0) {
    throw notVisualizable(source, test, `Test “${test.name}” has unsupported header or value lists`);
  }
  const normalizedHeaders = headers.map((header) => header.toLowerCase());
  let targets: Array<{ field: RuleField; headerName?: string }>;
  if (
    test.name === 'address'
    && normalizedHeaders.length === 2
    && normalizedHeaders.includes('to')
    && normalizedHeaders.includes('cc')
  ) {
    targets = [{ field: 'toCc' }];
  } else if (test.name === 'address' && normalizedHeaders.every((header) => ['from', 'to'].includes(header))) {
    targets = normalizedHeaders.map((header) => ({ field: header as 'from' | 'to' }));
  } else if (test.name === 'header') {
    targets = headers.map((header, index) => (
      normalizedHeaders[index] === 'subject'
        ? { field: 'subject' }
        : { field: 'header', headerName: header }
    ));
  } else {
    throw notVisualizable(source, test, `Test “${test.name}” targets headers the visual editor cannot combine`);
  }

  const conditions = targets.flatMap((target) => values.map<MailRuleCondition>((value) => ({
    id: newRuleId('condition'),
    type: 'condition',
    negated: false,
    field: target.field,
    operator,
    value,
    ...(target.headerName ? { headerName: target.headerName } : {}),
  })));
  if (conditions.length === 1) return conditions[0];
  return {
    id: newRuleId('group'),
    type: 'group',
    negated: false,
    match: 'any',
    conditions,
  };
}

function visualMatchArguments(
  source: string,
  test: Extract<SieveTest, { type: 'call' }>,
): { operator: RuleOperator; positional: SieveValue[] } {
  let operator: RuleOperator = 'is';
  let matchTypeSeen = false;
  let comparatorSeen = false;
  let addressPartSeen = false;
  let index = 0;

  while (true) {
    const argument = test.arguments[index];
    if (argument?.type !== 'tag') break;
    const tag = argument.value;
    if ([':is', ':contains', ':matches'].includes(tag)) {
      if (matchTypeSeen) {
        throw notVisualizable(source, test, `Test “${test.name}” has more than one match type`);
      }
      matchTypeSeen = true;
      operator = tag.slice(1) as RuleOperator;
      index += 1;
      continue;
    }
    if (tag === ':comparator') {
      const comparator = test.arguments[index + 1];
      if (
        comparatorSeen
        || comparator?.type !== 'string'
        || comparator.value.toLowerCase() !== 'i;ascii-casemap'
      ) {
        throw notVisualizable(source, test, `Test “${test.name}” uses an unsupported comparator`);
      }
      comparatorSeen = true;
      index += 2;
      continue;
    }
    if (test.name === 'address' && tag === ':all') {
      if (addressPartSeen) {
        throw notVisualizable(source, test, 'The address test has more than one address part');
      }
      addressPartSeen = true;
      index += 1;
      continue;
    }
    throw notVisualizable(source, test, `Test “${test.name}” uses unsupported match arguments`);
  }

  const positional = test.arguments.slice(index);
  if (positional.length !== 2 || positional.some((value) => value.type === 'tag')) {
    throw notVisualizable(source, test, `Test “${test.name}” uses unsupported match arguments`);
  }
  return { operator, positional };
}

function actionsFromCommands(
  source: string,
  commands: SieveStatement[],
): { actions: MailRuleAction[]; stopProcessing: boolean } {
  const actions: MailRuleAction[] = [];
  let stopProcessing = false;
  commands.forEach((command, index) => {
    if (command.type !== 'command') {
      throw notVisualizable(source, command, 'Nested control blocks are not represented as rule actions');
    }
    if (command.name === 'stop') {
      if (command.arguments.length > 0 || index !== commands.length - 1) {
        throw notVisualizable(source, command, 'stop must be the final action in a visual rule');
      }
      stopProcessing = true;
      return;
    }
    actions.push(...actionsFromCommand(source, command));
  });
  if (actions.length === 0) {
    throw notVisualizable(source, commands[0], 'A visual rule needs at least one supported action');
  }
  return { actions, stopProcessing };
}

function actionsFromCommand(source: string, command: SieveCommand): MailRuleAction[] {
  const tags = command.arguments.filter((value) => value.type === 'tag').map((value) => value.value);
  const positional = command.arguments.filter((value) => value.type !== 'tag');
  if (command.name === 'discard' && tags.length === 0 && positional.length === 0) {
    return [{ id: newRuleId('action'), type: 'discard' }];
  }
  if (command.name === 'fileinto' && tags.every((tag) => tag === ':mailboxid')) {
    const strings = positional.flatMap(stringValues);
    if (tags.length === 0 && strings.length === 1) {
      return [{
        id: newRuleId('action'), type: 'move', mailboxId: '', mailboxName: strings[0],
      }];
    }
    if (tags.length === 1 && strings.length === 2) {
      return [{
        id: newRuleId('action'), type: 'move', mailboxId: strings[0], mailboxName: strings[1],
      }];
    }
  }
  if (command.name === 'addflag' && tags.length === 0 && positional.length === 1) {
    const flags = stringValues(positional[0]);
    if (flags.length > 0 && flags.every((flag) => ['\\seen', '\\flagged'].includes(flag.toLowerCase()))) {
      return flags.map<MailRuleAction>((flag) => ({
        id: newRuleId('action'),
        type: flag.toLowerCase() === '\\seen' ? 'markRead' : 'star',
      }));
    }
  }
  if (command.name === 'redirect' && tags.length === 1 && tags[0] === ':copy' && positional.length === 1) {
    const addresses = stringValues(positional[0]);
    if (addresses.length === 1) {
      return [{ id: newRuleId('action'), type: 'redirect', address: addresses[0] }];
    }
  }
  throw notVisualizable(source, command, `Action “${command.name}” is not represented by the visual editor`);
}

function stringValues(value: SieveValue): string[] {
  if (value.type === 'string') return [value.value];
  if (value.type === 'stringList') return value.values;
  return [];
}

function isFalseTest(test: SieveTest | undefined): boolean {
  return test?.type === 'call' && test.name === 'false' && test.arguments.length === 0;
}

function ruleLabel(comments: string[], index: number, enabled: boolean): string {
  const prefixes = enabled ? [/^Rule:\s*(.+)$/i] : [/^Disabled rule:\s*(.+)$/i, /^Rule:\s*(.+)$/i];
  for (const comment of [...comments].reverse()) {
    for (const pattern of prefixes) {
      const match = comment.match(pattern);
      if (match?.[1]?.trim()) return match[1].trim();
    }
  }
  return `Rule ${index + 1}`;
}

function notVisualizable(
  source: string,
  node: { range: { start: number } } | undefined,
  message: string,
): RuleValidationError {
  const offset = node?.range.start ?? 0;
  const before = source.slice(0, offset);
  const line = before.split(/\r\n|\r|\n/).length;
  return new RuleValidationError(`${message} at line ${line}.`);
}

export function compileRules(
  input: unknown,
  capabilities: SieveRuleCapabilities,
  { managed = true }: CompileRulesOptions = {},
): string {
  const document = normalizeRuleDocument(input);
  validateRedirectBudget(document, capabilities.maxNumberRedirects);
  const extensions = new Set(capabilities.sieveExtensions ?? []);
  const required = new Set<string>();
  const blocks: string[] = [];

  for (const rule of document.rules) {
    const test = compileRuleTest(rule);
    const actionLines = rule.actions.map((action) =>
      `  ${compileAction(action, extensions, required)}`);
    if (rule.stopProcessing) actionLines.push('  stop;');
    const label = rule.name.replace(/[\r\n]+/g, ' ').trim();
    const ruleBlock = [`if ${test} {`, ...actionLines, '}'];
    if (rule.enabled) {
      blocks.push([`# Rule: ${label}`, ...ruleBlock].join('\r\n'));
    } else {
      blocks.push([
        `# Disabled rule: ${label}`,
        'if false {',
        ...ruleBlock.map((line) => `  ${line}`),
        '}',
      ].join('\r\n'));
    }
  }

  const lines = [
    '# Stormbox-compatible mail rules. The Sieve source is authoritative.',
    ...(managed ? [MANAGED_SCRIPT_MARKER] : []),
    '',
  ];
  if (required.size > 0) {
    lines.push(`require [${[...required].sort().map(sieveString).join(', ')}];`, '');
  }
  if (blocks.length > 0) {
    lines.push(blocks.join('\r\n\r\n'));
  } else {
    lines.push('# No enabled rules.', 'keep;');
  }
  lines.push('', '# End Stormbox managed mail rules.', '');
  const script = lines.join('\r\n');
  const maxSize = capabilities.maxSizeScript;
  if (typeof maxSize === 'number' && maxSize >= 0) {
    const size = new TextEncoder().encode(script).byteLength;
    if (size > maxSize) {
      throw new RuleValidationError(`The generated script is ${size} bytes; the server limit is ${maxSize}.`);
    }
  }
  return script;
}

function validateRedirectBudget(document: MailRuleDocument, limit: number | null | undefined): void {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) return;

  let redirectsOnContinuingPath = 0;
  let maximumRedirects = 0;
  for (const rule of document.rules) {
    if (!rule.enabled) continue;
    const redirectsInRule = rule.actions.filter((action) => action.type === 'redirect').length;
    maximumRedirects = Math.max(maximumRedirects, redirectsOnContinuingPath + redirectsInRule);
    // A matching stop rule terminates that path. Only the non-matching
    // path can reach later rules, so its redirects do not accumulate.
    if (!rule.stopProcessing) redirectsOnContinuingPath += redirectsInRule;
  }

  if (maximumRedirects > limit) {
    throw new RuleValidationError(
      `The rules can redirect ${maximumRedirects} messages in one evaluation; the server limit is ${limit}.`,
    );
  }
}

export function uniqueManagedScriptName(existingNames: Iterable<string | null | undefined>): string {
  const names = new Set([...existingNames].filter((name): name is string => Boolean(name)));
  if (!names.has(MANAGED_SCRIPT_NAME)) return MANAGED_SCRIPT_NAME;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${MANAGED_SCRIPT_NAME} ${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new RuleValidationError('Could not choose a unique managed script name.');
}

function normalizeRuleTest(
  input: unknown,
  ruleName: string,
  path: string,
  context: { seenIds: Set<string>; nodes: number },
  depth: number,
): MailRuleTest {
  if (!isRecord(input)) {
    throw new RuleValidationError(`Condition ${path} in “${ruleName}” is malformed.`);
  }
  context.nodes += 1;
  if (context.nodes > MAX_TEST_NODES) {
    throw new RuleValidationError(`Rule “${ruleName}” has more than ${MAX_TEST_NODES} conditions and groups.`);
  }
  if (depth > MAX_TEST_DEPTH) {
    throw new RuleValidationError(`Rule “${ruleName}” has condition groups nested more than ${MAX_TEST_DEPTH} levels.`);
  }

  if (input.type === 'group') {
    const id = requiredId(input.id, `Condition group ${path} in “${ruleName}”`, context.seenIds);
    const match = input.match === 'all' || input.match === 'any' ? input.match : null;
    if (!match || !Array.isArray(input.conditions) || input.conditions.length === 0) {
      throw new RuleValidationError(`Condition group ${path} in “${ruleName}” is malformed.`);
    }
    return {
      id,
      type: 'group',
      negated: input.negated === true,
      match,
      conditions: input.conditions.map((condition, index) =>
        normalizeRuleTest(condition, ruleName, `${path}.${index + 1}`, context, depth + 1)),
    };
  }

  const field = ['from', 'to', 'toCc', 'subject', 'header'].includes(String(input.field))
    ? input.field as RuleField
    : null;
  const operator = ['is', 'contains', 'matches'].includes(String(input.operator))
    ? input.operator as RuleOperator
    : null;
  if (!field || !operator) {
    throw new RuleValidationError(`Condition ${path} in “${ruleName}” is not supported.`);
  }
  const value = requiredSieveText(
    input.value,
    `Condition ${path} in “${ruleName}” needs a value.`,
  );
  rejectControlCharacters(value, `Condition ${path} in “${ruleName}”`);
  const condition: MailRuleCondition = {
    id: requiredId(input.id, `Condition ${path} in “${ruleName}”`, context.seenIds),
    type: 'condition',
    negated: input.negated === true,
    field,
    operator,
    value,
  };
  if (field === 'header') {
    const headerName = requiredSieveText(
      input.headerName,
      `Custom header condition ${path} in “${ruleName}” needs a header name.`,
    );
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(headerName)) {
      throw new RuleValidationError(`“${headerName}” is not a valid header field name.`);
    }
    condition.headerName = headerName;
  }
  return condition;
}

function normalizeAction(
  input: unknown,
  ruleName: string,
  index: number,
  seenIds: Set<string>,
): MailRuleAction {
  if (!isRecord(input)) {
    throw new RuleValidationError(`Action ${index + 1} in “${ruleName}” is malformed.`);
  }
  const id = requiredId(input.id, `Action ${index + 1} in “${ruleName}”`, seenIds);
  switch (input.type) {
    case 'move': {
      const mailboxId = typeof input.mailboxId === 'string' ? input.mailboxId : '';
      const mailboxName = requiredSieveText(
        input.mailboxName,
        `Move action ${index + 1} in “${ruleName}” needs a folder fallback name.`,
      );
      rejectControlCharacters(mailboxId, `Move action ${index + 1} in “${ruleName}”`);
      rejectControlCharacters(mailboxName, `Move action ${index + 1} in “${ruleName}”`);
      return { id, type: 'move', mailboxId, mailboxName };
    }
    case 'redirect': {
      const address = requiredSieveText(
        input.address,
        `Forward action ${index + 1} in “${ruleName}” needs an email address.`,
      );
      rejectControlCharacters(address, `Forward action ${index + 1} in “${ruleName}”`);
      if (!/^[^\s@]+@[^\s@]+$/.test(address)) {
        throw new RuleValidationError(`“${address}” is not a valid forwarding address.`);
      }
      return { id, type: 'redirect', address };
    }
    case 'markRead':
    case 'star':
    case 'discard':
      return { id, type: input.type };
    default:
      throw new RuleValidationError(`Action ${index + 1} in “${ruleName}” is not supported.`);
  }
}

function compileRuleTest(rule: MailRule): string {
  return compileTestGroup(rule.match, rule.conditions, false);
}

function compileRuleTestNode(test: MailRuleTest): string {
  if (test.type === 'group') {
    return compileTestGroup(test.match, test.conditions, test.negated);
  }
  const compiled = compileCondition(test);
  return test.negated ? `not ${compiled}` : compiled;
}

function compileTestGroup(match: RuleMatch, tests: MailRuleTest[], negated: boolean): string {
  const compiled = tests.map(compileRuleTestNode);
  const expression = compiled.length === 1
    ? compiled[0]
    : `${match === 'all' ? 'allof' : 'anyof'} (${compiled.join(', ')})`;
  return negated ? `not ${expression}` : expression;
}

function compileCondition(condition: MailRuleCondition): string {
  const match = `:${condition.operator}`;
  const value = sieveString(condition.value);
  switch (condition.field) {
    case 'from':
      return `address ${match} "From" ${value}`;
    case 'to':
      return `address ${match} "To" ${value}`;
    case 'toCc':
      return `address ${match} ["To", "Cc"] ${value}`;
    case 'subject':
      return `header ${match} "Subject" ${value}`;
    case 'header':
      return `header ${match} ${sieveString(condition.headerName ?? '')} ${value}`;
  }
}

function compileAction(
  action: MailRuleAction,
  extensions: ReadonlySet<string>,
  required: Set<string>,
): string {
  switch (action.type) {
    case 'move':
      requireExtension('fileinto', extensions, required, 'Moving messages');
      if (action.mailboxId && extensions.has('mailboxid')) {
        required.add('mailboxid');
        // Stalwart currently checks :mailboxid against the RFC 5490 "mailbox"
        // capability as well. Declare it when advertised so its authoritative
        // SieveScript/validate call accepts an otherwise RFC 9042 script.
        if (extensions.has('mailbox')) required.add('mailbox');
        return `fileinto :mailboxid ${sieveString(action.mailboxId)} ${sieveString(action.mailboxName)};`;
      }
      return `fileinto ${sieveString(action.mailboxName)};`;
    case 'markRead':
      requireExtension('imap4flags', extensions, required, 'Marking messages as read');
      return 'addflag "\\\\Seen";';
    case 'star':
      requireExtension('imap4flags', extensions, required, 'Starring messages');
      return 'addflag "\\\\Flagged";';
    case 'redirect':
      requireExtension('copy', extensions, required, 'Forwarding a copy');
      return `redirect :copy ${sieveString(action.address)};`;
    case 'discard':
      return 'discard;';
  }
}

function requireExtension(
  extension: string,
  available: ReadonlySet<string>,
  required: Set<string>,
  action: string,
): void {
  if (!available.has(extension)) {
    throw new RuleValidationError(`${action} requires the server’s “${extension}” Sieve extension.`);
  }
  required.add(extension);
}

function sieveString(value: string): string {
  rejectControlCharacters(value, 'Sieve value');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function requiredText(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RuleValidationError(message);
  }
  return value.trim();
}

function requiredSieveText(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuleValidationError(message);
  }
  return value;
}

function requiredId(value: unknown, label: string, seen: Set<string>): string {
  const id = requiredText(value, `${label} needs an identifier.`);
  if (seen.has(id)) throw new RuleValidationError(`${label} has a duplicate identifier.`);
  seen.add(id);
  return id;
}

function rejectControlCharacters(value: string, label: string): void {
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    throw new RuleValidationError(`${label} contains a line break or control character.`);
  }
}

function decodeBase64Url(value: string): Uint8Array {
  if (value.length % 4 === 1) throw new Error('invalid base64url length');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const index = BASE64URL_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('invalid base64url character');
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return new Uint8Array(bytes);
}

function sameRuleSemantics(left: MailRuleDocument, right: MailRuleDocument): boolean {
  return left.rules.length === right.rules.length
    && left.rules.every((rule, index) => sameRule(rule, right.rules[index]));
}

function sameRule(left: MailRule, right: MailRule): boolean {
  return left.name === right.name
    && left.enabled === right.enabled
    && (left.conditions.length < 2 || left.match === right.match)
    && left.stopProcessing === right.stopProcessing
    && left.conditions.length === right.conditions.length
    && left.conditions.every((test, index) => sameTest(test, right.conditions[index]))
    && left.actions.length === right.actions.length
    && left.actions.every((action, index) => sameAction(action, right.actions[index]));
}

function sameTest(left: MailRuleTest, right: MailRuleTest): boolean {
  if (left.type !== right.type || left.negated !== right.negated) return false;
  if (left.type === 'condition' && right.type === 'condition') {
    return left.field === right.field
      && left.operator === right.operator
      && left.value === right.value
      && left.headerName === right.headerName;
  }
  if (left.type !== 'group' || right.type !== 'group') return false;
  return left.match === right.match
    && left.conditions.length === right.conditions.length
    && left.conditions.every((test, index) => sameTest(test, right.conditions[index]));
}

function sameAction(left: MailRuleAction, right: MailRuleAction): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'move' && right.type === 'move') {
    return left.mailboxName === right.mailboxName
      && (!left.mailboxId || !right.mailboxId || left.mailboxId === right.mailboxId);
  }
  if (left.type === 'redirect' && right.type === 'redirect') {
    return left.address === right.address;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
