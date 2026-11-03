import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/attention.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's pictures of the task groups (#2309) there.
final shots = Platform.environment['SUPER_TAB_SIDEBAR_SHOTS'];

/// A busy project, as Huy's: something waits on the reader, several agents
/// work, some wait on review or another person, and older tasks rest.
ConversationServer busyProject() {
  final now = DateTime.now().millisecondsSinceEpoch;
  int ago(int minutes) => now - minutes * 60000;
  final server = ConversationServer();
  server.state['people'] = [
    {'id': 'owner', 'email': 'huy@example.com', 'role': 'owner'},
    {'id': 'ken', 'email': 'ken@example.com', 'role': 'collaborator'},
  ];
  server.state['projects'] = [
    projectFixture('lead', 'openharness', 'lead'),
    projectFixture('site', 'website', 'site-chat'),
  ];
  var sequence = 0;
  Map<String, dynamic> task(
    String id,
    int number,
    String title, {
    String? status,
    Map<String, dynamic>? liveness,
    bool unread = false,
  }) => {
    ...conversationFixture(id, title),
    'projectId': 'lead',
    'number': number,
    'lastMessageSequence': unread ? ++sequence : 0,
    if (status != null)
      'assignment': {'agentId': 'a1', 'status': status, 'progressAt': ago(3)},
    'liveness': ?liveness,
  };
  Map<String, dynamic> waiting(String why, int minutes, {String? personId}) => {
    'state': 'waiting',
    'why': why,
    'since': ago(minutes),
    'personId': ?personId,
  };
  (server.state['conversations'] as List)
    ..removeWhere((g) => (g as Map)['id'] == 'offline')
    ..addAll(<Map<String, dynamic>>[
      task(
        't1',
        2309,
        'Sidebar: tasks in foldable groups',
        status: 'needs_human',
        liveness: waiting('person', 4, personId: 'owner'),
        unread: true,
      ),
      task(
        't2',
        2311,
        'Web: thread bar on a phone',
        status: 'working',
        unread: true,
      ),
      task('t3', 2307, 'Dial: recap answers at once', status: 'working'),
      task(
        't4',
        2305,
        'Hub reports hide for everyone',
        status: 'working',
        liveness: waiting('starting', 1),
      ),
      task(
        't5',
        2304,
        'Typography pass on Activity',
        status: 'review',
        liveness: waiting('review', 12),
        unread: true,
      ),
      task(
        't6',
        2302,
        'Machine names in review',
        status: 'needs_human',
        liveness: waiting('person', 40, personId: 'ken'),
      ),
      task(
        't7',
        2298,
        'Remove machine privacy',
        status: 'working',
        liveness: {'state': 'quiet', 'since': ago(34)},
      ),
      task('t8', 2290, 'Sidebar groups for Buddy chats', unread: true),
      task('t9', 2287, 'Older: thread pane width'),
      task('t10', 2281, 'Older: release notes copy', status: 'done'),
      {...conversationFixture('site-chat', 'website'), 'projectId': 'site'},
    ]);
  return server;
}

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    for (final (name, size) in [
      ('desktop', const Size(1100, 760)),
      ('phone', const Size(390, 844)),
    ]) {
      testWidgets('the task groups at $name width in ${brightness.name}', (
        tester,
      ) async {
        if (shots == null) return;
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previous);
        tester.view.devicePixelRatio = 2;
        tester.view.physicalSize = size * 2;
        addTearDown(tester.view.reset);
        final c = busyProject().controller();
        await c.refresh();
        if (!c.expandedProjects.contains('lead')) c.toggleProject('lead');
        await c.select('lead');
        final picture = GlobalKey();
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: RepaintBoundary(
              key: picture,
              child: Scaffold(
                // On a phone the web app shows the sidebar on its own.
                body: name == 'phone'
                    ? ListenableBuilder(
                        listenable: c,
                        builder: (context, _) => ProjectSidebar(
                          controller: c,
                          needsHuman: (_) => 0,
                          onSelect: c.select,
                          attention: SuperTabAttention.of(c),
                          activity: SuperTabActivity.of(c),
                          onNotifications: () {},
                        ),
                      )
                    : SuperTabView(
                        controller: c,
                        onInvite: () {},
                        onAddAgent: (_) {},
                        onOpenTerminal: (_) {},
                        machineName: (_) => 'Team Mac',
                      ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await captureBoundary(
          tester,
          picture.currentContext!.findRenderObject()! as RenderRepaintBoundary,
          shots,
          'task-groups-$name-${brightness.name}',
        );
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
    }
  }
}
