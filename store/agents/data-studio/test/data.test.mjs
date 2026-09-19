import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseCSV, inferFields, summarize, exportCSV } from '../template/data.mjs';

test('CSV supports BOM, CRLF, quoted commas, doubled quotes, multiline fields and negative/decimal numbers', () => {
  const table = parseCSV('\uFEFFperiod,group,value\r\nQ1,"North, coast",-2.5\r\nQ2,"A ""quoted""\nteam",4.75\r\n');
  assert.equal(table.rows[0].group, 'North, coast');
  assert.equal(table.rows[1].group, 'A "quoted"\nteam');
  assert.deepEqual(parseCSV(exportCSV(table.headers, table.rows)), table);
  const fields = inferFields(table);
  assert.equal(summarize(table, fields, new Set(table.rows.map(row => row.group))).total, 2.25);
});

test('malformed CSV is rejected rather than charted as plausible numbers', () => {
  for (const csv of ['', 'x,x\na,b', 'x,\na,b', 'x,y\na,b,c', 'x,y\n"unfinished,b', 'x,y\n"a"oops,b']) {
    assert.throws(() => parseCSV(csv), undefined, csv);
  }
  assert.throws(() => inferFields(parseCSV('period,group,value\nQ1,A,NaN')));
  assert.throws(() => inferFields(parseCSV('period,group,value\nQ1,A,')));
});

test('new groups/periods, repeated observations, zeros and negative values determine the view', () => {
  const table = parseCSV('period,group,value\nQ1,New group,0\nQ2,New group,20\nQ2,New group,5\nQ2,Other,-8');
  const fields = inferFields(table);
  const all = summarize(table, fields, new Set(['New group', 'Other']));
  assert.equal(all.total, 17);
  assert.equal(all.growth, null, 'a zero baseline has no finite percentage growth');
  assert.equal(all.ranked[0].value, 25);
  assert.equal(summarize(table, fields, new Set()).rows.length, 0);
  assert.equal(summarize(table, fields, new Set(['Other']), { start: 'Q2', end: 'Q2' }).total, -8);
});

test('the actual starter totals and filters agree with the underlying rows', () => {
  const table = parseCSV(readFileSync(new URL('../template/data.csv', import.meta.url), 'utf8'));
  const fields = inferFields(table);
  const result = summarize(table, fields, new Set(['North', 'East', 'South', 'West']));
  assert.equal(result.total, 203000);
  assert.equal(result.ranked[0].name, 'East');
  assert.equal(result.ranked[0].value, 67200);
  assert.equal(summarize(table, fields, new Set(['North'])).total, 54600);
});
