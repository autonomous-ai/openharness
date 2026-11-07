import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'keymap_host_test.dart' show MemoryKeymap;
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

final _kind = find.byKey(const ValueKey('new-harness-field-agent-kind'));
final _form = find.byType(NewHarnessForm);

/// A Swarm v3 tab, its left pane with My agents and + New agent.
Future<SuperTabLaunchFixture> _mount(
  WidgetTester tester, {
  double width = 1500,
  double textScale = 1,
  bool reader = false,
}) async {
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
  tester.view.physicalSize = Size(width, 900);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.light),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(textScale)),
        child: KeymapProvider(keymap: map, child: child!),
      ),
      home: SwarmScreen(
        notifier: f.app,
        nativeTabs: false,
        projectStore: projects,
      ),
    ),
  );
  await tester.pumpAndSettle();
  return f;
}

/// Inside the test body: the Swarm's saves finish before the app goes.
Future<void> _unmount(WidgetTester tester, SuperTabLaunchFixture f) async {
  await tester.pumpWidget(const SizedBox());
  await f.app.superTabs.peek(tabId)!.flush();
  f.app.superTabs.dispose();
}

Future<void> _tapNewAgent(WidgetTester tester) async {
  final row = find.byKey(const ValueKey('super-new-agent-row'));
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
  // Audit 1.3.89 finding 11 (task #4445): the role reads as the crown does,
  // Product Manager, and the other role is a plain Agent, never Lead or Member.
  testWidgets('the role chip and menu say Agent or Product Manager, whole', (
    tester,
  ) async {
    final f = await _mount(tester, textScale: 1.3);
    await _tapNewAgent(tester);
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
    await _unmount(tester, f);
  });
}
