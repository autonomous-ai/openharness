/// No-login review fixture for every Quiet Swarm screen.
///
/// Build for web with `--dart-define=HARNESS_TEST=true -t
/// tool/super_tab_quiet_review.dart` and open with `?theme=dark` (Graphite;
/// light Paper is the default), or build with `--dart-define=REVIEW_THEME=dark`
/// where there is no address to read it from (Desktop). It renders the real [SuperTabView] against an
/// in-memory fake backend on made-up data, read by dee, and never touches a
/// real account or production data.
library;

import 'package:flutter/material.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import '../test/support/super_tab_fixture.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Let headless browsers address the rendered buttons by role/name.
  WidgetsBinding.instance.ensureSemantics();
  const theme = String.fromEnvironment('REVIEW_THEME');
  final palette = (Uri.base.queryParameters['theme'] ?? theme) == 'dark'
      ? HarnessPalette.graphite
      : HarnessPalette.paper;
  grid.AppTheme.palette.value = palette;
  grid.AppTheme.brightness.value = palette.brightness;
  final controller = _seed().controller(
    account: 'dee',
    initial: {'tabId': 'tab', 'accountId': 'dee', 'selectedId': 'lead'},
  );
  await controller.refresh();
  await controller.loadMessages('lead');
  runApp(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: palette.brightness),
      home: _Review(
        controller: controller,
        app: AppNotifier(
          config: AppConfig.dev,
          authSession: AuthSession(),
          configStore: null,
        )..status = AppStatus.authenticated,
      ),
    ),
  );
}

class _Review extends StatefulWidget {
  const _Review({required this.controller, required this.app});
  final SuperTabController controller;
  final AppNotifier app;

  @override
  State<_Review> createState() => _ReviewState();
}

class _ReviewState extends State<_Review> {
  @override
  void dispose() {
    widget.controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SuperTabView(
      controller: widget.controller,
      onInvite: () {},
      onAddAgent: (_) {},
      onOpenTerminal: (_) {},
      onNewProject: () {},
      onNewSwarm: () {},
      app: widget.app,
      machineName: (machineId) => machineId,
    ),
  );
}

final _now = DateTime.now();

