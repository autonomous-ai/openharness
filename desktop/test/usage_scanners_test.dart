import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/usage/ledger/ledger_scanner.dart';
import 'package:harness/usage/ledger/ledger_types.dart';
import 'package:harness/usage/ledger/opencode_ledger_scanner.dart';
import 'package:harness/usage/ledger/usage_overview.dart';
import 'package:sqlite3/sqlite3.dart';

Database createUsageDatabase(String path, {bool wal = false}) {
  final db = sqlite3.open(path);
  if (wal) {
    db.execute('PRAGMA journal_mode=WAL');
    db.execute('PRAGMA wal_autocheckpoint=0');
  }
  db.execute('''
    CREATE TABLE session (
      id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER,
      cost REAL, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER,
      tokens_cache_write INTEGER, model TEXT
    )
  ''');
  return db;
}

void addUsage(
  Database db, {
  String id = 'session',
  int input = 100,
  int cacheWrite = 0,
}) {
  db.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    id,
    '/fixture/project',
    1789862400000,
    0.0,
    input,
    0,
    0,
    0,
    cacheWrite,
    'fixture-model',
  ]);
}

Map<String, ScannedSource> previousSources(LedgerScanResult result) => {
  for (final source in result.sources) source.path: source,
};

void main() {
  late Directory fixture;
  late OpenCodeLedgerScanner scanner;
  setUp(() async {
    fixture = await Directory.systemTemp.createTemp('harness-usage-scanner-');
    scanner = OpenCodeLedgerScanner(dataDirectory: fixture.path);
  });
  tearDown(() async => fixture.delete(recursive: true));

  test(
    'a refresh sees committed WAL updates while OpenCode stays open',
    () async {
      final file = File('${fixture.path}/opencode.db');
      final writer = createUsageDatabase(file.path, wal: true);
      try {
        addUsage(writer);
        final first = await scanner.scan({});
        expect(first.sources.single.entries.single.totals.freshInput, 100);
        final before = await file.stat();
        writer.execute('UPDATE session SET tokens_input=200');
        final after = await file.stat();
        expect(after.modified, before.modified);
        expect(after.size, before.size);
        final second = await scanner.scan(previousSources(first));
        expect(second.sources.single.entries.single.totals.freshInput, 200);
        writer.execute('BEGIN');
        writer.execute('UPDATE session SET tokens_input=900');
        final uncommitted = await scanner.scan(previousSources(second));
        expect(
          uncommitted.sources.single.entries.single.totals.freshInput,
          200,
        );
        writer.execute('ROLLBACK');
        writer.execute('PRAGMA wal_checkpoint(TRUNCATE)');
        writer.execute('UPDATE session SET tokens_input=300');
        final third = await scanner.scan(previousSources(second));
        expect(third.sources.single.entries.single.totals.freshInput, 300);
      } finally {
        writer.dispose();
      }
    },
  );

  test(
    'a locked database reports a read failure and recovers on refresh',
    () async {
      final writer = createUsageDatabase('${fixture.path}/opencode.db');
      try {
        addUsage(writer);
        writer.execute('BEGIN EXCLUSIVE');
        final locked = await scanner.scan({});
        expect(locked.status, LedgerStatus.failed);
        expect(locked.message, contains('locked'));
        writer.execute('ROLLBACK');
        final recovered = await scanner.scan(previousSources(locked));
        expect(recovered.status, LedgerStatus.ok);
        expect(recovered.sources.single.entries.single.totals.freshInput, 100);
      } finally {
        writer.dispose();
      }
    },
  );

  test('a corrupt database is failed, not missing or zero usage', () async {
    await File('${fixture.path}/opencode.db')
        .writeAsString('not a sqlite database');
    final result = await scanner.scan({});
    expect(result.status, LedgerStatus.failed);
    expect(result.message, isNotEmpty);
  });

  test(
    'a missing data directory differs from a path that is not a directory',
    () async {
      final path = '${fixture.path}/data';
      final configured = OpenCodeLedgerScanner(dataDirectory: path);
      expect((await configured.scan({})).status, LedgerStatus.unavailable);
      await File(path).writeAsString('not a directory');
      expect((await configured.scan({})).status, LedgerStatus.failed);
    },
  );

  test(
    'an unsupported usage schema does not claim a successful empty scan',
    () async {
      final writer = sqlite3.open('${fixture.path}/opencode.db');
      writer.execute('CREATE TABLE session (id TEXT PRIMARY KEY)');
      writer.dispose();
      final result = await scanner.scan({});
      expect(result.status, LedgerStatus.failed);
      expect(result.message, contains('format'));
    },
  );

  test('a broken sibling is disclosed alongside readable usage', () async {
    final writer = createUsageDatabase('${fixture.path}/opencode.db');
    addUsage(writer);
    writer.dispose();
    await File('${fixture.path}/opencode-copy.db').writeAsString('broken');
    final result = await scanner.scan({});
    expect(result.status.name, 'partial');
    expect(result.message, contains('1'));
    expect(result.sources.single.entries.single.totals.freshInput, 100);
  });

  test('cache-write-only sessions count as usage', () async {
    final writer = createUsageDatabase('${fixture.path}/opencode.db');
    addUsage(writer, input: 0, cacheWrite: 70);
    writer.dispose();
    final result = await scanner.scan({});
    expect(result.sources.single.entries.single.totals.total, 70);
  });

  test(
    'the live database wins duplicate session ids over sibling copies',
    () async {
      for (final (name, input) in [
        ('opencode-copy.db', 100),
        ('opencode.db', 200),
      ]) {
        final writer = createUsageDatabase('${fixture.path}/$name');
        addUsage(writer, input: input);
        writer.dispose();
      }
      final result = await scanner.scan({});
      final ledger = buildProviderLedger(
        LedgerProvider.opencode,
        result.sources,
      );
      expect(ledger.sessionCount, 1);
      expect(ledger.totals.freshInput, 200);
      expect(ledger.costUsd, 0.0);
    },
  );

  test(
    'an empty supported database and an absent database remain distinct',
    () async {
      expect((await scanner.scan({})).status, LedgerStatus.unavailable);
      createUsageDatabase('${fixture.path}/opencode.db').dispose();
      final empty = await scanner.scan({});
      expect(empty.status, LedgerStatus.ok);
      expect(empty.sources.single.entries, isEmpty);
    },
  );
}
