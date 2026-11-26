console.warn('tablekit: version 2 is deprecated and no longer maintained')

function pad(text, width, align) {
  return align === 'right' ? text.padStart(width) : text.padEnd(width)
}

// columns: [{ key, title, align? }]; rows: plain objects. Every cell is printed with String().
export function renderTable(columns, rows) {
  const cells = rows.map((row) => columns.map((column) => String(row[column.key])))
  const widths = columns.map((column, i) => Math.max(column.title.length, ...cells.map((line) => line[i].length)))
  const line = (values) => values.map((value, i) => pad(value, widths[i], columns[i].align)).join('  ').trimEnd()
  return [
    line(columns.map((column) => column.title)),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...cells.map(line),
  ].join('\n')
}
