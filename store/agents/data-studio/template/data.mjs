// Shared by the dashboard and Node tests. No external runtime or chart library.
export function parseCSV(input) {
  const text = String(input).replace(/^\uFEFF/, '');
  const records = []; let record = [], field = '', quoted = false, closed = false;
  const finishField = () => { record.push(field); field = ''; closed = false; };
  const finishRecord = () => {
    finishField();
    if (record.some(value => value.trim() !== '')) records.push(record);
    record = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === '"' && field === '' && !closed) quoted = true;
    else if (char === ',') finishField();
    else if (char === '\n' || char === '\r') { if (char === '\r' && text[i + 1] === '\n') i++; finishRecord(); }
    else if (closed || char === '"') throw new Error('Unexpected character after a CSV quote.');
    else field += char;
  }
  if (quoted) throw new Error('An opening CSV quote has no closing quote.');
  if (field !== '' || record.length || closed) finishRecord();
  if (!records.length) throw new Error('The CSV is empty. Add a header row and your data.');
  const headers = records.shift().map(value => value.trim());
  if (headers.some(value => !value) || new Set(headers).size !== headers.length) throw new Error('Column names must be nonempty and unique.');
  const rows = records.map((record, index) => {
    if (record.length !== headers.length) throw new Error(`Record ${index + 2} has ${record.length} fields; expected ${headers.length}.`);
    return Object.fromEntries(headers.map((header, i) => [header, record[i]]));
  });
  return { headers, rows };
}

export function numericColumns({ headers, rows }) {
  return headers.filter(key => rows.length && rows.every(row => row[key].trim() !== '' && Number.isFinite(Number(row[key]))));
}

export function inferFields(table) {
  const numeric = numericColumns(table);
  if (!numeric.length) throw new Error('Choose data with at least one numeric column (no blank values).');
  const dimensions = table.headers.filter(key => !numeric.includes(key));
  if (dimensions.length < 2) throw new Error('This view needs two text columns (period and group) plus a numeric value.');
  const period = dimensions.find(key => /^(quarter|month|date|period|year)$/i.test(key)) || dimensions[0];
  const group = dimensions.find(key => /^(region|category|group|product|team)$/i.test(key) && key !== period) || dimensions.find(key => key !== period);
  const metric = numeric.find(key => /^(revenue|sales|value|amount)$/i.test(key)) || numeric[0];
  return { period, group, metric };
}

export function summarize(table, fields, enabled, range = {}) {
  const { period, group, metric } = fields;
  const periods = [...new Set(table.rows.map(row => row[period]))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const groups = [...new Set(table.rows.map(row => row[group]))].sort((a, b) => a.localeCompare(b));
  const start = Math.max(0, periods.indexOf(range.start)), end = range.end ? periods.indexOf(range.end) : periods.length - 1;
  const window = periods.slice(start, end + 1);
  const included = new Set(window), sums = new Map(), periodSums = new Map();
  const rows = table.rows.filter(row => enabled.has(row[group]) && included.has(row[period]));
  for (const row of rows) {
    const name = row[group], label = row[period], value = Number(row[metric]);
    if (!sums.has(name)) sums.set(name, new Map());
    const bucket = sums.get(name);
    bucket.set(label, (bucket.get(label) || 0) + value);
    periodSums.set(label, (periodSums.get(label) || 0) + value);
  }
  const series = groups.filter(name => enabled.has(name)).map(name => ({ name, values: window.map(label => ({
    period: label,
    value: sums.get(name)?.get(label) || 0
  })) }));
  const totals = window.map(label => periodSums.get(label) || 0);
  const total = totals.reduce((sum, value) => sum + value, 0);
  const growth = totals.length > 1 && totals[0] !== 0 ? (totals.at(-1) - totals[0]) / Math.abs(totals[0]) : null;
  const ranked = series.map(series => ({ name: series.name, value: series.values.reduce((sum, point) => sum + point.value, 0) })).sort((a, b) => b.value - a.value);
  return { periods: window, groups, rows, series, totals, total, growth, ranked };
}

export function exportCSV(headers, rows) {
  const escape = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  return [headers, ...rows.map(row => headers.map(key => row[key]))].map(row => row.map(escape).join(',')).join('\r\n') + '\r\n';
}
