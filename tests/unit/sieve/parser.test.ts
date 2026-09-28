import { describe, expect, it } from 'vitest';

import { parseSieve, SieveSyntaxError } from '../../../src/sieve/parser';

describe('Sieve syntax parser', () => {
  it('builds nested test nodes with source ranges', () => {
    const source = [
      '/* existing script */',
      'if allof (header :contains "Subject" "Project", not anyof (address :is "From" "a@example.com", address :is "From" "b@example.com")) {',
      '  addflag "\\\\Flagged";',
      '}',
    ].join('\r\n');

    const script = parseSieve(source);
    expect(script.statements).toHaveLength(1);
    expect(script.statements[0]).toMatchObject({
      type: 'if',
      comments: ['existing script'],
      branches: [{
        test: {
          type: 'allof',
          tests: [
            { type: 'call', name: 'header' },
            { type: 'not', test: { type: 'anyof' } },
          ],
        },
      }],
    });
    expect(source.slice(
      script.statements[0].range.start,
      script.statements[0].range.end,
    )).toMatch(/^if allof/);
  });

  it('parses elsif branches and multi-line strings before visual projection', () => {
    const source = [
      'if header :is "Subject" "one" { discard; }',
      'elsif header :is "Subject" "two" {',
      '  vacation text:# explanatory comment',
      'Out of office',
      '.',
      '  ;',
      '}',
      '',
    ].join('\r\n');
    const script = parseSieve(source);
    expect(script.statements[0]).toMatchObject({
      type: 'if',
      branches: [
        { test: { type: 'call', name: 'header' } },
        {
          test: { type: 'call', name: 'header' },
          commands: [{
            type: 'command', name: 'vacation', arguments: [{ type: 'string', value: 'Out of office\r\n' }],
          }],
        },
      ],
    });
  });

  it('reports syntax locations', () => {
    expect(() => parseSieve('if header :is "Subject" "broken" {\r\n  discard;'))
      .toThrow(SieveSyntaxError);
    expect(() => parseSieve('if header :is "Subject" "broken" {\r\n  discard;'))
      .toThrow(/line 2/);
  });

  it('retains trailing comments separately from the preceding statement', () => {
    const script = parseSieve('keep;\r\n# trailing note\r\n');
    expect(script.statements[0].comments).toEqual([]);
    expect(script.trailingComments).toEqual(['trailing note']);
  });

  it('rejects excessive recursive nesting before exhausting the JS stack', () => {
    const source = `if ${'not '.repeat(70)}true { keep; }`;
    expect(() => parseSieve(source)).toThrow(/parser nesting limit/);
  });
});
