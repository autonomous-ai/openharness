import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/api/api_client.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/auth/cli_link.dart';
import 'package:harness_mobile/auth/peer_link_client.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/demo/sample_mode.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:harness_mobile/viewer/viewer_key_store.dart';
import 'package:harness_mobile/viewer/viewer_services.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import '../agent_pager_fixture.dart' show goLive;
import '../voice_fakes.dart';

/// The phone screens under the edge cases a real phone meets: a small one and a large one, the
/// text scales a person can set, both brightnesses, names nobody would design for.
///
/// Everything here is a fake — no daemon, no network, no disk outside memory. See the rules in
/// `mobile/README.md` and the incident they came from.

/// A phone as a layout meets it, in logical pixels: the screen, the status bar over its top, the
/// home indicator under its foot, and how tall its keyboard stands (with the suggestion strip).
typedef Phone = ({Size size, double top, double bottom, double keyboard});

/// iPhone SE (2nd/3rd gen): a 20pt status bar, a home button rather than an indicator.
const Phone smallPhone = (
  size: Size(375, 667),
  top: 20,
  bottom: 0,
  keyboard: 260,
);

/// iPhone 15 Pro Max.
const Phone largePhone = (
  size: Size(430, 932),
  top: 59,
  bottom: 34,
  keyboard: 346,
);

const phones = {'SE': smallPhone, 'Pro Max': largePhone};

/// The phone [setPhone] last set — what [raiseKeyboard] raises.
Phone _current = largePhone;

/// The software keyboard up, at the current phone's height.
void raiseKeyboard(WidgetTester tester) =>
    tester.view.viewInsets = FakeViewPadding(bottom: _current.keyboard * 3);

void lowerKeyboard(WidgetTester tester) =>
    tester.view.viewInsets = FakeViewPadding.zero;

/// The scales the brief asks for, and the largest the app itself can reach: `HarnessApp` pins the
/// text scale to Settings ▸ Text size, 11–19pt over a 14pt default.
const textScales = [1.0, 19 / 14, 1.5, 2.0];

/// A name nobody designs for.
const longName =
    'refactor-the-authentication-middleware-so-that-sessions-survive-a-relaunch-of-the-app';
const emojiName = '🚀 ship it 👩‍💻🔥 fix 🐛 in 🇯🇵 build';
const rtlName = 'مساعد البرمجة الذكي للمشروع الكبير';
const longMachine = 'Ada’s MacBook Pro (16-inch, 2024) in the upstairs office';
const longProject =
    'an-extraordinarily-long-project-folder-name-that-keeps-going';
const longBranch =
    'feature/authentication-middleware-session-survival-across-relaunch';

/// Claude Code's permission dialog, as it lands in the pane: three answers, the first and last of
/// which Focus puts beside the mic.
const permissionDialog =
    '\r\n\x1b[2m────────────────────────────────────────────\x1b[0m\r\n'
    ' \x1b[1mBash command\x1b[0m\r\n'
    '   rm -rf build/ && flutter build ios\r\n'
    ' Do you want to proceed?\r\n'
    ' \x1b[36m❯ 1. Yes\x1b[0m\r\n'
    "   2. Yes, and don't ask again for rm commands\r\n"
    '   3. No, and tell Claude what to do differently\r\n'
    '\r\n'
    ' \x1b[2mEsc to cancel · Enter to confirm\x1b[0m';

/// Sample mode around a screen, without the sample's own runtime.
class FakeSample implements SampleSession {
  FakeSample(this.notifier);

  @override
  final AppNotifier notifier;

  @override
  bool endCardSeen = false;

  final List<String?> left = [];

  @override
  void leave([String? result]) => left.add(result);
}

/// A machine the fake conn answers every request for, and accepts every frame.
class EdgeConn extends WsConn {
  EdgeConn([this.answers = const {}, this.respond])
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  /// What the machine answers, by request type; anything else is answered with nothing.
  final Map<String, Map<String, dynamic>> answers;

  /// An answer worked out from the request — one that has to echo what it was sent, as a
  /// creation's receipt does. Null falls through to [answers].
  final Map<String, dynamic>? Function(
    String type,
    Map<String, dynamic> payload,
  )?
  respond;

  final List<(String, Map<String, dynamic>)> frames = [];
  final List<String> requests = [];

