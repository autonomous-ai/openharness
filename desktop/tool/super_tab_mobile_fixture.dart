/// No-login review fixture for the Super Tab on mobile web.
///
/// Build for web with `--dart-define=HARNESS_TEST=true` and open with a
/// `?scenario=rich|empty|one|viewer|offline` and optional `?group=<id>` and
/// `?theme=dark` (Graphite; light Paper is the default) queries.
/// This is a review-only target: it renders the real [SuperTabView] against an
/// in-memory fake backend and never touches a real account or production data.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/web/shell/web_layout.dart';

import '../test/support/super_tab_fixture.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Let headless browsers address the rendered buttons by role/name.
  WidgetsBinding.instance.ensureSemantics();
  final query = Uri.base.queryParameters;
  final scenario = query['scenario'] ?? 'rich';
  // The design tokens follow the palette, not the Material theme: set both,
  // as the app's root does, or a light theme draws dark-palette ink.
  final palette = query['theme'] == 'dark'
      ? HarnessPalette.graphite
      : HarnessPalette.paper;
  grid.AppTheme.palette.value = palette;
  grid.AppTheme.brightness.value = palette.brightness;
  final server = _seed(scenario);
  final controller = server.controller(
    account: scenario == 'viewer' ? 'viewer' : 'owner',
  );
  await controller.refresh();
  if (scenario != 'offline') {
    final group = query['group'];
    if (group != null && controller.snapshot?.conversation(group) != null) {
      controller.select(group);
    }
    for (final id in _groupIds(scenario)) {
      await controller.loadMessages(id);
    }
  }
  runApp(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: palette.brightness),
      home: _Fixture(controller: controller),
    ),
  );
}

class _Fixture extends StatefulWidget {
  const _Fixture({required this.controller});
  final SuperTabController controller;

  @override
  State<_Fixture> createState() => _FixtureState();
}

class _FixtureState extends State<_Fixture> {
  @override
  void dispose() {
    widget.controller.dispose();
    super.dispose();
  }

  @override
  // Under the switch the web workspace turns on for the Swarm tab
  // (`webWorkspaceChrome`), and with New project as the workspace passes it;
  // a phone below the web's compact width, as the workspace does.
  Widget build(BuildContext context) => WorkspaceChromeScope(
    chrome: WorkspaceChrome(
      leadingWidth: (_) => 0,
      leading: (_, _) => const SizedBox.shrink(),
      compactBelow: kWebCompactBelow,
      superTabRecovers: true,
    ),
    child: Scaffold(
      body: SafeArea(
        child: SuperTabView(
          controller: widget.controller,
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          onNewProject: () {},
          machineName: (machineId) => machineId,
        ),
      ),
    ),
  );
}

final _now = DateTime.now();

ConversationServer _seed(String scenario) {
  final server = ConversationServer();
  if (scenario == 'offline') {
    server.failReads = true;
    return server;
  }

  final projects = scenario == 'empty'
      ? <Map<String, dynamic>>[]
      : scenario == 'rich'
      ? _projects()
      : _projects().take(1).toList();
  final conversations = _conversations(scenario);
  server.state..clear()..addAll({
    'version': 1,
    'id': 'tab',
    'name': _name(scenario),
    'ownerId': 'owner',
    'paused': false,
    'people': _people(),
    'agents': _agents(),
    'machines': _machines(),
    'invitations': scenario == 'rich' ? _invitations() : <Object>[],
    'conversations': conversations,
    'projects': projects,
  });
  server.revision = 200;
  server.messages.addAll(_messages(scenario));
  return server;
}

String _name(String scenario) => switch (scenario) {
  'empty' => 'Empty Workspace',
  'one' => 'One Project',
  'viewer' => 'Shared Review',
  _ => 'Harness Mobile Web Review',
};

List<Map<String, dynamic>> _people() => [
  {'id': 'owner', 'email': 'ken15@autonomous.ai', 'role': 'owner'},
  {'id': 'collab', 'email': 'diego@autonomous.ai', 'role': 'collaborator'},
  {'id': 'viewer', 'email': 'viewer@acme.test', 'role': 'viewer'},
];

