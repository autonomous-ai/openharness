import 'dart:async';

import 'package:flutter/widgets.dart';
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
  testWidgets(
    'background workspace keeps its cached PR without polling and refreshes on return',
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
            branch: 'main',
          ),
        ),
      ];
      app.activeSwarm.panes.add(
        TerminalPane(id: 1, machineId: 'm', agentId: 'a'),
      );
      app.activeSwarm.focusedPaneId = 1;
      app.appLifecycleChanged(AppLifecycleState.hidden);
      var reads = 0;
      final controller = WorkspacePullRequest(
        app,
        now: tester.binding.clock.now,
        read: (_, _) async => found(++reads),
      );
      await tester.pump(const Duration(minutes: 5));
      expect(reads, 0);
      app.appLifecycleChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(controller.value!.number, 1);
      await tester.pump(const Duration(seconds: 10));
      app.appLifecycleChanged(AppLifecycleState.inactive);
      await tester.pump(const Duration(seconds: 40));
      app.appLifecycleChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(reads, 1);
      expect(controller.value!.number, 1);
      await tester.pump(const Duration(seconds: 10));
      expect(reads, 2);
      app.appLifecycleChanged(AppLifecycleState.hidden);
      await tester.pump(const Duration(minutes: 5));
      expect(reads, 2);
      app.appLifecycleChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(controller.value!.number, 3);
      controller.dispose();
      app.dispose();
    },
  );
  testWidgets(
    'resume joins an outstanding workspace lookup and disposal prevents another poll',
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
            branch: 'main',
          ),
        ),
      ];
      app.activeSwarm.panes.add(
        TerminalPane(id: 1, machineId: 'm', agentId: 'a'),
      );
      app.activeSwarm.focusedPaneId = 1;
      var reads = 0;
      final reply = Completer<Map<String, dynamic>>();
      final controller = WorkspacePullRequest(
        app,
        now: tester.binding.clock.now,
        read: (_, _) {
          reads++;
          return reply.future;
        },
      );
      app.appLifecycleChanged(AppLifecycleState.hidden);
      await tester.pump(const Duration(minutes: 2));
      app.appLifecycleChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(reads, 1);
      app.appLifecycleChanged(AppLifecycleState.hidden);
      reply.complete(found(298));
      await tester.pump();
      await tester.pump(const Duration(seconds: 20));
      app.appLifecycleChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(reads, 1);
      expect(controller.value!.number, 298);
      controller.dispose();
      app.appLifecycleChanged(AppLifecycleState.hidden);
      app.appLifecycleChanged(AppLifecycleState.resumed);
      await tester.pump(const Duration(minutes: 2));
      expect(reads, 1);
      app.dispose();
    },
  );
  testWidgets(
    'focus changes in background defer lookups to the final identity',
    (tester) async {
      final app = createApp();
      app.stateOf('m')!.agents = [
        for (final id in ['a', 'b', 'c'])
          Agent(
            id: id,
            name: id,
            engine: 'codex',
            project: AgentProject(
              name: 'repo',
              cwd: '/repo-$id',
              root: '/repo-$id',
              branch: id,
            ),
          ),
      ];
      app.activeSwarm.panes.addAll([
        for (var i = 0; i < 3; i++)
          TerminalPane(id: i + 1, machineId: 'm', agentId: ['a', 'b', 'c'][i]),
      ]);
      app.activeSwarm.focusedPaneId = 1;
      final old = Completer<Map<String, dynamic>>();
      final reads = <String>[];
      final controller = WorkspacePullRequest(
        app,
        read: (_, id) {
          reads.add(id);
          return id == 'a' ? old.future : Future.value(found(3));
        },
      );
      app.appLifecycleChanged(AppLifecycleState.hidden);
      app.focusPane(2);
      app.focusPane(3);
      old.complete(found(1));
      await tester.pump(const Duration(minutes: 5));
      expect(reads, ['a']);
      expect(controller.value, isNull);
      app.appLifecycleChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(reads, ['a', 'c']);
      expect(controller.value!.number, 3);
      controller.dispose();
      app.dispose();
    },
  );
  test('only valid PR states and GitHub links are actionable', () {
    for (final state in ['Draft', 'Open', 'Merged', 'Closed']) {
      expect(
        PullRequestStatus.fromResult(found(298, state))!.label,
        '#298 $state',
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
