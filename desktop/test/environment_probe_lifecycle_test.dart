import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';

class _ProbeProcess implements Process {
  final output = StreamController<List<int>>();
  final errors = StreamController<List<int>>();
  final ended = Completer<int>();
  final signals = <ProcessSignal>[];
  @override
  final stdin = IOSink(StreamController<List<int>>.broadcast().sink);

  _ProbeProcess();

  _ProbeProcess.finished(List<int> bytes) {
    output.add(bytes);
    finish();
  }

  void finish() {
    unawaited(output.close());
    unawaited(errors.close());
    if (!ended.isCompleted) ended.complete(0);
  }

  @override
  Stream<List<int>> get stdout => output.stream;
  @override
  Stream<List<int>> get stderr => errors.stream;
  @override
  Future<int> get exitCode => ended.future;
  @override
  int get pid => 42;
  @override
  bool kill([ProcessSignal signal = ProcessSignal.sigterm]) {
    signals.add(signal);
    return true;
  }
}

void main() {
  late Directory scratch;
  late String node;
  final children = <_ProbeProcess>[];
  setUp(() async {
    scratch = await Directory.systemTemp.createTemp('harness-probe-test-');
    node = '${scratch.path}/runtime/node/bin/node';
    await File(node).parent.create(recursive: true);
    await File(node).writeAsString('test fixture');
    await File('${scratch.path}/runtime/current-node').writeAsString(node);
    final cli = File('${scratch.path}/cli/cli.js');
    await cli.parent.create(recursive: true);
    await cli.writeAsString('test fixture');
  });
  tearDown(() async {
    for (final child in children) {
      child.finish();
      await child.stdin.close();
    }
    children.clear();
    await scratch.delete(recursive: true);
  });

  _ProbeProcess healthy(List<String> arguments) {
    final value = arguments.contains('--version') ? 'v20.18.0' : 'ready';
    final child = _ProbeProcess.finished(utf8.encode(value));
    children.add(child);
    return child;
  }

  EnvironmentProvisioner provisioner(ProcessStarter start) =>
      EnvironmentProvisioner(
        harnessHome: scratch,
        isMacOS: true,
        isLinux: false,
        probeTimeout: const Duration(milliseconds: 20),
        start: start,
        // Never execute a real tool, even on the old Process.run path.
        run: (_, _, {environment}) => Completer<ProcessResult>().future,
        openTerminal: (_) async => fail('A check must not open an installer'),
      );

  Future<EnvironmentReadiness?> check(
    EnvironmentProvisioner setup, {
    void Function(EnvironmentReadiness)? onProgress,
  }) => setup
      .ensureReady(onProgress: onProgress ?? (_) {}, install: false)
      .then<EnvironmentReadiness?>((value) => value)
      .timeout(const Duration(milliseconds: 300), onTimeout: () => null);

  for (final stalled in ['shell', 'tmux', 'node', 'cli']) {
    test('$stalled timeout is a failed check, and Retry can recover', () async {
      final waiting = _ProbeProcess();
      children.add(waiting);
      var shouldHang = true;
      final calls = <String>[];
      final setup = provisioner((executable, arguments, {environment}) async {
        final command = '$executable ${arguments.join(' ')}';
        calls.add(command);
        final isTarget = switch (stalled) {
          'shell' => command.contains('test -w'),
          'tmux' => command.contains('command -v tmux'),
          'node' => arguments.contains('--version'),
          _ => arguments.contains('version'),
        };
        return shouldHang && isTarget ? waiting : healthy(arguments);
      });
      final updates = <EnvironmentReadiness>[];
      final result = await check(setup, onProgress: updates.add);
      expect(result, isNotNull, reason: 'Checking must stop waiting');
      expect(result!.phase, EnvironmentSetupPhase.failed);
      expect(result.isReady, isFalse);
      expect(result.failure?.title, 'Checking this computer took too long');
      expect(
        result.failure?.command,
        isNull,
        reason: 'Do not suggest installing',
      );
      expect(waiting.signals, [ProcessSignal.sigkill]);
      expect(waiting.output.hasListener, isFalse);
      expect(waiting.errors.hasListener, isFalse);
      expect(calls.any((call) => call.contains('install.sh')), isFalse);
      final lastUpdate = updates.last;
      waiting.finish();
      await Future<void>.delayed(Duration.zero);
      expect(identical(updates.last, lastUpdate), isTrue);

      shouldHang = false;
      final retry = await check(setup);
      expect(retry?.phase, EnvironmentSetupPhase.ready);
      expect(retry?.isReady, isTrue);
    });
  }

  test(
    'a process that starts after timeout is stopped without updating UI',
    () async {
      final starting = Completer<Process>();
      final setup = provisioner((_, _, {environment}) => starting.future);
      final updates = <EnvironmentReadiness>[];
      final result = await check(setup, onProgress: updates.add);
      expect(result?.phase, EnvironmentSetupPhase.failed);
      final count = updates.length;
      final late = _ProbeProcess();
      children.add(late);
      starting.complete(late);
      await Future<void>.delayed(Duration.zero);
      expect(late.signals, [ProcessSignal.sigkill]);
      expect(late.output.hasListener, isFalse);
      expect(late.errors.hasListener, isFalse);
      expect(updates, hasLength(count));
    },
  );

  test('inherited open pipes cannot hold a finished check forever', () async {
    final child = _ProbeProcess()..ended.complete(0);
    children.add(child);
    final setup = provisioner((_, _, {environment}) async => child);
    final result = await check(setup);
    expect(result?.phase, EnvironmentSetupPhase.failed);
    expect(
      child.signals,
      isEmpty,
      reason: 'Never signal an already exited PID',
    );
    expect(child.output.hasListener, isFalse);
    expect(child.errors.hasListener, isFalse);
  });

  test(
    'partial UTF-8 in tool output does not prevent a successful check',
    () async {
      final setup = provisioner((_, arguments, {environment}) async {
        final text = arguments.contains('--version') ? 'v20.18.0\n' : 'ready\n';
        final child = _ProbeProcess.finished([...utf8.encode(text), 0xff]);
        children.add(child);
        return child;
      });
      expect((await check(setup))?.isReady, isTrue);
      expect(children.every((child) => child.signals.isEmpty), isTrue);
    },
  );

  test(
    'an unreadable output pipe stops the owned check and offers retry',
    () async {
      final child = _ProbeProcess()
        ..errors.addError(StateError('Pipe unavailable'));
      children.add(child);
      final setup = provisioner((_, _, {environment}) async => child);
      final result = await check(setup);
      expect(result?.phase, EnvironmentSetupPhase.failed);
      expect(result?.failure?.title, 'Could not check this computer');
      expect(child.signals, [ProcessSignal.sigkill]);
      expect(child.output.hasListener, isFalse);
      expect(child.errors.hasListener, isFalse);
    },
  );

  test('an injected run-only check also has a bounded wait', () async {
    final setup = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: true,
      isLinux: false,
      probeTimeout: const Duration(milliseconds: 20),
      run: (_, _, {environment}) => Completer<ProcessResult>().future,
    );
    expect((await check(setup))?.phase, EnvironmentSetupPhase.failed);
  });

  test(
    'retrying a previous verification never reports ready before checking',
    () async {
      final child = _ProbeProcess();
      children.add(child);
      final setup = provisioner((_, _, {environment}) async => child);
      final updates = <EnvironmentReadiness>[];
      final previous = EnvironmentReadiness(
        steps: {
          for (final step in EnvironmentStep.values)
            step: EnvironmentStepStatus.ready,
        },
        phase: EnvironmentSetupPhase.failed,
        failure: const EnvironmentFailure(
          title: 'Verification failed',
          detail: 'Retry to check again.',
        ),
      );
      final result = await setup.ensureReady(
        resumeFrom: previous,
        onProgress: updates.add,
        install: false,
      );
      expect(result.phase, EnvironmentSetupPhase.failed);
      expect(updates.where((value) => value.isReady), isEmpty);
    },
  );

  test('Windows verification also returns a recoverable timeout', () async {
    final child = _ProbeProcess();
    children.add(child);
    final setup = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: false,
      isLinux: false,
      isWindows: true,
      probeTimeout: const Duration(milliseconds: 20),
      start: (_, _, {environment}) async => child,
      run: (_, _, {environment}) => Completer<ProcessResult>().future,
    );
    final result = await check(setup);
    expect(result?.phase, EnvironmentSetupPhase.failed);
    expect(result?.failure?.step, EnvironmentStep.harness);
    expect(child.signals, [ProcessSignal.sigkill]);
  });

  test('a timed-out native subprocess exits before another check', () async {
    Process? child;
    var exited = false;
    addTearDown(() {
      if (!exited) child?.kill(ProcessSignal.sigkill);
    });
    final started = Completer<Process>();
    final setup = provisioner((_, _, {environment}) async {
      final process = await Process.start('/bin/sleep', ['10']);
      child = process;
      unawaited(process.exitCode.then((_) => exited = true));
      started.complete(process);
      return process;
    });
    final result = await check(setup);
    expect(result?.phase, EnvironmentSetupPhase.failed);
    final process = await started.future.timeout(const Duration(seconds: 2));
    expect(
      await process.exitCode.timeout(const Duration(seconds: 2)),
      isNot(0),
    );
    expect(exited, isTrue);
  }, skip: Platform.isWindows);
}