List<Map<String, dynamic>> _projects() => [
  {
    'id': 'project-harness',
    'name': 'Harness Web Mobile Redesign',
    'ownerId': 'owner',
    'leadConversationId': 'lead',
    'visibility': 'public',
    'members': [
      {'id': 'owner', 'generation': 'g1'},
      {'id': 'collab', 'generation': 'g1'},
      {'id': 'viewer', 'generation': 'g1'},
    ],
    'updateMinutes': 5,
    'repository': {
      'machineId': 'm1',
      'cwd': '/Users/macbook/WorkPlace/Grid/autonomous-harness',
      'repositoryUrl': 'https://github.com/autonomous-ai/harness',
    },
  },
  {
    'id': 'project-platform',
    'name': 'A Very Long Mobile Application Project Title That Runs Past Any Row',
    'ownerId': 'collab',
    'leadConversationId': 'lead-platform',
    'visibility': 'private',
    'members': [
      {'id': 'owner', 'generation': 'g1'},
      {'id': 'collab', 'generation': 'g1'},
    ],
    'updateMinutes': 15,
  },
  {
    'id': 'project-empty',
    'name': 'On Hold',
    'ownerId': 'owner',
    'leadConversationId': 'lead-on-hold',
    'visibility': 'public',
    'members': [
      {'id': 'owner', 'generation': 'g1'},
    ],
    'updateMinutes': 10,
  },
];

List<Map<String, dynamic>> _agents() => [
  _agent('lead-agent', 'lead', 'Lead agent', 'Lead', 'm1', 'h-lead', 'owner', 'claude'),
  _agent('builder', 'project-harness', 'Builder', 'Lark', 'm1', 'h-builder', 'owner', 'claude'),
  _agent('designer', 'project-harness', 'Designer', 'Juno', 'm2', 'h-design', 'owner', 'codex'),
  _agent('qa', 'project-platform', 'QA', 'Pixel', 'm2', 'h-qa', 'collab', 'codex'),
  _agent('idle-lead', 'project-harness', 'Lead agent', 'Lead', 'm4', 'h-idle', 'owner', 'claude'),
  for (var i = 1; i <= 6; i++)
    _agent('swarm-$i', 'project-harness', 'Worker $i', 'Bot $i', 'm3', 'h-swarm-$i', 'owner', 'claude'),
];

Map<String, dynamic> _agent(
  String id,
  String projectId,
  String name,
  String displayName,
  String machineId,
  String harnessId,
  String contributorId,
  String engine,
) => {
  'id': id,
  'projectId': projectId,
  'name': name,
  'displayName': displayName,
  'machineId': machineId,
  'harnessId': harnessId,
  'contributorId': contributorId,
  'configuration': {
    'engine': engine,
    'model': engine == 'claude' ? 'sonnet' : 'gpt-5',
    'effort': 'high',
  },
};

List<Map<String, dynamic>> _machines() {
  final live = _now.millisecondsSinceEpoch - const Duration(seconds: 40).inMilliseconds;
  final offline = _now.millisecondsSinceEpoch - const Duration(days: 2).inMilliseconds;
  final many = _now.millisecondsSinceEpoch - const Duration(minutes: 1).inMilliseconds;
  return [
    _machine('m1', 'MacBook Pro (Local)', 'owner', ['claude', 'codex'], live, false),
    _machine('m2', "Diego's Mac", 'collab', ['claude', 'codex'], offline, false),
    _machine('m3', 'Build Farm', 'owner', ['claude', 'codex'], many, true),
  ];
}

Map<String, dynamic> _machine(
  String id,
  String name,
  String contributorId,
  List<String> engines,
  int receivedAt,
  bool paused,
) => {
  'machineId': id,
  'name': name,
  'contributorId': contributorId,
  'engines': engines,
  'paused': paused,
  'observation': {
    'receivedAt': receivedAt,
    'resources': {
      'cpuPercent': 47.0,
      'memoryTotalBytes': 68719476736,
      'memoryUsedBytes': 42949672960,
      'diskFreeBytes': 207844089856,
      'projectDiskFreeBytes': 207844089856,
      'projectDiskTotalBytes': 994662584320,
      'gpuPercent': 0,
    },
  },
};

List<Map<String, dynamic>> _invitations() => [
  {'id': 'invite-1', 'email': 'new.engineer@acme.test', 'role': 'collaborator'},
  {'id': 'invite-2', 'email': 'design.critic@acme.test', 'role': 'viewer'},
];

