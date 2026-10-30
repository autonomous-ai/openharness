// The workspace's host chrome, read from context: the exact object the screen
// was given, Desktop's defaults when there is none, and the web's values.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/web/shell/web_chrome.dart';
import 'package:harness/web/shell/web_workspace.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/widgets/terminal_panel.dart';

import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

Future<void> _mount(
  WidgetTester tester,
  AppNotifier app, {
  WorkspaceChrome? chrome,
  Size size = const Size(1280, 800),
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: SwarmScreen(notifier: app, chrome: chrome),
    ),
  );
  await tester.pump(const Duration(milliseconds: 100));
}

/// A widget the workspace draws: a pane grid needs a pane.
BuildContext _insideWorkspace(WidgetTester tester) =>
    tester.element(find.byType(PaneGrid).first);

AppNotifier _appWithPane() {
  final app = createApp(connected: true);
  app.adoptSessionForTest(terminal('a0', <TerminalBinaryFrame>[]));
  return app;
}

WorkspaceChrome _hostChrome({bool flags = false}) => WorkspaceChrome(
  leadingWidth: (_) => 0,
  leading: (_, _) => const SizedBox.shrink(),
  menuOnEveryTab: flags,
  labelsPaneStatus: flags,
  compactPaneHeader: flags,
  compactBelow: 720,
);

void main() {
  testWidgets('a widget under the workspace reads the chrome it was given', (
    tester,
  ) async {
    final app = _appWithPane();
    addTearDown(app.dispose);
    final chrome = _hostChrome();

    await _mount(tester, app, chrome: chrome);

    final context = _insideWorkspace(tester);
    expect(WorkspaceChromeScope.maybeOf(context), same(chrome));
    expect(WorkspaceChrome.of(context), same(chrome));
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('Desktop, with no host chrome, keeps every new switch off', (
    tester,
  ) async {
    final app = _appWithPane();
    addTearDown(app.dispose);

    await _mount(tester, app);

    final context = _insideWorkspace(tester);
    expect(WorkspaceChromeScope.maybeOf(context), isNull);
    final chrome = WorkspaceChrome.of(context);
    expect(chrome.menuOnEveryTab, isFalse);
    expect(chrome.labelsPaneStatus, isFalse);
    expect(chrome.compactPaneHeader, isFalse);
    expect(chrome.compactPaneHeaderAt(320), isFalse);
    expect(chrome.maxPaneColumnsAt(768), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  test('a host chrome that names none of them leaves them off', () {
    final chrome = WorkspaceChrome(
      leadingWidth: (_) => 0,
      leading: (_, _) => const SizedBox.shrink(),
    );

    expect(chrome.menuOnEveryTab, isFalse);
    expect(chrome.labelsPaneStatus, isFalse);
    expect(chrome.compactPaneHeader, isFalse);
  });

  test('the web chrome turns all three on', () {
    final app = createApp();
    addTearDown(app.dispose);

    final chrome = webWorkspaceChrome(app);

    expect(chrome.menuOnEveryTab, isTrue);
    expect(chrome.labelsPaneStatus, isTrue);
    expect(chrome.compactPaneHeader, isTrue);
  });

  test('the compact pane header applies only below compactBelow', () {
    final chrome = _hostChrome(flags: true);

    expect(chrome.compactPaneHeaderAt(390), isTrue);
    expect(chrome.compactPaneHeaderAt(719), isTrue);
    expect(chrome.compactPaneHeaderAt(720), isFalse);
    expect(chrome.compactPaneHeaderAt(1440), isFalse);
  });

  test(
    'the web grid is two columns at most below 1000 px, any number above',
    () {
      final app = createApp();
      addTearDown(app.dispose);
      final chrome = webWorkspaceChrome(app);

      expect(chrome.maxPaneColumnsAt(768), 2);
      expect(chrome.maxPaneColumnsAt(999), 2);
      expect(chrome.maxPaneColumnsAt(1000), isNull);
      expect(chrome.maxPaneColumnsAt(1440), isNull);
    },
  );

  test('a host chrome that names no column rule keeps every column', () {
    final chrome = _hostChrome(flags: true);

    expect(chrome.maxPaneColumnsAt(320), isNull);
    expect(chrome.maxPaneColumnsAt(768), isNull);
  });

  testWidgets('a new chrome reaches the workspace without remounting it', (
    tester,
  ) async {
    final app = _appWithPane();
    addTearDown(app.dispose);
    await _mount(tester, app, chrome: _hostChrome());
    final terminal = tester.state(find.byType(TerminalPanel).first);

    final next = _hostChrome(flags: true);
    await _mount(tester, app, chrome: next);

    expect(tester.state(find.byType(TerminalPanel).first), same(terminal));
    expect(WorkspaceChrome.of(_insideWorkspace(tester)), same(next));
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('a widget in the search overlay reads the chrome it was given', (
    tester,
  ) async {
    final app = _appWithPane();
    addTearDown(app.dispose);
    final chrome = _hostChrome();
    await _mount(tester, app, chrome: chrome);

    await tester.tap(find.byKey(const ValueKey('swarm-search-button')));
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump();

    final results = find.byType(SwarmSearchResults);
    expect(results, findsOneWidget);
    expect(WorkspaceChrome.of(tester.element(results)), same(chrome));
    await tester.pumpWidget(const SizedBox.shrink());
  });

  test('the web chrome is made once per app', () {
    final app = createApp();
    final other = createApp();
    addTearDown(app.dispose);
    addTearDown(other.dispose);

    expect(webWorkspaceChrome(app), same(webWorkspaceChrome(app)));
    expect(webWorkspaceChrome(other), isNot(same(webWorkspaceChrome(app))));
  });

  testWidgets('an app notification does not hand the workspace a new chrome', (
    tester,
  ) async {
    final app = _appWithPane();
    addTearDown(app.dispose);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1280, 800);
    addTearDown(tester.view.reset);
    Widget page() => MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: WebWorkspace(app: app),
    );
    await tester.pumpWidget(page());
    await tester.pump(const Duration(milliseconds: 100));
    final before = WorkspaceChrome.of(_insideWorkspace(tester));

    // What RootShell does on every AppNotifier notification: build the
    // signed-in screen again.
    app.notifyListeners();
    await tester.pumpWidget(page());
    await tester.pump();

    expect(WorkspaceChrome.of(_insideWorkspace(tester)), same(before));
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
