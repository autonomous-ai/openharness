import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/super_tabs/launch.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'super_tab_new_agent_words_test.dart'
    show mountSwarm, tapNewAgent, unmountSwarm;

final _kind = find.byKey(const ValueKey('new-harness-field-agent-kind'));
final _visibility = find.byKey(
  const ValueKey('new-harness-project-visibility'),
);

Future<void> _choose(WidgetTester tester, String kind) async {
  await tester.tap(_kind);
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(ValueKey('new-harness-agent-kind-$kind')));
  await tester.pumpAndSettle();
}

/// + New agent's journal, opened again as a closed form or a restart does.
Future<NewHarnessController> _newAgent(SuperTabLaunchFixture f) async {
  final integration = await SuperTabLaunch.open(
    f.app,
    f.app.activeSwarm,
    'new-agent',
    newAgent: true,
  );
  final box = NewHarnessController(
    f.app,
    machineId: 'm',
    engine: 'claude',
    folder: '/work/project',
    task: 'Plan the docs site.',
    integration: integration,
  );
  addTearDown(box.dispose);
  await Future<void>.delayed(Duration.zero);
  return box;
}

void main() {
  // Audit 1.3.89 finding 14 (task #4445): a Product Manager's new project was
  // public without asking. It asks as + New project does.
  testWidgets('Product Manager shows the project visibility, Public first', (
    tester,
  ) async {
    final f = await mountSwarm(tester);
    await tapNewAgent(tester);
    expect(_visibility, findsNothing, reason: 'An agent makes no project');

    await _choose(tester, 'lead');
    expect(_visibility, findsOneWidget);
    expect(
      find.descendant(of: _visibility, matching: find.text('Public')),
      findsOneWidget,
    );
    await tester.tap(_visibility);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Private'));
    await tester.pumpAndSettle();
    expect(
      find.descendant(of: _visibility, matching: find.text('Private')),
      findsOneWidget,
    );
    final box = tester
        .widget<NewHarnessForm>(find.byType(NewHarnessForm))
        .controller;
    expect(box.integration!.projectVisibility, 'private');

    await _choose(tester, 'member');
    expect(_visibility, findsNothing);
    await unmountSwarm(tester, f);
  });

  TestWidgetsFlutterBinding.ensureInitialized();

  test('the choice reaches project.create and is locked once sent', () async {
    final f = SuperTabLaunchFixture()..connection.failCreation = true;
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    final box = await _newAgent(f);
    expect(box.integration!.projectVisibility, 'public');
    box.setAgentKind('lead');
    box.integration!.projectVisibility = 'private';
    expect(await box.create(), NewHarnessOutcome.failed);

    final create = [
      for (final post in f.connection.server.posts) post['command'] as Map,
    ].singleWhere((c) => c['type'] == 'project.create');
    expect(create['visibility'], 'private');
    expect(box.integration!.projectVisibilityLocked, isTrue);

    // Reopened after the failed start: the project exists, as sent.
    final again = await _newAgent(f);
    expect(again.integration!.projectVisibility, 'private');
    expect(again.integration!.projectVisibilityLocked, isTrue);
  });
}
