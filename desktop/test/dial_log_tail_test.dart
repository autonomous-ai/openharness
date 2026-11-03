import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/logging/dial_log_tail.dart';
import 'package:harness/logging/log_export.dart';
import 'package:harness/logging/log_file.dart';
import 'package:harness/logging/log_stream.dart';

void main() {
  test('parseDialLine strips the stamp and reads the level', () {
    final w = parseDialLine('2026-09-15T03:53:52.001Z W (27793) touch: dead');
    expect(w.level, AppLogLevel.warn);
    expect(w.message, 'W (27793) touch: dead');
    final d = parseDialLine('2026-09-15T03:56:22.418Z [daemon] open on /dev/x');
    expect(d.level, AppLogLevel.info);
    expect(d.message, '[daemon] open on /dev/x');
    expect(parseDialLine('no stamp E (1) x').level, AppLogLevel.info);
    expect(parseDialLine('E (1) x').level, AppLogLevel.error);
  });

  test('tails the day file into the stream, only what is new', () async {
    final dir = Directory.systemTemp.createTempSync('dial-tail-');
    addTearDown(() => dir.deleteSync(recursive: true));
    final now = DateTime(2026, 9, 15, 10);
    final file = File('${dir.path}/${dailyLogName(kDialLogBase, now)}');
    file.writeAsStringSync('2026-09-15T03:00:00.000Z I (1) ui: face: agent\n');
    final stream = LogStream();
    final tail = DialLogTail(dir, stream, clock: () => now);
    await tail.poll();
    expect(stream.entries.map((e) => e.message), ['I (1) ui: face: agent']);
    // A partial line waits for its newline.
    file.writeAsStringSync(
      '2026-09-15T03:00:01.000Z W (2) touch: pre',
      mode: FileMode.append,
    );
    await tail.poll();
    expect(stream.entries.length, 1);
    file.writeAsStringSync(
      'ss (1,2)\n2026-09-15T03:00:02.000Z [daemon] agents → 3\n',
      mode: FileMode.append,
    );
    await tail.poll();
    expect(stream.entries.map((e) => e.message).toList(), [
      '[daemon] agents → 3',
      'W (2) touch: press (1,2)',
      'I (1) ui: face: agent',
    ]);
    expect(stream.entries.every((e) => e.category == 'dial'), isTrue);
    expect(stream.entries[1].level, AppLogLevel.warn);
    // Nothing new: nothing added.
    await tail.poll();
    expect(stream.entries.length, 3);
  });

  test(
    'a big file is joined at its tail, dropping the opening fragment',
    () async {
      final dir = Directory.systemTemp.createTempSync('dial-tail-');
      addTearDown(() => dir.deleteSync(recursive: true));
      final now = DateTime(2026, 9, 15, 10);
      final file = File('${dir.path}/${dailyLogName(kDialLogBase, now)}');
      final sb = StringBuffer();
      for (var i = 0; i < 2000; i++) {
        sb.writeln(
          '2026-09-15T03:00:00.000Z I ($i) ui: line number $i padding padding',
        );
      }
      file.writeAsStringSync(sb.toString());
      final stream = LogStream();
      await DialLogTail(dir, stream, clock: () => now).poll();
      expect(stream.entries.length, lessThan(2000));
      expect(
        stream.entries.first.message,
        'I (1999) ui: line number 1999 padding padding',
      );
      // Every entry is a whole line — no fragment from the window's opening.
      for (final e in stream.entries) {
        expect(e.message, startsWith('I ('));
      }
    },
  );

  group('per-device folders', () {
    late Directory dir;
    final now = DateTime(2026, 10, 28, 10);
    final today = dailyLogName(kDialLogBase, now);

    setUp(() {
      dir = Directory.systemTemp.createTempSync('dial-tail-');
      addTearDown(() => dir.deleteSync(recursive: true));
    });

    File deviceFile(String folder, [String? name]) {
      final file = File('${dir.path}/$folder/${name ?? today}');
      file.parent.createSync(recursive: true);
      return file;
    }

    test(
      'each device folder reaches the stream tagged with its device',
      () async {
        deviceFile(
          'usb-AA-BB',
        ).writeAsStringSync('2026-10-28T03:00:00.000Z I (1) ui: face: agent\n');
        deviceFile('usb-CC-DD')
            .writeAsStringSync('2026-10-28T03:00:01.000Z E (2) cable: lost\n');
        final stream = LogStream();
        await DialLogTail(dir, stream, clock: () => now).poll();
        expect(stream.entries.map((e) => e.message).toSet(), {
          '[AA-BB] I (1) ui: face: agent',
          '[CC-DD] E (2) cable: lost',
        });
        expect(stream.entries.every((e) => e.category == 'dial'), isTrue);
        final lost = stream.entries.firstWhere(
          (e) => e.message.startsWith('[CC-DD]'),
        );
        expect(lost.level, AppLogLevel.error);
      },
    );

    test('a device folder that appears after start is followed on the next '
        'poll', () async {
      deviceFile('usb-AA-BB')
          .writeAsStringSync('2026-10-28T03:00:00.000Z I (1) ui: one\n');
      final stream = LogStream();
      final tail = DialLogTail(dir, stream, clock: () => now);
      await tail.poll();
      deviceFile('usb-EE-FF')
          .writeAsStringSync('2026-10-28T03:00:02.000Z I (3) ui: plugged\n');
      await tail.poll();
      expect(stream.entries.first.message, '[EE-FF] I (3) ui: plugged');
      expect(tail.devices, ['AA-BB', 'EE-FF']);
    });

    test('a top-level day file from an older daemon is still read', () async {
      File('${dir.path}/$today')
          .writeAsStringSync('2026-10-28T03:00:00.000Z [daemon] old layout\n');
      deviceFile('usb-AA-BB')
          .writeAsStringSync('2026-10-28T03:00:01.000Z I (1) ui: new layout\n');
      final stream = LogStream();
      await DialLogTail(dir, stream, clock: () => now).poll();
      expect(stream.entries.map((e) => e.message).toSet(), {
        '[daemon] old layout',
        '[AA-BB] I (1) ui: new layout',
      });
    });

    test('a folder that goes away is no longer followed', () async {
      final file = deviceFile('usb-AA-BB')
        ..writeAsStringSync('2026-10-28T03:00:00.000Z I (1) ui: one\n');
      final stream = LogStream();
      final tail = DialLogTail(dir, stream, clock: () => now);
      await tail.poll();
      expect(tail.devices, ['AA-BB']);
      file.parent.deleteSync(recursive: true);
      await tail.poll();
      expect(tail.devices, isEmpty);
      expect(stream.entries.length, 1);
    });

    test('a folder without a file for today is not followed', () async {
      deviceFile(
        'usb-AA-BB',
        'dial-20261027.log',
      ).writeAsStringSync('2026-10-27T03:00:00.000Z I (1) ui: yesterday\n');
      final stream = LogStream();
      final tail = DialLogTail(dir, stream, clock: () => now);
      await tail.poll();
      expect(tail.devices, isEmpty);
      expect(stream.entries, isEmpty);
    });

    test('the day rolling over moves each device to its new file', () async {
      var clock = now;
      deviceFile('usb-AA-BB')
          .writeAsStringSync('2026-10-28T23:59:59.000Z I (1) ui: late\n');
      final stream = LogStream();
      final tail = DialLogTail(dir, stream, clock: () => clock);
      await tail.poll();
      clock = DateTime(2026, 10, 29, 0, 0, 1);
      deviceFile(
        'usb-AA-BB',
        dailyLogName(kDialLogBase, clock),
      ).writeAsStringSync('2026-10-29T00:00:00.500Z I (2) ui: early\n');
      await tail.poll();
      expect(stream.entries.map((e) => e.message).toList(), [
        '[AA-BB] I (2) ui: early',
        '[AA-BB] I (1) ui: late',
      ]);
    });

    test(
      'past the cap, extra devices are not tailed and that is said once',
      () async {
        for (final id in ['AA', 'BB', 'CC']) {
          deviceFile('usb-$id')
              .writeAsStringSync('2026-10-28T03:00:00.000Z I (1) ui: $id\n');
        }
        final stream = LogStream();
        final tail = DialLogTail(dir, stream, clock: () => now, maxDevices: 2);
        await tail.poll();
        await tail.poll();
        expect(tail.devices, ['AA', 'BB']);
        final messages = stream.entries.map((e) => e.message).toList();
        expect(messages.where((m) => m.contains('[CC]')), isEmpty);
        expect(
          messages.where((m) => m == '1 more dial log not followed (limit 2)'),
          hasLength(1),
        );
      },
    );
  });

  test('a poll started while one is running reads nothing twice', () async {
    final dir = Directory.systemTemp.createTempSync('dial-tail-');
    addTearDown(() => dir.deleteSync(recursive: true));
    final now = DateTime(2026, 10, 28, 10);
    final today = dailyLogName(kDialLogBase, now);
    for (final folder in ['usb-AA', 'usb-BB']) {
      final file = File('${dir.path}/$folder/$today');
      file.parent.createSync();
      file.writeAsStringSync('2026-10-28T03:00:00.000Z I (1) ui: $folder\n');
    }
    final stream = LogStream();
    final tail = DialLogTail(dir, stream, clock: () => now);
    await Future.wait([tail.poll(), tail.poll()]);
    expect(stream.entries.map((e) => e.message).toList()..sort(), [
      '[AA] I (1) ui: usb-AA',
      '[BB] I (1) ui: usb-BB',
    ]);
  });

  test('parseLogExport reads the CLI answer', () {
    final ok = parseLogExport(
      '{"path":"/x/harness-logs.zip","included":["a"],"bytes":1}',
    );
    expect(ok.path, '/x/harness-logs.zip');
    expect(ok.included, ['a']);
    expect(ok.error, isNull);
    expect(parseLogExport('nope').error, contains('unreadable'));
    expect(parseLogExport('{"bytes":1}').error, 'no path in answer');
  });
}
