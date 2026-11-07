import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/tasks/personal_task_card.dart';
import 'package:harness/super_tabs/tasks/personal_tasks.dart';

import 'support/capture.dart';

/// Task #4532: the task card with its GitHub issue number beside the project. HARNESS_TASK_ISSUE_SHOTS=<dir> writes
/// the pictures; without it they only lay out.
void main() {
  final shots = Platform.environment['HARNESS_TASK_ISSUE_SHOTS'];
  setUpAll(() => loadCaptureFonts(shots));

  final agent = SuperTabAgent.fromJson({
    'id': 'quinn',
    'projectId': 'harness',
    'name': 'Quinn',
    'machineId': 'host',
    'harnessId': 'h',
    'contributorId': 'p1',
    'configuration': {'engine': 'claude'},
  });
  final person = SuperTabPerson.fromJson({
    'id': 'p1',
    'email': 'dee@example.com',
    'role': 'owner',
  });

  Widget card(
    String title,
    String status, {
    int? issue,
    bool waiting = false,
    VoidCallback? onOpen,
    VoidCallback? onOpenIssue,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: SuperTabPersonalTaskCard(
      key: ValueKey('card-$title'),
      task: SuperTabPersonalTask({
        'id': title,
        'version': 1,
        'at': 0,
        'projectId': 'harness',
        'projectName': 'harness',
        'title': title,
        'status': status,
      }),
      project: 'harness',
      selected: false,
      onOpen: onOpen ?? () {},
      requester: SuperTabAvatar.person(person, size: 18),
      agent: SuperTabAvatar.agent(agent, size: 18, engineBadge: false),
      waiting: waiting,
      onApprove: waiting ? () {} : null,
      onReject: waiting ? () {} : null,
      issue: issue,
      onOpenIssue: issue == null ? null : onOpenIssue ?? () {},
    ),
  );

  for (final brightness in Brightness.values) {
    testWidgets('three cards with and without an issue, ${brightness.name}', (
      t,
    ) async {
      t.view.physicalSize = const Size(340, 420);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await t.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  card('Quiet cards in the Tasks pane', 'working', issue: 5701),
                  card(
                    'Show the GitHub issue on a task card',
                    'proposal',
                    issue: 5702,
                    waiting: true,
                  ),
                  card('Round faces in the chat', 'done'),
                ],
              ),
            ),
          ),
        ),
      );
      await t.pump();
      expect(t.takeException(), isNull);
      expect(find.text('#5701'), findsOneWidget);
      expect(find.text('#5702'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('card-Round faces in the chat')),
          matching: find.byKey(const ValueKey('personal-task-issue')),
        ),
        findsNothing,
      );
      await captureWindow(t, shots, 'task-issue-${brightness.name}');
    });
  }

  testWidgets('the number opens the issue; the rest of the card the task', (
    t,
  ) async {
    final opened = <String>[];
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 340,
            child: card(
              'Quiet cards in the Tasks pane',
              'working',
              issue: 5701,
              onOpen: () => opened.add('task'),
              onOpenIssue: () => opened.add('issue'),
            ),
          ),
        ),
      ),
    );
    await t.tap(find.text('#5701'));
    await t.tap(find.text('Quiet cards in the Tasks pane'));
    expect(opened, ['issue', 'task']);
  });
}
