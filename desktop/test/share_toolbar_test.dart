import 'dart:async';

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/experimental_features.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/sharing/share_harness_dialog.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/app_shortcuts.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/shortcuts/keymap_native.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/workspace_share_button.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/experimental_settings.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp, MemoryStore;

class _SharingConnection extends WsConn {
  _SharingConnection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final shares = <(String, String)>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (!type.startsWith('harness_share_')) return {};
    shares.add((type, payload['agentId'] as String));
    return {'collaboration': true, 'shares': []};
  }
}

void main() {
  final button = find.byKey(const ValueKey('workspace-share-button'));
  void expectSharedHarness(String name) {
    final dialog = find.byType(ShareHarnessDialog);
    expect(
      find.descendant(of: dialog, matching: find.text('Share harness')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: dialog, matching: find.text(name)),
      findsOneWidget,
    );
  }

  late AppNotifier app;
  late MemoryKeymap keymap;
  late MemoryStore preferences;
  late ExperimentalFeaturesStore experiments;
  late _SharingConnection connection;
  final input = <TerminalBinaryFrame>[];

  // Initialize the icon library before the deep viewer build stack in Chrome.
  setUpAll(() => expect(AppIcons.refreshCw.codePoint, greaterThan(0)));

  setUp(() async {
    connection = _SharingConnection();
    app = createApp(connectionForTest: (_) => connection);
    app.stateOf('m')!.nodeOnline = true;
    keymap = MemoryKeymap();
    preferences = MemoryStore();
    experiments = MemoryExperimentalFeaturesStore(storage: preferences);
    // Finish the real-zone read before testWidgets enters its fake clock.
    await experiments.refresh();
    input.clear();
  });
  tearDown(() {
    app.dispose();
    keymap.dispose();
    experiments.dispose();
  });

  Future<void> mount(
    WidgetTester tester, {
    bool native = false,
    bool enableShareButton = true,
    Size size = const Size(1280, 800),
  }) async {
    if (enableShareButton) {
      await experiments.set(ExperimentalFeature.shareButton, true);
    }
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: KeymapProvider(
          keymap: keymap,
          child: SwarmScreen(
            notifier: app,
            nativeTabs: native,
            experimentalFeatures: experiments,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> shareKey(WidgetTester tester) => key(
    tester,
    LogicalKeyboardKey.keyS,
    cmd: !kIsWeb,
    alt: kIsWeb,
    shift: true,
  );

  for (final native in [false, true]) {
    testWidgets(
      'Share defaults hidden and its saved Settings toggle updates the toolbar (native=$native)',
      (tester) async {
        const feature = ExperimentalFeature.shareButton;
        const channel = MethodChannel('harness/swarm_tabs');
        final updates = <Map>[];
        final messenger = tester.binding.defaultBinaryMessenger;
        messenger.setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'update') updates.add(call.arguments as Map);
          return true;
        });
        addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
        final session = terminal('a0', input);
        final pane = app.adoptSessionForTest(session);
        await mount(tester, native: native, enableShareButton: false);
        expect(experiments.choice(feature), isFalse);
        expect(button, findsNothing);
        if (native) expect(updates.last['shareAction'], isNull);

        Future<void> openExperimental() async {
          await key(
            tester,
            LogicalKeyboardKey.comma,
            cmd: !kIsWeb,
            alt: kIsWeb,
          );
          await tester.pumpAndSettle();
          await tester.tap(find.text('Experimental'));
          await tester.pumpAndSettle();
        }

        await openExperimental();
        final toggle = find.byKey(const ValueKey('experimental-share_button'));
        expect(tester.widget<Switch>(toggle).value, isFalse);
        await tester.tap(toggle);
        await tester.pumpAndSettle();
        expect(tester.widget<Switch>(toggle).value, isTrue);
        expect(preferences.values[experimentFixtureKey(feature)], 'on');
        await tester.tap(find.byKey(const Key('settings-back-button')));
        await tester.pumpAndSettle();
        expect(find.byType(SettingsScreen), findsNothing);
        final shownTarget = native ? updates.last['shareAction'] as Map : null;
        if (native) {
          expect(shownTarget!['enabled'], isTrue);
        } else {
          expect(button, findsOneWidget);
        }

        await openExperimental();
        expect(tester.widget<Switch>(toggle).value, isTrue);
        await tester.tap(toggle);
        await tester.pumpAndSettle();
        expect(preferences.values[experimentFixtureKey(feature)], 'off');
        await tester.tap(find.byKey(const Key('settings-back-button')));
        await tester.pumpAndSettle();
        expect(button, findsNothing);
        if (native) {
          expect(updates.last['shareAction'], isNull);
          final done = Completer<void>();
          messenger.handlePlatformMessage(
            channel.name,
            const StandardMethodCodec().encodeMethodCall(
              MethodCall('shareAgent', shownTarget),
            ),
            (_) => done.complete(),
          );
          await tester.pumpAndSettle();
          expect(done.isCompleted, isTrue);
        }
        expect(connection.shares, isEmpty);
        expect(input, isEmpty);
        expect(pane.session, same(session));
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets(
    'button and shortcut share only the focused agent and return terminal focus',
    (tester) async {
      final firstSession = terminal('a0', input);
      final first = app.adoptSessionForTest(firstSession);
      final second = app.adoptSessionForTest(terminal('a1', input));
      await mount(tester);
      app.focusPane(first.id);
      await tester.pump();
      expect(
        tester.widget<WorkspaceShareButton>(button).tooltip,
        'Share Agent 0 · ${keymap.hint('agent.share')}',
      );
      await tester.tap(button);
      await tester.pumpAndSettle();
      expectSharedHarness('Agent 0');
      expect(connection.shares, [('harness_share_list', 'a0')]);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(first.session, same(firstSession));
      app.focusPane(second.id);
      await tester.pump();
      await shareKey(tester);
      await tester.pumpAndSettle();
      expectSharedHarness('Agent 1');
      await shareKey(tester);
      await tester.pump();
      expect(find.byType(ShareHarnessDialog), findsOneWidget);
      expect(connection.shares, [
        ('harness_share_list', 'a0'),
        ('harness_share_list', 'a1'),
      ]);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(
        input,
        isEmpty,
        reason: 'opening and dismissing Share never types into an agent',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 100));
      expect(
        input,
        isNotEmpty,
        reason: 'normal typing returns to the terminal',
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('empty and view-only panes keep an inactive Share button', (
    tester,
  ) async {
    await mount(tester);
    expect(tester.widget<WorkspaceShareButton>(button).onPressed, isNull);
    await shareKey(tester);
    expect(connection.shares, isEmpty);
    const shared = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      isShared: true,
    );
    app.machineStates['m'] = MachineState(shared)
      ..agents = const [Agent(id: 'a0', name: 'Shared agent')];
    app.adoptSessionForTest(terminal('a0', input));
    await tester.pump();
    expect(tester.widget<WorkspaceShareButton>(button).onPressed, isNull);
    await tester.tap(button);
    await shareKey(tester);
    await tester.pump();
    expect(connection.shares, isEmpty);
    expect(find.byType(ShareHarnessDialog), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a dependent viewer shares its owning agent', (tester) async {
    app.adoptSessionForTest(terminal('a0', input));
    final viewer = TerminalPane(
      id: 99,
      machineId: 'm',
      kind: PaneKind.web,
      ownerAgentId: 'a0',
    );
    app.panes.add(viewer);
    app.focusedPaneId = viewer.id;
    await mount(tester);
    await tester.tap(button);
    await tester.pumpAndSettle();
    expect(connection.shares.single, ('harness_share_list', 'a0'));
    expectSharedHarness('Agent 0');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'Share stays in the footer at narrow widths and follows custom shortcuts',
    (tester) async {
      app.adoptSessionForTest(terminal('a0', input));
      await mount(tester, size: const Size(520, 800));
      final bar = tester.getRect(
        find.byKey(const ValueKey('workspace-status-bar')),
      );
      expect(tester.getRect(button).right, lessThanOrEqualTo(bar.right));
      expect(bar.contains(tester.getRect(button).center), isTrue);
      expect(
        tester.getRect(button).top,
        greaterThan(
          tester
              .getRect(find.byKey(const ValueKey('workspace-tab-bar')))
              .bottom,
        ),
      );
      expect(tester.takeException(), isNull);
      keymap.apply(
        '{"bindings":[{"keys":"${platformWorkspaceBinding("cmd+shift+s")}","command":null},{"keys":"f8","command":"agent.share"}]}',
      );
      await tester.pump();
      expect(
        tester.widget<WorkspaceShareButton>(button).tooltip,
        'Share Agent 0 · F8',
      );
      await shareKey(tester);
      expect(connection.shares, isEmpty);
      await key(tester, LogicalKeyboardKey.f8);
      await tester.pumpAndSettle();
      expectSharedHarness('Agent 0');
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'native titlebar receives current target, colors and remapped hint and rejects stale clicks',
    (tester) async {
      const channel = MethodChannel('harness/swarm_tabs');
      const codec = StandardMethodCodec();
      final updates = <Map>[];
      final messenger = tester.binding.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'update') updates.add(call.arguments as Map);
        return true;
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      final first = app.adoptSessionForTest(terminal('a0', input));
      final second = app.adoptSessionForTest(terminal('a1', input));
      app.focusPane(first.id);
      await mount(tester, native: true);
      final old = updates.last['shareAction'] as Map;
      expect(old['label'], 'Share Agent 0');
      expect(old['enabled'], true);
      expect(
        old['background'],
        WorkspaceShareButton.backgroundFor(true).toARGB32(),
      );
      keymap.apply(
        '{"bindings":[{"keys":"${platformWorkspaceBinding("cmd+shift+s")}","command":null},{"keys":"f8","command":"agent.share"}]}',
      );
      await tester.pump();
      expect(
        (updates.last['shareAction'] as Map)['tooltip'],
        'Share Agent 0 · F8',
      );
      app.focusPane(second.id);
      await tester.pump();
      Future<void> click(Map target) async {
        final done = Completer<void>();
        messenger.handlePlatformMessage(
          channel.name,
          codec.encodeMethodCall(MethodCall('shareAgent', target)),
          (_) => done.complete(),
        );
        for (var i = 0; i < 8 && !done.isCompleted; i++) {
          await tester.pump();
        }
        expect(done.isCompleted, isTrue);
        await done.future;
        await tester.pumpAndSettle();
      }

      await click(old);
      expect(connection.shares, isEmpty);
      await click(updates.last['shareAction'] as Map);
      expect(connection.shares.single, ('harness_share_list', 'a1'));
      expect((updates.last['shareAction'] as Map)['enabled'], false);
      await tester.pumpWidget(const SizedBox());
    },
  );

  test(
    'Share has one documented platform binding and a remappable native command',
    () {
      final binding = platformWorkspaceBinding('cmd+shift+s');
      expect(
        harnessDefaultKeymap.match(KeymapContext.terminal, [
          KeyStroke.parse(binding),
        ]).command,
        'agent.share',
      );
      expect(
        shortcutRows().where((row) => row.label == 'Share the focused harness'),
        hasLength(1),
      );
      expect(nativeKeymapSnapshot(keymap).toString(), contains('shareAgent'));
    },
  );
}
