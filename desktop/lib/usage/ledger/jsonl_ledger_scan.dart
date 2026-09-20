import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'ledger_scanner.dart';
import 'ledger_types.dart';

/// Shared file lifecycle; each provider retains its own usage parser.
Future<LedgerScanResult> scanJsonlUsage({
  required LedgerProvider provider,
  required List<String> roots,
  required Map<String, ScannedSource> previous,
  required String missingMessage,
  required Future<List<LedgerEntry>> Function(File file, int length) parse,
}) async {
  final failures = <String>[];
  final files = <String, File>{};
  for (final root in roots) {
    try {
      await for (final entity in Directory(
        root,
      ).list(recursive: true, followLinks: false)) {
        if (entity is File && entity.path.endsWith('.jsonl')) {
          files[entity.path] = entity;
        }
      }
    } on FileSystemException catch (error) {
      // Unused/older roots normally do not exist. Other listing failures must
      // not look like a provider that simply has no logs on this machine.
      if (error.osError?.errorCode != 2 &&
          !(Platform.isWindows && error.osError?.errorCode == 3)) {
        failures.add(error.osError?.message ?? error.message);
      }
    }
  }

  final sources = <ScannedSource>[];
  final paths = files.keys.toList()..sort();
  for (final path in paths) {
    final file = files[path]!;
    try {
      final stat = await file.stat();
      if (stat.type != FileSystemEntityType.file) {
        failures.add(
          'A transcript changed while scanning. Refresh to read it again.',
        );
        continue;
      }
      final cached = previous[path];
      if (cached != null && cached.matches(stat)) {
        sources.add(cached);
        continue;
      }
      final entries = await parse(file, stat.size);
      sources.add(
        ScannedSource(
          path: path,
          mtimeMs: stat.modified.millisecondsSinceEpoch,
          size: stat.size,
          entries: entries,
        ),
      );
    } on FileSystemException catch (error) {
      failures.add(error.osError?.message ?? error.message);
    } on FormatException {
      failures.add('A transcript contains unreadable text.');
    }
  }

  if (failures.isEmpty && files.isEmpty) {
    return LedgerScanResult.unavailable(missingMessage);
  }
  return LedgerScanResult(
    sources: sources,
    status: failures.isEmpty
        ? LedgerStatus.ok
        : sources.isEmpty
        ? LedgerStatus.failed
        : LedgerStatus.partial,
    message: failures.isEmpty
        ? null
        : sources.isEmpty
        ? 'Could not read ${provider.label} usage: ${failures.first}'
        : 'Some ${provider.label} usage could not be read. '
              'Figures are incomplete. ${failures.first}',
  );
}

/// Read only the bytes that existed when scanning started. Holding back the
/// final four bytes keeps an unfinished UTF-8 character in the final record
/// from discarding earlier complete records while an agent appends to its log.
/// Corrupt completed lines still fail the source. A valid last line needs no LF.
Stream<String> readJsonlLines(File file, int length) {
  var pending = Uint8List(0);
  final completeBytes = StreamTransformer<List<int>, List<int>>.fromHandlers(
    handleData: (chunk, sink) {
      if (chunk.length >= 4) {
        if (pending.isNotEmpty) sink.add(pending);
        if (chunk.length > 4) sink.add(_slice(chunk, 0, chunk.length - 4));
        pending = Uint8List.fromList(
          _slice(chunk, chunk.length - 4, chunk.length),
        );
      } else {
        final combined = Uint8List(pending.length + chunk.length)
          ..setRange(0, pending.length, pending)
          ..setRange(pending.length, pending.length + chunk.length, chunk);
        final keepFrom = combined.length > 4 ? combined.length - 4 : 0;
        if (keepFrom > 0) {
          sink.add(Uint8List.sublistView(combined, 0, keepFrom));
        }
        pending = Uint8List.sublistView(combined, keepFrom);
      }
    },
    handleDone: (sink) {
      final end = pending.length - _unfinishedUtf8Length(pending);
      if (end > 0) sink.add(Uint8List.sublistView(pending, 0, end));
      sink.close();
    },
  );
  return file
      .openRead(0, length)
      .transform(completeBytes)
      .transform(utf8.decoder)
      .transform(const LineSplitter());
}

List<int> _slice(List<int> bytes, int start, int end) => bytes is Uint8List
    ? Uint8List.sublistView(bytes, start, end)
    : bytes.sublist(start, end);

int _unfinishedUtf8Length(Uint8List bytes) {
  var start = bytes.length - 1;
  while (start >= 0 && (bytes[start] & 0xc0) == 0x80) {
    start--;
  }
  if (start < 0) return 0;
  final lead = bytes[start];
  final expected = switch (lead) {
    >= 0xc2 && <= 0xdf => 2,
    >= 0xe0 && <= 0xef => 3,
    >= 0xf0 && <= 0xf4 => 4,
    _ => 0,
  };
  final available = bytes.length - start;
  if (expected == 0 || available >= expected) return 0;
  if (available > 1) {
    final next = bytes[start + 1];
    if ((lead == 0xe0 && next < 0xa0) ||
        (lead == 0xed && next >= 0xa0) ||
        (lead == 0xf0 && next < 0x90) ||
        (lead == 0xf4 && next >= 0x90)) {
      return 0;
    }
  }
  // Earlier bytes still pass through the strict decoder, including when they
  // precede an unfinished character. Only a valid incomplete suffix is omitted.
  return available;
}
