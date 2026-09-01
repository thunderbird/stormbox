import { describe, expect, it } from 'vitest';

import { useRepeaterRows } from '../../../src/composables/useRepeaterRows';

interface TestRow {
  formKey: string;
  position: number;
  value: string;
}

describe('useRepeaterRows', () => {
  it('appends, updates, replaces, and removes rows by stable key', () => {
    let rows: TestRow[] = [
      { formKey: 'first', position: 0, value: 'one' },
      { formKey: 'second', position: 1, value: 'two' },
    ];
    const repeater = useRepeaterRows<TestRow>({
      rows: () => rows,
      createRow: (position) => ({
        formKey: `created-${position}`,
        position,
        value: '',
      }),
      update: (next) => {
        rows = next;
      },
    });

    expect(repeater.appendRow()).toEqual({
      formKey: 'created-2',
      position: 2,
      value: '',
    });
    repeater.updateRow('second', { value: 'updated' });
    repeater.replaceRow({
      formKey: 'first',
      position: 0,
      value: 'replaced',
    });
    const removal = repeater.removeRow('second');

    expect(removal).toEqual({
      index: 1,
      rows: [
        { formKey: 'first', position: 0, value: 'replaced' },
        { formKey: 'created-2', position: 2, value: '' },
      ],
    });
    expect(rows).toEqual(removal.rows);
  });

  it('maps rows without changing their keys', () => {
    let rows: TestRow[] = [
      { formKey: 'first', position: 0, value: 'one' },
      { formKey: 'second', position: 1, value: 'two' },
    ];
    const repeater = useRepeaterRows<TestRow>({
      rows: () => rows,
      createRow: () => ({
        formKey: 'unused',
        position: 0,
        value: '',
      }),
      update: (next) => {
        rows = next;
      },
    });

    repeater.mapRows((row) => ({ ...row, value: row.value.toUpperCase() }));

    expect(rows).toEqual([
      { formKey: 'first', position: 0, value: 'ONE' },
      { formKey: 'second', position: 1, value: 'TWO' },
    ]);
  });
});
