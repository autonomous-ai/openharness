import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/widgets/desktop_chrome.dart';
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
}) async {
  if (native) {
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(_menus, (_) async => true);
    addTearDown(() => messenger.setMockMethodCallHandler(_menus, null));
  }
  final oldEntry = newHarnessOpensInBox;
  newHarnessOpensInBox = true;
  addTearDown(() => newHarnessOpensInBox = oldEntry);
  final f = SuperTabLaunchFixture();
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

/// Your agents' + (Swarm v4: the left pane's one way to New agent).
Future<void> tapNewAgent(WidgetTester tester) async {
  final row = find.byKey(const ValueKey('project-sidebar-agents-add'));
  await tester.ensureVisible(row);
  await tester.tap(row);
  await tester.pumpAndSettle();
}

/// + New agent's form: the role chip and a `New agent` button.
void _expectNewAgentForm(WidgetTester tester) {
  expect(_form, findsOneWidget);
  expect(_kind, findsOneWidget);
  expect(tester.widget<NewHarnessForm>(_form).controller.agentKind, 'member');
  expect(
    find.descendant(
      of: find.byKey(const ValueKey('new-harness-field-start')),
      matching: find.text('New agent'),
    ),
    findsOneWidget,
  );
}

void main() {
  // Audit 1.3.89 finding 11 (task #4445): the role reads as the
  // left pane names it, Product Manager, and the other role is a plain Agent, never Lead or Member.
  testWidgets('the role chip and menu say Agent or Product Manager, whole', (
    tester,
  ) async {
    final f = await mountSwarm(tester, textScale: 1.3);
    await tapNewAgent(tester);
    // The narrowest window, where the left pane may fold away: the form stays.
    tester.view.physicalSize = const Size(880, 900);
    await tester.pumpAndSettle();

    expect(
      find.descendant(of: _kind, matching: find.text('Agent')),
      findsOneWidget,
    );
    final words = RegExp(r'\b(Lead|Member)\b');
    expect(
      find.descendant(of: _form, matching: find.textContaining(words)),
      findsNothing,
    );

    await tester.tap(_kind);
    await tester.pumpAndSettle();
    final details = {
      'Agent': 'Works with you in its own chat',
      'Product Manager': 'Leads a project and its crew',
    };
    for (final MapEntry(key: label, value: detail) in details.entries) {
      final row = find.byKey(
        ValueKey(
          'new-harness-agent-kind-${label == 'Agent' ? 'member' : 'lead'}',
        ),
      );
      expect(
        find.descendant(of: row, matching: find.text(label)),
        findsOneWidget,
      );
      for (final line in [label, detail]) {
        final paragraph = tester.renderObject<RenderParagraph>(
          find.descendant(of: row, matching: find.text(line)),
        );
        expect(paragraph.didExceedMaxLines, isFalse, reason: '$line is cut');
      }
    }
    await tester.tap(find.byKey(const ValueKey('new-harness-agent-kind-lead')));
    await tester.pumpAndSettle();
    expect(
      find.descendant(of: _kind, matching: find.text('Product Manager')),
      findsOneWidget,
    );
    expect(tester.widget<NewHarnessForm>(_form).controller.agentKind, 'lead');
    await unmountSwarm(tester, f);
  });

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

  // Product owner, relayed by the PM (task #4445): the role is chosen where
  // the agent is started, beside New agent, not among the header's pickers.
  for (final way in ['+ New agent', 'Cmd-N']) {
    testWidgets('$way: the role chip sits just left of New agent', (
      tester,
    ) async {
      final f = await mountSwarm(tester);
      if (way == 'Cmd-N') {
        await key(tester, LogicalKeyboardKey.keyN, cmd: true);
        await tester.pumpAndSettle();
      } else {
        await tapNewAgent(tester);
      }
      final start = find.byKey(const ValueKey('new-harness-field-start'));
      final chip = tester.getRect(_kind);
      final button = tester.getRect(start);
      // Below the task's text, in the box's bottom row: no longer up among
      // the header's pickers.
      final task = tester.getRect(
        find.byKey(const ValueKey('new-harness-task')),
      );
      expect(chip.top, greaterThan(task.top), reason: 'Not the header');
      expect((chip.center.dy - button.center.dy).abs(), lessThan(2));
      expect(chip.right, lessThanOrEqualTo(button.left));
      expect(button.left - chip.right, lessThan(16), reason: 'Beside it');

      // Tab goes from the chip to New agent, and its menu still opens.
      tester.widget<DesktopPill>(_kind).focusNode!.requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      final focused = FocusManager.instance.primaryFocus!.context!;
      expect(
        find.descendant(
          of: start,
          matching: find.byElementPredicate((e) => e == focused),
          matchRoot: true,
        ),
        findsOneWidget,
      );
      await tester.tap(_kind);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('new-harness-agent-kind-lead')),
        findsOneWidget,
      );
      await tester.tap(_kind, warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('new-harness-agent-kind-lead')),
        findsNothing,
      );
      await unmountSwarm(tester, f);
    });
  }
}
