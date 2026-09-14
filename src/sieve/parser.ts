export interface SieveSourceRange {
  start: number;
  end: number;
}

export type SieveValue =
  | { type: 'tag'; value: string; range: SieveSourceRange }
  | { type: 'string'; value: string; range: SieveSourceRange }
  | { type: 'stringList'; values: string[]; range: SieveSourceRange }
  | { type: 'number'; value: string; range: SieveSourceRange };

export interface SieveCallTest {
  type: 'call';
  name: string;
  arguments: SieveValue[];
  range: SieveSourceRange;
}

export interface SieveNotTest {
  type: 'not';
  test: SieveTest;
  range: SieveSourceRange;
}

export interface SieveBooleanTest {
  type: 'allof' | 'anyof';
  tests: SieveTest[];
  range: SieveSourceRange;
}

export type SieveTest = SieveCallTest | SieveNotTest | SieveBooleanTest;

export interface SieveCommand {
  type: 'command';
  name: string;
  arguments: SieveValue[];
  comments: string[];
  range: SieveSourceRange;
}

export interface SieveBlockCommand {
  type: 'block';
  name: string;
  arguments: SieveValue[];
  commands: SieveStatement[];
  comments: string[];
  range: SieveSourceRange;
}

export interface SieveIfBranch {
  test: SieveTest;
  commands: SieveStatement[];
  comments: string[];
}

export interface SieveIfStatement {
  type: 'if';
  branches: SieveIfBranch[];
  elseCommands: SieveStatement[] | null;
  elseComments: string[];
  comments: string[];
  range: SieveSourceRange;
}

export type SieveStatement = SieveCommand | SieveBlockCommand | SieveIfStatement;

export interface SieveScript {
  source: string;
  statements: SieveStatement[];
  trailingComments: string[];
}

export class SieveSyntaxError extends Error {
  readonly offset: number;

  constructor(message: string, source: string, offset: number) {
    const before = source.slice(0, offset);
    const line = before.split(/\r\n|\r|\n/).length;
    const lastNewline = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'));
    const column = offset - lastNewline;
    super(`${message} at line ${line}, column ${column}.`);
    this.name = 'SieveSyntaxError';
    this.offset = offset;
  }
}

type TokenType =
  | 'identifier'
  | 'tag'
  | 'number'
  | 'string'
  | 'comment'
  | '['
  | ']'
  | '('
  | ')'
  | '{'
  | '}'
  | ','
  | ';'
  | 'eof';

const MAX_SOURCE_CHARACTERS = 2_000_000;
const MAX_TOKENS = 100_000;
const MAX_AST_NODES = 10_000;
const MAX_NESTING_DEPTH = 64;

interface Token {
  type: TokenType;
  value: string;
  start: number;
  end: number;
}

export function parseSieve(source: string): SieveScript {
  if (source.length > MAX_SOURCE_CHARACTERS) {
    throw new SieveSyntaxError('Script exceeds the parser size limit', source, 0);
  }
  const parser = new Parser(source, tokenize(source));
  return parser.parse();
}

class Parser {
  private index = 0;
  private nodeCount = 0;
  private trailingComments: string[] = [];

  constructor(
    private readonly source: string,
    private readonly tokens: Token[],
  ) {}

  parse(): SieveScript {
    const statements = this.parseStatements('eof', 0);
    this.expect('eof');
    return { source: this.source, statements, trailingComments: this.trailingComments };
  }

  private parseStatements(end: '}' | 'eof', depth: number): SieveStatement[] {
    const statements: SieveStatement[] = [];
    while (true) {
      const comments = this.takeComments();
      if (this.peek().type === end) {
        if (end === 'eof') {
          this.trailingComments = comments;
        } else if (comments.length > 0 && statements.length > 0) {
          statements[statements.length - 1].comments.push(...comments);
        }
        return statements;
      }
      if (this.peek().type === 'eof') {
        if (end === 'eof') return statements;
        throw this.error('Expected “}”', this.peek().start);
      }
      statements.push(this.parseStatement(comments, depth));
    }
  }

  private parseStatement(comments: string[], depth: number): SieveStatement {
    const start = this.peek().start;
    this.countNode(start);
    const name = this.expect('identifier');
    if (name.value.toLowerCase() === 'if') return this.parseIf(start, comments, depth);
    if (['elsif', 'else'].includes(name.value.toLowerCase())) {
      throw this.error(`Unexpected “${name.value}”`, name.start);
    }

    const args = this.parseValues(new Set([';', '{']));
    if (this.match('{')) {
      this.checkDepth(depth + 1, start);
      const commands = this.parseStatements('}', depth + 1);
      const close = this.expect('}');
      return {
        type: 'block',
        name: name.value.toLowerCase(),
        arguments: args,
        commands,
        comments,
        range: { start, end: close.end },
      };
    }
    const endToken = this.expect(';');
    return {
      type: 'command',
      name: name.value.toLowerCase(),
      arguments: args,
      comments,
      range: { start, end: endToken.end },
    };
  }

