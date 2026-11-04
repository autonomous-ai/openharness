import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/attention.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// Set to a folder to write the pictures of task #2927 there.
final shots = Platform.environment['SUPER_TAB_PROJECT_NUMBER_SHOTS'];

void _fromLead(ConversationServer server, String text, String id) {
  server.append(text, conversationId: id);
  server.messages.last['author'] = {
    'kind': 'agent',
    'id': 'lead-agent',
    'name': 'Lead',
  };
}

/// Dee's left bar (11-04): four projects with tags read and unread in their
/// chats, tags in their tasks and threads, a decision and a task waiting on
/// the reader. Only `lamp`'s chat holds a tag still unread.
ConversationServer _swarm() {
  final server = ConversationServer()..threads = true;
  server.state['projects'] = [
    projectFixture('gtm', 'harness-gtm', 'gtm-chat'),
    projectFixture('lamp', 'lamp', 'lamp-chat'),
    projectFixture('lamp-gtm', 'lamp-gtm', 'lamp-gtm-chat'),
    projectFixture('oh', 'openharness', 'oh-chat'),
  ];
  final groups = server.state['conversations'] as List;
  for (final (id, project) in [
    ('gtm-chat', 'gtm'),
    ('lamp-chat', 'lamp'),
    ('lamp-gtm-chat', 'lamp-gtm'),
    ('oh-chat', 'oh'),
  ]) {
    groups.add({...conversationFixture(id, id), 'projectId': project});
  }
  groups.add({
    ...conversationFixture('oh-task', 'Badge counts'),
    'projectId': 'oh',
    'number': 2927,
    'assignment': {'agentId': 'a1', 'status': 'needs_human', 'progressAt': 1},
    'liveness': {'state': 'waiting', 'why': 'person', 'since': 1},
  });
  groups.add({
    ...conversationFixture('gtm-task', 'Launch post'),
    'projectId': 'gtm',
    'number': 2901,
  });
  // Read: tags in harness-gtm's and lamp-gtm's chats.
  for (final chat in ['gtm-chat', 'lamp-gtm-chat']) {
    _fromLead(server, 'Have a look', chat);
    server.tag(
      server.messages.last['id'] as String,
      conversationId: chat,
      messageSequence: server.revision,
    );
    server.markReadElsewhere(chat, server.revision);
  }
  // Read: a tag in a task of harness-gtm.
  _fromLead(server, 'Copy is ready', 'gtm-task');
  server.tag(
    server.messages.last['id'] as String,
    conversationId: 'gtm-task',
    messageSequence: server.revision,
  );
  server.markReadElsewhere('gtm-task', server.revision);
  // Open for the reader: a decision in openharness's task.
  _fromLead(server, 'Which way?', 'oh-task');
  server.ask(['Ship it behind a flag?'], conversationId: 'oh-task');
  server.markReadElsewhere('oh-task', server.revision);
  server.markReadElsewhere('oh-chat', server.revision);
  // Unread: a tag in lamp's chat.
  _fromLead(server, 'Can you check the lamp firmware notes?', 'lamp-chat');
  server.tag(
    server.messages.last['id'] as String,
    conversationId: 'lamp-chat',
    messageSequence: server.revision,
  );
  return server;
}

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    for (final scene in ['before', 'after-opening-lamp']) {
      testWidgets('project numbers: $scene in ${brightness.name}', (
        tester,
      ) async {
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
            'selectedId': 'oh-chat',
          },
        );
        await c.refresh();
        final attention = SuperTabAttention.of(c);
        final activity = SuperTabActivity.of(c);
        await attention.mentions.load();
        await attention.decisions.load();
        await attention.load();
        await activity.mentions.load();
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
        // The decision and lamp's tag.
        expect(activity.count, 2);
        if (scene == 'after-opening-lamp') {
          c.select('lamp-chat');
          await tester.pumpAndSettle();
          c.markRead('lamp-chat');
          await tester.pumpAndSettle();
          expect(activity.count, 1);
        }
        await captureBoundary(
          tester,
          picture.currentContext!.findRenderObject()! as RenderRepaintBoundary,
          shots,
          'project-number-$scene-${brightness.name}',
        );
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
    }
  }
}
