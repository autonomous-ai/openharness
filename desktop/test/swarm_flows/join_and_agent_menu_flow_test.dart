import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/join_dialog.dart';
import 'package:harness/super_tabs/join_link.dart';
import 'package:harness/super_tabs/model.dart';

import 'support/stack.dart';

/// Joining a teammate's Swarm, by its link and by an invitation, and what a
/// person does to an agent of theirs: Rename, Restart and Remove.
void main() {
  if (cliRoot == null) {
    test('Join and agent menu flows', () {}, skip: skipReason);
    return;
  }
  late SwarmStack stack;
  setUpAll(() async => stack = await SwarmStack.start());
  tearDownAll(() => stack.stop());

  flowTest('Join a teammate\'s Swarm from its shared link', (tester) async {
    // The teammate, elsewhere: a Swarm of theirs, shared by link (Share ▸ Anyone with the link).
    final (tabId, joinUrl) = (await tester.runAsync(() async {
      final tabId = await stack.newSwarm('Teammate Co', as: 'teammate');
      final path = '/api/super-tabs/$tabId/sharing';
      final saved = await stack.api(path, as: 'teammate');
      final shared = await stack.api(
        path,
        as: 'teammate',
        method: 'POST',
        body: {
          'operationId': 'flow-share-${DateTime.now().microsecondsSinceEpoch}',
          'revision': (saved['data'] as Map)['revision'],
          'access': {'mode': 'link', 'role': 'collaborator'},
        },
      );
      return (tabId, (shared['data'] as Map)['joinUrl'] as String);
    }))!;
    final flow = await FlowApp.open(tester, stack);
    await _withJoinHost(flow, tester);
    // The person clicks the link they were sent; macOS hands it to the app.
    await tester.runAsync(() => swarmJoinInbox.accept(joinUrl));

    await flow.see(find.text('Teammate Co'), what: 'the Join Swarm dialog');
    await flow.tap(
      find.byKey(const Key('swarm-join-confirm')),
      what: 'Join Swarm',
    );

    await flow.until('the joined Swarm to open with the person in it', () {
      flow.refuse('unavailable for your account');
      flow.refuse('Could not open this Swarm');
      return flow.app.activeSwarm.superTabId == tabId &&
          _isMember(flow, tabId, stack);
    });
    expect(
      find.byKey(const ValueKey('swarm-join-confirm')),
      findsNothing,
      reason: 'the dialog closed',
    );
    expect(
      await _backendMembers(tester, stack, tabId),
      contains(stack.owner['id']),
      reason: 'the backend lists the person as a member',
    );
    await flow.close();
  });

  flowTest('Accept a teammate\'s Swarm invitation in Settings', (tester) async {
    // The teammate, elsewhere: a Swarm of theirs, and an invitation to the person's email.
    final tabId = (await tester.runAsync(() async {
      final tabId = await stack.newSwarm('Invited Co', as: 'teammate');
      await stack.command(tabId, {
        'type': 'invite.create',
        'email': stack.owner['email'],
        'role': 'collaborator',
        'conversationId': 'lead',
      }, as: 'teammate');
      return tabId;
    }))!;
    final flow = await FlowApp.open(tester, stack);

    await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.comma);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
    await flow.tap(find.text('Tab invites'), what: 'Settings ▸ Tab invites');
    await flow.see(find.text('Invited Co'), what: 'the invitation');
    await flow.tap(find.widgetWithText(FilledButton, 'Accept'));

    await flow.until(
      'Settings to close on the joined Swarm',
      () =>
          find.text('Back to app').evaluate().isEmpty &&
          flow.app.activeSwarm.superTabId == tabId &&
          _isMember(flow, tabId, stack),
    );
    expect(
      await _backendMembers(tester, stack, tabId),
      contains(stack.owner['id']),
      reason: 'the backend lists the person as a member',
    );
    await flow.close();
  });

  flowTest('Rename an agent from its chat\'s Agent options', (tester) async {
    final tabId = (await tester.runAsync(() => stack.newSwarm('Rename Co')))!;
    final flow = await FlowApp.open(tester, stack);
    flow.app.openSuperTab(tabId, 'Rename Co');
    final agent = await _newAgent(flow, tester, tabId);

    await flow.tap(find.byTooltip('Agent options'), what: 'the chat\'s ⋮');
    await flow.tap(find.text('Rename'));
    await flow.type(find.byKey(const Key('agent-rename-input')), 'Scout');
    await tester.testTextInput.receiveAction(TextInputAction.done);

    await flow.see(
      find.descendant(
        of: find.byKey(ValueKey('super-agent-${agent.id}')),
        matching: find.text('Scout'),
      ),
      what: 'the left pane\'s row named Scout',
    );
    final agents = await _backendAgents(tester, stack, tabId);
    expect(
      agents[agent.id]?['displayName'],
      'Scout',
      reason: 'the backend has the new name',
    );
    await flow.close();
  });

  flowTest('Restart an agent from its terminal brings it back', (tester) async {
    final tabId = (await tester.runAsync(() => stack.newSwarm('Restart Co')))!;
    final flow = await FlowApp.open(tester, stack);
    flow.app.openSuperTab(tabId, 'Restart Co');
    final agent = await _newAgent(flow, tester, tabId);

    await _openMembers(flow, tabId, 'Restart Co');
    await flow.tap(
      find.byKey(ValueKey('super-member-${agent.id}')),
      what: 'the agent in Members',
    );
    await flow.tap(
      find.text('Open terminal'),
      what: 'its card\'s Open terminal',
    );
    await flow.until(
      'its terminal to open, focused',
      () => flow.app.focusedPane?.agentId == agent.harnessId,
    );
    // Agent ▸ Restart Harness, ⇧⌘E.
    await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyE);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
    final prompt = find.byKey(const ValueKey('agent-restart-prompt'));
    await flow.see(prompt, what: 'the Restart Harness prompt');

    // The prompt closes by itself only once the daemon says the engine is back
    // in its pane with its conversation (restart_agent_action.dart _finish).
    await flow.until('the daemon to restart it', () {
      flow.refuse('Could not confirm the restart');
      flow.refuse('Restart not confirmed');
      flow.refuse('previous conversation could not be resumed');
      return prompt.evaluate().isEmpty;
    });
    await flow.until('it to show running again', () {
      final running = flow.app.machineStates[stack.machineId]?.agents
          .where((a) => a.id == agent.harnessId)
          .firstOrNull;
      return running?.launchState == 'ready' &&
          running?.terminalAvailable == true &&
          flow.app.focusedPane?.agentId == agent.harnessId;
    });
    expect(
      find.byKey(ValueKey('super-agent-${agent.id}')),
      findsOneWidget,
      reason: 'still in the left pane',
    );
    await flow.close();
  });

  flowTest('Remove an agent from the Members panel', (tester) async {
    final tabId = (await tester.runAsync(() => stack.newSwarm('Remove Co')))!;
    final flow = await FlowApp.open(tester, stack);
    flow.app.openSuperTab(tabId, 'Remove Co');
    final agent = await _newAgent(flow, tester, tabId);

    await _openMembers(flow, tabId, 'Remove Co');
    final member = find.byKey(ValueKey('super-member-${agent.id}'));
    await flow.see(member, what: 'the agent in Members');
    await tester.tap(member.first, buttons: kSecondaryButton);
    await tester.pump();
    await flow.tap(
      find.text('Remove from Swarm'),
      what: 'the menu\'s Remove from Swarm',
    );
    final confirm = find.widgetWithText(FilledButton, 'Remove from Swarm');
    await flow.until('the confirmation\'s Remove from Swarm', () {
      final shown = confirm.evaluate();
      return shown.isNotEmpty &&
          (shown.first.widget as FilledButton).onPressed != null;
    });
    await tester.tap(confirm);
    await tester.pump();

    await flow.until(
      'the agent to leave the left pane',
      () => find.byKey(ValueKey('super-agent-${agent.id}')).evaluate().isEmpty,
    );
    final agents = await _backendAgents(tester, stack, tabId);
    expect(
      agents.containsKey(agent.id),
      isFalse,
      reason: 'the backend no longer lists the agent',
    );
    await flow.close();
  });
}

