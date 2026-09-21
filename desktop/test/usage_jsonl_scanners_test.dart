import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/usage/ledger/claude_ledger_scanner.dart';
import 'package:harness/usage/ledger/codex_ledger_scanner.dart';
import 'package:harness/usage/ledger/ledger_scanner.dart';
import 'package:harness/usage/ledger/ledger_types.dart';
import 'package:harness/usage/ledger/jsonl_ledger_scan.dart';
import 'package:harness/usage/ledger/usage_overview.dart';

import 'usage_ledger_test.dart' show claudeRow, codexTokenCount;

LedgerScanner jsonlScanner(LedgerProvider provider, String home) =>
    provider == LedgerProvider.claude
    ? ClaudeLedgerScanner(home: home, environment: const {})
    : CodexLedgerScanner(home: home, environment: const {});

String jsonlRow(LedgerProvider provider, int tokens) =>
    provider == LedgerProvider.claude
    ? claudeRow(
        messageId: 'turn-$tokens',
        input: tokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
      )
    : codexTokenCount(totalInput: tokens, totalCached: 0, totalOutput: 0);

String jsonlRoot(LedgerProvider provider, String home, {bool legacy = false}) =>
    provider == LedgerProvider.claude
    ? '$home/.claude/${legacy ? 'transcripts' : 'projects'}'
    : '$home/.codex/${legacy ? 'archived_sessions' : 'sessions'}';

Map<String, ScannedSource> sourcesOf(LedgerScanResult result) => {
  for (final source in result.sources) source.path: source,
};

int tokensIn(LedgerProvider provider, LedgerScanResult result) =>
    buildProviderLedger(provider, result.sources).totals.freshInput;

Future<bool> denyRead(String path) async {
  final result = await Process.run('chmod', ['000', path]);
  if (result.exitCode != 0) {
    throw StateError('Could not prepare denied-read fixture');
  }
  try {
    await File(path).readAsBytes();
    markTestSkipped('This host can read files with no read permissions.');
    return false;
  } on FileSystemException {
    return true;
  }
}

