import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/companions/companion_home.dart';
import 'package:harness/companions/companion_story.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:xterm/xterm.dart';
import 'package:harness/daemons/daemon_brain.dart';
import 'package:harness/daemons/daemon_face.dart';
import 'package:harness/daemons/illustrated_art.dart';
import 'package:harness/daemons/illustrated_image.dart';
import 'package:harness/daemons/roster.dart';
import 'package:harness/daemons/zoo.dart';
import 'package:harness/daemons/zoo_controller.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/state/machine_profile.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/workspace_status.dart';

import 'daemons/zoo_test.dart' show FakeZooTransport;
import 'support/real_fonts.dart';
import 'support/coding_memory_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore, createApp;
import 'swarm_screen_test.dart' show terminal;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
    final serif = [
      '/System/Library/Fonts/Supplemental/Georgia.ttf',
      '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf',
      '/usr/share/fonts/liberation/LiberationSerif-Regular.ttf',
    ].map(File.new).where((f) => f.existsSync()).firstOrNull;
    if (serif != null) {
      await (FontLoader('Georgia')..addFont(
            Future.value(ByteData.sublistView(await serif.readAsBytes())),
          ))
          .load();
    }
  });

  test(
    'home is a single utility tab, persists and never adopts agent panes',
    () async {
      final storage = MemoryStore();
      final app = createApp(store: storage);
      addTearDown(app.dispose);
      await app.addAgentToSwarm('m', 'a0');
      final work = app.activeSwarm;
      app.openCompanions();
      final home = app.activeSwarm;
      app.selectSwarm(work.id);
      app.openCompanions();
      expect(app.activeSwarm, same(home));
      expect(app.swarms.where((s) => s.isCompanions), hasLength(1));
      expect(home.panes, isEmpty);
      expect(work.panes.single.agentId, 'a0');
      expect(swarmMatchesMachineProfile(home, 'another-machine'), isTrue);
      expect(workspaceTabNames(app)[home.id], 'companions');
      await app.flushPaneLayout();
      final restored = createApp(store: storage);
      addTearDown(restored.dispose);
      await restored.restorePaneLayoutForTest();
      expect(restored.activeSwarm.isCompanions, isTrue);
      expect(restored.activeSwarm.nameIsCustom, isFalse);
      // A malformed utility layout never attaches its alleged terminal.
      final malformedStorage = MemoryStore();
      final layout = PaneLayoutStore(storage: malformedStorage);
      await layout.saveSwarms([
        Swarm(id: 'home', name: Swarm.companionsName, kind: 'companions')
          ..panes.add(work.panes.single),
        Swarm(id: 'duplicate', name: Swarm.companionsName, kind: 'companions'),
      ], 'home');
      final malformed = createApp(store: malformedStorage);
      addTearDown(malformed.dispose);
      await malformed.restorePaneLayoutForTest();
      expect(malformed.swarms.where((s) => s.isCompanions), hasLength(1));
      expect(malformed.allPanes, isEmpty);
    },
  );

  test('all ten have distinct worlds and real growth thresholds', () {
    expect(CompanionStory.stories.keys.toSet(), IllustratedArt.species.toSet());
    expect(
      CompanionStory.stories.values.map((s) => s.story).toSet(),
      hasLength(10),
    );
    final little = ZooDaemon(id: 'tim', hatched: '', egg: 'first', xp: 49);
    expect(nextCompanionGrowth(daemonRoster, little)?.target, 150);
    expect(
      nextCompanionGrowth(
        daemonRoster,
        little.copyWith(version: '1.0', xp: 150),
      )?.target,
      600,
    );
    expect(
      nextCompanionGrowth(
        daemonRoster,
        little.copyWith(version: '2.0', xp: 600),
      ),
      isNull,
    );
  });

  late ZooController zoo;
  late DaemonFace face;
  late DaemonBrain brain;
  late FakeZooTransport remote;
  late List<(String, Map<String, dynamic>)> sent;
  late GlobalKey boundary;

  late AppNotifier workspace;
  late TerminalSession conversation;
  late List<TerminalBinaryFrame> input;

  Future<void> mount(
    WidgetTester tester, {
    Size size = const Size(1400, 950),
    Brightness brightness = Brightness.dark,
    double scale = 1,
    MemoryFixture? codingMemory,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final previous = grid.AppTheme.brightness.value;
    final previousPalette = grid.AppTheme.palette.value;
    grid.AppTheme.palette.value = brightness == Brightness.light
        ? HarnessPalette.paper
        : HarnessPalette.graphite;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() {
      grid.AppTheme.palette.value = previousPalette;
      grid.AppTheme.brightness.value = previous;
    });
    remote = FakeZooTransport()
      ..zoo = Zoo(
        daemons: [
          ZooDaemon(
            uid: 'tim-one',
            id: 'tim',
            seed: 52,
            hatched: '2026-09-28T10:00:00Z',
            egg: 'first',
            xp: 23,
          ),
          ZooDaemon(
            uid: 'gnu-one',
            id: 'gnu',
            seed: 81,
            hatched: '2026-09-29T10:00:00Z',
            egg: 'turn',
            xp: 150,
            version: '1.0',
          ),
        ],
        pair: 'tim-one',
        firstEgg: true,
      );
    zoo = ZooController();
    face = DaemonFace(zoo)
      ..setEnvironment(foreground: true, reduceMotion: true);
    sent = [];
    brain =
        DaemonBrain(
          now: tester.binding.clock.now,
          send: (type, payload) {
            sent.add((type, payload));
            return true;
          },
        )..receive('daemon_state', {
          'pair': 'tim',
          'companionHarness': {'agentId': 'a0', 'engine': 'codex'},
        });
    zoo.bind('account:fixture', remote: remote);
    await tester.pump();
    face.sync(const DaemonWatch());
    // Start the multi-stage material decoder outside FakeAsync. Its native
    // codec callbacks otherwise wait for a fake microtask while precache waits.
    await tester.runAsync(() async {
      for (final d in zoo.zoo.daemons) {
        for (final version in ['0.1', '1.0', '2.0']) {
          final art = IllustratedArt.daemon(
            d.id,
            version: version,
            traits: zoo.traitsOf(d),
          );
          for (final small in [true, false]) {
            final image = IllustratedImage(
              art.asset(0, slot: small),
              art.colour,
              art.mark,
            );
            final stream = image.resolve(ImageConfiguration.empty);
            final done = Completer<void>();
            final listener = ImageStreamListener((info, _) {
              info.dispose();
              if (!done.isCompleted) done.complete();
            }, onError: (Object e, StackTrace? s) => done.completeError(e, s));
            stream.addListener(listener);
            try {
              await done.future.timeout(const Duration(seconds: 15));
            } finally {
              stream.removeListener(listener);
            }
          }
        }
      }
    });
    workspace = createApp(connected: true);
    workspace.openCompanions();
    workspace.syncCompanionViewer(enabled: true, machineId: 'm');
    input = [];
    conversation = terminal('a0', input)..agentName = 'Tim';
    conversation.terminal.write(
      '\x1b[1mTim\x1b[0m\r\n\r\nA little company for whatever you are making.\r\n\r\n> ',
    );
    workspace.adoptSessionForTest(conversation);
    await workspace.showCompanionTerminal('m', 'a0');
    workspace.focusPane(workspace.panes.first.id);
    boundary = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: boundary,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(
              disableAnimations: true,
              textScaler: TextScaler.linear(scale),
            ),
            child: child!,
          ),
          home: Scaffold(
            body: ListenableBuilder(
              listenable: workspace,
              builder: (context, _) => PaneGrid(
                notifier: workspace,
                swarmMode: true,
                companionViewer: (_) => CompanionHome(
                  face: face,
                  brain: brain,
                  openMemoryConnection: codingMemory == null
                      ? null
                      : () => codingMemory,
                  onHatch: (_) {},
                  onOpenControls: (_) {},
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    addTearDown(() {
      face.dispose();
      zoo.dispose();
      brain.dispose();
      workspace.dispose();
    });
  }

  Future<void> capture(WidgetTester tester, String name) async {
    await tester.runAsync(() async {
      for (final e in find.byType(Image).evaluate().toList()) {
        await precacheImage(
          (e.widget as Image).image,
          e,
        ).timeout(const Duration(seconds: 15));
      }
    });
    await tester.pump();
    expect(tester.takeException(), isNull);
    final output = Platform.environment['COMPANION_CAPTURE_DIR'];
    if (output == null) return;
    await tester.runAsync(() async {
      final render =
          boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await render.toImage(pixelRatio: 1.5);
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      await Directory(output).create(recursive: true);
      await File('$output/$name.png').writeAsBytes(data!.buffer.asUint8List());
      image.dispose();
    });
  }

  for (final (label, size, brightness, scale) in [
    ('wide-dark', const Size(1520, 1020), Brightness.dark, 1.0),
    ('wide-light', const Size(1520, 1020), Brightness.light, 1.0),
    ('narrow', const Size(560, 860), Brightness.dark, 1.0),
    ('large-text', const Size(1100, 900), Brightness.dark, 1.8),
  ]) {
    testWidgets('storybook layout: $label', (tester) async {
      await mount(tester, size: size, brightness: brightness, scale: scale);
      expect(find.text('Meet Tim.'), findsOneWidget);
      expect(sent, isEmpty, reason: 'Opening the home never starts a model');
      await capture(tester, label);
      await tester.tap(find.byKey(const ValueKey('companion-nav-Collection')));
      await tester.pump();
      await capture(tester, '$label-collection');
      expect(remote.batches, isEmpty);
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets(
    'gallery does not pair; choosing an owned friend explicitly does',
    (tester) async {
      await mount(tester);
      await tester.tap(find.byKey(const ValueKey('companion-nav-Collection')));
      await tester.pump();
      await tester.tap(find.text('Meet all ten companions'));
      await tester.pump();
      await tester.ensureVisible(find.text('Meet Beastie'));
      await tester.tap(find.text('Meet Beastie'));
      await tester.pump();
      expect(find.text('Meet Beastie.'), findsOneWidget);
      expect(zoo.zoo.pair, 'tim-one');
      expect(remote.batches, isEmpty);
      expect(find.byKey(const ValueKey('companion-pair')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('companion-nav-Collection')));
      await tester.pump();
      await tester.tap(find.text('GNU').first);
      await tester.pump();
      expect(zoo.zoo.pair, 'tim-one');
      await tester.tap(find.text('Make my companion'));
      await tester.pump();
      expect(zoo.zoo.pair, 'gnu-one');
      expect(
        remote.batches.expand((b) => b).where((o) => o['op'] == 'zoo.pair'),
        hasLength(1),
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'coding library opens inside the DSH viewer without terminal input or history replay',
    (tester) async {
      final memory = MemoryFixture();
      await mount(tester, codingMemory: memory);
      await tester.tap(find.byKey(const ValueKey('companion-nav-Memories')));
      brain.receive('pair_result', {
        'requestId': sent.single.$2['requestId'],
        'ok': true,
        'lessons': [],
      });
      await tester.pump();
      await tester.pump();
      expect(find.text('Your coding memory'), findsOneWidget);
      expect(
        find.text('For regression fixes, start with a small failing test.'),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('memory-review-recent')), findsNothing);
      expect(find.byType(TerminalPanel), findsOneWidget);
      expect(input, isEmpty);
      expect(
        memory.calls.where((c) => ['apply', 'preview'].contains(c['action'])),
        isEmpty,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'an open Memories viewer discovers coding memory enabled in settings',
    (tester) async {
      final memory = MemoryFixture()
        ..handle = (_) async => {'ok': false, 'error': 'UNSUPPORTED'};
      await mount(tester, codingMemory: memory);
      await tester.tap(find.byKey(const ValueKey('companion-nav-Memories')));
      brain.receive('pair_result', {
        'requestId': sent.single.$2['requestId'],
        'ok': true,
        'lessons': [],
      });
      await tester.pump();
      await tester.pump();
      expect(find.text('For regression fixes, start with a small failing test.'), findsNothing);
      memory.handle = null;
      await tester.pump(const Duration(seconds: 30));
      brain.receive('pair_result', {
        'requestId': sent.last.$2['requestId'],
        'ok': true,
        'lessons': [],
      });
      await tester.pump();
      expect(find.text('For regression fixes, start with a small failing test.'), findsOneWidget);
      expect(input, isEmpty);
      expect(memory.calls.where((c) => ['apply', 'preview'].contains(c['action'])), isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'DSH keeps its viewer left and real agent terminal right, including setup',
    (tester) async {
      await mount(tester);
      final viewer = find.byKey(const ValueKey('companion-home'));
      final terminalView = find.byType(TerminalPanel);
      expect(terminalView, findsOneWidget);
      expect(
        tester.getRect(viewer).right,
        lessThan(tester.getRect(terminalView).left),
      );
      expect(find.byKey(const ValueKey('companion-chat-input')), findsNothing);
      expect(find.byTooltip('Open full conversation'), findsNothing);
      expect(workspace.swarms, hasLength(1));
      void expectBothPanesClear() {
        for (final pane in workspace.panes) {
          final frame = tester.widget<Container>(
            find.byKey(ValueKey('pane-frame:${pane.id}')),
          );
          expect((frame.foregroundDecoration as BoxDecoration).color, isNull);
        }
      }

      expectBothPanesClear();
      conversation.terminal.write(
        '\r\nDo you trust the files in this folder?\r\n> Yes, I trust this folder\r\n',
      );
      await tester.pump();
      final view = tester.widget<TerminalView>(find.byType(TerminalView));
      expect(
        view.terminal.buffer.getText(),
        contains('Yes, I trust this folder'),
      );
      expect(view.terminal, same(conversation.terminal));
      await capture(tester, 'conversation-setup');
      // A real terminal key uses the shared binary stream exactly once, never a
      // second chat API or automatic approval of the setup text above.
      await tester.tap(find.byType(TerminalView));
      await tester.pump();
      expectBothPanesClear();
      expect(tester.testTextInput.hasAnyClients, isTrue);
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'h',
          selection: TextSelection.collapsed(offset: 1),
        ),
      );
      await tester.pump(const Duration(milliseconds: 30));
      expect(input, hasLength(1));
      expect(String.fromCharCodes(input.single.bytes), 'h');
      expect(sent, isEmpty);
      await tester.pump(const Duration(milliseconds: 350));
      final session = workspace.panes.last.session;
      final renderer = tester.state(find.byType(TerminalView));
      workspace.newSwarm();
      await tester.pump();
      workspace.openCompanions();
      await tester.pump();
      expect(workspace.panes.last.session, same(session));
      expect(tester.state(find.byType(TerminalView)), same(renderer));
      expect(find.byType(TerminalView), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final (label, size, brightness, scale) in [
    ('wide', const Size(1400, 950), Brightness.dark, 1.0),
    ('narrow', const Size(800, 950), Brightness.dark, 1.0),
    ('large-light', const Size(1100, 950), Brightness.light, 1.8),
  ]) {
    testWidgets('memory inbox reviews and approves a sourced lesson: $label', (
      tester,
    ) async {
      await mount(tester, size: size, brightness: brightness, scale: scale);
      final renderer = tester.state(find.byType(TerminalView));
      await tester.tap(find.byKey(const ValueKey('companion-nav-Memories')));
      await tester.pump();
      final lesson = {
        'id': 'beef01',
        'name': 'keep-the-dsh-layout',
        'kind': 'skill',
        'status': 'pending',
        'description': 'Keep the standard viewer and agent arrangement.',
        'signal': 'conversation',
        'reason': 'You explicitly described this layout in your conversation.',
        'sources': [
          {
            'title': 'Companion design',
            'engine': 'claude',
            'turn': 2,
            'at': 1790762400000,
          },
        ],
        'evidence': ['You: Every DSH has a viewer and an agent terminal.'],
      };
      brain.receive('pair_result', {
        'requestId': sent.last.$2['requestId'],
        'ok': true,
        'lessons': [lesson],
        'learning': {
          'state': 'ready',
          'model': 'opus',
          'pending': 1,
          'history': {
            'state': 'complete',
            'hours': 24,
            'total': 8,
            'reviewed': 8,
            'proposed': 1,
          },
        },
      });
      await tester.pump();
      expect(find.text('1 possible memory'), findsOneWidget);
      expect(
        find.text('You explicitly described this layout in your conversation.'),
        findsOneWidget,
      );
      expect(find.textContaining('Companion design · claude'), findsOneWidget);
      final open = find.byKey(const ValueKey('memory-open-beef01'));
      await tester.ensureVisible(open);
      await tester.tap(open);
      await tester.pump();
      expect(sent.last.$2, containsPair('action', 'review'));
      brain.receive('pair_result', {
        'requestId': sent.last.$2['requestId'],
        'ok': true,
        'reviewId': 'lesson:beef01:one-time',
        'text': 'Keep the viewer on the left.\nKeep the agent terminal on the right.',
        'expiresInMs': 600000,
      });
      await tester.pump();
      await tester.ensureVisible(find.text('Keep the viewer on the left.'));
      await tester.pump();
      await tester.ensureVisible(
        find.text('Keep the agent terminal on the right.'),
      );
      await tester.pump();
      final approve = find.byKey(const ValueKey('memory-approve-beef01'));
      expect(sent.where((s) => s.$1 == 'daemon_act'), isEmpty);
      expect(brain.wasShown('lesson:beef01:one-time'), isTrue);
      await tester.pump(DaemonBrain.armAfter);
      await tester.ensureVisible(approve);
      await tester.pump();
      expect(tester.widget<TextButton>(approve).onPressed, isNotNull);
      await capture(tester, 'memory-inbox-$label');
      await tester.tap(approve);
      await tester.pump();
      final approval = sent.last;
      expect(approval.$1, 'daemon_act');
      expect(approval.$2, containsPair('id', 'lesson:beef01:one-time'));
      expect(approval.$2, containsPair('choice', 'y'));
      brain.receive('daemon_act_result', {
        'requestId': approval.$2['requestId'],
        'id': 'lesson:beef01:one-time',
        'ok': true,
        'learned': 'keep-the-dsh-layout',
      });
      await tester.pump();
      brain.receive('pair_result', {
        'requestId': sent.last.$2['requestId'],
        'ok': true,
        'lessons': [
          {...lesson, 'status': 'approved'},
        ],
      });
      await tester.pump();
      expect(find.text('1 possible memory'), findsNothing);
      expect(tester.state(find.byType(TerminalView)), same(renderer));
      expect(input, isEmpty);
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets('a 24-hour lookback queues a review without approving lessons', (
    tester,
  ) async {
    await mount(tester);
    await tester.tap(find.byKey(const ValueKey('companion-nav-Memories')));
    await tester.pump();
    brain.receive('pair_result', {
      'requestId': sent.last.$2['requestId'],
      'ok': true,
      'lessons': [],
      'learning': {'state': 'ready', 'model': 'opus'},
    });
    await tester.pump();
    final review = find.byKey(const ValueKey('memory-review-recent'));
    await tester.ensureVisible(review);
    await tester.tap(review);
    await tester.pump();
    expect(sent.last.$2, containsPair('action', 'review_recent'));
    expect(sent.last.$2, containsPair('hours', 24));
    brain.receive('pair_result', {
      'requestId': sent.last.$2['requestId'],
      'ok': true,
    });
    await tester.pump();
    brain.receive('pair_result', {
      'requestId': sent.last.$2['requestId'],
      'ok': true,
      'lessons': [],
      'learning': {
        'state': 'ready',
        'model': 'opus',
        'history': {
          'state': 'reviewing',
          'hours': 24,
          'total': 10,
          'reviewed': 0,
          'proposed': 0,
        },
      },
    });
    await tester.pump();
    expect(find.text('Looking back over 24 hours'), findsOneWidget);
    expect(find.text('Stop review'), findsOneWidget);
    expect(tester.widget<TextButton>(review).onPressed, isNull);
    expect(sent.where((s) => s.$1 == 'daemon_act'), isEmpty);
    // A provider quota pause keeps the job, explains the cause and lets the
    // person retry after changing the model in the same agent pane.
    await tester.ensureVisible(find.text('Refresh memories'));
    await tester.tap(find.text('Refresh memories'));
    await tester.pump();
    brain.receive('pair_result', {
      'requestId': sent.last.$2['requestId'],
      'ok': true,
      'lessons': [],
      'learning': {
        'state': 'ready',
        'model': 'opus',
        'history': {
          'state': 'waiting',
          'error': 'usage-limit',
          'total': 10,
          'reviewed': 0,
        },
      },
    });
    await tester.pump();
    expect(
      find.textContaining('Your chosen agent has reached its usage limit.'),
      findsOneWidget,
    );
    expect(find.text('Retry review'), findsOneWidget);
    expect(tester.widget<TextButton>(review).onPressed, isNotNull);
    expect(sent.where((s) => s.$1 == 'daemon_act'), isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'memory book shows backend lessons and forget is an explicit action',
    (tester) async {
      await mount(tester);
      await tester.tap(find.byKey(const ValueKey('companion-nav-Memories')));
      await tester.pump();
      final request = sent.single.$2;
      expect(request['verb'], 'lessons');
      brain.receive('pair_result', {
        'requestId': request['requestId'],
        'ok': true,
        'learning': {
          'state': 'ready',
          'model': 'opus',
          'effort': 'high',
          'queued': 2,
        },
        'lessons': [
          {
            'id': 'lesson-one',
            'name': 'Check the small things',
            'description': 'Run focused checks before finishing a change.',
            'status': 'approved',
            'kind': 'note',
          },
        ],
      });
      await tester.pump();
      expect(find.text('Check the small things'), findsOneWidget);
      expect(find.text('Learning with Opus'), findsOneWidget);
      expect(
        find.text('2 observations are waiting for a quiet moment to review.'),
        findsOneWidget,
      );
      await capture(tester, 'memories');
      await tester.ensureVisible(find.text('Forget…'));
      await tester.tap(find.text('Forget…'));
      await tester.pump();
      expect(sent, hasLength(1));
      await tester.ensureVisible(find.text('Forget shared lesson'));
      await tester.tap(find.text('Forget shared lesson'));
      await tester.pump();
      expect(sent.last.$2, containsPair('action', 'revert'));
      expect(sent.last.$2, containsPair('id', 'lesson-one'));
      // Unmount before clearing the pending request.
      await tester.pumpWidget(const SizedBox());
      brain.reset();
      await tester.pump();
    },
  );
}
