"""Independent stdlib CSV/Decimal/SQLite checks of actual browser downloads.

Usage: python3 test/verify-exports.py EVIDENCE_DIRECTORY
No harness parsing or aggregation helper is imported.
"""
import csv
import io
import json
import sqlite3
import sys
from decimal import Decimal
from pathlib import Path

root = Path(sys.argv[1])
if sqlite3.sqlite_version_info < (3, 37, 0):
    raise SystemExit('This independent reader needs SQLite 3.37+ for STRICT tables. Use a current Python runtime; do not weaken schema validation.')
sales = json.loads((root / 'sales-saved.data-studio.json').read_text())
source = sales['bundle']['sources']
transactions = list(csv.DictReader(io.StringIO(source['sources/transactions.csv'])))
products = {r['product_id']: r for r in csv.DictReader(io.StringIO(source['sources/products.csv']))}
assert '001' in products
totals = {'2026-01': Decimal(0), '2026-02': Decimal(0)}
monthly = {}
categories = {}
for row in transactions:
    if row['status'] != 'completed':
        continue
    net = (int(row['quantity']) * Decimal(row['unit_price_usd'])
           - Decimal(row['discount_usd']) - Decimal(row['refund_usd']))
    month = row['sold_on'][:7]
    if month in totals:
        totals[month] += net
        cat = products[row['product_id']]['category']
        categories[cat] = categories.get(cat, Decimal(0)) + net * (1 if month == '2026-02' else -1)
    if int(row['quantity']) >= 15:
        total, count = monthly.get(month, (Decimal(0), 0))
        monthly[month] = (total + net, count + 1)
assert totals == {'2026-01': Decimal('4628.50'), '2026-02': Decimal('4366.50')}
assert sum(categories.values()) == Decimal('-262.00')
expected = [[month, int(total * 100), count] for month, (total, count) in sorted(monthly.items())]
actual = json.loads((root / 'sales-current-query.json').read_text())
assert actual['rows'] == expected
with sqlite3.connect('file:' + str(root / 'sales-browser.sqlite') + '?mode=ro', uri=True) as db:
    assert db.execute('PRAGMA integrity_check').fetchone() == ('ok',)
    assert db.execute('SELECT line_id, unit_price_cents FROM transactions WHERE _record=2').fetchone() == ('00001', 4000)
    assert [list(r) for r in db.execute(sales['bundle']['sql']['queries/monthly.sql'], {'region': ''})] == expected
safe_rows = list(csv.reader(io.StringIO((root / 'sales-revised-query.csv').read_text())))
assert safe_rows[0] == actual['columns']
assert safe_rows[1:] == [[str(v) for v in r] for r in expected]

delivery = json.loads((root / 'delivery-saved.data-studio.json').read_text())
rows = list(csv.DictReader(io.StringIO(delivery['bundle']['sources']['sources/shipments.csv'])))
as_of = delivery['view']['parameters']['as_of']
delivered = [r for r in rows if r['delivered_on'] and r['delivered_on'] <= as_of]
on_time = [r for r in delivered if r['delivered_on'] <= r['promised_on']]
assert (len(rows), len(delivered), len(rows)-len(delivered), len(on_time)) == (18, 16, 2, 8)
with sqlite3.connect('file:' + str(root / 'delivery-browser.sqlite') + '?mode=ro', uri=True) as db:
    assert db.execute('PRAGMA integrity_check').fetchone() == ('ok',)
    assert db.execute('SELECT delivered_on FROM shipments WHERE shipment_id=?', ('0017',)).fetchone() == ('2026-04-19',)
    assert db.execute('SELECT count(*) FROM shipments WHERE delivered_on IS NULL').fetchone() == (2,)
    result = db.execute(delivery['bundle']['sql']['queries/headline.sql'], {'as_of': as_of, 'region': ''}).fetchone()
    assert result == (18, 16, 2, 0.5)
for report in ['sales-report.html', 'delivery-report.html']:
    text = (root / report).read_text()
    assert '<script' not in text.lower()
    assert 'Synthetic example data' in text
    assert 'Applied controls' in text
print(json.dumps({'independentReader': 'Python ' + sys.version.split()[0] + ' / CSV + Decimal + SQLite ' + sqlite3.sqlite_version,
                  'salesTotalsUSD': {k: str(v) for k, v in totals.items()},
                  'monthlyRows': expected, 'delivery': {'delivered': 16, 'open': 2, 'onTimeRate': 0.5},
                  'passed': True}, indent=2))
