import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/core/models.dart';
import 'package:harness/super_tabs/project_sidebar.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'support/swarm_v4_channel.dart';

/// Set to a folder to write this file's screenshots there, with the system's real fonts.
final shots = Platform.environment['SWARM_V4_SHOTS'];

/// Your Team (Swarm v4's left pane) of a person with forty agents on three computers: the list scrolls, Manage stays at the
/// foot, sections fold, an agent far down opens its chat and is deleted from its row.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  Finder key(String k) => find.byKey(ValueKey(k));

  /// The left pane's list, which scrolls.
  final sidebar = find
      .descendant(
        of: find.byType(ProjectSidebar),
        matching: find.byType(Scrollable),
      )
      .first;

  const names = [
    'Ada', 'Bo', 'Cy', 'Dot', 'Eli', 'Fay', 'Gus', 'Hal', 'Ida', 'Jin', //
    'Kai', 'Lea', 'Max', 'Nia', 'Oz', 'Pia', 'Quin', 'Rae', 'Sam', 'Tess',
    'Uma', 'Vic', 'Wes', 'Xia', 'Yan', 'Zed', 'Abe', 'Bea', 'Cal', 'Dan',
    'Eve', 'Fin', 'Gil', 'Han', 'Ivy', 'Jo', 'Kit',
  ];

  /// The three computers the forty run on: Mac Studio and Juno's laptop of [openSwarmV4]'s, and a desktop.
  const computers = [
    Machine(
      machineId: 'host',
      authMode: MachineAuthMode.managed,
      name: 'Mac Studio',
      status: 'online',
    ),
    Machine(
      machineId: 'laptop',
      authMode: MachineAuthMode.managed,
      name: 'Juno\'s laptop',
      status: 'offline',
    ),
    Machine(
      machineId: 'desk',
      authMode: MachineAuthMode.managed,
      name: 'Studio desk',
      status: 'online',
    ),
  ];

  /// Faye, Pip and Juno of [swarmV4Channel] and thirty-seven more, spread over the three computers.
  ConversationServer forty() {
    final server = swarmV4Channel();
    final groups = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>();
    final agents = (server.state['agents'] as List)
        .cast<Map<String, dynamic>>();
    for (final (i, name) in names.indexed) {
      final id = name.toLowerCase();
      agents.add({
        'id': id,
        'projectId': 'lampos',
        'name': name,
        'displayName': name,
        'machineId': const ['host', 'laptop', 'desk'][i % 3],
        'harnessId': 'session-$id',
        'contributorId': 'owner',
        'configuration': {'engine': i.isEven ? 'claude' : 'codex'},
        'kind': 'regular',
        'chatId': 'agent-chat-$id',
        'myAgent': true,
      });
      groups.add({
        ...conversationFixture('agent-chat-$id', name),
        'kind': 'agent-chat',
        'agentIds': [id],
      });
    }
    return server;
  }

  Future<void> look(WidgetTester tester, String name) =>
      captureWindow(tester, shots, 'team-$name');

  /// Opens the rows past Your Team's first eight, as its person does with "N more".
  Future<void> more(WidgetTester tester) async {
    await tester.ensureVisible(key('super-team-more'));
    await tester.pumpAndSettle();
    await tester.tap(key('super-team-more'));
    await tester.pumpAndSettle();
  }

  testWidgets('forty agents: the list scrolls, Manage stays at the foot', (
    tester,
  ) async {
    final c = await openSwarmV4(tester, forty(), machines: computers);
    expect(key('project-sidebar-agents'), findsOneWidget);
    expect(key('super-agent-ada'), findsOneWidget);
    // Further down than the window shows, until the list is scrolled.
    expect(key('super-agent-zed'), findsNothing);
    expect(find.text('Manage'), findsOneWidget);
    await look(tester, 'top');
    await more(tester);
    await tester.dragUntilVisible(
      key('super-agent-zed'),
      sidebar,
      const Offset(0, -300),
    );
    await tester.pumpAndSettle();
    expect(key('super-agent-zed'), findsOneWidget);
    expect(find.text('Manage'), findsOneWidget);
    await look(tester, 'scrolled');
    // Zed runs on the laptop; Cy, near the top, on the desktop: each chat's bar names its computer.
    await tester.tap(key('super-agent-zed'));
    await tester.pumpAndSettle();
    expect(c.selectedId, 'agent-chat-zed');
    expect(key('swarm-agent-header'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 300));
  });

  testWidgets('Your Team folds away, and the projects are then in sight', (
    tester,
  ) async {
    final c = await openSwarmV4(tester, forty(), machines: computers);
    await tester.tap(key('project-sidebar-agents'));
    await tester.pumpAndSettle();
    await tester.runAsync(c.flush);
    expect(key('super-agent-ada'), findsNothing);
    expect(key('super-group-channel'), findsOneWidget);
    expect(find.text('Manage'), findsOneWidget);
    await look(tester, 'folded');
  });

  testWidgets(
    'an agent far down is deleted from its row, and the list stays whole',
    (tester) async {
      final c = await openSwarmV4(tester, forty(), machines: computers);
      await more(tester);
      await tester.dragUntilVisible(
        key('super-agent-wes'),
        sidebar,
        const Offset(0, -300),
      );
      await tester.pumpAndSettle();
      await tester.tap(key('super-agent-wes'), buttons: kSecondaryButton);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();
      await tester.tap(key('delete-agent-confirm'));
      await tester.pumpAndSettle();
      expect(key('super-agent-wes'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pump(const Duration(milliseconds: 300));
      expect(c.snapshot!.agents.where((a) => a.id == 'wes'), isEmpty);
    },
  );

  for (final size in const [Size(1024, 700), Size(880, 560)]) {
    testWidgets(
      'forty agents at ${size.width.toInt()}x${size.height.toInt()}',
      (tester) async {
        await openSwarmV4(tester, forty(), machines: computers, size: size);
        expect(tester.takeException(), isNull);
        await look(tester, 'at-${size.width.toInt()}');
      },
    );
  }
}
