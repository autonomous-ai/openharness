// The web workspace's menus: what they offer and how big a finger's target
// is on a phone.

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/settings/settings_section.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/web/shell/web_app_menu.dart';
import 'package:harness/web/shell/web_chrome.dart';
import 'package:harness/web/tabs/web_tab_menu.dart';
import 'package:harness/widgets/desktop_workspace_tab.dart';
import 'package:harness/widgets/swarm_switcher.dart';

const _phone = Size(390, 844);
const _computer = Size(1440, 900);

/// An account whose machine list has answered, as it has once the app is in
/// use: the workspace shows, not a page still looking for computers.
class _Account extends AppNotifier {
  _Account()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  @override
  bool get machineInventoryLoaded => true;
}

AppNotifier _app() {
  final app = _Account()..newSwarm(newTabPage: true);
  addTearDown(app.dispose);
  return app;
}

void _size(WidgetTester tester, Size size) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
}

/// The web workspace, as the browser build composes it (or Desktop's, when
/// [desktop]), for an account with one connected machine — so the workspace
/// shows, not the page for connecting a first computer. With [harness], a
/// tab holds a harness on it, so the footer has a menu to open and Machines a
/// machine to show.
Future<AppNotifier> _workspace(
  WidgetTester tester,
  Size size, {
  bool harness = false,
  bool desktop = false,
}) async {
  final app = _app();
  const machine = Machine(
    machineId: 'm',
    name: 'box',
    authMode: MachineAuthMode.remote,
  );
  app.machines.add(machine);
  app.machineStates['m'] = MachineState(machine)
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected
    ..agents = [const Agent(id: 'a0', name: 'Agent 0')];
  if (harness) {
    app.newSwarm(newTabPage: true);
    app.activeSwarm.panes.add(
      TerminalPane(id: 100, machineId: 'm', agentId: 'a0'),
    );
  }
  _size(tester, size);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: SwarmScreen(
        notifier: app,
        nativeTabs: false,
        chrome: desktop ? null : webWorkspaceChrome(app),
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 200));
  return app;
}

/// Machines, with the connected machine chosen so its actions show.
Future<void> _openMachines(WidgetTester tester) async {
  final search = tester
      .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
      .search;
  final index = search.rows.indexWhere(
    (row) => row.isMachine && row.machineId == 'm',
  );
  search.move(index - search.cursor);
  await tester.pump(const Duration(milliseconds: 200));
}