  private parseIf(start: number, comments: string[], depth: number): SieveIfStatement {
    const branches: SieveIfBranch[] = [];
    const firstTest = this.parseTest(new Set(['{']), 0);
    branches.push({ test: firstTest, commands: this.parseBlock(depth), comments: [] });
    let end = this.previous().end;

    let elseCommands: SieveStatement[] | null = null;
    let elseComments: string[] = [];
    while (true) {
      const beforeComments = this.index;
      const branchComments = this.takeComments();
      const token = this.peek();
      if (token.type !== 'identifier') {
        this.index = beforeComments;
        break;
      }
      const keyword = token.value.toLowerCase();
      if (keyword === 'elsif') {
        this.index += 1;
        const test = this.parseTest(new Set(['{']), 0);
        branches.push({ test, commands: this.parseBlock(depth), comments: branchComments });
        end = this.previous().end;
        continue;
      }
      if (keyword === 'else') {
        this.index += 1;
        elseComments = branchComments;
        elseCommands = this.parseBlock(depth);
        end = this.previous().end;
      } else {
        this.index = beforeComments;
      }
      break;
    }

    return {
      type: 'if',
      branches,
      elseCommands,
      elseComments,
      comments,
      range: { start, end },
    };
  }

  private parseBlock(depth: number): SieveStatement[] {
    this.checkDepth(depth + 1, this.peek().start);
    this.expect('{');
    const commands = this.parseStatements('}', depth + 1);
    this.expect('}');
    return commands;
  }

  private parseTest(stop: ReadonlySet<TokenType>, depth: number): SieveTest {
    this.takeComments();
    const start = this.peek().start;
    this.checkDepth(depth, start);
    this.countNode(start);
    const nameToken = this.expect('identifier');
    const name = nameToken.value.toLowerCase();
    if (name === 'not') {
      const test = this.parseTest(stop, depth + 1);
      return { type: 'not', test, range: { start, end: test.range.end } };
    }
    if (name === 'allof' || name === 'anyof') {
      this.expect('(');
      const tests: SieveTest[] = [];
      if (this.peek().type === ')') {
        throw this.error(`${name} requires at least one test`, this.peek().start);
      }
      do {
        tests.push(this.parseTest(new Set([',', ')']), depth + 1));
      } while (this.match(','));
      const close = this.expect(')');
      return { type: name, tests, range: { start, end: close.end } };
    }

    const args = this.parseValues(stop);
    return {
      type: 'call',
      name,
      arguments: args,
      range: { start, end: this.previous().end },
    };
  }

  private parseValues(stop: ReadonlySet<TokenType>): SieveValue[] {
    const values: SieveValue[] = [];
    while (!stop.has(this.peek().type)) {
      const token = this.peek();
      if (token.type === 'comment') {
        this.index += 1;
        continue;
      }
      if (token.type === 'tag') {
        this.index += 1;
        values.push({ type: 'tag', value: token.value.toLowerCase(), range: range(token) });
        continue;
      }
      if (token.type === 'number') {
        this.index += 1;
        values.push({ type: 'number', value: token.value, range: range(token) });
        continue;
      }
      if (token.type === 'string') {
        this.index += 1;
        values.push({ type: 'string', value: token.value, range: range(token) });
        continue;
      }
      if (token.type === '[') {
        values.push(this.parseStringList());
        continue;
      }
      throw this.error(`Unexpected token “${token.value || token.type}”`, token.start);
    }
    return values;
  }

  private parseStringList(): SieveValue {
    const open = this.expect('[');
    const values: string[] = [];
    do {
      values.push(this.expect('string').value);
    } while (this.match(','));
    const close = this.expect(']');
    return { type: 'stringList', values, range: { start: open.start, end: close.end } };
  }

  private takeComments(): string[] {
    const comments: string[] = [];
    while (this.peek().type === 'comment') {
      comments.push(this.peek().value);
      this.index += 1;
    }
    return comments;
  }

  private match(type: TokenType): boolean {
    const start = this.index;
    this.takeComments();
    if (this.peek().type !== type) {
      this.index = start;
      return false;
    }
    this.index += 1;
    return true;
  }