/// + New agent as a person does it, waiting for its own chat; the agent it made.
Future<SuperTabAgent> _newAgent(
  FlowApp flow,
  WidgetTester tester,
  String tabId,
) async {
  await flow.tap(find.text('New agent'), what: 'the left pane\'s New agent');
  await flow.type(find.byKey(const ValueKey('new-harness-task')), 'Say hello.');
  await tester.testTextInput.receiveAction(TextInputAction.send);
  SuperTabAgent? made;
  await flow.until('the new agent\'s chat to open', () {
    flow.refuse('no longer available');
    final c = flow.swarm(tabId);
    if (c?.selected?.kind != 'agent-chat') return false;
    made = c!.snapshot?.agents
        .where((a) => a.chatId == c.selectedId)
        .firstOrNull;
    return made?.harnessId.isNotEmpty == true;
  }, timeout: const Duration(seconds: 60));
  return made!;
}

/// Members, where a person finds the Swarm's agents: Projects, the project,
/// its Chat, and the Members button in that chat's header.
Future<void> _openMembers(FlowApp flow, String tabId, String project) async {
  await flow.tap(find.text('Projects'), what: 'the left pane\'s Projects');
  await flow.see(find.text('New project'), what: 'the Projects page');
  await flow.tap(find.text(project).last, what: 'the project $project');
  // Its Board opens with the person's Buddy on the right, made on the server
  // the first time. Until that answers, it takes the selection late, off
  // whatever the person opened meanwhile.
  await flow.until(
    'the Buddy\'s chat beside the Board',
    () => flow.swarm(tabId)?.selected?.isBuddyChat == true,
  );
  await flow.tap(find.byKey(const ValueKey('super-board-tab-chat')));
  await flow.tap(find.byKey(const ValueKey('super-members-button')));
}

