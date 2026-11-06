import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/runtime_model_name.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/zone_time.dart';
import 'package:harness/widgets/engine_identity.dart';

import 'super_tab_personal_tasks_pane_test.dart' show TasksFixture;
import 'support/buddy_engine_fixture.dart';

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
  void oneRow(WidgetTester t, List<Finder> parts) {
    final row = t.getRect(parts.first).center.dy;
    for (final part in parts) {
      expect(part, findsOneWidget);
      expect(t.getRect(part).center.dy, closeTo(row, 4), reason: '$part');
    }
  }

  testWidgets(
    'the Buddy header is one row: avatar and name, then engine, model and menu',
    (t) async {
      final server = buddyEngineSwarm();
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      await c.select('swarm-buddy-peer');
      await show(t, c);
      expect(header, findsOneWidget);
      final agent = c.snapshot!.agent('wren')!;
      final avatar = inHeader(
        find.byWidgetPredicate(
          (w) => w is SuperTabAvatar && w.identity == 'agent:wren',
        ),
      );
      final name = inHeader(
        find.text(c.snapshot!.agentName('wren', fallback: agent.name)),
      );
      final engine = inHeader(find.byKey(const ValueKey('super-buddy-engine')));
      final model = inHeader(find.byKey(const ValueKey('super-buddy-model')));
      final menu = inHeader(find.byKey(const ValueKey('super-group-options')));
      oneRow(t, [avatar, name, engine, model, menu]);
      expect(t.getRect(avatar).left, lessThan(t.getRect(name).left));
      final middle = t.getRect(header).center.dx;
      expect(t.getRect(engine).left, greaterThan(middle));
      expect(t.getRect(model).left, greaterThan(t.getRect(engine).left));
      expect(t.getRect(menu).left, greaterThan(t.getRect(model).left));
      // No other text, here or on a second line.
      expect(find.textContaining('Kens-MacBook'), findsNothing);
      expect(find.textContaining('reads all your projects'), findsNothing);
      expect(find.textContaining('only you can read this chat'), findsNothing);
      expect(find.text('Your Buddy'), findsNothing);
    },
  );

  testWidgets(
    "a member agent's header shows its engine and model in the same place",
    (t) async {
      final f = TasksFixture();
      addTearDown(f.controller.dispose);
      await f.controller.refresh();
      await f.controller.select('aeef');
      await show(t, f.controller, tasks: true);
      expect(header, findsOneWidget);
      final avatar = inHeader(
        find.byWidgetPredicate(
          (w) => w is SuperTabAvatar && w.identity == 'agent:0540',
        ),
      );
      final engine = inHeader(find.text(engineIdentity('claude').label));
      final model = inHeader(find.text(modelDisplayName('opus')));
      final menu = inHeader(find.byKey(const ValueKey('super-group-options')));
      oneRow(t, [avatar, inHeader(find.text('Hugo')), engine, model, menu]);
      expect(
        inHeader(find.byKey(const ValueKey('super-buddy-engine'))),
        findsNothing,
      );
      expect(t.getRect(engine).left, greaterThan(t.getRect(header).center.dx));
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
    expect(inHeader(find.text('not served now')), findsOneWidget);
  });
}
