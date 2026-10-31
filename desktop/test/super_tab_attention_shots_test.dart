import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/attention.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// Set to a folder to write the PR's attention pictures there.
final shots = Platform.environment['SUPER_TAB_ATTENTION_SHOTS'];

Map<String, dynamic> _conversation(ConversationServer server, String id) =>
    (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((g) => g['id'] == id);

void _fromLead(ConversationServer server, String text, String id) {
  server.append(text, conversationId: id);
  server.messages.last['author'] = {
    'kind': 'agent',
    'id': 'lead-agent',
    'name': 'Lead',
  };
}

Map<String, dynamic> _root(String id, String text, String at) => {
  'id': id,
  'sequence': 1,
  'author': {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'},
  'text': text,
  'createdAt': at,
  'attachments': 0,
};

/// A Swarm with something for the reader: a tag in one workgroup, a decision
/// in another, plain news in a third, and threads with new replies.
ConversationServer _swarm() {
  final server = ConversationServer()..threads = true;
  server.state['projects'] = [
    projectFixture('lead', 'openharness', 'lead'),
    projectFixture('web', 'website', 'web-lead'),
  ];
  final groups = server.state['conversations'] as List;
  _conversation(server, 'offline')
    ..['projectId'] = 'lead'
    ..['number'] = 1600
    ..['title'] = 'Slack attention, wave 1';
  groups
    ..add({
      ...conversationFixture('routing', 'Routing goals piece 5'),
      'projectId': 'lead',
      'number': 1598,
    })
    ..add({
      ...conversationFixture('roster', 'Desktop roster'),
      'projectId': 'lead',
      'number': 1597,
    })
    ..add({...conversationFixture('web-lead', 'Lead'), 'projectId': 'web'});
  _fromLead(server, 'Release notes are up.', 'roster');
  server.markReadElsewhere('roster', server.revision);
  _fromLead(server, 'Mockup posted for review.', 'offline');
  server.tag('message-2', conversationId: 'offline');
  _fromLead(
    server,
    'Heavy CI is held while the account is at its limit.',
    'routing',
  );
  _fromLead(server, 'Which option should ship?', 'web-lead');
  server.ask(
    ['Ship it behind a flag?'],
    conversationId: 'web-lead',
    projectId: 'web',
  );
  server.tag('message-1', threadId: 'message-1');
  _fromLead(server, 'Weekly plan', 'lead');
  _fromLead(server, 'Looks right to me.', 'lead');
  server.messages.last['thread'] =
      server.messages[server.messages.length - 2]['id'];
  server.followedThreads = {
    'unread': [
      {
        'conversationId': 'lead',
        'rootId': server.messages[server.messages.length - 2]['id'],
        'root': _root(
          server.messages[server.messages.length - 2]['id'] as String,
          'Weekly plan: badges first, then the Threads view.',
          '2026-10-31T01:00:00Z',
        ),
        'lastReplyAt': '2026-10-31T02:00:00Z',
        'lastReplySequence': server.revision,
        'lastReplier': {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'},
        'unreadReplies': 1,
        'follow': null,
      },
    ],
    'read': [
      {
        'conversationId': 'routing',
        'rootId': 'message-old',
        'root': _root(
          'message-old',
          'Should heavy CI wait while the account is at its job limit?',
          '2026-10-30T01:00:00Z',
        ),
        'replies': 12,
        'lastReplyAt': '2026-10-30T09:15:00Z',
        'lastReplySequence': 4,
        'lastReplier': null,
        'follow': null,
      },
    ],
    'more': false,
  };
  return server;
}

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    for (final scene in ['sidebar', 'threads', 'hover']) {
      testWidgets('attention: $scene in ${brightness.name}', (tester) async {
        if (shots == null) return;
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previous);
        tester.view.devicePixelRatio = 2;
        tester.view.physicalSize = const Size(2400, 1400);
        addTearDown(tester.view.reset);
        final app = createApp(connected: true);
        addTearDown(app.dispose);
        final server = _swarm();
        final c = server.controller(
          initial: {
            'tabId': 'tab',
            'accountId': 'owner',
            'selectedId': 'roster',
          },
        );
        await c.refresh();
        final attention = SuperTabAttention.of(c);
        await attention.mentions.load();
        await attention.decisions.load();
        await attention.load();
        c.select('roster');
        if (!c.expandedProjects.contains('lead')) c.toggleProject('lead');
        final picture = GlobalKey();
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: RepaintBoundary(
              key: picture,
              child: Scaffold(
                body: SuperTabView(
                  controller: c,
                  app: app,
                  onInvite: () {},
                  onAddAgent: (_) {},
                  onOpenTerminal: (_) {},
                  onNewProject: () {},
                  machineName: (_) => 'Team Mac',
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        if (scene == 'threads') {
          await tester.tap(find.byKey(const ValueKey('super-threads')));
          await tester.pumpAndSettle();
          await tester.pumpAndSettle();
        }
        if (scene == 'hover') {
          final mouse = await tester.createGesture(
            kind: PointerDeviceKind.mouse,
          );
          await mouse.addPointer(location: Offset.zero);
          await mouse.moveTo(
            tester.getCenter(
              find.byKey(const ValueKey('super-project-toggle-web')),
            ),
          );
          await tester.pumpAndSettle();
          addTearDown(mouse.removePointer);
        }
        await captureBoundary(
          tester,
          picture.currentContext!.findRenderObject()! as RenderRepaintBoundary,
          shots,
          'attention-$scene-${brightness.name}',
        );
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
    }
  }
}
