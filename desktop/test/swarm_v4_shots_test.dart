import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// Set to a folder to write Swarm v4's screenshots there.
final shots = Platform.environment['SWARM_V4_SHOTS'];

Map<String, dynamic> _agent(String id, String kind, String chat) => {
  'id': id,
  'projectId': 'lead',
  'name': id,
  'displayName': id,
  'machineId': 'host',
  'harnessId': 'session-$id',
  'contributorId': 'owner',
  'configuration': {'engine': 'claude'},
  'kind': kind,
  'chatId': chat,
  'myAgent': true,
};

/// Swarm v4 (anh Dee 2026-11-08), in both appearances: the left pane (Your agents, Projects, Humans, Manage), a project's
/// channel in the middle, a task's chat beside it, and an agent's own chat.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    for (final scene in ['channel', 'thread', 'tasks', 'agent']) {
      testWidgets('$scene (${brightness.name})', (tester) async {
        await tester.binding.setSurfaceSize(const Size(1440, 860));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final before = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = before);
        final server = swarm()..threads = true;
        final groups = (server.state['conversations'] as List)
            .cast<Map<String, dynamic>>();
        server.state['agents'] = [
          _agent('first builder', 'pm', 'agent-chat-first'),
          _agent('second', 'regular', 'agent-chat-second'),
          _agent('third', 'regular', 'agent-chat-third'),
        ];
        final lead = groups.firstWhere((g) => g['id'] == 'lead');
        lead['leadId'] = 'first builder';
        lead['title'] = 'lampos';
        (server.state['projects'] as List).first['name'] = 'lampos';
        groups.add({
          ...conversationFixture('agent-chat-first', 'first builder'),
          'kind': 'agent-chat',
          'agentIds': ['first builder'],
        });
        groups.add({
          ...conversationFixture('agent-chat-second', 'second'),
          'kind': 'agent-chat',
          'agentIds': ['second'],
        });
        void say(String chat, String who, String text, {String? thread}) {
          server.append(text, conversationId: chat);
          server.messages.last['author'] = {
            'kind': who == 'Dee' ? 'person' : 'agent',
            'id': who == 'Dee' ? 'owner' : who,
            'name': who,
          };
          if (thread != null) {
            server.messages.last['thread'] = thread;
            server.messages.last['replyTo'] = thread;
          }
        }

        say(
          'lead',
          'first builder',
          'Plan for the week: voice first. Six tasks, three for second.',
        );
        say(
          'lead',
          'second',
          '@first builder Taking #1. I\'ll start with the name detector\'s tests.',
        );
        say(
          'lead',
          'third',
          '@second My noisy-rooms change touches the mixer too. I\'ll rebase after yours merges.',
        );
        say('lead', 'first builder', '@third Not in v2. Parked for v2.1.');
        // A task is a thread in the channel: its first line is the task, the replies its chat.
        say(
          'lead',
          'first builder',
          '#5861 Forget every copy. @second it\'s yours: forget clears the lamp, the cloud backup and guests\' faces.',
        );
        final task = server.messages.last['id'] as String;
        say(
          'lead',
          'second',
          '@friday Can I keep faces in a cache for 10 minutes? Answers get 300 ms faster.',
          thread: task,
        );
        say(
          'lead',
          'friday',
          '@second No face cache. Loc: privacy beats speed.',
          thread: task,
        );
        say(
          'lead',
          'fourth',
          'Approved at 7be03f1. The cloud delete now runs on the next connect.',
          thread: task,
        );
        say(
          'lead',
          'first builder',
          '#5843 Speaker clicks at low volume. @third yours.',
        );
        final clicks = server.messages.last['id'] as String;
        say('lead', 'third', 'Found it: the mixer fades in at 0 ms.', thread: clicks);
        say(
          'agent-chat-second',
          'Dee',
          'you own voice on lampos. privacy beats speed, every time.',
        );
        say(
          'agent-chat-second',
          'second',
          'Written to agents/second.md and pushed.',
        );
        final c = server.controller(
          account: 'owner',
          initial: {
            'tabId': 'tab',
            'accountId': 'owner',
            'selectedId': scene == 'agent' ? 'agent-chat-second' : 'lead',
          },
        );
        await tester.runAsync(c.refresh);
        if (scene == 'thread') {
          c.openThread(
            server.messages.firstWhere(
                  (m) => (m['text'] as String).startsWith('#5861'),
                )['id']
                as String,
          );
        }
        final AppNotifier app = createApp();
        addTearDown(app.dispose);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: Scaffold(
              body: SuperTabView(
                controller: c,
                app: app,
                onNewSwarm: () {},
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Mac Studio',
                board: true,
              ),
            ),
          ),
        );
        Future<void> settle() async {
          for (var i = 0; i < 3; i++) {
            await tester.runAsync(
              () => Future<void>.delayed(const Duration(milliseconds: 30)),
            );
            await tester.pump(const Duration(milliseconds: 50));
          }
        }

        await settle();
        if (scene == 'tasks') {
          await tester.tap(find.byKey(const ValueKey('swarm-tasks-button')));
          await settle();
        }
        await captureWindow(tester, shots, 'v4-$scene-${brightness.name}');
        await tester.pumpWidget(const SizedBox());
        await tester.runAsync(c.flush);
        c.dispose();
        await tester.pump(const Duration(seconds: 5));
      });
    }
  }
}
