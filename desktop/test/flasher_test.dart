import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/serial_port_lease.dart';
import 'package:harness/flash/flasher.dart';

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
        startProcess: (_) async => _FakeProcess(
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
        startProcess: (_) async => _FakeProcess(
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
          startProcess: (_) async => _FakeProcess(
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
      startProcess: (_) async {
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
      startProcess: (_) async {
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
      startProcess: (_) async {
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
        startProcess: (_) async {
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
      startProcess: (_) async => spawned,
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
        startProcess: (_) async => spawned,
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
      startProcess: (arguments) async {
        seen = arguments;
        return _FakeProcess(out: const []);
      },
    );
    await flasher.flash(port: "/dev/cu.o'dd");
    expect(seen, ['flash', '--yes', '--port', "/dev/cu.o'dd"]);
  });
}
