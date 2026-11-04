// A release-build page holding the real Swarm view on made-up data, for task
// #2207's test: an older project chat that still holds a Reviewer, Finn 2,
// next to its coordinator, River, and a task with two agents. The panel on the
// right lists the terminal panes Desktop opens for the chat shown (the
// controller's terminalAgents, which the workspace opens), as the browser has
// no native terminals to show. Never shipped: nothing in lib/ imports it.
// Build: flutter build web --release -t test/web/release/project_chat_panes_app.dart
import 'package:flutter/material.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import '../../support/super_tab_fixture.dart';

Map<String, dynamic> _agent(String id, String name, String role) => {
  'id': id,
  'name': name,
  'roleName': role,
  'machineId': 'studio',
  'harnessId': 'native-$id',
  'contributorId': 'owner',
  'configuration': {'engine': 'claude'},
};

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final server = ConversationServer();
  server.state['agents'] = [
    _agent('river', 'River', 'Product Manager'),
    _agent('finn', 'Finn 2', 'Reviewer'),
    _agent('kai', 'Kai', 'Engineer'),
  ];
  final chats = server.state['conversations'] as List;
  // An older Swarm's project chat: Finn 2 was added there before #2207.
  chats[0]
    ..['leadId'] = 'river'
    ..['agentIds'] = ['river', 'finn'];
  chats[1]
    ..['leadId'] = 'river'
    ..['agentIds'] = ['kai', 'finn'];
  final controller = server.controller();
  await controller.refresh();
  await controller.select('lead');
  runApp(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: Row(
          children: [
            Expanded(
              child: SuperTabView(
                controller: controller,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                onOpenGroupTerminals: () =>
                    controller.selectGroupTerminals(controller.selectedId),
                machineName: (_) => 'Studio',
              ),
            ),
            SizedBox(width: 260, child: _Panes(controller: controller)),
          ],
        ),
      ),
    ),
  );
}

/// The panes the workspace would open beside the chat shown.
class _Panes extends StatelessWidget {
  const _Panes({required this.controller});

  final SuperTabController controller;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final id = controller.selectedId;
      final open = controller.groupTerminalsOpen(id);
      final agents = open ? controller.terminalAgents(id) : const [];
      final title = controller.snapshot?.conversation(id)?.title ?? id;
      return Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          key: const ValueKey('panes'),
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Terminal panes: $title'),
            const SizedBox(height: 8),
            if (!open) const Text('None open. Use the terminal button.'),
            for (final agent in agents)
              Text(agent.name, key: ValueKey('pane-${agent.id}')),
          ],
        ),
      );
    },
  );
}