  /// Every request's payload, by type, in order.
  final Map<String, List<Map<String, dynamic>>> payloads = {};

  /// How many times a terminal was asked to open.
  int get opens => frames.where((frame) => frame.$1 == 'terminal_open').length;

  @override
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    frames.add((type, payload));
    return true;
  }

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    requests.add(type);
    (payloads[type] ??= []).add(payload);
    return respond?.call(type, payload) ??
        answers[type] ??
        (type == 'terminal_capabilities' ? capabilities : {});
  }

  /// What the machine's terminal can do, as `terminal_capabilities` reports it — a current CLI on
  /// tmux, making projects. Answered with nothing, a machine reads as having no terminal at all.
  Map<String, dynamic> capabilities = {
    'protocolVersion': TerminalSession.protocolVersion,
    'backend': 'tmux',
    'available': true,
    'features': {'projectFolder': true, 'pasteRaw': true},
  };
}

/// A machine that starts every agent it is asked for, as `new-<n>`, and echoes the receipt the
/// notifier checks — anything less reads as unconfirmed.
Map<String, dynamic>? startsAgents(String type, Map<String, dynamic> payload) {
  if (type != 'agent_create') return null;
  return {
    'creationId': payload['creationId'],
    'state': 'created',
    'agent': {
      'id': 'new-agent',
      'name': 'new-agent',
      'engine': payload['engine'],
      'terminal': {'available': true},
    },
  };
}

Agent edgeAgent(
  String id, {
  String? name,
  String engine = 'claude',
  String project = 'web',
  String? branch = 'main',
  int minutesAgo = 5,
}) => Agent(
  id: id,
  name: name ?? id,
  engine: engine,
  sessionId: 'session-$id',
  status: 'active',
  project: AgentProject(name: project, cwd: '/code/$project', branch: branch),
  updatedAt: DateTime.now().subtract(Duration(minutes: minutesAgo)),
  terminalAvailable: true,
);

/// An account with one machine, `m`, running [agents] — as a phone sees it when [online], or as it
/// sees a machine that has gone away when not.
///
/// ⚠️ **Every way out of the process is stubbed, not only the machine's socket.** A notifier left
/// with its defaults reaches the local `harness` CLI's HTTP port through [ApiClient], and runs the
/// `harness` binary itself to link a computer by password — the user's real harnesses, from a
/// test. [EdgeApi], [EdgeLinks] and a CLI runner that refuses to start anything close all three.
AppNotifier edgeApp({
  List<Agent>? agents,
  String machineName = 'studio',
  bool online = true,
  AgentLoadStatus load = AgentLoadStatus.loaded,
  EdgeConn? conn,
  bool noMachines = false,
  EdgeLinks? links,
}) {
  final session = AuthSession();
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: session,
    configStore: null,
    connectionForTest: (_) => conn ?? EdgeConn(),
    peerLinks: links ?? EdgeLinks(),
    viewer: ViewerServices(
      config: AppConfig.dev,
      session: session,
      keys: ViewerKeyStore(storage: MemoryKeyValueStore()),
    ),
  );
  app.api = EdgeApi(app, session);
  if (noMachines) return app;
  final machine = Machine(
    machineId: 'm',
    authMode: MachineAuthMode.remote,
    name: machineName,
  );
  app.machines = [machine];
  app.machineStates['m'] = MachineState(machine)
    ..nodeOnline = online
    ..connectionStatus = online
        ? ConnectionStatus.connected
        : ConnectionStatus.disconnected
    ..agentLoadStatus = load
    ..terminalCapabilityAvailable = true
    ..agents = agents ?? [edgeAgent('a')];
  return app;
}

/// The control plane, answered from the app's own list — never the local CLI's HTTP port, which
/// is where a real [ApiClient] outside a viewer build sends everything.
class EdgeApi extends ApiClient {
  EdgeApi(this._app, AuthSession session)
    : super(config: AppConfig.dev, session: session);

  final AppNotifier _app;

  @override
  Future<Map<String, dynamic>?> me() async => null;

  @override
  Future<List<Machine>> machines() async => _app.machines;

  @override
  Future<String?> renameMachine({
    required String machineId,
    required String name,
  }) async => name;

  @override
  Future<void> deleteMachine({required String machineId}) async {}

  @override
  Future<Map<String, dynamic>?> desk() async => null;

