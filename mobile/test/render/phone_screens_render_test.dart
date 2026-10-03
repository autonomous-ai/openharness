import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/phone/new_agent_draft.dart';
import 'package:harness_mobile/phone/welcome/how_it_works.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/phone/welcome/focus_hints.dart';
import 'package:harness_mobile/phone/link_page.dart';
import 'package:harness_mobile/phone/machines_tab.dart';
import 'package:harness_mobile/phone/welcome/connect_computer.dart';
import 'package:harness_mobile/phone/welcome/phone_welcome.dart';
import 'package:harness_mobile/phone/welcome/set_up_computer.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/settings_page.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_mic_face.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/pending_question.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:harness_mobile/ws/ws_conn.dart';
import 'package:xterm/xterm.dart';

import '../voice_fakes.dart';

/// Renders the phone's three screens — Focus, Find, New — at iPhone 14 size in
/// the real system fonts, to PNGs a reviewer (or an agent without a phone) can
/// look at.
///
/// Skipped unless PHONE_RENDER_DIR names a directory to write into:
///
///     PHONE_RENDER_DIR=/tmp/renders flutter test test/render/phone_screens_render_test.dart
///
/// macOS only: it loads SF Mono and SF Pro from /Library/Fonts.
final _outDir = Platform.environment['PHONE_RENDER_DIR'];

/// Claude Code, mid-turn, the way its TUI draws on a phone-width terminal.
const _claudeOutput = [
  '\x1b[1m⏺\x1b[0m I\'ll look at how Find ranks them first.\r\n',
  '\r\n',
  '\x1b[32m⏺\x1b[0m \x1b[1mRead\x1b[0m(lib/phone/phone_search_rank.dart)\r\n',
  '  ⎿  Read \x1b[1m262\x1b[0m lines\r\n',
  '\r\n',
  '\x1b[1m⏺\x1b[0m The empty-query branch sorts by this\r\n',
  '  phone\'s visits first, then by activity.\r\n',
  '  The desktop does the opposite.\r\n',
  '\r\n',
  '\x1b[32m⏺\x1b[0m \x1b[1mUpdate\x1b[0m(lib/phone/phone_search_rank.dart)\r\n',
  '  ⎿  Updated with \x1b[32m18\x1b[0m additions and\r\n',
  '     \x1b[31m7\x1b[0m removals\r\n',
  '     \x1b[2m183\x1b[0m \x1b[31m-    if (needle.isEmpty) {\x1b[0m\r\n',
  '     \x1b[2m183\x1b[0m \x1b[32m+    if (byActivity || empty) {\x1b[0m\r\n',
  '\r\n',
  '\x1b[32m⏺\x1b[0m \x1b[1mBash\x1b[0m(flutter test test/search_test.dart)\r\n',
  '  ⎿  00:01 +42: All tests passed!\r\n',
  '\r\n',
  '\x1b[1m⏺\x1b[0m Find now orders by last use, the\r\n',
  '  same order as the desktop\'s ⌘P. Typing\r\n',
  '  filters without reordering.\r\n',
  '\r\n',
  '\x1b[38;5;208m✻\x1b[0m Committing… \x1b[2m(12s · ↓ 1.8k tokens)\x1b[0m\r\n',
  '\r\n',
  '\x1b[2m╭────────────────────────────────────────╮\x1b[0m\r\n',
  '\x1b[2m│\x1b[0m > \x1b[2m                                     │\x1b[0m\r\n',
  '\x1b[2m╰────────────────────────────────────────╯\x1b[0m\r\n',
  '  \x1b[35m⏵⏵ auto mode on\x1b[0m \x1b[2m(shift+tab to cycle)\x1b[0m\r\n',
];

class _Conn extends WsConn {
  _Conn()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => switch (type) {
    'engines_probe' => {
      'engines': [
        {'engine': 'claude', 'installed': true},
        {'engine': 'codex', 'installed': true, 'supportsCodexHome': true},
      ],
    },
    'git_project_info' => {
      'isGit': true,
      'branch': 'main',
      'defaultRef': 'refs/heads/main',
      'branches': [
        {'ref': 'refs/heads/main', 'name': 'main'},
      ],
    },
    'grid_models_list' => {
      'supportsModelLaunch': true,
      'localModelEngines': ['claude', 'codex'],
      'grids': [
        {
          'name': 'own',
          'own': true,
          'models': [
            {'id': 'qwen-coder', 'node': 'studio'},
          ],
        },
        {
          'name': 'team-grid',
          'models': [
            {'id': 'shared-coder', 'node': 'server'},
          ],
        },
      ],
    },
    _ => {},
  };
}