List<Map<String, dynamic>> _conversations(String scenario) {
  final all = <Map<String, dynamic>>[
    _conversation(
      'lead',
      'project-harness',
      0,
      'Lead',
      'lead-agent',
      ['lead-agent', 'builder', 'designer'],
      brief: 'Phase 1 mobile-web redesign of the Super Tab. Audit the current phone experience and propose a mobile-first flow before any production change.',
      checks: _checks(),
    ),
    _conversation('lead-platform', 'project-platform', 0, 'Lead', 'qa', ['qa'],
        brief: 'Mobile platform hardening.'),
    _conversation('lead-on-hold', 'project-empty', 0, 'Lead', null, [],
        brief: 'Paused until the release settles.'),
    _conversation('wg-working', 'project-harness', 1, 'Layout audit', 'builder', ['builder'],
        brief: 'Reproduce the mobile layout in a disposable fixture.',
        task: _task('Capture every Super Tab state on a phone.', 'Add a fixture and screenshots.', 'No production UI change.', ['desktop/tool']),
        assignment: _assignment('attempt-a', 'builder', 'working', 'Fixture built; capturing widths.'),
        checks: _checks()),
    _conversation('wg-needs-human', 'project-harness', 2, 'Owner decision', 'designer', ['designer'],
        brief: 'Pick a mobile navigation pattern before the mockup.',
        task: _task('Choose the bottom-sheet pattern.', 'Present two options.', 'Keep 44px targets.', ['web']),
        assignment: _assignment('attempt-b', 'designer', 'needs_human', 'Need a decision on the bottom sheet.'),
        checks: _checks()),
    _conversation('wg-blocked', 'project-harness', 3, 'Flutter web render', 'builder', ['builder'],
        brief: 'CanvasKit text measurement differs at 320px.',
        task: _task('Investigate CanvasKit text overflow.', 'Reproduce on 320px.', 'No production change.', ['desktop/lib/super_tabs']),
        assignment: _assignment('attempt-c', 'builder', 'blocked', 'Cannot reproduce outside a real device.'),
        checks: _checks()),
    _conversation('wg-review', 'project-harness', 4, 'Composer patch', 'builder', ['builder'],
        brief: 'A width fix for the composer.',
        task: _task('Review the composer width fix.', 'Send a small patch.', 'Do not regress desktop.', ['desktop/lib/super_tabs/view.dart']),
        assignment: _assignment('attempt-d', 'builder', 'review', 'Patch open for review.'),
        checks: _checks()),
    _conversation('wg-done', 'project-harness', 5, 'Accessibility pass', 'designer', ['designer'],
        brief: 'Touch targets on a phone.',
        task: _task('Audit touch targets.', 'List and fix below 44px.', 'Web only.', ['web']),
        assignment: _assignment('attempt-e', 'designer', 'done', 'All targets at or above 44px.'),
        checks: _checks()),
    _conversation('wg-stopped', 'project-harness', 6, 'Hold notice copy', 'builder', ['builder'],
        brief: 'Waiting-message wording.',
        task: _task('Tune the waiting message.', 'Shorten two lines.', 'Keep the reason.', ['backend']),
        assignment: _assignment('attempt-f', 'builder', 'stopped', 'Out of scope for this phase.'),
        checks: _checks()),
  ];
  if (scenario == 'empty') return <Map<String, dynamic>>[];
  if (scenario == 'one') return [all.first];
  return all;
}

Map<String, dynamic> _conversation(
  String id,
  String projectId,
  int number,
  String title,
  String? leadId,
  List<String> agentIds, {
  required String brief,
  Map<String, dynamic>? task,
  Map<String, dynamic>? assignment,
  List<Map<String, dynamic>> checks = const [],
}) => {
  'id': id,
  'projectId': projectId,
  'number': number == 0 ? null : number,
  'title': title,
  'leadId': leadId,
  'agentIds': agentIds,
  'archived': false,
  'brief': brief,
  'checks': checks,
  'assignment': assignment,
  'task': ?task,
  'lastMessageSequence': 100,
};

Map<String, dynamic> _task(String goal, String changes, String constraints, List<String> owns) =>
    {'goal': goal, 'changes': changes, 'constraints': constraints, 'owns': owns};

Map<String, dynamic> _assignment(String id, String agentId, String status, String result) =>
    {
      'id': id,
      'agentId': agentId,
      'status': status,
      'result': result,
      'configuration': {'engine': 'codex'},
      'execution': {'machineId': 'm1', 'harnessId': 'h-builder'},
    };

List<Map<String, dynamic>> _checks() => [
  {'id': 'check-1', 'description': 'Fixture covers every listed case.', 'independent': false, 'evidence': 'Screenshots at 320/375/390/1440px.', 'passedBy': 'owner'},
  {'id': 'check-2', 'description': 'Every problem has a severity and a why.', 'independent': true, 'evidence': null, 'passedBy': null},
  {'id': 'check-3', 'description': 'Mockup keeps 44px touch targets.', 'independent': false, 'evidence': 'Height audit in the review page.', 'passedBy': 'designer'},
];

List<String> _groupIds(String scenario) {
  if (scenario == 'empty' || scenario == 'one') return const ['lead'];
  return [
    'lead',
    'wg-working',
    'wg-needs-human',
    'wg-blocked',
    'wg-review',
    'wg-done',
    'wg-stopped',
  ];
}

