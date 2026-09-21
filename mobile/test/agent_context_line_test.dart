import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_context_line.dart';

/// Every character the line actually renders, in order — `find.text` matches a plain string and so
/// sees nothing of a line built from spans across two halves.
String _rendered(WidgetTester tester) => [
  for (final text in tester.widgetList<Text>(find.byType(Text)))
    text.textSpan!.toPlainText(),
].join();

Future<void> _pump(
  WidgetTester tester, {
  required AgentProject? project,
  String machineName = 'MacBookPro2021.local',
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: AgentContextLine(project: project, machineName: machineName),
      ),
    ),
  );
}

void main() {
  testWidgets('names the folder, the branch and the machine, in that order', (
    tester,
  ) async {
    await _pump(
      tester,
      project: const AgentProject(
        name: 'Harness',
        cwd: '/Users/dev/WorkPlace/Grid/autonomous-harness',
        branch: 'main',
      ),
    );
    expect(_rendered(tester), contains('autonomous-harness'));
    expect(
      _rendered(tester).indexOf('main'),
      greaterThan(_rendered(tester).indexOf('autonomous-harness')),
    );
    expect(
      _rendered(tester).indexOf('MacBookPro2021.local'),
      greaterThan(_rendered(tester).indexOf('main')),
    );
  });

  testWidgets('the folder is the tail of the path, not the project name', (
    tester,
  ) async {
    await _pump(
      tester,
      project: const AgentProject(name: 'Harness', cwd: '/srv/apps/backend'),
    );
    expect(_rendered(tester), contains('backend'));
    expect(_rendered(tester), isNot(contains('Harness')));
    expect(_rendered(tester), isNot(contains('/srv/apps')));
  });

  testWidgets('a blank branch draws no separator of its own', (tester) async {
    await _pump(
      tester,
      project: const AgentProject(name: 'x', cwd: '/srv/api', branch: '   '),
    );
    expect(_rendered(tester), 'api  ·  MacBookPro2021.local');
  });

  testWidgets('with no project reported, the machine still stands alone', (
    tester,
  ) async {
    await _pump(tester, project: null);
    expect(_rendered(tester), 'MacBookPro2021.local');
  });
}
