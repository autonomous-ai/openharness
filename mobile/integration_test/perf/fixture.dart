import 'dart:async';
import 'dart:convert';
import 'dart:io' show ZLibCodec;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_recorder.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

/// The machine every fixture agent lives on.
const perfMachineId = 'perf-machine';

/// The agents Find lists: the first two have live terminals (Find switches
/// between them), the rest are rows. Most recent first, so the two switched
/// between are always the top rows.
const perfAgents = <(String, String)>[
  ('agent-a', 'fix flaky login test'),
  ('agent-b', 'tighten rate limiter'),
  ('agent-c', 'docs rewrite'),
  ('agent-d', 'release notes 1.0'),
  ('agent-e', 'db migration dry run'),
  ('agent-f', 'search ranking'),
  ('agent-g', 'onboarding copy'),
  ('agent-h', 'mobile perf pass'),
];

/// A synthetic live terminal, fed through the production binary path.
///
/// Output goes through [TerminalSession.handleBinary] — the same decode
/// (zlib when the daemon would have compressed), UTF-8 and xterm parse a
/// relayed frame gets — with a sequence number, as the daemon sends it. What is
/// NOT here: the socket, the relay/P2P transport and its E2EE decryption, and
/// the daemon and tmux on the far side.
class FixtureTerminal {
  FixtureTerminal._(this.session, this.agentId);

  final TerminalSession session;
  final String agentId;
  int _seq = 0;

  /// `terminal_resize` frames the session sent, which a steady terminal must
  /// not send — a fixture that resizes is measuring the wrong thing.
  int resizes = 0;

  /// The grid the last `terminal_resize` asked for: what the view measured.
  ///
  /// ⚠️ **Not `terminal.viewWidth`.** The phone's emulator stays at the size
  /// the machine last drew — xterm does not resize it locally — and asks the
  /// machine for its own size instead, which answers with a keyframe at that
  /// size. A seed at `viewWidth` was an 80×24 screen drawn into a phone.
  (int, int)? lastResize;

  static final ZLibCodec _zlib = ZLibCodec(level: 1);

  /// The daemon's rule (`encoded` in `cli/src/lib/terminalStreamManager.ts`):
  /// zlib level 1 above 1 KiB, when it actually saves bytes. The phone asks
  /// for zlib, so this is what its frames look like.
  static ({Uint8List bytes, bool compressed}) encode(String text) {
    final raw = Uint8List.fromList(utf8.encode(text));
    if (raw.length > 1024) {
      final packed = Uint8List.fromList(_zlib.encode(raw));
      if (packed.length < raw.length) return (bytes: packed, compressed: true);
    }
    return (bytes: raw, compressed: false);
  }

  /// A full screen and its history, as the machine sends on attach — a new
  /// emulator, replaced atomically.
  Future<void> keyframe(String text, {required int cols, required int rows}) {
    final body = encode(text);
    return session.handleBinary(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.keyframe,
        streamId: session.streamId!,
        seq: _seq++,
        bytes: body.bytes,
        compressed: body.compressed,
        cols: cols,
        rows: rows,
      ),
    );
  }

  /// One output frame, pre-encoded. Answers the microseconds the session took
  /// to take it in: decode, UTF-8 and the xterm parse, on this thread.
  Future<int> output(({Uint8List bytes, bool compressed}) body) async {
    final watch = Stopwatch()..start();
    await session.handleBinary(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.output,
        streamId: session.streamId!,
        seq: _seq++,
        bytes: body.bytes,
        compressed: body.compressed,
      ),
    );
    return watch.elapsedMicroseconds;
  }
}

/// The account the benchmark shows: one machine, eight agents, two of them
/// attached — and nothing that can reach a real machine.
///
/// ⚠️ **Nothing here can reach the owner's harnesses.** No config store, no
/// layout store (so nothing is read from or written to the app's files), a
/// fresh in-memory auth session, and every machine connection is
/// [_SilentConn]: it never dials and answers every request with nothing. The
/// installed build shares its bundle id — and so its data container — with the
/// owner's development copy, which is exactly why none of that may be touched.
class PerfFixture {
  PerfFixture._(this.notifier, this.terminals, this.voice, this._language);

  final AppNotifier notifier;
  final Map<String, FixtureTerminal> terminals;
  final VoiceInputController voice;
  final ValueNotifier<String> _language;

