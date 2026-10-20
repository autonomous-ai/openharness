import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/serial_port_lease.dart';
import 'package:harness/flash/flasher.dart';
import 'package:harness/ws/local_cli_discovery.dart';

// Redirect only the default lease paths; all tested markers remain real files in a private cache.
final class _LeaseIo extends IOOverrides {
  _LeaseIo(this.directory) : original = SerialPortLease.flasherDirectory();
  final Directory directory;
  final String original;

  @override
  File createFile(String path) => path == '$original/flashing'
      ? super.createFile('${directory.path}/flashing')
      : super.createFile(path);

  @override
  Directory createDirectory(String path) =>
      path == original ? directory : super.createDirectory(path);
}

class _DownDiscovery extends LocalCliDiscovery {
  _DownDiscovery(Future<void> Function() spawn)
    : super(config: AppConfig.dev, spawnCommand: spawn);

  @override
  Future<LocalCliProbe> probe({String? expectedComputerId}) async =>
      const LocalCliProbe.down('fixture daemon stopped');
}

/// A process whose output is a script, so the parsing rules can be exercised
/// without a board, a cable, or a shell.
class _FakeProcess implements Process {
  _FakeProcess({
    required this.out,
    this.err = const [],
    this.code = 0,
    this.waitForKill = false,
  });

  final List<String> out;
  final List<String> err;
  final int code;

  /// Keeps running until something signals it — the only way to exercise a
  /// cancel, since a process that has already exited cannot be cancelled.
  final bool waitForKill;
  final List<ProcessSignal> signals = [];
  final Completer<int> _exit = Completer<int>();

  @override
  Stream<List<int>> get stdout =>
      Stream.value(utf8.encode(out.map((l) => '$l\n').join()));

  @override
  Stream<List<int>> get stderr =>
      Stream.value(utf8.encode(err.map((l) => '$l\n').join()));

  @override
  Future<int> get exitCode => waitForKill ? _exit.future : Future.value(code);

  @override
  bool kill([ProcessSignal signal = ProcessSignal.sigterm]) {
    signals.add(signal);
    if (!_exit.isCompleted) _exit.complete(code);
    return true;
  }

  @override
  int get pid => 4242;

  @override
  IOSink get stdin => throw UnimplementedError();
}

