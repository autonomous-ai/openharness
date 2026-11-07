import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
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
import 'support/capture.dart';

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

Future<void> show(
  WidgetTester t,
  SuperTabController c, {
  bool tasks = false,
  double width = 1600,
  Brightness brightness = Brightness.dark,
}) async {
  t.view.devicePixelRatio = 1;
  t.view.physicalSize = Size(width, 900);
  addTearDown(t.view.reset);
  // The design tokens follow the app's brightness, which main.dart sets from the theme.
  final previous = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previous);
  await t.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
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

  // The header sits between the left pane and the Tasks pane, so at 880 it is far narrower than the window.
  group('at 880 wide the model gives way, not the name or ⋮ (#4444)', () {
    const long = 'openrouter/qwen/qwen3-coder-480b-a35b-instruct';
    setUpAll(() => loadCaptureFonts(shots));

    bool cut(WidgetTester t, Finder text) => t
        .renderObject<RenderParagraph>(
          find.descendant(of: text, matching: find.byType(RichText)).first,
        )
        .didExceedMaxLines;

    // [title] is what holds the name: the name itself, or the Buddy card's button.
    void fits(
      WidgetTester t, {
      required Finder name,
      Finder? title,
      required Finder engine,
      required Finder model,
    }) {
      expect(t.takeException(), isNull);
      final row = t.getRect(header);
      final menu = t.getRect(
        inHeader(find.byKey(const ValueKey('super-group-options'))),
      );
      expect(
        row.left <= menu.left && menu.right <= row.right,
        isTrue,
        reason: '⋮ $menu is outside the header $row',
      );
      expect(cut(t, name), isFalse, reason: 'the name is cut');
      expect(cut(t, model), isTrue, reason: 'the model has no …');
      expect(
        t.getRect(engine).left - t.getRect(title ?? name).right,
        greaterThanOrEqualTo(grid.AppDesktop.controlGap),
        reason: 'no gap between the name and the engine',
      );
    }

    testWidgets("a member agent's name and ⋮ stay; its model ends in …", (
      t,
    ) async {
      final f = TasksFixture();
      addTearDown(f.controller.dispose);
      // The fixture's reads, with Hugo's model a long OpenRouter id.
      final c = SuperTabController(
        tabId: f.controller.tabId,
        accountId: f.controller.accountId,
        initial: {
          'tabId': f.controller.tabId,
          'accountId': f.controller.accountId,
          'selectedId': 'lead5701',
        },
        pollInterval: Duration.zero,
        save: (_) async {},
        request: (method, path, {body}) async {
          final result = await f.controller.request(method, path, body: body);
          for (final row in (result['agents'] as List? ?? const [])) {
            final agent = (row as Map)['data'] as Map;
            if (agent['id'] == '0540') {
              agent['configuration'] = {
                ...agent['configuration'] as Map,
                'model': long,
              };
            }
          }
          return result;
        },
      );
      addTearDown(c.dispose);
      await c.refresh();
      await c.select('aeef');
      for (final (brightness, mode) in [
        (Brightness.light, 'light'),
        (Brightness.dark, 'dark'),
      ]) {
        await show(t, c, tasks: true, width: 880, brightness: brightness);
        fits(
          t,
          name: inHeader(find.text('Hugo')),
          engine: inHeader(find.text(engineIdentity('claude').label)),
          model: inHeader(find.text(modelDisplayName(long))),
        );
        await captureWindow(t, shots, '06-chat-header-880-$mode');
      }
    });

    testWidgets("the Buddy's name and ⋮ stay; its model ends in …", (t) async {
      final server = buddyEngineSwarm();
      // A model nobody serves is named by its id, and said not to be served.
      (server.state['agents'] as List).cast<Map>().firstWhere(
        (a) => a['id'] == 'wren',
      )['gridModel'] = long;
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      await c.select('swarm-buddy-peer');
      final agent = c.snapshot!.agent('wren')!;
      for (final (brightness, mode) in [
        (Brightness.light, 'light'),
        (Brightness.dark, 'dark'),
      ]) {
        await show(t, c, width: 880, brightness: brightness);
        fits(
          t,
          name: inHeader(
            find.text(c.snapshot!.agentName('wren', fallback: agent.name)),
          ),
          title: inHeader(
            find.byKey(const ValueKey('super-board-buddy-button')),
          ),
          engine: inHeader(find.byKey(const ValueKey('super-buddy-engine'))),
          model: inHeader(find.byKey(const ValueKey('super-buddy-model'))),
        );
        await captureWindow(t, shots, '06-buddy-header-880-$mode');
      }
    });
  });
}