void main() {
  test(
    'Unicode records survive every snapshot boundary and CRLF endings',
    () async {
      final fixture = await Directory.systemTemp.createTemp(
        'harness-jsonl-boundary-',
      );
      addTearDown(() => fixture.delete(recursive: true));
      const first = '{"text":"héλ中文🙂"}';
      const second = '{"text":"€"}';
      final firstBytes = utf8.encode(first);
      final bytes = utf8.encode('$first\r\n$second');
      final file = await File('${fixture.path}/fixture.jsonl')
          .writeAsBytes(bytes);
      for (var end = 0; end <= bytes.length; end++) {
        final records = <Object?>[];
        await for (final line in readJsonlLines(file, end)) {
          try {
            records.add(jsonDecode(line));
          } on FormatException {
            // An incomplete JSON record is ignored until the next scan.
          }
        }
        expect(records, [
          if (end >= firstBytes.length) {'text': 'héλ中文🙂'},
          if (end == bytes.length) {'text': '€'},
        ], reason: 'snapshot ends at byte $end');
      }
    },
  );

  test(
    'malformed Unicode is not mistaken for an unfinished trailing character',
    () async {
      final fixture = await Directory.systemTemp.createTemp(
        'harness-jsonl-invalid-',
      );
      addTearDown(() => fixture.delete(recursive: true));
      final file = File('${fixture.path}/fixture.jsonl');
      for (final bytes in [
        [0xff],
        [0x80],
        [0xc0],
        [0xe0, 0x80],
        [0xed, 0xa0],
        [0xf0, 0x80],
        [0xf4, 0x90],
        [0xff, 0xe2],
        [0xe2, 10],
      ]) {
        await file.writeAsBytes(bytes);
        await expectLater(
          readJsonlLines(file, bytes.length).toList(),
          throwsFormatException,
        );
      }
    },
  );

  for (final provider in [LedgerProvider.claude, LedgerProvider.codex]) {
    group(provider.label, () {
      late Directory fixture;
      late LedgerScanner scanner;
      late Directory root;
      setUp(() async {
        fixture = await Directory.systemTemp.createTemp('harness-jsonl-scan-');
        scanner = jsonlScanner(provider, fixture.path);
        root = Directory(jsonlRoot(provider, fixture.path));
      });
      tearDown(() => fixture.delete(recursive: true));

      Future<File> write(String name, int tokens, {bool legacy = false}) async {
        final file = File(
          '${jsonlRoot(provider, fixture.path, legacy: legacy)}/$name.jsonl',
        );
        await file.parent.create(recursive: true);
        await file.writeAsString('${jsonlRow(provider, tokens)}\n');
        return file;
      }

      test(
        'missing logs and readable logs without usage are distinct',
        () async {
          expect((await scanner.scan({})).status, LedgerStatus.unavailable);
          await root.create(recursive: true);
          await File('${root.path}/empty.jsonl')
              .writeAsString('{"type":"user"}\n');
          final result = await scanner.scan({});
          expect(result.status, LedgerStatus.ok);
          expect(result.sources.single.entries, isEmpty);
        },
      );

      test('current and legacy roots both contribute', () async {
        await write('current', 100);
        await write('older', 200, legacy: true);
        final result = await scanner.scan({});
        expect(result.status, LedgerStatus.ok);
        expect(tokensIn(provider, result), 300);
      });

      test(
        'a denied read is not cached as zero and recovers without a file edit',
        () async {
          final file = await write('denied', 100);
          late LedgerScanResult denied;
          try {
            if (!await denyRead(file.path)) return;
            denied = await scanner.scan({});
          } finally {
            await Process.run('chmod', ['600', file.path]);
          }
          final recovered = await scanner.scan(sourcesOf(denied));
          expect(tokensIn(provider, recovered), 100);
          expect(denied.status, LedgerStatus.failed);
          expect(denied.message, isNotEmpty);
        },
        skip: Platform.isWindows,
      );

      test('an unreadable file is disclosed beside readable usage', () async {
        await write('good', 100);
        final file = await write('denied', 200);
        try {
          if (!await denyRead(file.path)) return;
          final result = await scanner.scan({});
          expect(result.status, LedgerStatus.partial);
          expect(tokensIn(provider, result), 100);
          expect(result.message, isNotEmpty);
        } finally {
          await Process.run('chmod', ['600', file.path]);
        }
      }, skip: Platform.isWindows);

      test(
        'an unreadable root is a failure rather than a missing installation',
        () async {
          await root.parent.create(recursive: true);
          await File(root.path)
              .writeAsString('a configured root is not a directory');
          final result = await scanner.scan({});
          expect(result.status, LedgerStatus.failed);
          expect(result.message, isNotEmpty);
        },
      );

      test('a corrupt UTF-8 file does not hide a readable sibling', () async {
        await write('good', 100);
        await File('${root.path}/bad.jsonl').writeAsBytes([0xff, 10]);
        final result = await scanner.scan({});
        expect(result.status, LedgerStatus.partial);
        expect(tokensIn(provider, result), 100);
        expect(result.message, isNotEmpty);
      });

      test('an incomplete Unicode tail preserves earlier turns and completes on refresh', () async {
        final file = await write('live', 100);
        final row = jsonDecode(jsonlRow(provider, 200)) as Map<String, dynamic>;
        row['fixtureText'] = '€';
        final bytes = utf8.encode(jsonEncode(row));
        final split = bytes.indexOf(0xe2) + 1;
        await file.writeAsBytes(bytes.sublist(0, split), mode: FileMode.append);
        final pending = await scanner.scan({});
        expect(pending.status, LedgerStatus.ok);
        expect(tokensIn(provider, pending), 100);
        await file.writeAsBytes([
          ...bytes.sublist(split),
          10,
        ], mode: FileMode.append);
        final complete = await scanner.scan(sourcesOf(pending));
        expect(complete.status, LedgerStatus.ok);
        expect(
          tokensIn(provider, complete),
          provider == LedgerProvider.claude ? 300 : 200,
        );
      });

      test('appended and removed files update an existing snapshot', () async {
        final file = await write('live', 100);
        final first = await scanner.scan({});
        final unchanged = await scanner.scan(sourcesOf(first));
        expect(tokensIn(provider, unchanged), 100);
        await file.writeAsString(
          jsonlRow(provider, 200),
          mode: FileMode.append,
        );
        final appended = await scanner.scan(sourcesOf(unchanged));
        expect(
          tokensIn(provider, appended),
          provider == LedgerProvider.claude ? 300 : 200,
        );
        await file.delete();
        final removed = await scanner.scan(sourcesOf(appended));
        expect(removed.status, LedgerStatus.unavailable);
        expect(removed.sources, isEmpty);
      });
    });
  }
}
