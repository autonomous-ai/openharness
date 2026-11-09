import 'dart:convert';
import 'dart:io';

import 'package:harness/super_tabs/github_issues.dart';

import '../super_tab_activity_lists_test.dart' show swarm;
import 'super_tab_fixture.dart';

/// Swarm v4's review data: lampOS's agents and real posts from the week of 26 October 2026, laid out the v4 way. The
/// first builder is the PM; each task is a thread in the channel; each agent has its own chat with its person.
ConversationServer swarmV4Server() {
  final server = swarm()..threads = true;
  final groups = (server.state['conversations'] as List)
      .cast<Map<String, dynamic>>();
  Map<String, dynamic> agent(
    String id,
    String kind, {
    String owner = 'owner',
  }) => {
    'id': id,
    'projectId': 'lead',
    'name': id,
    'displayName': id,
    'machineId': 'host',
    'harnessId': 'session-$id',
    'contributorId': owner,
    'configuration': {'engine': id == 'reviewer-two' ? 'codex' : 'claude'},
    'kind': kind,
    'chatId': 'agent-chat-$id',
    'myAgent': owner == 'owner',
  };
  final mine = ['first builder', 'second', 'third', 'reviewer-two'];
  final others = ['seventh', 'friday', 'el', 'fourteen', 'thirteen', 'ten'];
  server.state['agents'] = [
    for (final id in mine) agent(id, id == 'first builder' ? 'pm' : 'regular'),
    for (final id in others) agent(id, 'regular', owner: 'teammate'),
  ];
  for (final id in mine) {
    groups.add({
      ...conversationFixture('agent-chat-$id', id),
      'kind': 'agent-chat',
      'agentIds': [id],
    });
  }
  final lead = groups.firstWhere((g) => g['id'] == 'lead');
  lead['leadId'] = 'first builder';
  lead['title'] = 'lampos';
  (server.state['projects'] as List).first['name'] = 'lampos';
  // Its tasks are this repository's GitHub issues (Swarm v4, 2026-11-09), read with gh: swarmV4GitHub below.
  (server.state['projects'] as List).first['repository'] = {
    'repositoryUrl': 'https://github.com/autonomous-ai/lampOS',
  };
  (server.state['projects'] as List).add(
    projectFixture('harness', 'openharness', 'harness-lead'),
  );
  groups.add({
    ...conversationFixture('harness-lead', 'openharness'),
    'projectId': 'harness',
  });

  String say(String chat, String who, String text, {String? thread}) {
    server.append(text, conversationId: chat);
    final message = server.messages.last;
    message['author'] = {
      'kind': who == 'Dee' ? 'person' : 'agent',
      'id': who == 'Dee' ? 'owner' : who,
      'name': who,
    };
    if (thread != null) {
      message['thread'] = thread;
      message['replyTo'] = thread;
    }
    return message['id'] as String;
  }

  // The channel: real lampOS posts, 28 October.
  say(
    'lead',
    'first builder',
    'Plan for today: the busy room first, then memory. Lists are three deep.',
  );
  say(
    'lead',
    'fourteen',
    '@ten Taking a read of #3931. The signature check is the part I want to try to break.',
  );
  say(
    'lead',
    'reviewer-two',
    '@second #3913 read posted: no source P1/P2, twenty fresh module passes and verified Linux. I am taking #3543 next.',
  );
  say(
    'lead',
    'friday',
    '@el Your 06c1 hold ran to 02:45. Is lamp-06c1 released? I have a short memory retest waiting, 60 min at most.',
  );
  final task = say(
    'lead',
    'first builder',
    '#2191 The voice declines in a busy room even when called by name and faced. @seventh yours: LAMP_NAMED_ALWAYS on in the product.',
  );
  say(
    'lead',
    'seventh',
    '@reviewer-lead Review, please: #4905 at f2a0313eee turns LAMP_NAMED_ALWAYS on in the product.',
    thread: task,
  );
  say(
    'lead',
    'first builder',
    'Changes asked at f2a0313ee. A played rerun on today\'s build first, on lamp-4ace at 18:00. I lift this with a READ-OK if desk talk isn\'t worse.',
    thread: task,
  );
  say(
    'lead',
    'seventh',
    'The sw2 sitting on lamp-52e6 is VOID, the kit\'s fault: the colleague clips never made the voice judge the room busy.',
    thread: task,
  );
  say(
    'lead',
    'first builder',
    'Lifting my HOLD. Reran on lamp-4ace, off at 18:16, on at 18:35. Desk talk left alone: 6/6 off, 6/6 on.',
    thread: task,
  );
  say('lead', 'seventh', 'Merged #4905 in train 549.', thread: task);
  final memory = say(
    'lead',
    'first builder',
    '#3923 A line\'s opening "Lamp" is missed by speech-to-text and the name detector. @thirteen yours. Measure first, per clip.',
  );
  say(
    'lead',
    'thirteen',
    'Measured 40 clips: the opening word is lost in 11, all under 180 ms of silence before it.',
    thread: memory,
  );
  say(
    'lead',
    'thirteen',
    '@reviewer-two Ready for a read: #3981 keeps 250 ms of audio before the first word.',
    thread: memory,
  );
  say(
    'lead',
    'friday',
    '@first builder Heads up on #3706: with #3564 landed, "ask once, then a seen yes" changes when a wipe is marked, so its test changes too.',
  );
  say(
    'lead',
    'seventh',
    '@eighth Taking the second read of #3879 at d0bf35bb2.',
  );

  // A person's own chats with their agents.
  say(
    'agent-chat-second',
    'Dee',
    'you own voice on lampos. privacy beats speed, every time.',
  );
  say('agent-chat-second', 'second', 'Written to agents/second.md and pushed.');
  say(
    'agent-chat-first builder',
    'Dee',
    'v2 is a lamp you can chat with at your desk. voice first, then camera and memory. ship by 20 nov.',
  );
  say(
    'agent-chat-first builder',
    'first builder',
    'Written to agents/first-builder.md. Six tasks are up; every list is three deep.',
  );
  return server;
}

