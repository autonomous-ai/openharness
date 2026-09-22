// Native Release benchmark. Run only through the isolated copy from prepare.py.
// The fixture uses the production Swarm screen, sessions, parser and renderer;
// all machines, transports, terminal output and storage are disposable.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/harness_file_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';

import 'flutter_driver.dart';

const _host = MethodChannel('harness/isolated_benchmark');
final _timings = <int, ui.FrameTiming>{};
final _samples = <_Sample>[];
final _sequences = <String, int>{};
_Sample? _pending;
Timer? _outputTimer;
bool _burstPending = false;
int _outputBytes = 0;
int _skippedBursts = 0;
int _inputBytes = 0;
final _interactive = Platform.environment['HARNESS_BENCH_MANUAL'] == '1';
final _flutterDriven = Platform.environment['HARNESS_BENCH_FLUTTER'] == '1';

class _Sample {
  _Sample(
    this.operation,
    this.phase,
    this.load,
    this.expectedSwarm,
    this.expectedPane,
  );
  final String operation, phase, load, expectedSwarm;
  final int expectedPane;
  final done = Completer<void>();
  int? queued, observed, postFrame, frame;
  String? nativeResponder;

  void observe() {
    if (observed != null) return;
    observed = DateTime.now().microsecondsSinceEpoch;
    SchedulerBinding.instance.addPostFrameCallback((_) {
      frame = ui.PlatformDispatcher.instance.frameData.frameNumber;
      postFrame = DateTime.now().microsecondsSinceEpoch;
      done.complete();
    });
    SchedulerBinding.instance.ensureVisualUpdate();
  }

  Map<String, Object?> toJson() {
    final timing = _timings[frame];
    return {
      'operation': operation,
      'phase': phase,
      'load': load,
      'frame': frame,
      'nativeResponder': nativeResponder,
      'queuedWallMicros': queued,
      'observedWallMicros': observed,
      'postFrameWallMicros': postFrame,
      if (timing != null) ...{
        'rasterFinishWallMicros': timing.timestampInMicroseconds(
          ui.FramePhase.rasterFinishWallTime,
        ),
        'buildMicros': timing.buildDuration.inMicroseconds,
        'rasterMicros': timing.rasterDuration.inMicroseconds,
        'eventToObservedMicros': observed! - queued!,
        'eventToRasterMicros':
            timing.timestampInMicroseconds(ui.FramePhase.rasterFinishWallTime) -
            queued!,
      },
    };
  }
}

Future<void> _output(TerminalSession session, List<int> bytes) =>
    session.handleBinary(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.output,
        streamId: session.streamId!,
        seq: _sequences.update(session.agentId, (value) => value + 1) - 1,
        bytes: bytes is Uint8List ? bytes : Uint8List.fromList(bytes),
        compressed: false,
      ),
    );