/// The workspace as the shipped app builds it around the Swarm screen
/// (desktop_workspace.dart): with the host that shows a Swarm link's Join
/// dialog, which [FlowApp] leaves out. Signed in, as the host requires.
Future<void> _withJoinHost(FlowApp flow, WidgetTester tester) async {
  flow.app.status = AppStatus.authenticated;
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: Brightness.light),
      home: SwarmJoinHost(
        app: flow.app,
        child: SwarmScreen(notifier: flow.app, nativeTabs: false),
      ),
    ),
  );
}

/// Whether the app's open Swarm [tabId] lists the person among its people.
bool _isMember(FlowApp flow, String tabId, SwarmStack stack) =>
    flow.swarm(tabId)?.snapshot?.people.any((p) => p.id == stack.owner['id']) ==
    true;

/// The Swarm's members as the backend reads them to its owner, the teammate.
Future<List<Object?>> _backendMembers(
  WidgetTester tester,
  SwarmStack stack,
  String tabId,
) async {
  final parts = (await tester.runAsync(
    () => stack.api('/api/super-tabs/$tabId/parts', as: 'teammate'),
  ))!;
  return [
    for (final member in (parts['data'] as Map)['members'] as List)
      (member as Map)['data']['id'],
  ];
}

/// The Swarm's agents as the backend reads them to the owner, by id.
Future<Map<String, Map>> _backendAgents(
  WidgetTester tester,
  SwarmStack stack,
  String tabId,
) async {
  final parts = (await tester.runAsync(
    () => stack.api('/api/super-tabs/$tabId/parts'),
  ))!;
  return {
    for (final part in (parts['data'] as Map)['agents'] as List)
      (part as Map)['key'] as String: part['data'] as Map,
  };
}
