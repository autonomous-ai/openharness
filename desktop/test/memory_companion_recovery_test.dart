import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/companions/coding_memory_connection.dart';
import 'package:harness/companions/coding_memory_view.dart';
import 'package:harness/companions/companion_home.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/daemons/zoo.dart';
import 'package:harness/daemons/zoo_controller.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/experimental_features.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:xterm/xterm.dart';

import 'daemons/zoo_test.dart' show FakeZooTransport;
import 'support/coding_memory_fixture.dart';
import 'support/experimental_settings.dart';
import 'support/real_fonts.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show MemoryStore;

class _MemoryWorkspace extends AppNotifier {
  _MemoryWorkspace(this.memory)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        paneLayoutStore: PaneLayoutStore(storage: MemoryStore()),
      );

  final MemoryFixture memory;

  @override
  CodingMemoryConnection? openCodingMemoryConnection() => memory;
}

void main() => memoryCompanionRecoveryTests();

void memoryCompanionRecoveryTests({bool native = false}) {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(loadRealFonts);

  testWidgets(
    'Memories reopens the same companion after failure without duplicate requests or changing its DSH',
    (tester) async {
      final memory = MemoryFixture()
        ..runtime = {
          'state': 'ready',
          'learning': {
            'state': 'waiting_for_model',
            'reason': 'companion_stopped',
          },
          'capture': {'state': 'unavailable', 'reason': 'memory_backlog_full'},
        };
      final app = _MemoryWorkspace(memory)
        ..hasNavigationRail = false
        ..currentUser = const CurrentUserProfile(
          id: 'owner',
          email: 'owner@example.test',
        );
      addTearDown(app.dispose);
      const machine = Machine(
        machineId: 'm',
        authMode: MachineAuthMode.remote,
        name: 'Fixture',
      );
      app.machines = [machine];
      app.machineStates['m'] = MachineState(machine)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..localEndpoint = LocalCliEndpoint(
          computerId: 'fixture',
          wsUri: Uri.parse('ws://fixture.invalid'),
          protocolVersion: 1,
          terminalProtocolVersion: 3,
        )
        ..agents = [
          const Agent(
            id: 'pair-one',
            name: 'Companions',
            engine: 'codex',
            dsh: 'autonomous/pair',
            terminalAvailable: true,
          ),
        ];
      final frames = <(String, Map<String, dynamic>)>[];
      app.daemonFrameSenderForTest = (type, payload) {
        frames.add((type, payload));
        return true;
      };
      final input = <TerminalBinaryFrame>[];
      final conversation = terminal('pair-one', input);
      conversation.terminal.write(
        'Companion terminal (synthetic fixture)\r\n\r\n> ',
      );
      app.adoptSessionForTest(conversation);
      final experiments = MemoryExperimentalFeaturesStore(
        storage: MemoryStore(),
      );
      await experiments.set(ExperimentalFeature.focusBarCreature, true);
      final zoo = ZooController();
      final preview = ValueNotifier(true);
      addTearDown(experiments.dispose);
      addTearDown(zoo.dispose);
      addTearDown(preview.dispose);
      final remote = FakeZooTransport()
        ..revision = 1
        ..zoo = Zoo(
          daemons: [
            ZooDaemon(uid: 'tim-one', id: 'tim', hatched: '', egg: 'first'),
          ],
          pair: 'tim-one',
          firstEgg: true,
          consent: const ZooConsent(watching: true, at: '2026-10-03T00:00:00Z'),
        );
      if (!native) {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(1280, 1000);
        addTearDown(tester.view.reset);
      }
      final boundary = GlobalKey();
      Future<void> capture(String name) async {
        final directory =
            Platform.environment['HARNESS_MEMORY_WORKSPACE_CAPTURE_DIR'];
        if (directory == null) return;
        await tester.runAsync(() async {
          final image =
              await (boundary.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 1);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(directory).create(recursive: true);
          await File('$directory/$name.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
      }

      Future<void> frame(String type, Map<String, dynamic> payload) async {
        await app.handleMachineEventForTest('m', {
          'type': type,
          'payload': payload,
        });
        await tester.pump();
      }

      Iterable<(String, Map<String, dynamic>)> opens() =>
          frames.where((f) => f.$1 == 'daemon_open');
      Future<void> answerOpen(bool ok) => frame('daemon_open_result', {
        'requestId': opens().last.$2['requestId'],
        'ok': ok,
        if (ok) 'agentId': 'pair-one',
        if (ok) 'engine': 'codex',
        if (!ok) 'error': 'RESUME_FAILED',
      });

      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: SwarmScreen(
              notifier: app,
              experimentalFeatures: experiments,
              projectStore: SwarmProjectStore(),
              zoo: zoo,
              zooTransport: remote,
              daemonClock: () => tester.binding.clock.now(),
              daemonsPreview: preview,
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      await frame('daemon_state', {
        'pair': 'tim',
        'companionHarness': {'agentId': 'pair-one', 'engine': 'codex'},
        'needs': [],
        'working': 0,
        'failing': [],
        'machines': [],
        'done': {'count': 0, 'last': []},
        'asks': [],
        'acted': [],
      });
      await tester.tap(find.byKey(const ValueKey('daemon-slot')));
      await tester.pump();
      await tester.pump();
      expect(opens(), hasLength(1));
      await answerOpen(true);
      await tester.pump();
      final tab = app.activeSwarm;
      final paneIds = app.panes.map((p) => p.id).toList();
      final tabIds = app.swarms.map((s) => s.id).toList();
      expect(tab.isCompanions, isTrue);
      expect(
        tab.manualLayout!.tiles,
        PaneArrangement.viewerBesideTerminal.tiles,
      );

      void expectSplit(double fraction) {
        final left = tester.getRect(
          find.byKey(ValueKey('pane-frame:${paneIds.first}')),
        );
        final right = tester.getRect(
          find.byKey(ValueKey('pane-frame:${paneIds.last}')),
        );
        expect(left.right, lessThanOrEqualTo(right.left));
        expect(left.width / (left.width + right.width), closeTo(fraction, .02));
      }

      expectSplit(.7);
      final resized = PaneArrangement(const [
        Rect.fromLTRB(0, 0, .62, 1),
        Rect.fromLTRB(.62, 0, 1, 1),
      ]);
      tab.savePaneSizes('2:manual', resized);
      app.stateOf('m')!.agents[0] = app
          .stateOf('m')!
          .agents[0]
          .copyWith(status: 'stopped');
      app.notifyListeners();
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('companion-nav-Memories')));
      await tester.pump();
      for (final request in frames.where((f) => f.$1 == 'pair').toList()) {
        await frame('pair_result', {
          'requestId': request.$2['requestId'],
          'ok': true,
          'lessons': [],
        });
      }
      await tester.pump();
      final action = find.byKey(const ValueKey('memory-open-companion'));
      expect(action, findsOneWidget);
      expect(
        opens(),
        hasLength(1),
        reason: 'Reading the blocked state does not resume the agent.',
      );
      final retained = tester
          .widget<CompanionHome>(find.byType(CompanionHome))
          .onOpenConversation!;
      await tester.ensureVisible(action);
      await capture('memory-recovery-waiting');
      await tester.tap(action);
      await tester.pump();
      await tester.pump();
      expect(opens(), hasLength(2));
      expect(tester.widget<TextButton>(action).onPressed, isNull);
      retained();
      await tester.pump();
      expect(
        opens(),
        hasLength(2),
        reason: 'An already-rendered callback cannot duplicate pending work.',
      );
      expectSplit(.62);

      await answerOpen(false);
      await tester.pump();
      expect(action, findsOneWidget);
      expect(tester.widget<TextButton>(action).onPressed, isNotNull);
      expectSplit(.62);
      await tester.ensureVisible(action);
      await capture('memory-recovery-retry');
      await tester.tap(action);
      await tester.pump();
      await tester.pump();
      expect(opens(), hasLength(3));
      app.stateOf('m')!.agents[0] = app
          .stateOf('m')!
          .agents[0]
          .copyWith(status: 'active');
      await answerOpen(true);
      await tester.pump();
      expect(app.activeSwarm, same(tab));
      expect(app.swarms.map((s) => s.id), tabIds);
      expect(app.panes.map((p) => p.id), paneIds);
      expect(app.panes.last.agentId, 'pair-one');
      expect(app.panes.last.session, same(conversation));
      expect(app.focusedPane!.id, paneIds.last);
      expect(tab.manualLayout, same(resized));
      expectSplit(.62);
      final view = tester.widget<TerminalView>(find.byType(TerminalView));
      expect(view.focusNode!.hasFocus, isTrue);
      expect(input, isEmpty, reason: 'Recovery sends no terminal input.');
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
      await tester.pump(const Duration(milliseconds: 30));
      expect(input.single.bytes, [27, 91, 67]);
      await capture('memory-recovery-resumed');
      expect(
        opens().every(
          (f) =>
              f.$2['companionUid'] == 'tim-one' &&
              !f.$2.containsKey('engine') &&
              !f.$2.containsKey('text'),
        ),
        isTrue,
      );
      expect(frames.where((f) => f.$1 == 'daemon_talk'), isEmpty);
      expect(
        memory.calls.where((p) => ['preview', 'apply'].contains(p['action'])),
        isEmpty,
      );
      expect(memory.learn, isTrue);
      expect(memory.recall, isTrue);

      memory.runtime = {
        'state': 'ready',
        'learning': {'state': 'learned', 'learned': 1},
      };
      await tester
          .widget<CodingMemoryView>(find.byType(CodingMemoryView))
          .library
          .refresh();
      await tester.pump();
      expect(action, findsNothing);
      final oldOwner = tester
          .widget<CompanionHome>(find.byType(CompanionHome))
          .onOpenConversation!;
      app.currentUser = const CurrentUserProfile(
        id: 'another-owner',
        email: 'another@example.test',
      );
      app.notifyListeners();
      await tester.pump();
      final count = opens().length;
      oldOwner();
      await tester.pump();
      expect(opens(), hasLength(count));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 11));
    },
  );
}
