import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/runtime_model_name.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/zone_time.dart';
import 'package:harness/widgets/engine_identity.dart';

import 'super_tab_personal_tasks_pane_test.dart' show TasksFixture;
import 'support/buddy_engine_fixture.dart';
import 'support/super_tab_fixture.dart';

Future<void> show(
  WidgetTester t,
  SuperTabController c, {
  bool tasks = false,
}) async {
  t.view.devicePixelRatio = 1;
  t.view.physicalSize = const Size(1600, 900);
  addTearDown(t.view.reset);
  await t.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: WorkspaceChromeScope(
        chrome: WorkspaceChrome(compactBelow: 720),
        child: Scaffold(
          body: SuperTabView(
            controller: c,
            board: true,
            // The Desktop's right slot: the chat is in the middle.
            rightPane: tasks ? null : (_) => const SizedBox.expand(),
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Kens-MacBook',
          ),
        ),
      ),
    ),
  );
  await t.pumpAndSettle();
}

void main() {
  setUpAll(superTabLoadZones);
  final header = find.descendant(
    of: find.byKey(const ValueKey('super-middle-chat')),
    matching: find.byKey(const ValueKey('super-agent-chat-header')),
  );
  Finder inHeader(Finder f) => find.descendant(of: header, matching: f);
  bool chevronShown(WidgetTester t, Finder of) {
    final chevron = find.descendant(
      of: of,
      matching: find.byIcon(AppIcons.chevronDown),
    );
    if (chevron.evaluate().isEmpty) return false;
    final hidden = find.ancestor(
      of: chevron,
      matching: find.byWidgetPredicate((w) => w is Opacity && w.opacity == 0),
    );
    return hidden.evaluate().isEmpty;
  }

  void oneRow(WidgetTester t, List<Finder> parts) {
    final row = t.getRect(parts.first).center.dy;
    for (final part in parts) {
      expect(part, findsOneWidget);
      expect(t.getRect(part).center.dy, closeTo(row, 4), reason: '$part');
    }
  }

  /// The bar's parts, in a 44-high row: a 22 face, the name in 13 semibold, then one 12-point line in the third grey and
  /// the ⋯ menu (anh Dee's six rules, task #4465).
  void quietBar(
    WidgetTester t, {
    required String identity,
    required String name,
    required String line,
  }) {
    expect(t.getSize(header).height, 44);
    final face = inHeader(
      find.byWidgetPredicate(
        (w) => w is SuperTabAvatar && w.identity == identity,
      ),
    );
    expect(t.getSize(face), const Size(22, 22));
    final title = t.widget<Text>(inHeader(find.text(name)));
    expect(title.style?.fontSize, 13);
    expect(title.style?.fontWeight, grid.AppFont.semibold);
    final quiet = inHeader(
      find.byKey(const ValueKey('super-agent-engine-model')),
    );
    final words = t.widget<Text>(
      find.descendant(of: quiet, matching: find.text(line)),
    );
    expect(words.style?.fontSize, 12);
    expect(words.style?.color, grid.AppPalette.textFaint);
    final menu = inHeader(find.byKey(const ValueKey('super-group-options')));
    expect(
      find.descendant(of: menu, matching: find.byIcon(AppIcons.ellipsis)),
      findsOneWidget,
    );
    oneRow(t, [face, inHeader(find.text(name)), quiet, menu]);
    expect(t.getRect(quiet).left, greaterThan(t.getRect(header).center.dx));
    expect(t.getRect(menu).left, greaterThan(t.getRect(quiet).left));
    // Plain until hover: no chevron shows at rest.
    expect(chevronShown(t, quiet), isFalse);
    // Nothing else: no subscription, machine or reach.
    for (final gone in [
      'Your subscription',
      'Kens-MacBook',
      'reads all your projects',
      'only you can read this chat',
    ]) {
      expect(inHeader(find.textContaining(gone)), findsNothing, reason: gone);
    }
  }

  Future<void> hover(WidgetTester t, Finder f) async {
    final mouse = await t.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(t.getCenter(f));
    await t.pumpAndSettle();
  }

  List<Map> commands(ConversationServer server, String type) => [
    for (final post in server.posts)
      if ((post['command'] as Map)['type'] == type) post['command'] as Map,
  ];
  Finder row(String label) => find.widgetWithText(AppMenuItem, label);
  final line = inHeader(find.byKey(const ValueKey('super-agent-engine-model')));

  testWidgets("the Buddy's bar: face, name, one quiet line and ⋯", (t) async {
    final server = buddyEngineSwarm();
    final c = server.controller(account: 'peer');
    addTearDown(c.dispose);
    await c.refresh();
    await c.select('swarm-buddy-peer');
    await show(t, c);
    final agent = c.snapshot!.agent('wren')!;
    quietBar(
      t,
      identity: 'agent:wren',
      name: c.snapshot!.agentName('wren', fallback: agent.name),
      line: 'Claude Code',
    );
    expect(find.text('Your Buddy'), findsNothing);
  });

  testWidgets("a member agent's bar looks the same", (t) async {
    final f = TasksFixture();
    addTearDown(f.controller.dispose);
    await f.controller.refresh();
    await f.controller.select('aeef');
    await show(t, f.controller, tasks: true);
    quietBar(
      t,
      identity: 'agent:0540',
      name: 'Hugo',
      line: '${engineIdentity('claude').label} · ${modelDisplayName('opus')}',
    );
    // The server switches no other agent: its line opens nothing, even hovered.
    await hover(t, line);
    expect(chevronShown(t, line), isFalse);
    await t.tap(line);
    await t.pumpAndSettle();
    expect(find.byType(AppMenuItem), findsNothing);
  });

  testWidgets(
    "hovering the Buddy's line shows its chevron in the same bounds, and it opens one menu",
    (t) async {
      final server = buddyEngineSwarm();
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      await c.select('swarm-buddy-peer');
      await show(t, c);
      final before = t.getRect(line);
      await hover(t, line);
      expect(chevronShown(t, line), isTrue);
      expect(t.getRect(line), before);
      await t.tap(line);
      await t.pumpAndSettle();
      // The engines, then the shared models, in one menu.
      expect(row('Claude Code'), findsOneWidget);
      expect(row('Codex'), findsOneWidget);
      expect(find.text('SHARED IN THIS SWARM'), findsOneWidget);
      expect(
        t.getRect(row('Codex')).top,
        lessThan(t.getRect(find.text('SHARED IN THIS SWARM')).top),
      );
      expect(row('Your subscription'), findsNothing);
      // The engine it is on sends nothing; another switches it.
      await t.tap(row('Claude Code'));
      await t.pumpAndSettle();
      expect(commands(server, 'buddy.engine'), isEmpty);
      await t.tap(line);
      await t.pumpAndSettle();
      await t.tap(row('Codex'));
      await t.pumpAndSettle();
      expect(commands(server, 'buddy.engine'), [
        {'type': 'buddy.engine', 'engine': 'codex'},
      ]);
    },
  );

  testWidgets(
    'on a shared model, its engine row takes the Buddy back to its own sign-in',
    (t) async {
      final server = buddyEngineSwarm();
      (server.state['agents'] as List).cast<Map>().firstWhere(
        (a) => a['id'] == 'wren',
      )['gridModel'] = 'qwen3-coder';
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      await c.select('swarm-buddy-peer');
      await show(t, c);
      await t.tap(line);
      await t.pumpAndSettle();
      await t.tap(row('Claude Code'));
      await t.pumpAndSettle();
      expect(commands(server, 'buddy.model'), [
        {'type': 'buddy.model', 'gridModel': null},
      ]);
      expect(commands(server, 'buddy.engine'), isEmpty);
    },
  );

  testWidgets(
    'with a thread open the Buddy chat is in the full view and keeps its pickers',
    (t) async {
      final server = buddyEngineSwarm();
      server.append('A word', conversationId: 'swarm-buddy-peer');
      (server.state['conversations'] as List).cast<Map>().firstWhere(
        (g) => g['id'] == 'swarm-buddy-peer',
      )['lastMessageSequence'] = 1;
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      await c.select('swarm-buddy-peer');
      await show(t, c);
      c.openThread(c.messages('swarm-buddy-peer').last.id);
      await t.pumpAndSettle();
      expect(header, findsNothing);
      expect(find.byKey(const ValueKey('super-buddy-engine')), findsOneWidget);
      expect(find.byKey(const ValueKey('super-buddy-model')), findsOneWidget);
    },
  );

  testWidgets('the Buddy header says when its shared model is not served', (
    t,
  ) async {
    final server = buddyEngineSwarm();
    (server.state['agents'] as List).cast<Map>().firstWhere(
      (a) => a['id'] == 'wren',
    )['gridModel'] = 'qwen3-coder';
    final c = server.controller(account: 'peer');
    addTearDown(c.dispose);
    await c.refresh();
    await c.select('swarm-buddy-peer');
    await show(t, c);
    expect(
      find.descendant(
        of: line,
        matching: find.textContaining('not served now'),
      ),
      findsOneWidget,
    );
  });
}
