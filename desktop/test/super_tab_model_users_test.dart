import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/local_models.dart';

import 'support/buddy_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Whoever serves a model shared in the Swarm sees which Buddies run on it
/// (task #2354, docs/plans/2026-11-03-buddy-model-switch-design.md).
void main() {
  const swarmGrid = 'swarm-0123456789ab';

  int now() => DateTime.now().millisecondsSinceEpoch;

  Map<String, dynamic> machine(
    String id,
    String name,
    String contributor,
    List<Map<String, dynamic>> served, {
    int? at,
    bool buddyOnly = false,
  }) => {
    'machineId': id,
    'name': name,
    'contributorId': contributor,
    'scope': 'swarm',
    'engines': <dynamic>[],
    'maxAgents': 4,
    'availableSlots': 4,
    'buddyOnly': ?(buddyOnly ? true : null),
    'observation': {'receivedAt': at ?? now(), 'localModels': served},
  };

  /// Ken's (`peer`) one Buddy runs on his Mac; the Swarm's grid is on, and
  /// its members' machines serve models on it, and on others.
  ConversationServer swarm({String? gridModel}) {
    final server = oneBuddySwarm();
    server.state['people'] = [
      ...server.state['people'] as List,
      {'id': 'tony', 'email': 'tony@example.com', 'role': 'collaborator'},
      {'id': 'diego', 'email': 'diego@example.com', 'role': 'collaborator'},
    ];
    giveSwarmBuddy(server);
    final buddy = (server.state['agents'] as List).cast<Map>().firstWhere(
      (a) => a['id'] == 'wren',
    );
    if (gridModel != null) buddy['gridModel'] = gridModel;
    server.state['localModels'] = {
      'grid': swarmGrid,
      'enabled': true,
      'ready': true,
    };
    final kenMac = (server.state['machines'] as List).first as Map;
    server.state['machines'] = [
      kenMac,
      machine('studio', 'Studio.local', 'owner', [
        {
          'grid': swarmGrid,
          'model': 'deepseek-4.1-flash',
          'name': 'DeepSeek 4.1 Flash',
          'kind': 'local',
        },
        {'grid': swarmGrid, 'model': 'kimi-k3', 'name': 'Kimi K3'},
        // Still starting: the grid does not list it yet.
        {
          'grid': swarmGrid,
          'model': 'qwen-3.6',
          'name': 'Qwen 3.6',
          'starting': true,
        },
        // Shared with the owner from another grid: their machine alone.
        {'grid': 'team', 'model': 'muse', 'name': 'Muse', 'kind': 'shared'},
        // Another Swarm's grid.
        {
          'grid': 'swarm-ffffffffffff',
          'model': 'other',
          'name': 'Other Grid',
          'kind': 'local',
        },
      ]),
      machine('tony-mini', 'Tonys-Mac-mini.local', 'tony', [
        {
          'grid': swarmGrid,
          'model': 'kimi-k3',
          'name': 'Kimi K3',
          'kind': 'local',
        },
      ]),
      machine('diego-mac', 'Diego-MacBook.local', 'diego', [
        {
          'grid': swarmGrid,
          'model': 'openai/gpt-6.1-sol',
          'name': 'GPT-6.1 Sol',
          'kind': 'api',
        },
      ]),
      // Its reading is ten minutes old: it says nothing now.
      machine('old-box', 'Old-Box.local', 'owner', [
        {
          'grid': swarmGrid,
          'model': 'stale-model',
          'name': 'Stale Model',
          'kind': 'local',
        },
      ], at: now() - 10 * 60 * 1000),
      // A Buddy-only machine never joins the Swarm's grid.
      machine('outside', 'Outside.local', 'owner', [
        {
          'grid': swarmGrid,
          'model': 'outside-model',
          'name': 'Outside Model',
          'kind': 'local',
        },
      ], buddyOnly: true),
    ];
    return server;
  }

  Future<void> close(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  }

  group("the contributor's models", () {
    testWidgets('name the Buddies that run on each model', (tester) async {
      final server = swarm(gridModel: 'kimi-k3');
      // A Buddy goes by its own name (task #4568), never "<person>'s Buddy".
      (server.state['agents'] as List).cast<Map>().firstWhere(
        (a) => a['id'] == 'wren',
      )['displayName'] = 'Wren';
      final c = server.controller(account: 'owner');
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: SuperTabMachineLocalModels(
              controller: c,
              machineId: 'studio',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Kimi K3'), findsOneWidget);
      expect(find.text('Used by Wren'), findsOneWidget);
      // One line, under the model the Buddy runs on alone.
      expect(
        tester.getTopLeft(find.text('Used by Wren')).dy,
        greaterThan(tester.getTopLeft(find.text('Kimi K3')).dy),
      );
      expect(find.textContaining('Used by'), findsOneWidget);
      await close(tester, c);
    });
  });
}