Future<AppNotifier> _fixture(int count, Directory stateDirectory) async {
  final app = AppNotifier(
    config: const AppConfig(
      apiBaseUrl: 'http://127.0.0.1:1',
      localCliBaseUrl: 'http://127.0.0.1:1',
    ),
    authSession: AuthSession(),
    paneLayoutStore: PaneLayoutStore(
      storage: HarnessFileStore(directory: stateDirectory),
    ),
    connectionForTest: (_) =>
        throw StateError('The benchmark cannot attach a transport'),
  )..hasNavigationRail = false;
  const machine = Machine(
    machineId: 'fixture',
    name: 'Isolated fixture',
    authMode: MachineAuthMode.remote,
  );
  app.machines = [machine];
  app.machineStates[machine.machineId] = MachineState(machine)
    ..nodeOnline = true
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..agents = [
      for (var i = 0; i < count; i++)
        Agent(
          id: 'fixture-$i',
          name: 'Fixture agent $i',
          engine: 'codex',
          terminalAvailable: true,
        ),
    ];
  final first = app.activeSwarmId;
  for (var i = 0; i < count; i++) {
    if (i % 4 == 0) {
      if (i != 0) app.newSwarm();
      app.renameSwarm(app.activeSwarmId, 'Fixture ${i ~/ 4 + 1}');
    }
    late TerminalSession session;
    session = TerminalSession(
      machineId: machine.machineId,
      agentId: 'fixture-$i',
      agentName: 'Fixture agent $i',
      engineId: 'codex',
      send: (_, _) async => true,
      sendBinary: (packet) async {
        if (packet.kind != TerminalBinaryKind.input) return true;
        if (_interactive || _flutterDriven) {
          await _output(session, packet.bytes);
          return true;
        }
        final sample = _pending;
        if (sample == null ||
            sample.operation != 'typing' ||
            packet.bytes.length != 1 ||
            packet.bytes.any((byte) => byte != 120) ||
            app.activeSwarmId != sample.expectedSwarm ||
            app.focusedPaneId != sample.expectedPane ||
            !identical(app.focusedPane?.session, session)) {
          final error = StateError(
            'Unexpected input: session ${session.agentId}, '
            'focused ${app.focusedPane?.session?.agentId}, '
            'bytes ${packet.bytes}, pending ${sample?.operation}',
          );
          stderr.writeln(error);
          throw error;
        }
        _inputBytes += packet.bytes.length;
        // Zero-RTT echo through the actual output decoder/parser, not a widget label.
        await _output(session, packet.bytes);
        sample.observe();
        return true;
      },
    )..streamId = 'fixture-stream-$i';
    _sequences[session.agentId] = 1;
    await session.handleBinary(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.keyframe,
        streamId: session.streamId!,
        seq: 0,
        bytes: utf8.encode(
          List.generate(
            1000,
            (row) =>
                '\x1b[32m$row\x1b[0m  retained terminal output with project context\r\n',
          ).join(),
        ),
        compressed: false,
        cols: 160,
        rows: 40,
      ),
    );
    // This executable is an isolated native test fixture.
    // ignore: invalid_use_of_visible_for_testing_member
    app.adoptSessionForTest(session);
  }
  app.selectSwarm(first, attachPending: false);
  app.addListener(() {
    final sample = _pending;
    if (sample != null &&
        sample.operation != 'typing' &&
        app.activeSwarmId == sample.expectedSwarm &&
        app.focusedPaneId == sample.expectedPane) {
      sample.observe();
    }
  });
  return app;
}

Future<void> _frame() async {
  SchedulerBinding.instance.scheduleFrame();
  await SchedulerBinding.instance.endOfFrame;
}

Future<void> _sample(
  AppNotifier app,
  String operation,
  String phase,
  String load,
) async {
  var expectedSwarm = app.activeSwarm;
  var expectedPane = app.focusedPaneId!;
  var index = 0;
  if (operation == 'focus') {
    index = (app.panes.indexWhere((p) => p.id == expectedPane) + 1) % 4;
    expectedPane = app.panes[index].id;
  } else if (operation == 'tab') {
    expectedSwarm = app
        .swarms[(app.swarms.indexOf(app.activeSwarm) + 1) % app.swarms.length];
    expectedPane = expectedSwarm.focusedPaneId!;
  }
  final sample = _Sample(
    operation,
    phase,
    load,
    expectedSwarm.id,
    expectedPane,
  );
  _samples.add(sample);
  _pending = sample;
  final reply = await _host.invokeMapMethod<String, Object?>('key', {
    'operation': operation,
    'index': index + 1,
  });
  sample.queued = reply!['queuedWallMicros'] as int;
  sample.nativeResponder = reply['responder'] as String?;
  await sample.done.future.timeout(
    const Duration(seconds: 3),
    onTimeout: () => throw StateError(
      '$operation did not reach its expected pane/frame: '
      'expected ${sample.expectedSwarm}/${sample.expectedPane}, '
      'actual ${app.activeSwarmId}/${app.focusedPaneId}, '
      'Dart focus ${FocusManager.instance.primaryFocus?.debugLabel}, '
      'native responder ${sample.nativeResponder}',
    ),
  );
  _pending = null;
}

