import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/workspace.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

// Swarm v4: only agents post in a project's channel. New Project with a PM the Swarm starts on another of the person's
// computers sends their request to the PM's own 1:1 chat, which lead.start opens at once (backend pmChat.ts), and opens
// that chat: the request waits there for the PM.

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 30; i++) {
    await tester.pump(const Duration(milliseconds: 20));
  }
}

/// The PM's own chat its start opened (backend pmChat.ts), as the fake server keeps it.
String _pmChat(SuperTabLaunchFixture f) =>
    (f.connection.server.state['conversations'] as List)
            .cast<Map>()
            .singleWhere(
              (g) =>
                  g['kind'] == 'agent-chat' && g['title'] == 'Product Manager',
            )['id']
        as String;

void main() {
  testWidgets('New Project with a PM the Swarm starts puts the request in the '
      'PM’s own chat, which opens, and nothing in the channel', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final f = SuperTabLaunchFixture();
    // A repo this Mac knows, and the person's other computer, which this
    // Desktop does not reach: the Swarm starts the PM there.
    f.app.machineStates['m']!.agents = [
      const Agent(
        id: 'earlier',
        name: 'Earlier',
        engine: 'codex',
        terminalAvailable: true,
        project: AgentProject(
          name: 'project',
          cwd: '/work/project',
          root: '/work/project',
          remote: 'git@github.com:autonomous-ai/lamp-os.git',
        ),
      ),
    ];
    f.connection.server.state['machines'] = [
      {
        'machineId': 'far',
        'name': 'Office Mini',
        'cwd': '/swarm/far',
        'contributorId': 'owner',
        'maxAgents': 8,
        'availableSlots': 4,
        'paused': false,
        'observation': {
          'receivedAt': DateTime.now().millisecondsSinceEpoch,
          'runningHarnessIds': <String>[],
          'capabilities': ['leadStart'],
        },
      },
    ];
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    final box = await tester.runAsync(
      () => f.box(newProject: true, task: 'Plan the launch', lead: 'far'),
    );
    expect(box!.leadThroughSwarm, isTrue);

    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: NewHarnessForm(
            controller: box,
            desktop: true,
            embedded: true,
            onClose: () {},
            onCreated: () {},
          ),
        ),
      ),
    );
    await _settle(tester);
    await tester.tap(find.byKey(const ValueKey('new-harness-field-start')));
    await tester.runAsync(() async {
      for (
        var i = 0;
        i < 50 && f.app.superTabs.peek(tabId)?.selectedId == null;
        i++
      ) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
    });
    await _settle(tester);

    final c = f.app.superTabs.peek(tabId)!;
    final project = c.snapshot!.projects.last;
    final chat = _pmChat(f);
    expect(c.selectedId, chat);

    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: ListenableBuilder(
            listenable: f.app,
            builder: (_, _) => SuperTabWorkspace(
              app: f.app,
              canvas: const Text('Native terminals'),
              onAddAgent: (_) {},
            ),
          ),
        ),
      ),
    );
    await _settle(tester);
    // The request, in the PM's chat, waiting for it.
    expect(find.text('Plan the launch'), findsOneWidget);
    expect(find.text('Waiting for the Product Manager'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('super-message-composer')),
      findsOneWidget,
    );

    // The channel holds none of the person's words, and stays agents only.
    await c.select(project.leadConversationId);
    await _settle(tester);
    expect(find.text('Plan the launch'), findsNothing);
    expect(find.byKey(const ValueKey('super-agents-only')), findsOneWidget);
    expect(
      f.connection.server.messages.where(
        (m) => m['conversationId'] == project.leadConversationId,
      ),
      isEmpty,
    );
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  });
}