ConversationServer _seed() {
  final server = ConversationServer()..threads = true;
  server.state
    ..clear()
    ..addAll({
      'version': 1,
      'id': 'tab',
      'name': 'autonomous.ai',
      'ownerId': 'ken15',
      'paused': false,
      'swarmBuddy': true,
      'people': [
        for (final (id, role) in [
          ('ken15', 'owner'),
          ('diego', 'collaborator'),
          ('dee', 'collaborator'),
          ('tony', 'collaborator'),
          ('scholes', 'collaborator'),
          ('phamngochuy.1989', 'collaborator'),
        ])
          {
            'id': id,
            'email': '$id@autonomous.ai',
            'role': role,
            if (id == 'dee') 'avatar': {'kind': 'preset', 'key': 'fox'},
          },
      ],
      'agents': [
        _agent('river', 'River', 'studio', role: 'lead'),
        {
          ..._agent('nico', 'Nico', 'studio'),
          'avatar': {'kind': 'preset', 'key': 'owl'},
        },
        _agent('theo', 'Theo', 'm9'),
        _agent('iris', 'Iris', 'studio', model: 'claude-sonnet-5-5'),
        for (final name in [
          'Atlas',
          'Sage',
          'Nova',
          'Finn',
          'Juno',
          'Lark',
          'Moss',
          'Teal',
          'Wren',
          'Echo',
        ])
          _agent(name.toLowerCase(), name, 'studio'),
      ],
      'machines': [
        _machine('studio', 'MACs-Mac-Studio', 'ken15'),
        _machine('m9', 'MacBooks-MacBook-Pro-9', 'scholes'),
        {
          ..._machine('m3', 'Mac 3', 'dee'),
          'observation': {
            'receivedAt': _now
                .subtract(const Duration(days: 1))
                .millisecondsSinceEpoch,
          },
        },
      ],
      'invitations': <Object>[],
      'projects': [
        {
          'id': 'oh',
          'name': 'openharness',
          'ownerId': 'ken15',
          'leadConversationId': 'lead',
          'visibility': 'public',
          'members': <Object>[],
          'updateMinutes': 30,
        },
        for (final name in ['computer', 'lamp', 'physical-router', 'spaceship'])
          {
            'id': name,
            'name': name,
            'ownerId': 'ken15',
            'leadConversationId': 'lead-$name',
            'visibility': 'public',
            'members': <Object>[],
            'updateMinutes': 30,
          },
      ],
      'conversations': [
        for (final name in ['computer', 'lamp', 'physical-router', 'spaceship'])
          {
            ..._conversation('lead-$name', name, lead: 'river', agent: 'river'),
            'projectId': name,
          },
        _conversation('lead', 'openharness', lead: 'river', agent: 'river'),
        _conversation(
          't-nico',
          'W1 ships alone or waits?',
          agent: 'nico',
          status: 'needs_human',
        ),
        _conversation('t-theo', 'Windows credential fix', agent: 'theo'),
        _conversation('t-iris', 'Activity read fix', agent: 'iris'),
        {
          ..._conversation(
            't-atlas',
            'Closed agents leave the list',
            agent: 'atlas',
            status: 'done',
          ),
          'shippedAt': _now
              .subtract(const Duration(minutes: 40))
              .millisecondsSinceEpoch,
        },
        {
          ..._conversation(
            't-sage',
            'Commits read Harness by Autonomous',
            agent: 'sage',
            status: 'done',
          ),
          'shippedAt': _now
              .subtract(const Duration(minutes: 20))
              .millisecondsSinceEpoch,
        },
      ],
    });
  server.revision = 200;
  server.leaderboard = {
    'projectId': 'oh',
    'week': DateTime.utc(2026, 10, 26).millisecondsSinceEpoch,
    'period': {'name': '7d', 'start': 1, 'end': 2},
    'allProjects': true,
    'people': [
      {
        ..._score('ken15', 424, 1, 111, 40, 411),
        'prevWeekPoints': 380,
        'details': {
          'shipped': [
            {
              'title': 'Closed agents leave the list',
              'prUrl': 'https://github.com/autonomous-ai/openharness/pull/2601',
            },
            {
              'title': 'Prod DB profile: five slow reads',
              'prUrl': 'https://github.com/autonomous-ai/openharness/pull/2610',
            },
          ],
          'unblocked': [
            {
              'title': 'W1 ships alone or waits?',
              'conversationId': 't-nico',
              'kind': 'decision',
              'waitedMinutes': 42,
            },
          ],
          'lent': [
            {'machineName': 'MACs-Mac-Studio.local', 'busyHours': 411},
          ],
        },
      },
      _score('diego', 394, 2, 98, 31, 260),
      _score('dee', 339, 3, 87, 22, 120),
      _score('tony', 239, 4, 54, 19, 88),
      _score('scholes', 210, 5, 49, 12, 140),
      _score('phamngochuy.1989', 48, 6, 9, 4, 36),
    ],
    'waiting': {'total': 0, 'people': <Object>[]},
    'byModel': [
      for (final (i, model, points) in [
        (1, 'claude-opus-5-5', 62),
        (2, 'claude-sonnet-5-5', 21),
        (3, 'gpt-6.1-sol', 11),
        (4, 'deepseek-v4.1', 6),
      ])
        {
          'engine': i == 3 ? 'codex' : 'claude',
          'model': model,
          'effort': 'high',
          'points': points,
          'rank': i,
          'attempts': points,
          'shipped': {'count': points},
          'firstReview': {'reviewed': points, 'passed': points},
          'reviews': points,
        },
    ],
  };
  var sequence = 1;
  void say(String author, String text, Duration ago, {bool agent = false}) =>
      server.messages.add({
        'id': 'lead-$sequence',
        'conversationId': 'lead',
        'sequence': sequence++,
        'text': text,
        'author': agent
            ? {'kind': 'agent', 'id': author, 'name': author}
            : {'kind': 'person', 'id': author, 'name': '$author@autonomous.ai'},
        'source': const <String, Object>{},
        'attachments': const <Object>[],
        'deliveries': const <Object>[],
        'createdAt': _now.subtract(ago).toIso8601String(),
      });
  void line(String task, String title, String state, {String? answerFor}) =>
      server.messages.add({
        'id': 'lead-$sequence',
        'conversationId': 'lead',
        'sequence': sequence++,
        'text': '$title · $state',
        'author': {'kind': 'agent', 'id': 'river', 'name': 'River'},
        'source': {
          'kind': 'task-line',
          'taskId': task,
          'title': title,
          'state': state,
          'answerFor': ?answerFor,
        },
        'attachments': const <Object>[],
        'deliveries': const <Object>[],
        'createdAt': _now
            .subtract(const Duration(minutes: 50))
            .toIso8601String(),
      });
  say(
    'ken15',
    'Prod DB profile: five slow reads to fix.',
    const Duration(hours: 2),
  );
  line('t-atlas', 'Closed agents leave the list', 'shipped');
  line('t-sage', 'Commits read Harness by Autonomous', 'done');
  line('t-theo', 'Windows credential fix', 'review');
  line('t-iris', 'Activity read fix', 'working');
  line('t-plan', 'Phone Activity opens the right message', 'planned');
  line('t-ready', 'Machines list sorts by owner', 'ready');
  line('t-nico', 'W1 ships alone or waits?', 'waiting', answerFor: 'dee');
  server.messages.add({
    'id': 'lead-$sequence',
    'conversationId': 'lead',
    'thread': 'lead-$sequence',
    'sequence': sequence++,
    'text': 'Buddy proposal\n\nGoal: Activity read fix',
    'author': {'kind': 'agent', 'id': 'river', 'name': 'River'},
    'source': const {'kind': 'buddy-proposal', 'personId': 'diego'},
    'attachments': const <Object>[],
    'deliveries': const <Object>[],
    'createdAt': _now.subtract(const Duration(minutes: 45)).toIso8601String(),
  });
  say(
    'river',
    'Three fixes are on main.',
    const Duration(minutes: 32),
    agent: true,
  );
  final mentioned = sequence - 1;
  // A sender's run of lines, and a thread with replies (task #2426 review).
  for (final (text, ago) in [
    ('Nico here: the read fix is on its branch.', 12),
    ('Tests pass locally.', 11),
    ('Opening the PR now.', 10),
  ]) {
    say('nico', text, Duration(minutes: ago), agent: true);
  }
  final root = 'lead-$sequence';
  server.messages.add({
    'id': root,
    'conversationId': 'lead',
    'thread': root,
    'sequence': sequence++,
    'text': 'Which avatar shape do we keep in threads?',
    'author': {'kind': 'person', 'id': 'tony', 'name': 'tony@autonomous.ai'},
    'source': const <String, Object>{},
    'attachments': const <Object>[],
    'deliveries': const <Object>[],
    'createdAt': _now.subtract(const Duration(minutes: 8)).toIso8601String(),
  });
  for (final (who, text, agent, ago) in [
    ('nico', 'The same rounded square as the chat.', true, 7),
    ('dee', 'Agreed.', false, 6),
    ('dee', 'Same spacing too.', false, 6),
    ('tony', 'Thanks, both.', false, 5),
  ]) {
    server.messages.add({
      'id': 'lead-$sequence',
      'conversationId': 'lead',
      'thread': root,
      'sequence': sequence++,
      'text': text,
      'author': agent
          ? {'kind': 'agent', 'id': who, 'name': who}
          : {'kind': 'person', 'id': who, 'name': '$who@autonomous.ai'},
      'source': const <String, Object>{},
      'attachments': const <Object>[],
      'deliveries': const <Object>[],
      'createdAt': _now.subtract(Duration(minutes: ago)).toIso8601String(),
    });
  }
  say('dee', "ok i like a. let's make it perfect.", const Duration(minutes: 2));
  say('dee', 'One more pass on the spacing.', const Duration(minutes: 1));
  for (final (who, text) in [
    ('theo', 'Ready: PR #2605.'),
    ('river', 'With fixes: one Important.'),
    ('theo', 'Fixed at 98bcfd21c.'),
  ]) {
    server.messages.add({
      'id': 't-theo-$sequence',
      'conversationId': 't-theo',
      'sequence': sequence++,
      'text': text,
      'author': {'kind': 'agent', 'id': who, 'name': who},
      'source': const <String, Object>{},
      'attachments': const <Object>[],
      'deliveries': const <Object>[],
      'createdAt': _now.subtract(const Duration(minutes: 20)).toIso8601String(),
    });
  }
  for (final g in (server.state['conversations'] as List).cast<Map>()) {
    final own = server.messages.where((m) => m['conversationId'] == g['id']);
    if (own.isNotEmpty) {
      g['lastMessageSequence'] = own
          .map((m) => m['sequence'] as int)
          .reduce((a, b) => a > b ? a : b);
    }
  }
  server.ask(['W1 ships alone or waits?'], projectId: 'oh');
  server.tag(
    'lead-$mentioned',
    text: 'River mentioned you',
    createdAt: _now
        .subtract(const Duration(minutes: 32))
        .toUtc()
        .toIso8601String(),
    messageSequence: mentioned,
  );
  server.mentions.last['projectId'] = 'oh';
  server.mentions.last['projectName'] = 'openharness';
  server.followedThreads = {
    'unread': [
      for (final (root, text, count) in [
        ('t-theo', 'Windows credential fix', 3),
        ('t-iris', 'Prod DB profile', 1),
      ])
        {
          'conversationId': root,
          'rootId': root,
          'root': {
            'id': root,
            'sequence': 1,
            'author': {'kind': 'agent', 'id': 'river', 'name': 'River'},
            'text': text,
            'createdAt': _now.toUtc().toIso8601String(),
            'attachments': 0,
          },
          'lastReplyAt': _now.toUtc().toIso8601String(),
          'lastReplySequence': 2,
          'lastReplier': {'kind': 'agent', 'id': 'river', 'name': 'River'},
          'unreadReplies': count,
          'follow': null,
        },
    ],
    'read': <Object>[],
    'more': false,
  };
  return server;
}

