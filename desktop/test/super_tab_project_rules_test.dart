import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/super_tabs/project_rules.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// The backend's seed (superTabs/policy.ts SEED_RULES), cut to two review rows and two test rows.
Map<String, dynamic> _rules({bool train = false}) => {
  'releaseWindow': {
    'start': '09:00',
    'end': '18:00',
    'timeZone': 'Asia/Ho_Chi_Minh',
  },
  'releasePace': {
    'backendEveryMinutes': 120,
    'appsAfterVisibleBatch': true,
    'backendPause': {'start': '09:00', 'end': '10:00'},
  },
  'reviews': {
    'defaultReads': 1,
    'rows': [
      {
        'area': 'Sign-in',
        'reads': 2,
        'paths': ['**/*auth*', '**/*login*', '**/*logout*'],
      },
      {
        'area': 'Deletion',
        'reads': 2,
        'paths': ['**/*delet*'],
      },
    ],
    'test': [
      {
        'where': 'Desktop on a Mac',
        'paths': ['desktop/**'],
      },
      {
        'where': 'The phone app in a simulator',
        'paths': ['mobile/**'],
      },
    ],
    'untested': ['**/*.md', 'docs/**'],
  },
  'mergeTrain': {'enabled': train, 'everyMinutes': 10},
  'caps': <dynamic>[],
  'paths': <dynamic>[],
  'crew': [
    {
      'role': 'Engineer',
      'names': ['Ledger', 'Yarrow4'],
    },
  ],
  'lanes': <dynamic>[],
};

Map<String, dynamic> _saved() => {
  'projectId': 'lead',
  'revision': 3,
  'rules': _rules(train: true),
  'seeded': false,
  'history': [
    {
      'revision': 3,
      'rules': _rules(train: true),
      'summary': 'Merge train on',
      'diff': [
        {'path': 'mergeTrain.enabled', 'before': false, 'after': true},
      ],
      'writtenBy': {'kind': 'agent', 'id': 'lead-agent'},
      'askedBy': 'peer',
      'askedIn': {'conversationId': 'lead', 'messageId': 'm1'},
      'at': DateTime.now()
          .subtract(const Duration(hours: 2))
          .toUtc()
          .toIso8601String(),
    },
    {
      'revision': 2,
      'rules': _rules(),
      'summary': 'Releases start at 10',
      'diff': [
        {'path': 'releaseWindow.start', 'before': '09:00', 'after': '10:00'},
      ],
      'writtenBy': {'kind': 'person', 'id': 'owner'},
      'askedBy': 'owner',
      'askedIn': null,
      'at': DateTime.now()
          .subtract(const Duration(days: 1))
          .toUtc()
          .toIso8601String(),
    },
  ],
};

ConversationServer _swarm(Map<String, dynamic>? rules) {
  final server = ConversationServer();
  server.state['projects'] = [projectFixture('lead', 'openharness', 'lead')];
  (server.state['people'] as List).add({
    'id': 'peer',
    'email': 'peer@example.com',
    'role': 'collaborator',
    'username': 'dee',
  });
  (server.state['agents'] as List).add({
    'id': 'lead-agent',
    'projectId': 'lead',
    'name': 'Lead',
    'displayName': 'River',
    'machineId': 'host',
    'harnessId': 'session',
    'contributorId': 'owner',
    'configuration': {'engine': 'codex'},
  });
  if (rules != null) server.projectRules['lead'] = rules;
  return server;
}

Future<void> _openRules(WidgetTester tester) async {
  await tester.tap(find.byTooltip('Project options'));
  await tester.pumpAndSettle();
  await tester.tap(find.widgetWithText(AppMenuItem, 'Project settings…'));
  await tester.pumpAndSettle();
  await tester.tap(
    find.byKey(const ValueKey('super-project-setting-Project rules')),
  );
  await tester.pumpAndSettle();
}

/// Set to a folder to write the PR's pictures of the dialog there, in light and dark.
final _shots = Platform.environment['PROJECT_RULES_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(_shots));

  for (final brightness in Brightness.values) {
    testWidgets('pictures of Project rules (${brightness.name})', (
      tester,
    ) async {
      if (_shots == null) return;
      tester.view.devicePixelRatio = 2;
      addTearDown(tester.view.reset);
      final c = await showView(
        tester,
        _swarm(_saved()),
        brightness: brightness,
      );
      await _openRules(tester);
      await captureWindow(tester, _shots, 'project-rules-${brightness.name}');
      await c.flush();
    }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
  }

  test('reads the backend\'s answer, seed and history', () {
    final rules = SuperTabProjectRules.fromJson(_saved());
    expect(rules.revision, 3);
    expect(rules.seeded, isFalse);
    expect(rules.rules['mergeTrain'], {'enabled': true, 'everyMinutes': 10});
    expect(rules.history.map((h) => h.revision), [3, 2]);
    expect(rules.history.first.writtenBy, (kind: 'agent', id: 'lead-agent'));
    expect(rules.history.first.askedBy, 'peer');
    expect(rules.history.first.diff.single.path, 'mergeTrain.enabled');
    expect(
      superTabRulesPath('tab 1', 'lead'),
      '/api/super-tabs/tab%201/projects/lead/rules',
    );
  });
}
