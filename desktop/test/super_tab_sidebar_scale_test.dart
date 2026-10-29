import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/project_sidebar.dart';

import 'support/super_tab_fixture.dart';

/// Counts how often each project's Chat with PM is looked up.
class _CountingController extends SuperTabController {
  _CountingController(ConversationServer server, {required super.initial})
    : super(
        tabId: 'tab',
        accountId: 'owner',
        request: server.request,
        save: server.save,
        pollInterval: Duration.zero,
      );

  final pmChatLookups = <String, int>{};

  @override
  SuperTabConversation? pmChat(String projectId) {
    pmChatLookups.update(projectId, (n) => n + 1, ifAbsent: () => 1);
    return super.pmChat(projectId);
  }
}

const _projects = 20, _perProject = 200;

/// [_projects] projects, each with its Lead, the reader's Chat with PM and
/// [_perProject] workgroups, every fourth of them closed.
List<String> _manyProjects(ConversationServer server) {
  final ids = ['lead', for (var p = 1; p < _projects; p++) 'p$p'];
  server.state['projects'] = [
    for (final id in ids)
      projectFixture(id, 'Project $id', id == 'lead' ? 'lead' : 'lead-$id'),
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
    for (var n = 1; n <= _perProject; n++) {
      conversations.add({
        ...conversationFixture('g-$id-$n', 'Group $n'),
        'projectId': id,
        'number': n,
        'archived': n % 4 == 0,
      });
    }
  }
  return ids;
}

void main() {
  test('a Chat with PM made after a read is found in the next one', () async {
    final server = ConversationServer();
    final controller = server.controller();
    await controller.refresh();
    expect(controller.pmChat('lead'), isNull);
    expect(controller.projectConversations('lead').map((g) => g.id), [
      'lead',
      'offline',
    ]);

    (server.state['conversations'] as List).add({
      ...conversationFixture('pm-lead', 'Chat with PM'),
      'audience': {
        'people': [
          {'id': 'owner'},
        ],
      },
    });
    server.revision++;
    await controller.refresh();

    expect(controller.pmChat('lead')?.id, 'pm-lead');
    expect(controller.projectConversations('lead').map((g) => g.id), [
      'lead',
      'offline',
      'pm-lead',
    ]);
    await controller.flush();
    controller.dispose();
  });

  testWidgets(
    'one sidebar build looks up each Chat with PM once and asks each open conversation once',
    (tester) async {
      final server = ConversationServer();
      final ids = _manyProjects(server);
      final controller = _CountingController(
        server,
        initial: {
          'tabId': 'tab',
          'accountId': 'owner',
          'expandedProjects': ids,
        },
      );
      await controller.refresh();
      expect(controller.snapshot!.conversations, hasLength(2 + 19 + 20 * 201));

      final asked = <String, int>{};
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
                  needsHuman: (group) {
                    asked.update(group.id, (n) => n + 1, ifAbsent: () => 1);
                    return 0;
                  },
                );
              },
            ),
          ),
        ),
      );
      await tester.pump();

      controller.pmChatLookups.clear();
      asked.clear();
      rebuild(() {});
      await tester.pump();

      expect(controller.pmChatLookups.keys, unorderedEquals(ids));
      expect(controller.pmChatLookups.values, everyElement(1));
      // Each project's 150 open workgroups, its Lead and its Chat with PM.
      expect(asked, hasLength(20 * 152 + 1));
      expect(asked.values, everyElement(1));

      await tester.pumpWidget(const SizedBox());
      await controller.flush();
      controller.dispose();
    },
  );
}