/// Settings as the web opens it: the phone layout below 720 px.
Future<void> _openSettings(WidgetTester tester, Size size) async {
  final app = _app();
  _size(tester, size);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Builder(
        builder: (context) => Scaffold(
          body: TextButton(
            onPressed: () => showSettingsScreen(
              context,
              app,
              source: 'test',
              compactBelow: 720,
            ),
            child: const Text('Open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

Future<void> _openAppMenu(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('web-app-menu-button')));
  await tester.pump(const Duration(milliseconds: 100));
}

/// One ordinary tab, unshared, under [chrome] (none is Desktop's).
Widget _tab({
  WorkspaceChrome? chrome,
  VoidCallback? onRename,
  VoidCallback? onClose,
}) => MaterialApp(
  theme: grid.buildAppTheme(brightness: Brightness.dark),
  home: Scaffold(
    body: WorkspaceChromeScope(
      chrome: chrome,
      child: Align(
        alignment: Alignment.topLeft,
        child: SizedBox(
          width: 220,
          height: 40,
          child: DesktopWorkspaceTab(
            id: 'docs',
            label: 'docs',
            selected: false,
            showShortcuts: const AlwaysStoppedAnimation(false),
            onSelect: () {},
            onRename: onRename,
            onClose: onClose,
          ),
        ),
      ),
    ),
  ),
);

Future<void> _rightClick(WidgetTester tester, Finder target) async {
  await tester.tap(
    target,
    buttons: kSecondaryButton,
    kind: PointerDeviceKind.mouse,
  );
  await tester.pumpAndSettle();
}

const _tabLabel = ValueKey('tab-label:docs');

/// What a finger or the mouse hits for the control at [key]: its button.
Size _target(WidgetTester tester, Key key) {
  final control = find.byKey(key);
  final button = find.ancestor(
    of: control,
    matching: find.byWidgetPredicate((w) => w is ButtonStyleButton),
  );
  return tester.getSize(button.evaluate().isEmpty ? control : button.first);
}

/// A phone's target is at least this big both ways (S1).
const _finger = 44.0;

void main() {
  late WorkspaceChrome web;
  setUp(() {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    addTearDown(app.dispose);
    web = webWorkspaceChrome(app);
  });

  testWidgets('on web, right-clicking an ordinary tab renames or closes it', (
    tester,
  ) async {
    var renames = 0, closes = 0;
    await tester.pumpWidget(
      _tab(chrome: web, onRename: () => renames++, onClose: () => closes++),
    );

    await _rightClick(tester, find.byKey(_tabLabel));
    expect(find.text('Rename Tab…'), findsOneWidget);
    expect(find.text('Close Tab'), findsOneWidget);
    await tester.tap(find.text('Rename Tab…'));
    await tester.pumpAndSettle();
    expect(renames, 1);
    expect(find.text('Close Tab'), findsNothing);

    await _rightClick(tester, find.byKey(_tabLabel));
    await tester.tap(find.text('Close Tab'));
    await tester.pumpAndSettle();
    expect(closes, 1);
    expect(renames, 1);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('on web, a double click on a tab still renames it', (
    tester,
  ) async {
    var renames = 0;
    await tester.pumpWidget(_tab(chrome: web, onRename: () => renames++));

    await tester.tap(find.byKey(_tabLabel));
    await tester.pump(const Duration(milliseconds: 80));
    await tester.tap(find.byKey(_tabLabel));
    await tester.pumpAndSettle();

    expect(renames, 1);
    expect(find.text('Rename Tab…'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('on Desktop, an ordinary tab still has no right-click menu', (
    tester,
  ) async {
    var renames = 0, closes = 0;
    await tester.pumpWidget(
      _tab(onRename: () => renames++, onClose: () => closes++),
    );

    await _rightClick(tester, find.byKey(_tabLabel));

    expect(find.text('Rename Tab…'), findsNothing);
    expect(find.text('Close Tab'), findsNothing);
    expect((renames, closes), (0, 0));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the web workspace at 1440 gives a tab the menu', (tester) async {
    final app = await _workspace(tester, _computer);
    final tab = app.activeSwarmId;

    await _rightClick(tester, find.byKey(ValueKey('tab-label:$tab')));

    expect(find.text('Rename Tab…'), findsOneWidget);
    expect(find.text('Close Tab'), findsOneWidget);
    await tester.tap(find.text('Close Tab'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(app.swarms.any((swarm) => swarm.id == tab), isFalse);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('the phone tab menu renames with Rename Tab…', (tester) async {
    final app = _app();
    WebTabChoice? chosen;
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Material(
          child: Column(
            children: webTabMenuRows(
              app,
              WorkspaceCommands(
                enabled: () => true,
                canRun: (command) => command == 'swarm.rename',
                run: (_) {},
              ),
              (choice) => chosen = choice,
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Rename Tab…'));

    expect((chosen! as WebRunCommand).command, 'swarm.rename');
    expect(find.text('Rename this tab'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a phone app menu has rows a finger can hit', (tester) async {
    await _workspace(tester, _phone);
    await _openAppMenu(tester);

    for (final row in ['super_tab.new', 'machines.list', 'web.sign_out']) {
      expect(
        _target(tester, ValueKey('web-menu:$row')).height,
        greaterThanOrEqualTo(_finger),
        reason: row,
      );
    }
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('a mouse keeps the app menu rows as they were', (tester) async {
    await _workspace(tester, _computer);
    await _openAppMenu(tester);

    expect(
      _target(tester, const ValueKey('web-menu:machines.list')).height,
      32,
    );
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('a phone tab menu has rows and closes a finger can hit', (
    tester,
  ) async {
    final app = await _workspace(tester, _phone);
    app.newSwarm(newTabPage: true);
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.byKey(const ValueKey('web-tab-switcher')));
    await tester.pump(const Duration(milliseconds: 100));

    final tab = app.swarms.first.id;
    for (final key in [
      ValueKey('web-tab:$tab'),
      ValueKey('web-tab-run:swarm.rename'),
    ]) {
      expect(
        _target(tester, key).height,
        greaterThanOrEqualTo(_finger),
        reason: '$key',
      );
    }
    final close = _target(tester, ValueKey('web-tab:$tab:close'));
    expect(close.width, greaterThanOrEqualTo(_finger));
    expect(close.height, greaterThanOrEqualTo(_finger));
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('a phone footer menu has rows a finger can hit', (tester) async {
    final app = await _workspace(tester, _phone, harness: true);
    app.focusPane(100);
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.byKey(const ValueKey('web-footer-menu-button')));
    await tester.pump(const Duration(milliseconds: 100));

    for (final row in ['Machine', 'Subscriptions']) {
      expect(
        _target(tester, ValueKey('web-footer:$row')).height,
        greaterThanOrEqualTo(_finger),
        reason: row,
      );
    }
    await tester.pumpWidget(const SizedBox.shrink());
  });

  const machineActions = [
    ValueKey('resource-action:picker.resource_view'),
    ValueKey('resource-action:picker.resource_rename'),
    Key('machine-picker-add-machine'),
    Key('account-devices-history'),
    Key('machine-window-choice-field'),
  ];

  Future<void> machines(
    WidgetTester tester,
    Size size, {
    bool desktop = false,
  }) async {
    await _workspace(tester, size, harness: true, desktop: desktop);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    final menu = find.byKey(const ValueKey('web-app-menu-button'));
    if (menu.evaluate().isNotEmpty) {
      await _openAppMenu(tester);
      await tester.tap(find.byKey(const ValueKey('web-menu:machines.list')));
    } else {
      await tester.tap(find.byKey(const ValueKey('swarm-search-button')));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.enterText(find.byType(EditableText).first, '@');
    }
    await tester.pump(const Duration(milliseconds: 400));
    await _openMachines(tester);
  }

  testWidgets('a phone Machines picker has actions a finger can hit', (
    tester,
  ) async {
    await machines(tester, _phone);

    for (final key in machineActions) {
      expect(
        _target(tester, key).height,
        greaterThanOrEqualTo(_finger),
        reason: '$key',
      );
    }
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('Machines keeps its actions under a mouse and on Desktop', (
    tester,
  ) async {
    await machines(tester, _computer);
    final web = {
      for (final key in machineActions) key: _target(tester, key).height,
    };
    await tester.pumpWidget(const SizedBox.shrink());
    await machines(tester, _phone, desktop: true);
    final desktop = {
      for (final key in machineActions) key: _target(tester, key).height,
    };

    for (final key in machineActions) {
      expect(web[key], lessThan(_finger), reason: 'web 1440 $key');
      expect(desktop[key], web[key], reason: 'Desktop 390 $key');
    }
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('phone Settings has a Back a finger can hit, both ways back', (
    tester,
  ) async {
    await _openSettings(tester, _phone);
    expect(
      _target(tester, const Key('settings-back-button')).height,
      greaterThanOrEqualTo(_finger),
    );

    await tester.tap(find.text(SettingsSection.notifications.label));
    await tester.pumpAndSettle();
    expect(
      _target(tester, const Key('settings-compact-back')).height,
      greaterThanOrEqualTo(_finger),
    );
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('a wide Settings keeps its Back as it was', (tester) async {
    await _openSettings(tester, _computer);

    expect(_target(tester, const Key('settings-back-button')).height, 38);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  for (final size in [_phone, _computer]) {
    testWidgets('New Swarm in the menu runs what Alt+S runs at ${size.width}', (
      tester,
    ) async {
      final app = _app();
      final ran = <String>[];
      _size(tester, size);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: Align(
              alignment: Alignment.topLeft,
              child: WebAppMenuButton(
                app: app,
                commands: WorkspaceCommands(
                  enabled: () => true,
                  canRun: (_) => true,
                  run: ran.add,
                ),
              ),
            ),
          ),
        ),
      );
      await _openAppMenu(tester);
      expect(find.text('New Swarm'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('web-menu:super_tab.new')));
      await tester.pump(const Duration(milliseconds: 100));

      // super_tab.new is the command Alt+S is bound to (keymap_host_test).
      expect(ran, ['super_tab.new']);
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('New Swarm in the menu opens a new Swarm at ${size.width}', (
      tester,
    ) async {
      final app = await _workspace(tester, size);
      final tabs = app.swarms.length;

      await _openAppMenu(tester);
      await tester.tap(find.byKey(const ValueKey('web-menu:super_tab.new')));
      await tester.pump(const Duration(milliseconds: 200));

      expect(app.swarms, hasLength(tabs + 1));
      expect(app.activeSwarm.isSuperTab, isTrue);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }
}