  static PerfFixture create() {
    final now = DateTime.now();
    // As the daemon's `agents_list` carries them — the connection answers a
    // reload with these same records, so a reload changes nothing.
    final wireAgents = [
      for (final (index, (id, name)) in perfAgents.indexed)
        <String, dynamic>{
          'id': id,
          'name': name,
          'sessionId': 'session-$id',
          'engine': 'claude',
          'status': 'active',
          'terminal': {'available': true},
          'project': {'name': 'harness', 'cwd': '/srv/harness'},
          'updatedAt': now
              .subtract(Duration(minutes: 3 + index * 17))
              .toUtc()
              .toIso8601String(),
        },
    ];
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(storage: MemoryStore()),
      configStore: null,
      connectionForTest: (machineId) => _SilentConn(machineId, wireAgents),
    );
    const machine = Machine(
      machineId: perfMachineId,
      authMode: MachineAuthMode.remote,
      name: 'Studio',
    );
    notifier.machines = [machine];
    notifier.machineStates[perfMachineId] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [for (final json in wireAgents) Agent.fromJson(json)];
    final terminals = <String, FixtureTerminal>{};
    for (final (id, name) in perfAgents.take(2)) {
      late FixtureTerminal terminal;
      final session =
          TerminalSession(
              machineId: perfMachineId,
              agentId: id,
              agentName: name,
              engineId: 'claude',
              send: (type, payload) async {
                if (type == 'terminal_resize') {
                  terminal.resizes++;
                  terminal.lastResize = (
                    payload['cols'] as int,
                    payload['rows'] as int,
                  );
                }
                return true;
              },
              sendBinary: (_) async => true,
            )
            ..streamId =
                '00000000-0000-4000-8000-00000000000${terminals.length + 1}';
      terminal = FixtureTerminal._(session, id);
      terminals[id] = terminal;
      // ignore: invalid_use_of_visible_for_testing_member
      notifier.adoptSessionForTest(session);
    }
    final language = ValueNotifier('en');
    return PerfFixture._(
      notifier,
      terminals,
      VoiceInputController(
        transcriber: (_, _) async => '',
        recorder: FakeRecorder(),
        language: language,
      ),
      language,
    );
  }

  String nameOf(String agentId) =>
      perfAgents.firstWhere((agent) => agent.$1 == agentId).$2;

  void dispose() {
    voice.dispose();
    _language.dispose();
    notifier.dispose();
  }
}

/// The app's own dark theme, as `app_shell.dart` builds it, around [home].
Widget perfApp(Widget home, {List<NavigatorObserver> observers = const []}) {
  grid.AppTheme.brightness.value = Brightness.dark;
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: grid.buildAppTheme(brightness: Brightness.dark),
    navigatorObservers: observers,
    builder: (context, child) =>
        grid.BrightnessScope(child: child ?? const SizedBox.shrink()),
    home: home,
  );
}

/// The home screen's one agent at a time: [TerminalPage] at the root, swapped
/// for another agent's when Find opens one.
///
/// ⚠️ **The production home is `AgentHome` → `AgentSwipeHost` → `TerminalPage`,
/// and this is the last of those three.** Opening an agent from Find calls the
/// shell's `onOpenAgent` (see `openAgent` in `phone_navigation.dart`); this
/// answers it by building the other agent's page in place, keyed by agent, as
/// `AgentHome` does with its pager. Not included: `AgentHome`'s pager snapshot
/// and bookkeeping, `AgentSwipeHost`'s visit record, the shell's tab reset, and
/// `selectAgent`'s attach — both agents' terminals are already attached and
/// rendered here, so a switch never waits on a keyframe.
class FocusHost extends StatefulWidget {
  const FocusHost({
    super.key,
    required this.fixture,
    required this.initialAgentId,
  });

  final PerfFixture fixture;
  final String initialAgentId;

  @override
  State<FocusHost> createState() => FocusHostState();
}

class FocusHostState extends State<FocusHost> {
  late String agentId = widget.initialAgentId;

  void show(String next) => setState(() => agentId = next);

  @override
  Widget build(BuildContext context) => PhoneShellScope(
    onMachineLinked: (_) {},
    onOpenAgent: (_, next) => show(next),
    child: TerminalPage(
      key: ValueKey(agentId),
      notifier: widget.fixture.notifier,
      machineId: perfMachineId,
      agentId: agentId,
      voice: widget.fixture.voice,
    ),
  );
}

/// A microphone that opens at once and hears nothing: the benchmark times the
/// app's answer to a tap, not the audio hardware opening.
class FakeRecorder implements VoiceRecorder {
  @override
  Future<bool> allowed() async => true;

  @override
  Future<void> start() async {}

  @override
  Future<VoiceTake?> stop() async => null;

  @override
  Future<void> cancel() async {}

  @override
  Future<void> dispose() async {}
}

class MemoryStore implements LocalKeyValueStore {
  final Map<String, String> values = {};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}

/// A machine connection that never dials: it reads as ready, answers
/// `agents_list` with the fixture's own agents (so a reload the notifier starts
/// by itself is a no-op rather than a ten-second wait with the header showing a
/// refresh), and answers every other request — what the new-agent form asks as
/// it opens — with nothing.
class _SilentConn extends WsConn {
  _SilentConn(String machineId, this._agents)
    : super(
        wsBaseUrl: 'ws://perf.invalid',
        autonomousEnv: 'test',
        machineId: machineId,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final List<Map<String, dynamic>> _agents;

  @override
  bool get isReady => true;

  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}

  @override
  Future<void> connect() async {}

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => type == 'agents_list' ? {'agents': _agents} : {};
}
