import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/launch_menu.dart' show acceptSetupOrSearch;

final _kind = find.byKey(const ValueKey('new-harness-field-agent-kind'));
final _form = find.byType(NewHarnessForm);
const _menus = MethodChannel('harness/swarm_tabs');

/// An action from AppKit's menus, as the channel delivers it. Its reply is
/// not waited for: it comes once the frames the action asks for are pumped.
void _menu(WidgetTester tester, String method) {
  unawaited(
    tester.binding.defaultBinaryMessenger.handlePlatformMessage(
      _menus.name,
      const StandardMethodCodec().encodeMethodCall(MethodCall(method)),
      null,
    ),
  );
}

/// A Swarm v3 tab, its left pane with My agents and + New agent.
Future<SuperTabLaunchFixture> mountSwarm(
  WidgetTester tester, {
  double textScale = 1,
  Brightness brightness = Brightness.light,
  bool reader = false,
  // The title bar and menus are AppKit's, reached through their channel.
  bool native = false,
  // How this computer makes a new folder for an agent; without it, the app's own.
  Future<String> Function(ProjectFolderRequest request)? prepareFolder,
  // What the Swarm and this computer hold before the Swarm is first read.
  void Function(SuperTabLaunchFixture f)? before,
}) async {
  if (native) {
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(_menus, (_) async => true);
    addTearDown(() => messenger.setMockMethodCallHandler(_menus, null));
  }
  final oldEntry = newHarnessOpensInBox;
  newHarnessOpensInBox = true;
  addTearDown(() => newHarnessOpensInBox = oldEntry);
  final f = SuperTabLaunchFixture(prepareFolder: prepareFolder);
  before?.call(f);
  if (reader) {
    (f.connection.server.state['people'] as List).first['role'] = 'viewer';
  }
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
  final c = await f.app.superTabs.open(tabId);
  await c.refresh();
  final map = MemoryKeymap();
  addTearDown(map.dispose);
  final projects = SwarmProjectStore();
  addTearDown(projects.dispose);
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1500, 900);
  final previous = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previous);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(textScale)),
        child: KeymapProvider(keymap: map, child: child!),
      ),
      home: SwarmScreen(
        notifier: f.app,
        nativeTabs: native,
        projectStore: projects,
      ),
    ),
  );
  await tester.pumpAndSettle();
  return f;
}

/// Inside the test body: the Swarm's saves finish before the app goes.
Future<void> unmountSwarm(WidgetTester tester, SuperTabLaunchFixture f) async {
  await tester.pumpWidget(const SizedBox());
  await f.app.superTabs.peek(tabId)!.flush();
  f.app.superTabs.dispose();
}

/// Your Team's + (Swarm v4: the left pane's one way to New agent).
Future<void> tapNewAgent(WidgetTester tester) async {
  final row = find.byKey(const ValueKey('project-sidebar-agents-add'));
  await tester.ensureVisible(row);
  await tester.tap(row);
  await tester.pumpAndSettle();
}

/// + New agent's form (Swarm v4): a `New agent` button and no role to choose: a PM is New project's.
void _expectNewAgentForm(WidgetTester tester) {
  expect(_form, findsOneWidget);
  expect(_kind, findsNothing);
  expect(
    find.descendant(
      of: find.byKey(const ValueKey('new-harness-field-start')),
      matching: find.text('New agent'),
    ),
    findsOneWidget,
  );
}

void main() {
  // Audit 1.3.89 finding 11 (task #4445): in a Swarm, every way to New Agent
  // opens what + New agent opens, so a new agent means one thing.
  final ways = <String, Future<void> Function(WidgetTester)>{
    'Cmd-N': (tester) => key(tester, LogicalKeyboardKey.keyN, cmd: true),
    'File ▸ New Agent': (tester) async => _menu(tester, 'newAgent'),
    'search’s New Harness': (tester) async {
      await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        '> New Harness',
      );
      await acceptSetupOrSearch(tester);
    },
  };
  for (final MapEntry(key: way, value: open) in ways.entries) {
    testWidgets('$way in a Swarm opens + New agent’s form', (tester) async {
      final f = await mountSwarm(tester, native: way == 'File ▸ New Agent');
      await open(tester);
      await tester.pumpAndSettle();
      _expectNewAgentForm(tester);
      await unmountSwarm(tester, f);
    });
  }

  testWidgets('Cmd-N gives a reader what + New agent does: nothing', (
    tester,
  ) async {
    final f = await mountSwarm(tester, reader: true);
    expect(find.byKey(const ValueKey('super-new-agent-row')), findsNothing);
    await key(tester, LogicalKeyboardKey.keyN, cmd: true);
    await tester.pumpAndSettle();
    expect(_form, findsNothing);
    await unmountSwarm(tester, f);
  });
}
