interface KeyedRepeaterRow {
  formKey: string;
}

type RowUpdate<Row> = Partial<Row> | ((row: Row) => Row);

export interface RepeaterRemoval<Row> {
  index: number;
  rows: Row[];
}

export interface UseRepeaterRowsOptions<Row extends KeyedRepeaterRow> {
  rows: () => readonly Row[];
  createRow: (position: number) => Row;
  update: (rows: Row[]) => void;
}

export function useRepeaterRows<Row extends KeyedRepeaterRow>({
  rows,
  createRow,
  update,
}: UseRepeaterRowsOptions<Row>) {
  function appendRow(): Row {
    const current = rows();
    const created = createRow(current.length);
    update([...current, created]);
    return created;
  }

  function updateRow(formKey: string, change: RowUpdate<Row>): void {
    update(rows().map((row) => {
      if (row.formKey !== formKey) return row;
      return typeof change === 'function'
        ? change(row)
        : { ...row, ...change };
    }));
  }

  function replaceRow(replacement: Row): void {
    updateRow(replacement.formKey, () => replacement);
  }

  function removeRow(formKey: string): RepeaterRemoval<Row> {
    const current = rows();
    const index = current.findIndex((row) => row.formKey === formKey);
    const remaining = current.filter((row) => row.formKey !== formKey);
    update(remaining);
    return { index, rows: remaining };
  }

  function mapRows(mapper: (row: Row) => Row): void {
    update(rows().map(mapper));
  }

  return {
    appendRow,
    mapRows,
    removeRow,
    replaceRow,
    updateRow,
  };
}