  @override
  Future<Map<String, dynamic>?> deskOps(List<Map<String, dynamic>> ops) async =>
      null;

  @override
  Future<String> transcribeVoice(Uint8List wav, {required String lang}) async =>
      '';
}

/// Linking a computer by password or by code, answered by the test: [error] when set, else
/// success.
class EdgeLinks implements PeerLinkClient {
  String? error;
  final List<String> passwords = [];

  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
    String? label,
  }) async {
    passwords.add(password);
    onProgress?.call('connecting');
    return error == null
        ? CliLinkConnectResult(linkedMachineId: machineId)
        : CliLinkConnectResult(error: error);
  }

  @override
  Future<CliLinkConnectResult> connectWithCode(
    String machineId,
    String code, {
    required String label,
    String? displayName,
  }) async => error == null
      ? CliLinkConnectResult(linkedMachineId: machineId)
      : CliLinkConnectResult(error: error);

  @override
  Future<CliLinkListResult> list() async => const CliLinkListResult();

  @override
  Future<String?> unlink(String machineId) async => null;
}

/// [count] agents, `a0`…, the first named [firstName] when given.
List<Agent> manyAgents(int count, {String? firstName}) => [
  for (var i = 0; i < count; i++)
    edgeAgent(
      'a$i',
      name: i == 0 && firstName != null ? firstName : 'agent-$i',
      minutesAgo: i,
    ),
];

/// A live terminal for [agentId] on `m`: adopted as the pane and given its first keyframe, so the
/// page draws a screen rather than its skeleton.
///
/// [sent] collects every frame the session sends — a reopen, a resize.
Future<TerminalSession> liveTerminal(
  AppNotifier app,
  String agentId, {
  String? name,
  List<(String, Map<String, dynamic>)>? sent,
}) async {
  final session = TerminalSession(
    machineId: 'm',
    agentId: agentId,
    agentName: name ?? agentId,
    engineId: 'claude',
    send: (type, payload) async {
      sent?.add((type, payload));
      return true;
    },
    sendBinary: (_) async => true,
  );
  app.adoptSessionForTest(session);
  await goLive(session);
  session.status = TerminalSessionStatus.controlling;
  return session;
}

/// A voice controller on fakes, disposed with the test.
({VoiceInputController voice, FakeVoiceRecorder recorder, FakeTranscriber stt})
edgeVoice() {
  final language = ValueNotifier('en');
  final recorder = FakeVoiceRecorder();
  final stt = FakeTranscriber();
  final voice = VoiceInputController(
    transcriber: stt.call,
    recorder: recorder,
    language: language,
  );
  addTearDown(() {
    voice.dispose();
    language.dispose();
  });
  return (voice: voice, recorder: recorder, stt: stt);
}

/// Sizes the test's window as [phone] on a 3x screen, with its status bar and home indicator and
/// no keyboard — reset when the test ends.
void setPhone(WidgetTester tester, Phone phone) {
  _current = phone;
  final insets = FakeViewPadding(top: phone.top * 3, bottom: phone.bottom * 3);
  tester.view.physicalSize = phone.size * 3;
  tester.view.devicePixelRatio = 3;
  tester.view.padding = insets;
  tester.view.viewPadding = insets;
  tester.view.viewInsets = FakeViewPadding.zero;
  addTearDown(tester.view.reset);
}

/// Sets the app's brightness for the test, and puts the dark it ships with back afterwards.
void setBrightness(Brightness brightness) {
  final before = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = before);
}

/// [home] as the phone app mounts a screen: its theme, and the text scale set in the builder the
/// way `HarnessApp` sets it.
Widget phoneApp(
  Widget home, {
  double textScale = 1.0,
  Brightness brightness = Brightness.dark,
  List<NavigatorObserver> observers = const [],
}) => grid.BrightnessScope(
  child: MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: grid.buildAppTheme(brightness: brightness),
    navigatorObservers: observers,
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context)
          .copyWith(textScaler: TextScaler.linear(textScale)),
      child: child!,
    ),
    home: home,
  ),
);

/// Every error Flutter reports while [body] runs — an overflow, an exception in a build — rather
/// than only the first, which is all `takeException` keeps.
Future<List<String>> collectErrors(Future<void> Function() body) async {
  final errors = <String>[];
  final previous = FlutterError.onError;
  FlutterError.onError = (details) {
    final text = details.exceptionAsString().split('\n').first;
    errors.add(text);
  };
  try {
    await body();
  } finally {
    FlutterError.onError = previous;
  }
  return errors;
}