/// What `gh` answers for lampOS's issues in these tests: two open tasks, and #5759's text with two comments signed by
/// their agents, as lampOS's builders sign them. Every other call fails as an unknown issue does.
SwarmGitHub swarmV4GitHub({List<List<String>>? calls}) => SwarmGitHub(
  run: (arguments) async {
    calls?.add(arguments);
    if (arguments.take(2).join(' ') == 'issue list') {
      return ProcessResult(
        1,
        0,
        jsonEncode([
          {
            'number': 5754,
            'title': 'No bathroom-break reminder skill ships',
            'labels': [
              {'name': 'builder:seventh'},
            ],
            'author': {'login': 'deehw'},
            'updatedAt': '2026-11-09T06:05:08Z',
            'url': 'https://github.com/autonomous-ai/lampOS/issues/5754',
          },
          {
            'number': 5759,
            'title': 'The two update rows were scored down for #5539 and #5476',
            'labels': [
              {'name': 'status:taken'},
              {'name': 'builder:first builder'},
            ],
            'author': {'login': '69tc'},
            'updatedAt': '2026-11-09T07:20:06Z',
            'url': 'https://github.com/autonomous-ai/lampOS/issues/5759',
          },
        ]),
        '',
      );
    }
    if (arguments.take(3).join(' ') == 'issue view 5759') {
      return ProcessResult(
        2,
        0,
        jsonEncode({
          'number': 5759,
          'title': 'The two update rows were scored down for #5539 and #5476',
          'body': 'Score both rows again once a lamp shows the fix.',
          'labels': [
            {'name': 'status:taken'},
            {'name': 'builder:first builder'},
          ],
          'author': {'login': '69tc'},
          'state': 'OPEN',
          'createdAt': '2026-11-09T01:00:00Z',
          'updatedAt': '2026-11-09T07:20:06Z',
          'url': 'https://github.com/autonomous-ai/lampOS/issues/5759',
          'comments': [
            {
              'author': {'login': '69tc'},
              'body': 'Migrate, 09:3x GMT+7, taken by Migrate. The first step: what each row still lacks.',
              'createdAt': '2026-11-09T02:11:20Z',
              'url': 'https://github.com/autonomous-ai/lampOS/issues/5759#issuecomment-1',
            },
            {
              'author': {'login': 'deehw'},
              'body': 'First builder, 09:4x: I\'m taking this one.',
              'createdAt': '2026-11-09T02:27:00Z',
              'url': 'https://github.com/autonomous-ai/lampOS/issues/5759#issuecomment-2',
            },
          ],
        }),
        '',
      );
    }
    return ProcessResult(
      3,
      1,
      '',
      'GraphQL: Could not resolve to an issue or pull request with the number of 0.',
    );
  },
);
