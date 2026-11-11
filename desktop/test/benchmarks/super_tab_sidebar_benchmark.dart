// Run explicitly: flutter test test/benchmarks/super_tab_sidebar_benchmark.dart --reporter expanded
// Headless CPU measurements of one Swarm sidebar rebuild, not display latency.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/project_sidebar.dart';

import '../support/super_tab_fixture.dart';
import 'swarm_benchmark.dart' show distribution;

void main() {
  // `mixed`: open tasks in every state the sidebar groups by (#2309): a
  // quarter working, a quarter waiting on a person, a quarter in review, a
  // quarter with no work, four in five unread.
  for (final (projects, perProject, mixed) in [
    (5, 50, false),
    (20, 200, false),
    (5, 50, true),
    (20, 200, true),
  ]) {
    testWidgets(
      'Swarm sidebar rebuild with $projects projects x $perProject conversations${mixed ? ', mixed states' : ''}',
      (tester) async {
        final server = ConversationServer();
        final ids = ['lead', for (var p = 1; p < projects; p++) 'p$p'];
        server.state['projects'] = [
          for (final id in ids)
            projectFixture(
              id,
              'Project $id',
              id == 'lead' ? 'lead' : 'lead-$id',
            ),
        ];
        final conversations = server.state['conversations'] as List;
        for (final id in ids) {
          if (id != 'lead') {
            conversations.add({
              ...conversationFixture('lead-$id', 'Lead'),
              'projectId': id,
            });
          }
          conversations.add({
            ...conversationFixture('pm-$id', 'Chat with PM'),
            'projectId': id,
            'audience': {
              'people': [
                {'id': 'owner'},
              ],
            },
          });
          for (var n = 1; n <= perProject; n++) {
            conversations.add({
              ...conversationFixture('g-$id-$n', 'Group $n'),
              'projectId': id,
              'number': n,
              'archived': n % 4 == 0,
              if (mixed) ...{
                'archived': false,
                'lastMessageSequence': n % 5 == 0 ? 0 : n,
                if (n % 4 != 3)
                  'assignment': {
                    'agentId': 'a1',
                    'status': n % 4 == 2 ? 'review' : 'working',
                    'progressAt': 1,
                  },
                if (n % 4 == 1)
                  'liveness': {
                    'state': 'waiting',
                    'why': 'person',
                    'personId': 'other',
                    'since': 1,
                  },
                if (n % 4 == 2)
                  'liveness': {'state': 'waiting', 'why': 'review', 'since': 1},
              },
            });
          }
        }
        final controller = server.controller(
          initial: {'tabId': 'tab', 'accountId': 'owner'},
        );
        await controller.refresh();

        late StateSetter rebuild;
        await tester.binding.setSurfaceSize(const Size(280, 1000));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: Scaffold(
              body: StatefulBuilder(
                builder: (context, setState) {
                  rebuild = setState;
                  return ProjectSidebar(
                    controller: controller,
                    onSelect: controller.select,
                  );
                },
              ),
            ),
          ),
        );
        await tester.pump();

        Future<int> once() async {
          final watch = Stopwatch()..start();
          rebuild(() {});
          await tester.pump();
          return watch.elapsedMicroseconds;
        }

        for (var i = 0; i < 20; i++) {
          await once();
        }
        final times = [for (var i = 0; i < 100; i++) await once()];
        // ignore: avoid_print
        print(
          jsonEncode({
            'benchmark': 'super_tab_sidebar_rebuild',
            'projects': projects,
            'conversationsPerProject': perProject,
            'mixed': mixed,
            ...distribution(times),
          }),
        );

        await tester.pumpWidget(const SizedBox());
        await controller.flush();
        controller.dispose();
      },
    );
  }
}
