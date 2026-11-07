import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/super_tabs/launch.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'super_tab_new_agent_words_test.dart'
    show mountSwarm, tapNewAgent, unmountSwarm;

/// The name + New agent sends for its new agent's chat, in a Swarm whose
/// agents already have [names].
Future<String> _sentName(String engine, List<String> names) async {
  final f = SuperTabLaunchFixture();
  final agents = f.connection.server.state['agents'] as List;
  for (final (i, name) in names.indexed) {
    agents.add({
      'id': 'agent-$i',
      'machineId': 'studio',
      'harnessId': 'harness-$i',
      'name': name,
      'contributorId': 'owner',
      'projectId': 'lead',
      'configuration': {'engine': engine, 'model': 'default'},
    });
  }
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
  final integration = await SuperTabLaunch.open(
    f.app,
    f.app.activeSwarm,
    'new-agent',
    newAgent: true,
  );
  final box = NewHarnessController(
    f.app,
    machineId: 'm',
    engine: engine,
    folder: '/work/project',
    task: 'Tidy the docs.',
    integration: integration,
  );
  addTearDown(box.dispose);
  await Future<void>.delayed(Duration.zero);
  expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
  final chat = [
    for (final post in f.connection.server.posts) post['command'] as Map,
  ].singleWhere((c) => c['type'] == 'agent.new');
  return chat['name'] as String;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // Audit 1.3.89 polish (task #4445): every new agent was named after its
  // engine, so two read "Claude Code" side by side.
  for (final (engine, label) in [
    ('claude', 'Claude Code'),
    ('codex', 'Codex'),
  ]) {
    test('a second $label is $label 2, then $label 3', () async {
      expect(await _sentName(engine, []), label);
      expect(await _sentName(engine, [label]), '$label 2');
      expect(await _sentName(engine, [label, '$label 2']), '$label 3');
    });
  }

  // With no remembered project the chip showed the generated folder's name,
  // claude-2026-11-07-13-54. That name is still what is created.
  testWidgets('the folder chip of an automatic project reads New folder', (
    tester,
  ) async {
    final f = await mountSwarm(tester);
    await tapNewAgent(tester);
    final chip = find.byKey(const ValueKey('new-harness-field-project'));
    expect(
      find.descendant(of: chip, matching: find.text('New folder')),
      findsOneWidget,
    );
    final box = tester
        .widget<NewHarnessForm>(find.byType(NewHarnessForm))
        .controller;
    expect(box.project.generated?.name, matches(RegExp(r'^claude-\d{4}-')));
    await unmountSwarm(tester, f);
  });
}