Future<void> _loadFont(
  String family,
  List<String> files, {
  String dir = '/Library/Fonts',
}) async {
  final loader = FontLoader(family);
  for (final file in files) {
    final bytes = await File('$dir/$file').readAsBytes();
    loader.addFont(Future.value(ByteData.view(bytes.buffer)));
  }
  await loader.load();
}

Future<void> _loadFonts() async {
  const mono = [
    'SF-Mono-Regular.otf',
    'SF-Mono-Medium.otf',
    'SF-Mono-Semibold.otf',
    'SF-Mono-Bold.otf',
  ];
  const sans = [
    'SF-Pro-Text-Regular.otf',
    'SF-Pro-Text-Medium.otf',
    'SF-Pro-Text-Semibold.otf',
    'SF-Pro-Text-Bold.otf',
  ];
  for (final family in ['.AppleSystemUIFontMonospaced', 'SF Mono']) {
    await _loadFont(family, mono);
  }
  for (final family in ['.AppleSystemUIFont', 'SF Pro Text']) {
    await _loadFont(family, sans);
  }
  // The icons still on screen (the mic's glyph, the key bar), from the package in the pub cache.
  final lucide =
      '${Platform.environment['HOME']}/.pub-cache/hosted/pub.dev/lucide_icons_flutter-3.1.19/assets';
  if (Directory(lucide).existsSync()) {
    await _loadFont('packages/lucide_icons_flutter/Lucide', [
      'lucide.ttf',
    ], dir: lucide);
    for (final weight in [100, 200, 300, 400, 500, 600]) {
      await _loadFont('packages/lucide_icons_flutter/Lucide$weight', [
        'LucideVariable-w$weight.ttf',
      ], dir: '$lucide/build_font');
    }
  }
  // Material's, for the Apple logo on the set-up page — from the Flutter SDK running the test.
  final material =
      '${Platform.environment['FLUTTER_ROOT']}/bin/cache/artifacts/material_fonts';
  if (File('$material/MaterialIcons-Regular.otf').existsSync()) {
    await _loadFont('MaterialIcons', [
      'MaterialIcons-Regular.otf',
    ], dir: material);
  }
}

Agent _agent(
  String id,
  String name, {
  required String cwd,
  required int minutesAgo,
}) => Agent(
  id: id,
  name: name,
  engine: 'claude',
  sessionId: 'session-$id',
  status: 'active',
  project: AgentProject(name: cwd.split('/').last, cwd: cwd, branch: 'main'),
  updatedAt: DateTime.now().subtract(Duration(minutes: minutesAgo)),
  terminalAvailable: true,
);

