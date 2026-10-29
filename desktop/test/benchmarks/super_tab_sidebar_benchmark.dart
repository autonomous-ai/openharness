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
  for (final (projects, perProject) in [(5, 50), (20, 200)]) {
    testWidgets(
      'Swarm sidebar rebuild with $projects projects x $perProject conversations',
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
            });
          }
        }
        final controller = server.controller(
          initial: {
            'tabId': 'tab',
            'accountId': 'owner',
            'expandedProjects': ids,
          },
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
                    onAddAgent: (_) {},
                    needsHuman: (_) => 0,
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
