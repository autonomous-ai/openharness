import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/super_tabs/buddies.dart';
import 'package:harness/super_tabs/buddy_machines.dart';
import 'package:harness/super_tabs/buddy_restart.dart';
import 'package:harness/super_tabs/controller.dart';

import 'support/buddy_engine_fixture.dart';
import 'support/buddy_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Polish of the Buddy's dialogs, header and start form (Desktop 1.3.89 audit, "Buddy and Board").
void main() {
  Color? colorOf(WidgetTester t, Finder text) =>
      t.widget<Text>(text).style?.color;

  /// A Buddy dialog opened from a button, as its menus open it.
  Future<(ConversationServer, SuperTabController)> open(
    WidgetTester t,
    void Function(BuildContext, SuperTabController) show,
  ) async {
    final server = buddySwarm();
    giveBuddy(server, machineId: 'm');
    final c = server.controller(account: 'peer');
    addTearDown(c.dispose);
    await c.refresh();
    await t.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(),
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => show(context, c),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await t.tap(find.text('open'));
    await t.pumpAndSettle();
    return (server, c);
  }

  testWidgets('a Restart error is drawn in the Buddy card\'s error colour', (
    t,
  ) async {
    // With no app to restart it through, Restart says so.
    await open(t, (context, c) => showRestartBuddy(context, c, 'lead'));
    await t.tap(find.widgetWithText(FilledButton, 'Restart'));
    await t.pumpAndSettle();
    final error = find.byKey(const ValueKey('super-buddy-launch-args-error'));
    expect(find.text('Restart is not available here.'), findsOneWidget);
    expect(colorOf(t, error), grid.AppPalette.dangerFill);
  });

  testWidgets('a Rename error is drawn in the Buddy card\'s error colour', (
    t,
  ) async {
    final (server, _) = await open(
      t,
      (context, c) => showRenameBuddy(context, c, 'lead'),
    );
    server.refuse = {'code': 'CONFLICT', 'message': 'That name is taken.'};
    await t.enterText(find.byKey(const ValueKey('super-buddy-name')), 'Moss');
    await t.tap(find.widgetWithText(FilledButton, 'Save'));
    await t.pumpAndSettle();
    final error = find.text('That name is taken.');
    expect(error, findsOneWidget);
    expect(colorOf(t, error), grid.AppPalette.dangerFill);
  });

  final model = find.byKey(const ValueKey('super-buddy-model'));
  Finder inModel(Finder f) => find.descendant(of: model, matching: f);

  ConversationServer withModel(String engine, String id) {
    final server = buddyEngineSwarm(engine: engine);
    (server.state['agents'] as List).cast<Map>().firstWhere(
      (a) => a['id'] == 'wren',
    )['configuration'] = {
      'engine': engine,
      'model': id,
    };
    return server;
  }

  testWidgets('the Buddy header names the model its subscription runs', (
    t,
  ) async {
    final c = await showBuddyEngine(t, withModel('claude', 'claude-opus-5-5'));
    expect(inModel(find.text('Opus 5.5')), findsOneWidget);
    expect(inModel(find.text('Your subscription')), findsNothing);
    // Claude's menu still offers the Swarm's shared models.
    expect(inModel(find.byIcon(AppIcons.chevronDown)), findsOneWidget);
    await closeBuddyEngine(t, c);
  });

  testWidgets('with only its subscription to choose, there is no menu', (
    t,
  ) async {
    final c = await showBuddyEngine(t, withModel('codex', 'gpt-5.6-sol'));
    expect(inModel(find.text('GPT-5.6 Sol')), findsOneWidget);
    expect(inModel(find.byIcon(AppIcons.chevronDown)), findsNothing);
    await t.tap(model);
    await t.pumpAndSettle();
    expect(find.byType(AppMenuItem), findsNothing);
    await closeBuddyEngine(t, c);
  });

  testWidgets('the start form shows Choose a machine whole at 880', (t) async {
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = const Size(880, 600);
    addTearDown(t.view.reset);
    await t.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(),
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: BuddyMachineField(
              machines: const [
                (
                  id: 'm',
                  name: 'Mac',
                  inSwarm: true,
                  offline: true,
                  paused: false,
                ),
              ],
              value: null,
              fitNames: true,
              onChanged: (_) {},
            ),
          ),
        ),
      ),
    );
    final label = t.renderObject<RenderParagraph>(
      find.text('Choose a machine'),
    );
    expect(label.didExceedMaxLines, isFalse);
  });
}