List<Map<String, dynamic>> _messages(String scenario) {
  if (scenario == 'empty') return <Map<String, dynamic>>[];
  final lead = <Map<String, dynamic>>[];
  var seq = 1;
  void add(String conversationId, Map<String, dynamic> author, String text,
      {Map<String, dynamic>? source,
      List<Map<String, dynamic>> attachments = const [],
      List<Map<String, dynamic>> deliveries = const [],
      String? replyTo}) {
    lead.add({
      'id': '$conversationId-$seq',
      'conversationId': conversationId,
      'sequence': seq++,
      'text': text,
      'author': author,
      'source': source ?? const {},
      'attachments': attachments,
      'deliveries': deliveries,
      'replyTo': ?replyTo,
      'createdAt': _now.subtract(Duration(minutes: seq)).toIso8601String(),
    });
  }

  const leadAgent = {
    'kind': 'agent',
    'id': 'lead-agent',
    'name': 'Lead agent',
    'displayName': 'Lead',
  };
  const builder = {
    'kind': 'agent',
    'id': 'builder',
    'name': 'Builder',
    'displayName': 'Lark',
  };
  const owner = {'kind': 'person', 'id': 'owner', 'name': 'ken15@autonomous.ai'};

  add('lead', leadAgent,
      '**Phase 1 plan**\n\nHere is the mobile-web breakdown:\n\n- Build a no-login fixture from fake data\n- Capture every screen at **320 / 375 / 390 / 1440 px**\n- List concrete phone problems with a severity\n- Propose a mobile-first flow\n\n| Width | Target |\n| --- | --- |\n| Phone | 44px tap targets |\n| Desktop | unchanged |\n\nOpen https://github.com/autonomous-ai/harness/pull/1543');
  add('lead', builder,
      '```dart\nfinal width = MediaQuery.sizeOf(context).width;\nfinal narrow = width < 720;\nreturn narrow ? const PhoneLayout() : const DesktopLayout();\n```');
  add('lead', builder, 'Here is the fixture screenshot at 375px.',
      attachments: [
        {'id': 'att-img', 'name': 'fixture-375.png', 'mime': 'image/png', 'size': 64000, 'url': 'https://cdn.harness.local/fixture-375.png'},
      ]);
  add('lead', builder, 'And the release notes.',
      attachments: [
        {'id': 'att-pdf', 'name': 'mobile-audit.pdf', 'mime': 'application/pdf', 'size': 218000, 'url': 'https://cdn.harness.local/mobile-audit.pdf'},
      ]);
  add('lead', owner, 'Thanks, starting the 320px pass now.', replyTo: 'lead-1');
  add('lead', leadAgent,
      'Routed to Builder · Codex gpt-5 high · MacBook Pro (Local) — only candidate · "Full fake Super Tab data"',
      source: {
        'kind': 'route',
        'decisionId': 'decision-1',
        'via': 'only',
        'why': 'Flutter fixture with full fake data',
        'pick': {'id': 'builder', 'title': 'Builder · Codex gpt-5 high · MacBook Pro (Local)'},
        'alternatives': <Object>[],
      });
  // The newest own message carries a held delivery so the hold notice renders.
  add('lead', owner, 'Can you run the 320px pass now?', deliveries: [
    {
      'id': 'delivery-1',
      'agentId': 'idle-lead',
      'status': 'queued',
      'holdReason': 'team_waiting_idle',
      'holdSince': _now.subtract(const Duration(seconds: 35)).toIso8601String(),
    },
  ]);

  if (scenario == 'one') return lead;

  add('wg-working', builder,
      'Working through the fixture. All four widths render from one dataset.\n\nhttps://github.com/autonomous-ai/harness/pull/1543');
  add('wg-needs-human', builder,
      'Routed to Designer · Claude sonnet xhigh · Diego\'s Mac — only available candidate\n\nNeed a decision.',
      source: {
        'kind': 'route',
        'decisionId': 'decision-2',
        'via': 'only',
        'why': 'Bottom sheet pattern choice',
        'pick': {'id': 'designer', 'title': 'Designer · Claude sonnet xhigh · Diego\'s Mac'},
        'alternatives': <Object>[],
      });
  add('wg-blocked', builder, 'Blocked: cannot reproduce the overflow outside a real device.');
  add('wg-blocked', owner, 'I tried resending the patch.', deliveries: [
    {'id': 'delivery-fail', 'agentId': 'builder', 'status': 'uncertain'},
  ]);
  add('wg-review', builder, 'Reviewing the composer width patch.\n\nhttps://github.com/autonomous-ai/harness/pull/1543');
  add('wg-done', builder, 'Done. All targets measured at 44px.');
  add('wg-stopped', builder, 'Stopped: out of scope for this phase.');
  return lead;
}
