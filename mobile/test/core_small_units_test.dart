import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/app_version.dart';
import 'package:harness_mobile/core/codex_profiles.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/crash_log.dart';
import 'package:harness_mobile/core/retry.dart';
import 'package:harness_mobile/core/snapshot_store.dart';

/// The small pieces of `core/` a phone runs on every launch: the retry the
/// machine list is fetched with, the backend's address, the crash log, the
/// snapshot files and the version shown in Settings.
void main() {
  group('withRetry', () {
    test('answers the first success', () async {
      var calls = 0;

      final value = await withRetry(() async {
        calls++;
        return 7;
      });

      expect(value, 7);
      expect(calls, 1);
    });

    test('retries only what it is told to, backing off', () async {
      var calls = 0;
      final started = DateTime.now();

      final value = await withRetry(
        () async {
          if (++calls < 3) throw const SocketException('blip');
          return 'ok';
        },
        initialDelay: const Duration(milliseconds: 5),
        isRetryable: (error) => error is SocketException,
      );

      expect(value, 'ok');
      expect(calls, 3);
      // 5ms, then 10ms: the delay doubles.
      expect(
        DateTime.now().difference(started),
        greaterThanOrEqualTo(const Duration(milliseconds: 15)),
      );
    });

    test('a refusal is not retried by default', () async {
      var calls = 0;

      await expectLater(
        withRetry(() async {
          calls++;
          throw StateError('refused');
        }),
        throwsStateError,
      );
      expect(calls, 1);
    });

    test('gives up after the last attempt with the last error', () async {
      var calls = 0;

      await expectLater(
        withRetry(
          () async {
            calls++;
            throw SocketException('attempt $calls');
          },
          maxAttempts: 2,
          initialDelay: Duration.zero,
          isRetryable: (_) => true,
        ),
        throwsA(
          isA<SocketException>().having(
            (e) => e.message,
            'message',
            'attempt 2',
          ),
        ),
      );
      expect(calls, 2);
    });
  });

  group('AppConfig', () {
    test('the socket is the API\'s host over ws or wss', () {
      expect(
        const AppConfig(apiBaseUrl: 'https://api.example.com/').wsBaseUrl,
        'wss://api.example.com',
      );
      expect(
        const AppConfig(apiBaseUrl: 'http://127.0.0.1:4000/v1').wsBaseUrl,
        'ws://127.0.0.1:4000',
      );
      expect(AppConfig.dev.autonomousEnv, 'prod');
    });
  });

  group('LocalCodexProfile', () {
    test('a profile with no label is named by its path', () {
      final bare = LocalCodexProfile.fromJson({'path': '/h/.codex'});
      final named = LocalCodexProfile.fromJson({
        'path': '/h/.codex-work',
        'label': 'Work',
      });

      expect((bare.path, bare.label), ('/h/.codex', '/h/.codex'));
      expect((named.path, named.label), ('/h/.codex-work', 'Work'));
    });
  });

  group('runningAppVersion', () {
    test('is what the package says, off Linux', () async {
      if (Platform.isLinux) return;
      expect(
        await runningAppVersion(packageInfoVersion: () async => '2.1.0'),
        '2.1.0',
      );
    });
  });

  group('snapshots', () {
    late Directory dir;

    setUp(() => dir = Directory.systemTemp.createTempSync('snapshot_test'));
    tearDown(() => dir.deleteSync(recursive: true));

    test(
      'a file snapshot round-trips, and clearing it is forgetting it',
      () async {
        final store = FileSnapshotStore('cache', directory: dir);

        expect(await store.read(), isNull);
        await store.write('{"a":1}');
        expect(await store.read(), '{"a":1}');
        expect(store.file.path, '${dir.path}/cache.json');
        expect(File('${store.file.path}.tmp').existsSync(), isFalse);

        await store.clear();
        expect(await store.read(), isNull);
        await store.clear();
      },
    );

    test(
      'a snapshot that cannot be written or read is simply not there',
      () async {
        // A directory where the file should be: every operation on it fails.
        final blocked = FileSnapshotStore('cache', directory: dir);
        Directory(blocked.file.path).createSync();

        await blocked.write('x');
        expect(await blocked.read(), isNull);
        await blocked.clear();
      },
    );

    test('the in-memory one keeps the same contract', () async {
      final store = MemorySnapshotStore();

      expect(store.isEmpty, isTrue);
      await store.write('y');
      expect(await store.read(), 'y');
      await store.clear();
      expect(store.isEmpty, isTrue);
    });
  });

  group('CrashLog', () {
    late Directory dir;

    setUp(() {
      dir = Directory.systemTemp.createTempSync('crash_log_test');
      CrashLog.testFile = File('${dir.path}/nested/errors.log');
    });

    tearDown(() {
      CrashLog.testFile = null;
      dir.deleteSync(recursive: true);
    });

    test('writes what threw and where, into a folder it makes', () {
      CrashLog.record(
        StateError('boom'),
        StackTrace.fromString('#0 main (x.dart:1)'),
        context: 'renderer',
      );

      final text = CrashLog.testFile!.readAsStringSync();
      expect(text, contains('[renderer] Bad state: boom'));
      expect(text, contains('#0 main (x.dart:1)'));
    });

    test('a record with no stack says where it was recorded from', () {
      CrashLog.record('plain', null);

      expect(CrashLog.testFile!.readAsStringSync(), contains('plain'));
    });

    test('an oversized log starts over rather than growing', () {
      CrashLog.testFile!
        ..parent.createSync(recursive: true)
        ..writeAsStringSync('x' * (300 * 1024));

      CrashLog.record('fresh', null);

      final text = CrashLog.testFile!.readAsStringSync();
      expect(text.length, lessThan(10 * 1024));
      expect(text, contains('fresh'));
    });

    test('a log that cannot be written is not a second failure', () {
      Directory(CrashLog.testFile!.path).createSync(recursive: true);

      CrashLog.record('lost', null);
    });

    test(
      'catches the framework\'s errors and the async ones, and passes them on',
      () {
        final previousFlutter = FlutterError.onError;
        final previousPlatform = PlatformDispatcher.instance.onError;
        final seen = <String>[];
        FlutterError.onError = (details) => seen.add('flutter');
        PlatformDispatcher.instance.onError = (error, stack) {
          seen.add('platform');
          return true;
        };
        addTearDown(() {
          FlutterError.onError = previousFlutter;
          PlatformDispatcher.instance.onError = previousPlatform;
        });

        CrashLog.install();
        FlutterError.onError!(
          FlutterErrorDetails(exception: StateError('layout')),
        );
        final handled = PlatformDispatcher.instance.onError!(
          StateError('async'),
          StackTrace.empty,
        );

        expect(seen, ['flutter', 'platform']);
        expect(handled, isTrue);
        final text = CrashLog.testFile!.readAsStringSync();
        expect(text, contains('[flutter] Bad state: layout'));
        expect(text, contains('[async] Bad state: async'));
      },
    );
  });
}