void main() {
  final skip = _outDir == null || !Platform.isMacOS;

  late AppNotifier notifier;
  late VoiceInputController voice;
  late ValueNotifier<String> language;

  setUp(() async {
    if (skip) return;
    newAgentDraft = null;
    notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      connectionForTest: (_) => _Conn(),
    );
    const m2 = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'M2',
    );
    const mini = Machine(
      machineId: 'mini',
      authMode: MachineAuthMode.remote,
      name: 'mini',
    );
    notifier.machines = [m2, mini];
    notifier.machineStates['m'] = MachineState(m2)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [
        _agent(
          'a',
          'hn',
          cwd: '/Users/me/code/autonomous-harness',
          minutesAgo: 3,
        ),
        _agent(
          'b',
          'docs-rewrite',
          cwd: '/Users/me/code/site',
          minutesAgo: 120,
        ),
      ];
    notifier.machineStates['mini'] = MachineState(mini)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [
        _agent('c', 'api-fix', cwd: '/Users/me/code/api', minutesAgo: 40),
      ];
    // One asking, one working — Find's `needs you` and its state words.
    notifier.machineStates['mini']!.blockedAgents['c'] = PendingQuestion(
      machineId: 'mini',
      agentId: 'c',
      requestId: 'q1',
      answerKey: '1',
      prompt: 'Run the migration on the test db?',
      options: const ['Yes', 'No'],
      multi: false,
      since: DateTime.now().subtract(const Duration(minutes: 2)),
    );
    notifier.machineStates['m']!.processingAgentIds.add('b');
    final session = TerminalSession(
      machineId: 'm',
      agentId: 'a',
      agentName: 'hn',
      engineId: 'claude',
      send: (type, payload) async => true,
      sendBinary: (_) async => true,
    );
    session.status = TerminalSessionStatus.controlling;
    session.streamId = 's';
    // A screen to show — kept from "last time", which is what a render needs: the live path waits
    // for a keyframe this fixture has no machine to send.
    // 42 columns: what a 390pt phone fits at 14pt SF Mono between the two 12pt
    // gutters, measured. The live terminal resizes itself to the view; this
    // fixture has no machine to answer a resize, so a wider seed would render
    // clipped at the right edge — a fixture fault a reviewer reads as the app's.
    final screen = Terminal(maxLines: 1000)..resize(42, 49);
    for (var line = 0; line < 60; line++) {
      screen.write('earlier output line $line\r\n');
    }
    for (final chunk in _claudeOutput) {
      screen.write(chunk);
    }
    session.seedScreen(screen);
    notifier.adoptSessionForTest(session);
    await notifier.projectHistory.select(
      'm',
      '/Users/me/code/autonomous-harness',
    );
    language = ValueNotifier('en');
    voice = VoiceInputController(
      transcriber: FakeTranscriber().call,
      recorder: FakeVoiceRecorder(),
      language: language,
    );
  });

  tearDown(() {
    if (skip) return;
    newAgentDraft = null;
    voice.dispose();
    language.dispose();
    notifier.dispose();
  });

  Future<void> shoot(WidgetTester tester, GlobalKey key, String name) async {
    await tester.runAsync(() async {
      final boundary =
          key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 3);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      final file = File('$_outDir/$name.png');
      await file.parent.create(recursive: true);
      await file.writeAsBytes(png!.buffer.asUint8List());
    });
    // Done with the screen: take it down and run its clocks out, so no timer outlives the test.
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 10));
  }

  Future<GlobalKey> pumpScreen(WidgetTester tester, Widget home) async {
    await tester.runAsync(_loadFonts);
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
    tester.view.viewPadding = const FakeViewPadding(
      top: 47 * 3,
      bottom: 34 * 3,
    );
    addTearDown(tester.view.reset);
    final key = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: key,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: home,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump(const Duration(milliseconds: 200));
    return key;
  }

  TerminalPage focus() => TerminalPage(
    notifier: notifier,
    machineId: 'm',
    agentId: 'a',
    voice: voice,
  );

  testWidgets('welcome', skip: skip, (tester) async {
    final key = await pumpScreen(
      tester,
      PhoneWelcome(notifier: notifier, onTrySample: (_) async => null),
    );
    await shoot(tester, key, '0-welcome');
  });

  PhoneWelcome welcome() => PhoneWelcome(
    notifier: notifier,
    onTrySample: (_) async => null,
    sendCode: (_) async {},
    signIn: (_, _) async {},
    scanCamera: const SizedBox(),
    loadDownloads: () async => const {},
  );

  testWidgets('welcome, scan', skip: skip, (tester) async {
    final key = await pumpScreen(tester, welcome());
    await tester.tap(find.text('Yes — scan to connect'));
    await tester.pump(const Duration(milliseconds: 300));
    // [shoot] takes the screen down after it: one capture per test.
    await shoot(tester, key, '0a-welcome-scan');
  });

  testWidgets('welcome, email', skip: skip, (tester) async {
    final key = await pumpScreen(tester, welcome());
    await tester.tap(find.text('Yes — scan to connect'));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('Use email instead'));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.enterText(
      find.byKey(const Key('welcome-email')).last,
      'ada@example.com',
    );
    await tester.pump();
    await shoot(tester, key, '0b-welcome-email');
  });

  testWidgets('welcome, code', skip: skip, (tester) async {
    final key = await pumpScreen(
      tester,
      PhoneWelcome(
        notifier: notifier,
        onTrySample: (_) async => null,
        sendCode: (_) async {},
        signIn: (_, _) async {},
        scanCamera: const SizedBox(),
      ),
    );
    await tester.tap(find.text('Yes — scan to connect'));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('Use email instead', findRichText: true));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.enterText(find.byType(TextField), 'ada@example.com');
    await tester.tap(find.text('Send code'));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.enterText(find.byType(TextField), '42');
    await tester.pump();
    await shoot(tester, key, '0c-welcome-code');
  });

  testWidgets('set up your computer', skip: skip, (tester) async {
    final key = await pumpScreen(
      tester,
      ConnectComputerPage(
        notifier: notifier,
        onTrySample: (_) async => null,
        loadDownloads: () async => const {},
      ),
    );
    await shoot(tester, key, '0d-connect-computer');
  });

  testWidgets('set up, download menu', skip: skip, (tester) async {
    final key = await pumpScreen(
      tester,
      Builder(
        builder: (context) => Scaffold(
          backgroundColor: Tty.of(context).ground,
          body: SafeArea(
            child: SetUpComputerPage(
              onScan: () {},
              onBack: () {},
              onTrySample: () {},
              loadDownloads: () async => const {},
            ),
          ),
        ),
      ),
    );
    await shoot(tester, key, '0e-set-up');
  });

  void addOtherComputers() {
    const studio = Machine(
      machineId: 'studio',
      authMode: MachineAuthMode.remote,
      name: 'studio',
    );
    const laptop = Machine(
      machineId: 'laptop',
      authMode: MachineAuthMode.remote,
      name: 'laptop',
    );
    notifier.machines = [...notifier.machines, studio, laptop];
    notifier.machineStates['studio'] = MachineState(studio)
      ..nodeOnline = true
      ..needsLink = true
      ..agentLoadStatus = AgentLoadStatus.needsLink;
    notifier.machineStates['laptop'] = MachineState(laptop)..nodeOnline = false;
  }

  testWidgets('computers', skip: skip, (tester) async {
    addOtherComputers();
    final key = await pumpScreen(tester, MachinesTab(notifier: notifier));
    await shoot(tester, key, '0e-computers');
  });

  testWidgets('unlock a computer', skip: skip, (tester) async {
    addOtherComputers();
    final key = await pumpScreen(
      tester,
      LinkPage(notifier: notifier, machineId: 'studio'),
    );
    await shoot(tester, key, '0f-unlock');
  });

  testWidgets('how it works', skip: skip, (tester) async {
    final key = await pumpScreen(tester, const HowItWorksPage());
    await shoot(tester, key, '0g-how-it-works');
  });

  testWidgets('focus', skip: skip, (tester) async {
    final key = await pumpScreen(tester, focus());
    await shoot(tester, key, '1-focus');
  });

  testWidgets('focus, scrolled up while output arrives', skip: skip, (
    tester,
  ) async {
    final key = await pumpScreen(tester, focus());
    await tester.drag(find.byType(TerminalView), const Offset(0, 400));
    await tester.pump(const Duration(milliseconds: 200));
    final session = notifier.panes.first.session!;
    session.outputTicks.value++;
    session.terminal.write('more output\r\n');
    await tester.pump(const Duration(milliseconds: 200));
    await shoot(tester, key, '2-focus-scrolled');
  });

  testWidgets('find', skip: skip, (tester) async {
    final key = await pumpScreen(tester, focus());
    await tester.dragFrom(
      tester.getCenter(find.byType(TerminalPage).first) - const Offset(120, 0),
      const Offset(300, 0),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    await shoot(tester, key, '3-find');
  });

  testWidgets('new', skip: skip, (tester) async {
    final key = await pumpScreen(
      tester,
      NewAgentPage(notifier: notifier, machineId: 'm', voice: voice),
    );
    await tester.pump(const Duration(milliseconds: 400));
    await shoot(tester, key, '4-new');
  });

  testWidgets('focus, keyboard up', skip: skip, (tester) async {
    final key = await pumpScreen(tester, focus());
    await tester.tap(find.byType(TerminalView));
    await tester.pump();
    tester.view.viewInsets = const FakeViewPadding(bottom: 336 * 3);
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump(const Duration(milliseconds: 300));
    await shoot(tester, key, '1b-focus-keyboard');
  });

  testWidgets('focus, recording', skip: skip, (tester) async {
    final key = await pumpScreen(tester, focus());
    await tester.tap(find.byType(VoiceMicCore));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await shoot(tester, key, '1c-focus-recording');
    // The take's clock is the controller's, not the screen's: throw the take away to stop it.
    voice.clear();
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('focus, prompt', skip: skip, (tester) async {
    final key = await pumpScreen(tester, focus());
    notifier.panes.first.session!.terminal.write(
      '\r\n\x1b[2m──────────────────────────────────────────\x1b[0m\r\n'
      ' \x1b[1mBash command\x1b[0m\r\n'
      '   rm -rf build/ && flutter build ios\r\n'
      ' Do you want to proceed?\r\n'
      ' \x1b[36m❯ 1. Yes\x1b[0m\r\n'
      "   2. Yes, and don't ask again for rm\r\n"
      '      commands\r\n'
      '   3. No, and tell Claude what to do\r\n'
      '      differently\r\n'
      '\r\n'
      ' \x1b[2mEsc to cancel · Enter to confirm\x1b[0m',
    );
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump(const Duration(milliseconds: 300));
    await shoot(tester, key, '1e-focus-prompt');
  });

  testWidgets('focus, first time', skip: skip, (tester) async {
    final key = await pumpScreen(
      tester,
      Stack(
        children: [
          focus(),
          Positioned.fill(
            child: FocusHints(
              micBottom: 34 + 4 * 15.6,
              store: FocusHintsSeen(storage: _MemoryStore()),
            ),
          ),
        ],
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
    await shoot(tester, key, '1f-focus-first-time');
  });

  testWidgets('focus, actions', skip: skip, (tester) async {
    final key = await pumpScreen(tester, focus());
    // The title opens the harness's actions — rename, restart, paste…
    await tester.tap(find.text('hn', findRichText: true).first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    await shoot(tester, key, '1d-focus-actions');
  });

  Future<void> openFind(WidgetTester tester) async {
    await tester.dragFrom(
      tester.getCenter(find.byType(TerminalPage).first) - const Offset(120, 0),
      const Offset(300, 0),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  testWidgets('find, typed', skip: skip, (tester) async {
    final key = await pumpScreen(tester, focus());
    await openFind(tester);
    await tester.enterText(find.byType(TextField), 'ap');
    await tester.pump(const Duration(milliseconds: 200));
    await shoot(tester, key, '3b-find-typed');
  });

  testWidgets('find, commands', skip: skip, (tester) async {
    final key = await pumpScreen(tester, focus());
    await openFind(tester);
    await tester.enterText(find.byType(TextField), '>');
    await tester.pump(const Duration(milliseconds: 200));
    await shoot(tester, key, '3c-find-commands');
  });

  testWidgets('new, task typed', skip: skip, (tester) async {
    final key = await pumpScreen(
      tester,
      NewAgentPage(notifier: notifier, machineId: 'm', voice: voice),
    );
    await tester.enterText(
      find.byType(TextField),
      'Fix the login test that fails on CI, then run the whole suite.',
    );
    await tester.pump(const Duration(milliseconds: 300));
    await shoot(tester, key, '4b-new-task');
  });

  testWidgets('new, keyboard up', skip: skip, (tester) async {
    final key = await pumpScreen(
      tester,
      NewAgentPage(notifier: notifier, machineId: 'm', voice: voice),
    );
    await tester.tap(find.byType(TextField));
    await tester.enterText(find.byType(TextField), 'Fix the login test');
    tester.view.viewInsets = const FakeViewPadding(bottom: 336 * 3);
    await tester.pump(const Duration(milliseconds: 300));
    await shoot(tester, key, '4e-new-keyboard');
  });

  testWidgets('new, project chooser', skip: skip, (tester) async {
    final key = await pumpScreen(
      tester,
      NewAgentPage(notifier: notifier, machineId: 'm', voice: voice),
    );
    await tester.tap(find.text('project'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await shoot(tester, key, '4c-new-project-chooser');
  });

  testWidgets('new, agent chooser', skip: skip, (tester) async {
    final key = await pumpScreen(
      tester,
      NewAgentPage(notifier: notifier, machineId: 'm', voice: voice),
    );
    await tester.tap(find.text('agent'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await shoot(tester, key, '4d-new-agent-chooser');
  });

  Future<GlobalKey> expandedNew(WidgetTester tester, String engine) async {
    final key = await pumpScreen(
      tester,
      NewAgentPage(notifier: notifier, machineId: 'm', voice: voice),
    );
    await tester.tap(find.text('agent'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    final choice = find
        .text(engine == 'codex' ? 'Codex' : 'Claude Code', findRichText: true)
        .last;
    await tester.ensureVisible(choice);
    await tester.tap(choice);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('options'));
    await tester.pump(const Duration(milliseconds: 300));
    expect(
      find.text(engine == 'codex' ? 'OpenAI' : 'Anthropic'),
      findsOneWidget,
    );
    if (engine == 'codex') expect(find.text('profile'), findsOneWidget);
    return key;
  }

  for (final engine in ['claude', 'codex']) {
    testWidgets('new, $engine options', skip: skip, (tester) async {
      final key = await expandedNew(tester, engine);
      await shoot(tester, key, '4f-new-$engine-options');
    });
  }

  testWidgets('new, models', skip: skip, (tester) async {
    final key = await expandedNew(tester, 'codex');
    await tester.tap(find.text('model'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await shoot(tester, key, '4g-new-models');
  });

  testWidgets('settings', skip: skip, (tester) async {
    final key = await pumpScreen(tester, SettingsPage(notifier: notifier));
    await shoot(tester, key, '5-settings');
  });
}

class _MemoryStore implements LocalKeyValueStore {
  final _values = <String, String>{};

  @override
  Future<String?> read(String key) async => _values[key];

  @override
  Future<void> write(String key, String value) async => _values[key] = value;

  @override
  Future<void> delete(String key) async => _values.remove(key);
}