void main() {
  group('Windows persisted flash ownership', () {
    late Directory dir;
    late Map<String, String> leaseEnvironment;
    setUp(() {
      dir = Directory.systemTemp.createTempSync('flasher-owned-');
      leaseEnvironment = {'HARNESS_FLASHER_CACHE': dir.path};
    });
    tearDown(() => dir.deleteSync(recursive: true));

    File mark(String name) => File('${dir.path}/$name')
      ..writeAsStringSync('${DateTime.now().millisecondsSinceEpoch ~/ 1000}\n');

    test(
      'forced tree exit retires only its own real lease before resolving',
      () async {
        final spawned = _FakeProcess(out: [], code: 130, waitForKill: true);
        late File owned;
        final killFinished = Completer<void>();
        final killStarted = Completer<void>();
        var finished = false;
        final flasher = Flasher(
          windows: true,
          cancelDirectory: dir.path,
          killAfter: const Duration(milliseconds: 1),
          startProcess: (_, {Map<String, String>? environment}) async {
            final runId =
                environment?['HARNESS_FLASH_RUN_ID'] ?? 'missing-owner';
            owned = mark('flashing.$runId');
            return spawned;
          },
          killTree: (_) async {
            killStarted.complete();
            spawned.kill();
            await killFinished.future;
          },
        );
        final run = flasher.flash().then((value) {
          finished = true;
          return value;
        });
        await Future<void>.delayed(Duration.zero);
        try {
          expect(SerialPortLease.held, isTrue);
          expect(
            SerialPortLease.heldByAnotherProcess(environment: leaseEnvironment),
            isTrue,
          );
          flasher.cancel();
          await killStarted.future.timeout(const Duration(seconds: 2));
          await Future<void>.delayed(Duration.zero);
          expect(
            finished,
            isFalse,
            reason: 'parent exit alone is not proof that taskkill finished',
          );
          expect(SerialPortLease.held, isTrue);
          expect(owned.existsSync(), isTrue);
        } finally {
          if (!killFinished.isCompleted) killFinished.complete();
          spawned.kill();
          await run;
        }
        expect(owned.existsSync(), isFalse);
        expect(SerialPortLease.held, isFalse);
        expect(
          SerialPortLease.heldByAnotherProcess(environment: leaseEnvironment),
          isFalse,
        );
      },
    );

    test('successful kill still waits for parent exit before retiring the lease', () async {
      final spawned = _FakeProcess(out: [], code: 130, waitForKill: true);
      late File owned;
      final killed = Completer<void>();
      final flasher = Flasher(
        windows: true,
        cancelDirectory: dir.path,
        killAfter: const Duration(milliseconds: 1),
        startProcess: (_, {Map<String, String>? environment}) async {
          owned = mark(
            'flashing.${environment?['HARNESS_FLASH_RUN_ID'] ?? 'missing-owner'}',
          );
          return spawned;
        },
        killTree: (_) async {
          killed.complete();
        },
      );

      final run = flasher.flash();
      await Future<void>.delayed(Duration.zero);
      flasher.cancel();
      await killed.future.timeout(const Duration(seconds: 2));
      await Future<void>.delayed(Duration.zero);
      expect(owned.existsSync(), isTrue);
      expect(SerialPortLease.held, isTrue);
      spawned.kill();
      expect((await run).cancelled, isTrue);
      expect(owned.existsSync(), isFalse);
    });

    test('a real forced child exit unblocks explicit startup and timed supervision', () async {
      await IOOverrides.runWithIOOverrides(() async {
        Process? child;
        var spawned = 0;
        final supervised = Completer<void>();
        final discovery = _DownDiscovery(() async {
          spawned++;
          if (spawned == 2) supervised.complete();
        });
        final flasher = Flasher(
          windows: true,
          cancelDirectory: dir.path,
          killAfter: const Duration(milliseconds: 1),
          startProcess: (_, {Map<String, String>? environment}) async {
            mark('flashing.${environment!['HARNESS_FLASH_RUN_ID']}');
            return child = await Process.start(
              Platform.isWindows ? 'powershell.exe' : '/bin/sleep',
              Platform.isWindows
                  ? ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30']
                  : ['30'],
            );
          },
          killTree: (pid) async {
            if (!Process.killPid(pid, ProcessSignal.sigkill)) {
              throw StateError('fixture child did not terminate');
            }
          },
        );
        final run = flasher.flash();
        while (!flasher.isRunning) {
          await Future<void>.delayed(const Duration(milliseconds: 1));
        }
        Timer? timer;
        try {
          expect(SerialPortLease.heldByAnotherProcess(), isTrue);
          await discovery.ensureRunning(timeout: Duration.zero);
          expect(spawned, 0);
          timer = discovery.startSupervising(
            checkInterval: const Duration(milliseconds: 5),
            graceWindow: Duration.zero,
            spawnAfter: 1,
            spawnAllowedAt: (_) => true,
          );
          await Future<void>.delayed(const Duration(milliseconds: 25));
          expect(spawned, 0);
          timer.cancel();
          flasher.cancel();
          expect((await run).cancelled, isTrue);
          expect(SerialPortLease.held, isFalse);
          expect(SerialPortLease.heldByAnotherProcess(), isFalse);
          await discovery.ensureRunning(timeout: Duration.zero);
          expect(spawned, 1);
          timer = discovery.startSupervising(
            checkInterval: const Duration(milliseconds: 5),
            graceWindow: Duration.zero,
            spawnAfter: 1,
            spawnAllowedAt: (_) => true,
          );
          await supervised.future.timeout(const Duration(seconds: 2));
          expect(spawned, 2);
        } finally {
          timer?.cancel();
          child?.kill();
          await run;
        }
      }, _LeaseIo(dir));
    });

    test(
      'a cached older script keeps its unowned shared lease after forced exit',
      () async {
        final spawned = _FakeProcess(out: [], code: 130, waitForKill: true);
        late File legacy;
        final flasher = Flasher(
          windows: true,
          cancelDirectory: dir.path,
          killAfter: const Duration(milliseconds: 1),
          startProcess: (_, {environment}) async {
            legacy = mark('flashing');
            return spawned;
          },
          killTree: (_) async {
            spawned.kill();
          },
        );
        final run = flasher.flash();
        await Future<void>.delayed(Duration.zero);
        flasher.cancel();
        await run;
        expect(legacy.existsSync(), isTrue);
        expect(
          SerialPortLease.heldByAnotherProcess(environment: leaseEnvironment),
          isTrue,
        );
      },
    );

    for (final foreignName in ['flashing', 'flashing.${'b' * 32}']) {
      test('forced cleanup preserves a same-second foreign $foreignName', () async {
        final spawned = _FakeProcess(out: [], code: 130, waitForKill: true);
        late File owned;
        late File foreign;
        late String foreignContents;
        final flasher = Flasher(
          windows: true,
          cancelDirectory: dir.path,
          killAfter: const Duration(milliseconds: 1),
          startProcess: (_, {Map<String, String>? environment}) async {
            owned = mark(
              'flashing.${environment?['HARNESS_FLASH_RUN_ID'] ?? 'missing-owner'}',
            );
            return spawned;
          },
          killTree: (_) async {
            foreign = mark(foreignName);
            // Deliberately indistinguishable timestamps: run identity must decide ownership.
            foreignContents = owned.readAsStringSync();
            foreign.writeAsStringSync(foreignContents);
            foreign.setLastModifiedSync(owned.lastModifiedSync());
            spawned.kill();
          },
        );
        final run = flasher.flash();
        await Future<void>.delayed(Duration.zero);
        flasher.cancel();
        await run;
        expect(owned.existsSync(), isFalse);
        expect(foreign.readAsStringSync(), foreignContents);
        expect(SerialPortLease.held, isFalse);
        expect(
          SerialPortLease.heldByAnotherProcess(environment: leaseEnvironment),
          isTrue,
        );
      });
    }

    test('failed tree termination preserves its real persisted lease', () async {
      final spawned = _FakeProcess(out: [], code: 130, waitForKill: true);
      late File owned;
      final attempted = Completer<void>();
      final lines = <FlashLine>[];
      final flasher = Flasher(
        windows: true,
        cancelDirectory: dir.path,
        killAfter: const Duration(milliseconds: 1),
        startProcess: (_, {Map<String, String>? environment}) async {
          owned = mark(
            'flashing.${environment?['HARNESS_FLASH_RUN_ID'] ?? 'missing-owner'}',
          );
          return spawned;
        },
        killTree: (_) async {
          attempted.complete();
          throw StateError('access denied');
        },
      );
      final run = flasher.flash(onLine: lines.add);
      await Future<void>.delayed(Duration.zero);
      try {
        flasher.cancel();
        await attempted.future.timeout(const Duration(seconds: 2));
        await Future<void>.delayed(Duration.zero);
        expect(SerialPortLease.held, isTrue);
        expect(
          SerialPortLease.heldByAnotherProcess(environment: leaseEnvironment),
          isTrue,
        );
        expect(owned.existsSync(), isTrue);
        expect(lines.single.text, contains('access denied'));
      } finally {
        spawned.kill();
        await run;
      }
      expect(
        owned.existsSync(),
        isTrue,
        reason: 'a parent exit after failed taskkill does not establish writer exit',
      );
      expect(
        SerialPortLease.heldByAnotherProcess(environment: leaseEnvironment),
        isTrue,
      );
    });

    test('every invocation passes a distinct child-only owner and the chosen cache', () async {
      final owners = <String?>[];
      final flasher = Flasher(
        windows: true,
        cancelDirectory: dir.path,
        startProcess: (_, {Map<String, String>? environment}) async {
          owners.add(environment?['HARNESS_FLASH_RUN_ID']);
          expect(environment?['HARNESS_FLASHER_CACHE'], dir.path);
          return _FakeProcess(out: []);
        },
      );
      await flasher.flash();
      await flasher.flash();
      expect(owners, everyElement(matches(RegExp(r'^[0-9a-f]{32}$'))));
      expect(owners.toSet(), hasLength(2));
      expect(Platform.environment['HARNESS_FLASH_RUN_ID'], isNull);
    });
  });

  group('classifyFlashLine', () {
    test('a >> line opens a step, and loses its marker in the title', () {
      final line = classifyFlashLine(
        '>> flashing 0.0.39 → /dev/cu.usbmodem',
        stderr: false,
      );
      expect(line.kind, FlashLineKind.step);
      expect(line.title, 'flashing 0.0.39 → /dev/cu.usbmodem');
    });

    test('an indented line details the step it follows', () {
      expect(
        classifyFlashLine('   write app (0x10000)', stderr: false).kind,
        FlashLineKind.detail,
      );
    });

    test('error: wins over the stream it arrived on', () {
      // The script writes `die` to stderr, but a line that names itself an
      // error must read as one from either stream — the prefix is the claim.
      expect(
        classifyFlashLine('error: cancelled', stderr: true).kind,
        FlashLineKind.error,
      );
      expect(
        classifyFlashLine('error: cancelled', stderr: false).kind,
        FlashLineKind.error,
      );
    });

    test('anything else on stderr is a warning, not routine detail', () {
      expect(
        classifyFlashLine(
          '   sha256 mismatch — not installing',
          stderr: true,
        ).kind,
        FlashLineKind.warning,
      );
    });
  });

  group('probe', () {
    test('reads the port the script settled on', () async {
      final flasher = Flasher(
        startProcess: (_, {environment}) async => _FakeProcess(
          out: [
            '>> probing 2 serial port(s)…',
            '>> board: /dev/cu.usbmodem2101',
            '>> detect-only: nothing was written.',
          ],
        ),
      );
      final probe = await flasher.probe();
      expect(probe.found, isTrue);
      expect(probe.ports, ['/dev/cu.usbmodem2101']);
      expect(probe.problem, isNull);
    });

    test('a bare exit 1 still yields a reason to show', () async {
      final flasher = Flasher(
        startProcess: (_, {environment}) async => _FakeProcess(
          out: ['>> probing 1 serial port(s)…'],
          err: ['error: no ESP32-S3 found'],
          code: 1,
        ),
      );
      final probe = await flasher.probe();
      expect(probe.found, isFalse);
      // Stripped of the prefix: the dialog puts it under a heading that already
      // says something went wrong.
      expect(probe.problem, 'no ESP32-S3 found');
    });

    test(
      'names the permission case rather than calling it "not found"',
      () async {
        final flasher = Flasher(
          startProcess: (_, {environment}) async => _FakeProcess(
            out: ['>> probing 1 serial port(s)…'],
            err: ['   /dev/cu.usbmodem2101 — no permission'],
            code: 1,
          ),
        );
        expect(
          (await flasher.probe()).problem,
          'no permission to open the serial port',
        );
      },
    );
  });

  test('cancel asks with SIGTERM so the script can run its trap', () async {
    // SIGKILL would skip `trap start_harness_after_flash EXIT INT TERM`, which
    // is the only thing that restarts the daemon the script stopped.
    late _FakeProcess spawned;
    final flasher = Flasher(
      windows: false,
      startProcess: (_, {environment}) async {
        spawned = _FakeProcess(
          out: ['>> flashing…'],
          code: 143,
          waitForKill: true,
        );
        return spawned;
      },
    );
    final run = flasher.flash();
    await Future<void>.delayed(Duration.zero);
    flasher.cancel();
    final result = await run;

    expect(spawned.signals, [ProcessSignal.sigterm]);
    expect(result.cancelled, isTrue);
    expect(result.ok, isFalse);
  });

  test('Windows cancellation writes a file before ending an unresponsive tree', () async {
    final dir = Directory.systemTemp.createTempSync('flasher-cancel-');
    addTearDown(() => dir.deleteSync(recursive: true));
    late _FakeProcess spawned;
    final killed = <int>[];
    final flasher = Flasher(
      windows: true,
      cancelDirectory: dir.path,
      killAfter: const Duration(milliseconds: 50),
      killTree: (pid) async => killed.add(pid),
      startProcess: (_, {environment}) async {
        spawned = _FakeProcess(
          out: ['>> flashing…'],
          code: 130,
          waitForKill: true,
        );
        return spawned;
      },
    );
    final run = flasher.flash();
    await Future<void>.delayed(Duration.zero);
    flasher.cancel();

    expect(spawned.signals, isEmpty);
    expect(
      File('${dir.path}${Platform.pathSeparator}cancel').existsSync(),
      isTrue,
    );
    expect(killed, isEmpty);
    await Future<void>.delayed(const Duration(milliseconds: 120));
    expect(killed, [spawned.pid]);
    spawned
        .kill(); // Simulates the process tree ending, without running taskkill.
    final result = await run;
    expect(result.cancelled, isTrue);
    expect(result.ok, isFalse);
  });

  test('a Windows script that stops in time is not killed', () async {
    final dir = Directory.systemTemp.createTempSync('flasher-cancel-');
    addTearDown(() => dir.deleteSync(recursive: true));
    late _FakeProcess spawned;
    final killed = <int>[];
    final flasher = Flasher(
      windows: true,
      cancelDirectory: dir.path,
      killAfter: const Duration(milliseconds: 50),
      killTree: (pid) async => killed.add(pid),
      startProcess: (_, {environment}) async {
        spawned = _FakeProcess(out: const [], code: 130, waitForKill: true);
        return spawned;
      },
    );
    final run = flasher.flash();
    await Future<void>.delayed(Duration.zero);
    flasher.cancel();
    expect(spawned.signals, isEmpty);
    spawned.kill(); // Simulates the script seeing the file and exiting itself.
    final result = await run;
    await Future<void>.delayed(const Duration(milliseconds: 120));
    expect(killed, isEmpty);
    expect(result.cancelled, isTrue);
  });

  test(
    'a Windows cancel-file error still allows the grace period before killing',
    () async {
      final dir = Directory.systemTemp.createTempSync('flasher-cancel-');
      addTearDown(() => dir.deleteSync(recursive: true));
      final blocked = File('${dir.path}${Platform.pathSeparator}file')
        ..writeAsStringSync('');
      late _FakeProcess spawned;
      final killed = <int>[];
      final flasher = Flasher(
        windows: true,
        cancelDirectory: blocked.path,
        killAfter: const Duration(milliseconds: 50),
        killTree: (pid) async => killed.add(pid),
        startProcess: (_, {environment}) async {
          spawned = _FakeProcess(out: const [], code: 130, waitForKill: true);
          return spawned;
        },
      );
      final run = flasher.flash();
      await Future<void>.delayed(Duration.zero);
      flasher.cancel();
      expect(spawned.signals, isEmpty);
      expect(killed, isEmpty);
      await Future<void>.delayed(const Duration(milliseconds: 120));
      expect(killed, [spawned.pid]);
      spawned.kill();
      expect((await run).cancelled, isTrue);
    },
  );

  test('a failed Windows tree kill is logged while the flash still holds its lease', () async {
    final dir = Directory.systemTemp.createTempSync('flasher-cancel-');
    addTearDown(() => dir.deleteSync(recursive: true));
    final spawned = _FakeProcess(out: const [], code: 130, waitForKill: true);
    final lines = <FlashLine>[];
    var finished = false;
    final flasher = Flasher(
      windows: true,
      cancelDirectory: dir.path,
      killAfter: const Duration(milliseconds: 10),
      killTree: (_) async => throw StateError('tree termination failed'),
      startProcess: (_, {environment}) async => spawned,
    );
    final run = flasher.flash(onLine: lines.add).then((result) {
      finished = true;
      return result;
    });
    await Future<void>.delayed(Duration.zero);
    try {
      flasher.cancel();
      await Future<void>.delayed(const Duration(milliseconds: 50));
      final errors = lines.where((line) => line.kind == FlashLineKind.error);
      expect(errors, hasLength(1));
      expect(errors.single.text, contains('tree termination failed'));
      expect(flasher.isRunning, isTrue);
      expect(SerialPortLease.held, isTrue);
      expect(finished, isFalse);
      expect(spawned.signals, isEmpty);
    } finally {
      spawned.kill();
      await run;
    }
    expect(SerialPortLease.held, isFalse);
  });

  test(
    'a nonzero taskkill exit is logged and does not release a live flash',
    () async {
      final dir = Directory.systemTemp.createTempSync('flasher-cancel-');
      addTearDown(() => dir.deleteSync(recursive: true));
      final spawned = _FakeProcess(out: const [], code: 130, waitForKill: true);
      final lines = <FlashLine>[];
      String? executable;
      List<String>? arguments;
      var finished = false;
      final flasher = Flasher(
        windows: true,
        cancelDirectory: dir.path,
        killAfter: const Duration(milliseconds: 10),
        runProcess: (command, args) async {
          executable = command;
          arguments = args;
          return ProcessResult(7, 5, '', 'Access is denied.');
        },
        startProcess: (_, {environment}) async => spawned,
      );
      final run = flasher.flash(onLine: lines.add).then((result) {
        finished = true;
        return result;
      });
      await Future<void>.delayed(Duration.zero);
      try {
        flasher.cancel();
        await Future<void>.delayed(const Duration(milliseconds: 50));
        expect(executable, 'taskkill');
        expect(arguments, ['/PID', '${spawned.pid}', '/T', '/F']);
        final errors = lines.where((line) => line.kind == FlashLineKind.error);
        expect(errors, hasLength(1));
        expect(errors.single.text, contains('Access is denied.'));
        expect(flasher.isRunning, isTrue);
        expect(SerialPortLease.held, isTrue);
        expect(finished, isFalse);
        expect(spawned.signals, isEmpty);
      } finally {
        spawned.kill();
        await run;
      }
      expect(SerialPortLease.held, isFalse);
    },
  );

  test(
    'the dialog names this computer on Windows and keeps this Mac elsewhere',
    () {
      expect(flashHostName(windows: true), 'this computer');
      expect(flashHostName(windows: false), 'this Mac');
    },
  );

  test('a port stays one literal argv value', () async {
    List<String>? seen;
    final flasher = Flasher(
      startProcess: (arguments, {environment}) async {
        seen = arguments;
        return _FakeProcess(out: const []);
      },
    );
    await flasher.flash(port: "/dev/cu.o'dd");
    expect(seen, ['flash', '--yes', '--port', "/dev/cu.o'dd"]);
  });
}