  private expect(type: TokenType): Token {
    if (type !== 'comment') this.takeComments();
    const token = this.peek();
    if (token.type !== type) throw this.error(`Expected “${type}”`, token.start);
    this.index += 1;
    return token;
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private previous(): Token {
    return this.tokens[Math.max(0, this.index - 1)];
  }

  private error(message: string, offset: number): SieveSyntaxError {
    return new SieveSyntaxError(message, this.source, offset);
  }

  private countNode(offset: number): void {
    this.nodeCount += 1;
    if (this.nodeCount > MAX_AST_NODES) {
      throw this.error('Script exceeds the parser node limit', offset);
    }
  }

  private checkDepth(depth: number, offset: number): void {
    if (depth > MAX_NESTING_DEPTH) {
      throw this.error('Script exceeds the parser nesting limit', offset);
    }
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < source.length) {
    if (tokens.length >= MAX_TOKENS) {
      throw new SieveSyntaxError('Script exceeds the parser token limit', source, offset);
    }
    const character = source[offset];
    if (/\s/.test(character)) {
      offset += 1;
      continue;
    }
    if (character === '#') {
      const start = offset;
      offset += 1;
      const contentStart = offset;
      while (offset < source.length && source[offset] !== '\r' && source[offset] !== '\n') offset += 1;
      tokens.push({ type: 'comment', value: source.slice(contentStart, offset).trim(), start, end: offset });
      continue;
    }
    if (source.startsWith('/*', offset)) {
      const start = offset;
      const end = source.indexOf('*/', offset + 2);
      if (end < 0) throw new SieveSyntaxError('Unterminated comment', source, start);
      tokens.push({
        type: 'comment',
        value: source.slice(offset + 2, end).trim(),
        start,
        end: end + 2,
      });
      offset = end + 2;
      continue;
    }
    if (isMultilineStart(source, offset)) {
      const token = readMultilineString(source, offset);
      tokens.push(token);
      offset = token.end;
      continue;
    }
    if (character === '"') {
      const token = readQuotedString(source, offset);
      tokens.push(token);
      offset = token.end;
      continue;
    }
    if (character === ':') {
      const start = offset;
      offset += 1;
      if (!/[A-Za-z_]/.test(source[offset] ?? '')) {
        throw new SieveSyntaxError('Invalid tag', source, start);
      }
      while (/[A-Za-z0-9_]/.test(source[offset] ?? '')) offset += 1;
      tokens.push({ type: 'tag', value: source.slice(start, offset), start, end: offset });
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const start = offset;
      offset += 1;
      while (/[A-Za-z0-9_]/.test(source[offset] ?? '')) offset += 1;
      tokens.push({ type: 'identifier', value: source.slice(start, offset), start, end: offset });
      continue;
    }
    if (/[0-9]/.test(character)) {
      const start = offset;
      offset += 1;
      while (/[0-9]/.test(source[offset] ?? '')) offset += 1;
      if (/[KkMmGg]/.test(source[offset] ?? '')) offset += 1;
      tokens.push({ type: 'number', value: source.slice(start, offset), start, end: offset });
      continue;
    }
    if ('[](){},;'.includes(character)) {
      tokens.push({ type: character as TokenType, value: character, start: offset, end: offset + 1 });
      offset += 1;
      continue;
    }
    throw new SieveSyntaxError(`Unexpected character “${character}”`, source, offset);
  }
  tokens.push({ type: 'eof', value: '', start: source.length, end: source.length });
  return tokens;
}

function readQuotedString(source: string, start: number): Token {
  let offset = start + 1;
  let value = '';
  while (offset < source.length) {
    const character = source[offset];
    if (character === '"') {
      return { type: 'string', value, start, end: offset + 1 };
    }
    if (character === '\\') {
      offset += 1;
      if (offset >= source.length) break;
      value += source[offset];
      offset += 1;
      continue;
    }
    if (character === '\0') throw new SieveSyntaxError('NUL is not allowed in a string', source, offset);
    value += character;
    offset += 1;
  }
  throw new SieveSyntaxError('Unterminated string', source, start);
}

function isMultilineStart(source: string, offset: number): boolean {
  if (source.slice(offset, offset + 5).toLowerCase() !== 'text:') return false;
  const next = source[offset + 5];
  return next === ' ' || next === '\t' || next === '#' || next === '\r' || next === '\n';
}

function readMultilineString(source: string, start: number): Token {
  let offset = start + 5;
  while (source[offset] === ' ' || source[offset] === '\t') offset += 1;
  if (source[offset] === '#') {
    while (offset < source.length && source[offset] !== '\r' && source[offset] !== '\n') offset += 1;
  }
  offset = consumeLineBreak(source, offset, start);
  const lines: string[] = [];
  while (offset <= source.length) {
    const lineStart = offset;
    while (offset < source.length && source[offset] !== '\r' && source[offset] !== '\n') offset += 1;
    const line = source.slice(lineStart, offset);
    const afterLine = consumeLineBreak(source, offset, start);
    if (line === '.') {
      const value = lines.length === 0 ? '' : `${lines.join('\r\n')}\r\n`;
      return { type: 'string', value, start, end: afterLine };
    }
    lines.push(line.startsWith('..') ? line.slice(1) : line);
    offset = afterLine;
  }
  throw new SieveSyntaxError('Unterminated multi-line string', source, start);
}

function consumeLineBreak(source: string, offset: number, start: number): number {
  if (source.startsWith('\r\n', offset)) return offset + 2;
  if (source[offset] === '\r' || source[offset] === '\n') return offset + 1;
  throw new SieveSyntaxError('Expected a line break in multi-line string', source, start);
}

function range(token: Token): SieveSourceRange {
  return { start: token.start, end: token.end };
}
