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
}