Map<String, num> _distribution(Iterable<int> values) {
  final sorted = values.toList()..sort();
  num percentile(double p) =>
      sorted[(sorted.length * p).ceil().clamp(1, sorted.length) - 1] / 1000;
  return {
    'samples': sorted.length,
    'p50Ms': percentile(.50),
    'p95Ms': percentile(.95),
    'p99Ms': percentile(.99),
    'maxMs': sorted.last / 1000,
  };
}

Future<void> _run() async {
  final env = Platform.environment;
  if (env['HARNESS_NATIVE_BENCHMARK'] != '1' ||
      !env.containsKey('FLUTTER_TEST')) {
    throw StateError('Use the isolated native benchmark runner');
  }
  final output = env['HARNESS_BENCH_OUTPUT'];
  if (output == null || !output.startsWith('/private/tmp/')) {
    throw StateError('A private temporary output path is required');
  }
  final count = int.parse(env['HARNESS_BENCH_TERMINALS'] ?? '16');
  final observations = int.parse(env['HARNESS_BENCH_SAMPLES'] ?? '120');
  if (![16, 48].contains(count) || observations < 1 || observations > 500) {
    throw StateError('Invalid fixture size');
  }
  final binding = WidgetsFlutterBinding.ensureInitialized();
  binding.addTimingsCallback((values) {
    for (final value in values) {
      _timings[value.frameNumber] = value;
    }
  });
  await const MethodChannel('harness/swarm_tabs')
      .invokeMethod<void>('configure');
  final metadata = await _host.invokeMapMethod<String, Object?>('ready');
  if (metadata?['bundle'] != 'ai.autonomous.harness.benchmark') {
    throw StateError('Wrong native host');
  }
  final app = await _fixture(
    count,
    Directory(
      '${File(output).parent.path}/state-$count-${DateTime.now().microsecondsSinceEpoch}',
    ),
  );
  final projects = SwarmProjectStore();
  // Production defaults to this path; FLUTTER_TEST otherwise selects a legacy
  // creation form for older tests. Exercise the actual Cmd-N box here.
  newHarnessOpensInBox = true;
  runApp(
    grid.BrightnessScope(
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: SwarmScreen(
          notifier: app,
          nativeTabs: true,
          projectStore: projects,
        ),
      ),
    ),
  );
  await _frame();
  if (_interactive) return;
  await Future<void>.delayed(const Duration(seconds: 1));
  if (_flutterDriven) {
    try {
      await runFlutterDispatchBenchmark(app, output, metadata!, _timings);
    } catch (error, stack) {
      await File(output).writeAsString(
        jsonEncode({'success': false, 'error': '$error', 'stack': '$stack'}),
      );
    } finally {
      await _host.invokeMethod<void>('finish');
    }
    return;
  }
  final random = Random(77);
  final phases = <Map<String, Object?>>[];
  try {
    metadata!['initialResponder'] = await _host.invokeMethod<String>('begin');
    for (final op in ['typing', 'focus', 'tab']) {
      await _sample(app, op, 'cold_interaction', 'idle');
    }
    // Visit all tabs so the warm workload includes every retained renderer.
    for (var i = 0; i < app.swarms.length * 2; i++) {
      app.stepSwarm(1);
      await _frame();
    }
    final packet = utf8.encode(
      '\x1b7\x1b[1;1H${List.filled(8, '${List.filled(110, 'output ').join().substring(0, 110)}\x1b[K\r\n').join()}\x1b8',
    );
    for (final load in ['idle', 'all_terminals_20hz']) {
      final began = DateTime.now().microsecondsSinceEpoch;
      final bytesBefore = _outputBytes;
      if (load != 'idle') {
        _outputTimer = Timer.periodic(const Duration(milliseconds: 50), (
          _,
        ) async {
          if (_burstPending) {
            _skippedBursts++;
            return;
          }
          _burstPending = true;
          try {
            await Future.wait([
              for (final pane in app.allPanes) _output(pane.session!, packet),
            ]);
            _outputBytes += packet.length * count;
          } finally {
            _burstPending = false;
          }
        });
      }
      for (final op in ['typing', 'focus', 'tab']) {
        for (var i = 0; i < 20 + observations; i++) {
          await Future<void>.delayed(
            Duration(milliseconds: 20 + random.nextInt(40)),
          );
          await _sample(app, op, i < 20 ? 'warmup' : 'measured', load);
        }
      }
      _outputTimer?.cancel();
      _outputTimer = null;
      phases.add({
        'load': load,
        'durationMicros': DateTime.now().microsecondsSinceEpoch - began,
        'outputBytes': _outputBytes - bytesBefore,
        'skippedBursts': _skippedBursts,
        'packetBytesPerTerminal': packet.length,
      });
    }
    // Release engines batch timing delivery; retain exact frame IDs before joining.
    for (
      var i = 0;
      i < 25 && _samples.any((s) => !_timings.containsKey(s.frame));
      i++
    ) {
      await _frame();
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    final rows = _samples.map((sample) => sample.toJson()).toList();
    if (rows.any(
      (row) =>
          row['eventToRasterMicros'] is! int ||
          (row['eventToRasterMicros'] as int) < 0,
    )) {
      throw StateError('Missing or invalid exact-frame timing');
    }
    if (_inputBytes !=
        _samples.where((sample) => sample.operation == 'typing').length) {
      throw StateError('Native typing produced duplicate or missing input');
    }
    final summaries = <Map<String, Object?>>[];
    for (final load in ['idle', 'all_terminals_20hz']) {
      for (final op in ['typing', 'focus', 'tab']) {
        final group = rows
            .where(
              (row) =>
                  row['load'] == load &&
                  row['operation'] == op &&
                  row['phase'] == 'measured',
            )
            .toList();
        summaries.add({
          'operation': op,
          'load': load,
          'eventToRaster': _distribution(
            group.map((row) => row['eventToRasterMicros'] as int),
          ),
          'eventToObserved': _distribution(
            group.map((row) => row['eventToObservedMicros'] as int),
          ),
          'build': _distribution(group.map((row) => row['buildMicros'] as int)),
          'raster': _distribution(
            group.map((row) => row['rasterMicros'] as int),
          ),
        });
      }
    }
    await File(output).writeAsString(
      const JsonEncoder.withIndent('  ').convert({
        'success': true,
        'kind': 'native_release_event_to_raster',
        'terminals': count,
        'visible': 4,
        'initialScrollbackRows': 1000,
        'metadata': metadata,
        'inputBytes': _inputBytes,
        'phases': phases,
        'summaries': summaries,
        'samples': rows,
      }),
    );
    stdout.writeln(
      'NATIVE_BENCH ${jsonEncode({'terminals': count, 'summaries': summaries})}',
    );
  } catch (error, stack) {
    await File(output).writeAsString(
      jsonEncode({
        'success': false,
        'error': '$error',
        'stack': '$stack',
        'samples': _samples.map((s) => s.toJson()).toList(),
      }),
    );
    stderr.writeln('Native benchmark failed: $error');
  } finally {
    _outputTimer?.cancel();
    runApp(const SizedBox());
    await _frame();
    await app.flushPaneLayout();
    app.dispose();
    projects.dispose();
    await _host.invokeMethod<void>('finish');
  }
}

void main() {
  runZonedGuarded(
    () => HttpOverrides.runZoned(
      () => unawaited(_run()),
      createHttpClient: (_) =>
          throw StateError('Network is disabled in the native fixture'),
    ),
    (error, stack) {
      // A missing runner environment or setup error must not leave a blank app.
      stderr.writeln(
        'Native benchmark setup/asynchronous failure: $error\n$stack',
      );
      exit(1);
    },
  );
}