Map<String, dynamic> _agent(
  String id,
  String name,
  String machineId, {
  String? role,
  String model = 'claude-opus-5-5',
}) => {
  'id': id,
  'projectId': 'oh',
  'name': name,
  'displayName': name,
  'machineId': machineId,
  'harnessId': 'h-$id',
  'contributorId': 'ken15',
  'role': ?role,
  'configuration': {'engine': 'claude', 'model': model, 'effort': 'high'},
};

Map<String, dynamic> _machine(String id, String name, String owner) => {
  'machineId': id,
  'name': name,
  'contributorId': owner,
  'engines': ['claude', 'codex'],
  'paused': false,
  'observation': {'receivedAt': _now.millisecondsSinceEpoch},
};

Map<String, dynamic> _conversation(
  String id,
  String title, {
  required String agent,
  String? lead,
  String status = 'working',
}) => {
  'id': id,
  'projectId': 'oh',
  'title': title,
  'leadId': lead ?? 'river',
  'agentIds': [agent],
  'archived': false,
  'brief': title,
  'checks': <Object>[],
  'assignment': {
    'id': 'a-$id',
    'agentId': agent,
    'status': status,
    'progressAt': _now
        .subtract(const Duration(minutes: 6))
        .millisecondsSinceEpoch,
    // Held: its own last post vouches for it until then.
    'leaseUntil': _now.add(const Duration(hours: 2)).millisecondsSinceEpoch,
  },
  'lastMessageSequence': switch (id) {
    'lead' => 11,
    't-theo' => 14,
    _ => 0,
  },
};

Map<String, dynamic> _score(
  String id,
  int points,
  int rank,
  int shipped,
  int unblocked,
  int hours,
) => {
  'personId': id,
  'points': points,
  'rank': rank,
  'medal': null,
  'shipped': {'count': shipped, 'medianAskToShipMs': 7200000},
  'unblocked': {'count': unblocked, 'agentMs': 0, 'medianAnswerMs': 600000},
  'lent': {'machines': 1, 'agentMs': hours * 3600000},
  'streakDays': 3,
};