/// Runs [pump] at every phone, scale and brightness, and fails listing every combination that
/// reported an error — so one run shows the whole picture rather than the first overflow.
Future<void> expectNoLayoutErrors(
  WidgetTester tester,
  Future<void> Function(double scale, Brightness brightness) pump, {
  Map<String, Phone> sizes = phones,
  List<double> scales = textScales,
  List<Brightness> brightnesses = const [Brightness.dark, Brightness.light],
}) async {
  final failures = <String>[];
  for (final MapEntry(key: name, value: phone) in sizes.entries) {
    for (final scale in scales) {
      for (final brightness in brightnesses) {
        setPhone(tester, phone);
        final before = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        final where = '$name ×${scale.toStringAsFixed(2)} ${brightness.name}';
        try {
          final errors = await collectErrors(() => pump(scale, brightness));
          for (final error in errors.toSet()) {
            failures.add('$where: $error');
          }
        } on Object catch (error) {
          // A step of the test that could not be taken — a control the layout pushed out of
          // reach — says which phone it was on.
          fail('$where: $error');
        } finally {
          grid.AppTheme.brightness.value = before;
        }
        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(seconds: 1));
      }
    }
  }
  // What the screens started — a machine being re-reached, a request's timeout — runs out here,
  // before the test's end checks for timers left behind.
  await tester.pump(const Duration(seconds: 30));
  expect(failures, isEmpty, reason: failures.join('\n'));
}

/// Lays the screens out in the phone's own faces rather than the test font, when
/// `PHONE_EDGE_REAL_FONTS=1` asks for it — macOS only, from the SF Mono and SF Pro files the render
/// test reads (`test/render/phone_screens_render_test.dart`).
///
/// ⚠️ **Off by default, and the tests are written to pass either way.** The test font draws every
/// glyph a full em wide — about two thirds wider than SF Mono — so text wraps sooner than on a
/// phone and a layout that holds here holds there. The real faces are for telling a layout that
/// is truly short of room from one only the test font crowds.
Future<void> loadRealFontsIfAsked() async {
  if (Platform.environment['PHONE_EDGE_REAL_FONTS'] != '1' ||
      !Platform.isMacOS) {
    return;
  }
  Future<void> load(String family, List<String> files) async {
    final loader = FontLoader(family);
    for (final file in files) {
      final bytes = await File('/Library/Fonts/$file').readAsBytes();
      loader.addFont(Future.value(ByteData.view(bytes.buffer)));
    }
    await loader.load();
  }

  const weights = ['Regular', 'Medium', 'Semibold', 'Bold'];
  for (final family in ['.AppleSystemUIFontMonospaced', 'SF Mono']) {
    await load(family, [for (final w in weights) 'SF-Mono-$w.otf']);
  }
  for (final family in ['.AppleSystemUIFont', 'SF Pro Text', 'Roboto']) {
    await load(family, [for (final w in weights) 'SF-Pro-Text-$w.otf']);
  }
}

/// Taps [finder] once it is scrolled into view — on a small phone at a large text size, most of
/// a screen is below the fold.
Future<void> tapInView(WidgetTester tester, Finder finder) async {
  // Not even built yet: a list builds only a screen's worth past what it shows.
  if (finder.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      finder,
      200,
      scrollable: find.byType(Scrollable).first,
    );
  }
  await tester.ensureVisible(finder);
  await tester.pump();
  await tester.tap(finder);
}

/// Takes the screen down and runs its clocks out, so no timer outlives the test.
Future<void> unmount(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(seconds: 30));
}

/// Pumps a few frames of [duration] each — enough for an entrance to finish without
/// `pumpAndSettle`, which a breathing skeleton or a spinner would never let return.
Future<void> frames(
  WidgetTester tester, {
  int count = 4,
  Duration duration = const Duration(milliseconds: 150),
}) async {
  for (var i = 0; i < count; i++) {
    await tester.pump(duration);
  }
}

/// Resolves [future] inside the test's fake clock.
Future<T> settle<T>(WidgetTester tester, Future<T> future) async {
  T? value;
  unawaited(future.then((v) => value = v));
  await tester.pump();
  return value as T;
}
