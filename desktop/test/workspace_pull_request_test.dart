import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/pull_request_status.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/state/workspace_pull_request.dart';

import 'swarm_state_test.dart' show createApp;

Map<String, dynamic> found(int number, [String state = 'Open']) => {
  'status': 'found',
  'number': number,
  'state': state,
  'url': 'https://github.com/acme/repo/pull/$number',
};

void main() {
  test('only valid PR states and GitHub links are actionable', () {
    for (final state in ['Draft', 'Open', 'Merged', 'Closed']) {
      expect(
        PullRequestStatus.fromResult(found(298, state))!.label,
        'PR #298 · $state',
      );
    }
    for (final invalid in [
      {...found(1), 'state': 'Unknown'},
      {...found(1), 'number': -1},
      {...found(1), 'url': 'https://github.com/acme/repo/pull/2'},
      {...found(1), 'url': 'http://github.com/acme/repo/pull/1'},
      {...found(1), 'url': 'https://github.com.evil.test/acme/repo/pull/1'},
      {...found(1), 'url': 'https://user@github.com/acme/repo/pull/1'},
      {'status': 'none'},
      {'status': 'unavailable'},
    ]) {
      expect(PullRequestStatus.fromResult(invalid), isNull);
    }
  });

  testWidgets(
    'focused PR follows the viewer owner, caches switches, refreshes, and clears',
    (tester) async {
      final app = createApp();
      app.stateOf('m')!.agents = const [
        Agent(
          id: 'a',
          name: 'A',
          engine: 'codex',
          project: AgentProject(
            name: 'repo',
            cwd: '/repo',
            root: '/repo',
            branch: 'feature',
          ),
        ),
        Agent(
          id: 'b',
          name: 'B',
          engine: 'claude',
          project: AgentProject(name: 'notes', cwd: '/notes'),
        ),
      ];
      app.activeSwarm.panes.addAll([
        TerminalPane(id: 1, machineId: 'm', agentId: 'a'),
        TerminalPane(id: 2, machineId: 'm', agentId: 'b'),
        TerminalPane(
          id: 3,
          machineId: 'm',
          kind: PaneKind.web,
          ownerAgentId: 'a',
        ),
      ]);
      app.activeSwarm.focusedPaneId = 1;
      final reads = <(String, String)>[];
      final controller = WorkspacePullRequest(
        app,
        read: (machine, agent) async {
          reads.add((machine, agent));
          return found(298, reads.length == 1 ? 'Open' : 'Merged');
        },
      );
      await tester.pump();
      expect(controller.value!.state, 'Open');
      app.focusPane(3);
      await tester.pump();
      expect(reads, [('m', 'a')]);
      expect(controller.value!.number, 298);
      app.focusPane(2);
      expect(controller.value, isNull);
      app.focusPane(1);
      expect(controller.value!.number, 298);
      expect(reads, hasLength(1));
      await tester.pump(const Duration(seconds: 60));
      expect(controller.value!.state, 'Merged');
      expect(reads, hasLength(2));
      app.newSwarm();
      expect(controller.value, isNull);
      controller.dispose();
      app.dispose();
      await tester.pump(const Duration(seconds: 60));
      expect(reads, hasLength(2));
    },
  );

  testWidgets('branch changes and disposal reject old PR replies', (
    tester,
  ) async {
    final app = createApp();
    void branch(String name) {
      app.stateOf('m')!.agents = [
        Agent(
          id: 'a',
          name: 'A',
          engine: 'codex',
          project: AgentProject(
            name: 'repo',
            cwd: '/repo',
            root: '/repo',
            branch: name,
          ),
        ),
      ];
    }

    branch('old');
    app.activeSwarm.panes.add(
      TerminalPane(id: 1, machineId: 'm', agentId: 'a'),
    );
    app.activeSwarm.focusedPaneId = 1;
    final replies = <Completer<Map<String, dynamic>>>[];
    final controller = WorkspacePullRequest(
      app,
      read: (_, _) {
        final reply = Completer<Map<String, dynamic>>();
        replies.add(reply);
        return reply.future;
      },
    );
    branch('new');
    app.focusPane(1, reveal: true);
    replies[1].complete(found(2));
    await tester.pump();
    replies[0].complete(found(1, 'Merged'));
    await tester.pump();
    expect(controller.value!.number, 2);
    branch('third');
    app.focusPane(1, reveal: true);
    expect(controller.value, isNull);
    controller.dispose();
    replies[2].complete(found(3));
    await tester.pump();
    app.dispose();
    await tester.pump(const Duration(seconds: 60));
    expect(replies, hasLength(3));
  });
}
