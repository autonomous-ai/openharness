import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/screens/swarm_menu_bus.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/widgets/linux_menu_bar.dart';

/// The Linux menu bar's wiring.
///
/// The bar is a mouse-shaped door onto the same surfaces the native menus
/// drive: the app-menu rows report through [LinuxMenuBar.onAction] and the
/// swarm rows dispatch through the bus with the SAME action strings the macOS
/// channel delivers. Those strings are the shared contract with
/// `_RootShellState.runAppMenuAction` and `SwarmScreen._onNative` — a typo in
/// one is a menu item that silently does nothing — so the tests pin strings
/// and arguments, not styling, which the other menus' tests already guard.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final appActions = <String>[];
  final swarmCalls = <MethodCall>[];

  setUp(() {
    appActions.clear();
    swarmCalls.clear();
    swarmMenuBus.setHandler((call) async => swarmCalls.add(call));
    swarmMenuBus.send('update', {
      'enabled': true,
      'canReopen': true,
      'canFind': true,
      'canClosePane': true,
      'canGoBack': true,
      'canGoForward': true,
    });
  });

  tearDown(() {
    swarmMenuBus.setHandler(null);
    swarmMenuBus.send('update', {'enabled': false});
    swarmMenuBus.send('keymapState', {'contexts': {}});
  });

  Future<void> pumpBar(WidgetTester tester) async {
    tester.view.physicalSize = const Size(900 * 2, 700 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: Column(
            children: [
              LinuxMenuBar(
                onAction: (action) async => appActions.add(action),
                visible: true,
              ),
              const Expanded(child: SizedBox.shrink()),
            ],
          ),
        ),
      ),
    );
  }

  /// Taps the first hit-testable widget under [key].
  ///
  /// MenuAnchor keeps a closed menu's rows mounted but unhittable while its
  /// close animation unwinds, and a long menu scrolls its lower rows out of
  /// the panel's max height — so a raw find matches a row the pointer cannot
  /// reach. Scrolling to the row and waiting for a hit-testable match keeps
  /// the sequence deterministic without weakening what it asserts.
  Future<void> tap(WidgetTester tester, String key) async {
    for (var attempt = 0; attempt < 5; attempt++) {
      final candidates = find.byKey(Key(key));
      if (candidates.evaluate().isNotEmpty) {
        await tester.ensureVisible(candidates.first);
        await tester.pumpAndSettle();
        final tappable = candidates.hitTestable();
        if (tappable.evaluate().isNotEmpty) {
          await tester.tap(tappable.first);
          await tester.pumpAndSettle();
          return;
        }
      }
      await tester.pump(const Duration(milliseconds: 50));
    }
    fail('no tappable widget for $key');
  }

  testWidgets('stays off the screen when not visible', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LinuxMenuBar(onAction: (_) async {}, visible: false),
        ),
      ),
    );

    expect(find.text('File'), findsNothing);
    expect(find.text('History'), findsNothing);
    expect(find.text('View'), findsNothing);
  });

  testWidgets('the Harness menu carries the app-menu commands', (tester) async {
    await pumpBar(tester);

    await tap(tester, 'menu-bar-harness');
    await tap(tester, 'menu-bar-about');
    expect(appActions.last, 'showAbout');

    await tap(tester, 'menu-bar-harness');
    await tap(tester, 'menu-bar-customize');
    expect(swarmCalls.last.method, 'customize');

    await tap(tester, 'menu-bar-harness');
    await tap(tester, 'menu-bar-shortcuts');
    expect(appActions.last, 'showShortcuts');

    await tap(tester, 'menu-bar-harness');
    await tap(tester, 'menu-bar-check-for-updates');
    expect(appActions.last, 'checkForUpdates');

    await tap(tester, 'menu-bar-harness');
    await tap(tester, 'menu-bar-flash-firmware');
    expect(appActions.last, 'flashFirmware');
  });

  testWidgets('the File menu fires the native action strings', (tester) async {
    await pumpBar(tester);

    await tap(tester, 'menu-bar-file');
    await tap(tester, 'menu-bar-new-harness');
    expect(swarmCalls.last.method, 'newAgent');

    await tap(tester, 'menu-bar-file');
    await tap(tester, 'menu-bar-open-harness');
    expect(swarmCalls.last.method, 'addAgent');

    await tap(tester, 'menu-bar-file');
    await tap(tester, 'menu-bar-clone-agent');
    expect(swarmCalls.last.method, 'cloneAgent');

    // Kept off the File menu, as SwarmTitlebar.swift keeps it off.
    await tap(tester, 'menu-bar-file');
    expect(find.byKey(const Key('menu-bar-new-terminal')), findsNothing);
    await tap(tester, 'menu-bar-move-pane');
    expect(swarmCalls.last.method, 'movePaneToTab');

    await tap(tester, 'menu-bar-file');
    await tap(tester, 'menu-bar-close-tab');
    expect(swarmCalls.last.method, 'closeActive');
  });

  testWidgets('View reaches both channels', (tester) async {
    await pumpBar(tester);

    await tap(tester, 'menu-bar-view');
    await tap(tester, 'menu-bar-notifications');
    expect(swarmCalls.last.method, 'notifications');

    await tap(tester, 'menu-bar-view');
    await tap(tester, 'menu-bar-layout');
    expect(appActions.last, 'showLayout');

    await tap(tester, 'menu-bar-view');
    await tap(tester, 'menu-bar-bigger-font');
    expect(appActions.last, 'increaseTerminalFontSize');

    for (final (key, action) in [
      ('menu-bar-sessions', 'sessions'),
      ('menu-bar-machines', 'machineList'),
      ('menu-bar-models', 'models'),
      ('menu-bar-machine-monitor', 'manageMachines'),
    ]) {
      await tap(tester, 'menu-bar-view');
      await tap(tester, key);
      expect(swarmCalls.last.method, action);
    }
  });

  testWidgets('History navigates and reopens from the state', (tester) async {
    swarmMenuBus.send('update', {
      'enabled': true,
      'canGoBack': true,
      'history': [
        {
          'id': 'visited-1',
          'title': 'Codex on workstation',
          'machineName': 'workstation',
          'current': true,
        },
      ],
      'closedHistory': [
        {'id': 'closed-1', 'title': 'Claude on laptop', 'canReopen': true},
        {'id': 'closed-2', 'title': 'Gone for good', 'canReopen': false},
      ],
    });
    await pumpBar(tester);

    await tap(tester, 'menu-bar-history');
    await tap(tester, 'menu-bar-history-back');
    expect(swarmCalls.map((c) => c.method), ['historyBack']);

    await tap(tester, 'menu-bar-history');
    await tap(tester, 'menu-bar-visited-visited-1');
    expect(swarmCalls.last.method, 'historyDestination');
    expect(swarmCalls.last.arguments, {'id': 'visited-1'});

    await tap(tester, 'menu-bar-history');
    await tap(tester, 'menu-bar-closed-closed-1');
    expect(swarmCalls.last.method, 'reopenHistory');
    expect(swarmCalls.last.arguments, {'id': 'closed-1'});

    // A closed tab that cannot reopen draws as a label, not a row.
    await tap(tester, 'menu-bar-history');
    expect(find.byKey(const Key('menu-bar-closed-closed-2')), findsNothing);
    expect(find.text('Gone for good'), findsOneWidget);
  });

  testWidgets('pane rows follow what the focused pane can take', (
    tester,
  ) async {
    swarmMenuBus.send('update', {
      'enabled': true,
      'canFind': false,
      'canClosePane': false,
      'paneActions': {'restartAgent': true, 'shareAgent': false},
    });
    await pumpBar(tester);

    await tap(tester, 'menu-bar-file');
    await tap(tester, 'menu-bar-restart-agent');
    expect(swarmCalls.last.method, 'restartAgent');

    // No pane to act on: the rows validateMenuItem would disable draw as labels.
    await tap(tester, 'menu-bar-file');
    for (final key in [
      'menu-bar-share-agent',
      'menu-bar-split-right',
      'menu-bar-zoom-pane',
      'menu-bar-close-pane',
    ]) {
      expect(find.byKey(Key(key)), findsNothing, reason: key);
    }
    expect(find.text('Share Harness'), findsOneWidget);
    await tap(tester, 'menu-bar-file');

    await tap(tester, 'menu-bar-edit');
    expect(find.byKey(const Key('menu-bar-find-terminal')), findsNothing);
    await tap(tester, 'menu-bar-commands');
    expect(swarmCalls.last.method, 'commands');
  });

  testWidgets('rows show the chord the keymap gives their action', (
    tester,
  ) async {
    swarmMenuBus.send('keymapState', {
      'version': 1,
      'contexts': {
        'terminal': [
          {
            'command': 'agent.new',
            'hint': 'Ctrl+Alt+N',
            'menuAction': 'newAgent',
          },
        ],
        'workspace': [
          {'command': 'agent.new', 'hint': 'Super+N', 'menuAction': 'newAgent'},
          {'command': 'keyboard.quick_start', 'hint': 'Super+K Q'},
        ],
      },
    });
    await pumpBar(tester);

    // The workspace binding wins: it is the one that works from anywhere.
    await tap(tester, 'menu-bar-file');
    expect(find.text('Super+N'), findsOneWidget);
    expect(find.text('Ctrl+Alt+N'), findsNothing);
    await tap(tester, 'menu-bar-file');

    // Quick Start sends the keymap command itself, as the macOS Help row does,
    // and shows that command's chord.
    await tap(tester, 'menu-bar-help');
    expect(find.text('Super+K Q'), findsOneWidget);
    await tap(tester, 'menu-bar-quick-start');
    expect(swarmCalls.last.method, 'keymapCommand');
    expect(swarmCalls.last.arguments, {'command': 'keyboard.quick_start'});

    await tap(tester, 'menu-bar-help');
    await tap(tester, 'menu-bar-keyboard-practice');
    expect(appActions.last, 'keyboardPractice');
  });

  testWidgets('rows go quiet while the app cannot take them', (tester) async {
    swarmMenuBus.send('update', {
      'enabled': false,
      'canGoBack': false,
      'canReopen': false,
    });
    await pumpBar(tester);

    await tap(tester, 'menu-bar-file');
    expect(find.byKey(const Key('menu-bar-clone-agent')), findsNothing);
    expect(find.text('Clone Harness'), findsOneWidget);

    await tap(tester, 'menu-bar-history');
    expect(find.byKey(const Key('menu-bar-history-back')), findsNothing);
    expect(find.text('Back'), findsOneWidget);
  });
}
