import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/personal_lead.dart';
import 'package:harness/super_tabs/personal_projects.dart';
import 'package:harness/super_tabs/swarm_switcher.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/super_tab_fixture.dart';

// Huy, 11-04 (task #2633): in his Personal Swarm, a message in # Games, which
// had no Lead, said "Not sent, this chat has no Lead". Now Desktop starts the
// project's PM on his own computer, in the repo's folder when the project has
// a repo, and opens the PM's own chat at once (Swarm v4: only agents post in
// the channel), where what he sends waits for it on the server.

Agent _agent(String id, {String? remote, required String cwd}) => Agent(
  id: id,
  name: 'Agent $id',
  engine: 'codex',
  terminalAvailable: true,
  project: AgentProject(
    name: cwd.split('/').last,
    cwd: cwd,
    root: remote == null ? null : cwd,
    remote: remote,
  ),
);

var _paneIds = 7000;

/// One desk tab of the person's on this Mac with one pane: in a checkout of
/// [remote], or in a plain folder beside a project made by hand.
void _desk(SuperTabLaunchFixture f, {String? remote, required String cwd}) {
  f.app.machineStates['m']!.agents = [_agent('n1', remote: remote, cwd: cwd)];
  f.app.swarms.add(
    Swarm(id: 'desk', name: 'Games')
      ..panes.add(TerminalPane(id: _paneIds++, machineId: 'm', agentId: 'n1')),
  );
  if (remote == null) _byHand(f, 'Games');
}

/// A project the person made by hand, [name]: a pane with no repo is in no project (Swarm v4), so a project with no repo
/// is one made so.
void _byHand(SuperTabLaunchFixture f, String name) {
  final server = f.connection.server.state;
  (server['projects'] ??= [projectFixture('lead', 'Personal', 'lead')] as List)
      .add(
        projectFixture('by-hand', name, 'chat-by-hand', visibility: 'private'),
      );
  (server['conversations'] as List).add({
    ...conversationFixture('chat-by-hand', 'Lead'),
    'projectId': 'by-hand',
  });
}

/// The fixture's Swarm, made the person's Personal one, with its projects made
/// for the desk; [personal] false leaves it a Team Swarm.
Future<SuperTabController> _swarm(
  SuperTabLaunchFixture f, {
  bool personal = true,
}) async {
  for (final state in f.app.machineStates.values) {
    state.localOnly = true;
  }
  f.connection.server.state
    ..['name'] = personal ? 'Personal' : 'Team'
    ..['ownerId'] = 'owner'
    ..['people'] = [
      {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
      if (!personal)
        {'id': 'peer', 'email': 'peer@example.com', 'role': 'collaborator'},
    ];
  if (personal) {
    await f.app.superTabs.storage.write('super_tab.personal.owner', tabId);
  }
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Personal');
  PersonalSwarm.of(f.app).id;
  for (var i = 0; i < 20; i++) {
    await Future<void>.microtask(() {});
  }
  final c = await f.app.superTabs.open(tabId);
  await c.refresh();
  if (personal) await PersonalProjects.of(f.app).sync(c);
  return c;
}

/// The project chat the desk's pane belongs to.
String _games(SuperTabController c) =>
    c.snapshot!.projects.firstWhere((p) => p.id != 'lead').leadConversationId;

List<Map> _commands(SuperTabLaunchFixture f, String type) => [
  for (final post in f.connection.server.posts)
    if ((post['command'] as Map?)?['type'] == type) post['command'] as Map,
];

Map<String, dynamic> _create(SuperTabLaunchFixture f) =>
    f.connection.calls.singleWhere((c) => c.$1 == 'agent_create').$2;

/// The PM's own chat its start opened (backend pmChat.ts), as the fake server keeps it.
String _pmChat(SuperTabLaunchFixture f) =>
    (f.connection.server.state['conversations'] as List)
            .cast<Map>()
            .singleWhere(
              (g) =>
                  g['kind'] == 'agent-chat' && g['title'] == 'Product Manager',
            )['id']
        as String;

void main() {
  test('Start PM in a repo project starts one in the repo\'s folder on this '
      'Mac, joins it as Lead and opens its own chat', () async {
    final f = SuperTabLaunchFixture();
    _desk(f, remote: 'git@github.com:huy/games.git', cwd: '/Users/huy/games');
    final c = await _swarm(f);
    final games = _games(c);
    final starter = PersonalLeadStarter.of(f.app);
    expect(starter.wants(c, games), isTrue);
    await starter.start(c, games);
    expect(_commands(f, 'lead.claim').single['machineId'], 'm');
    // The PM's own chat, which the claim answered, is open; nothing went to
    // the channel.
    final chat = _pmChat(f);
    expect(c.selectedId, chat);
    expect(_commands(f, 'message.send'), isEmpty);
    final create = _create(f);
    expect(create['cwd'], '/Users/huy/games');
    expect(create['swarmRole'], 'lead');
    expect(create['engine'], 'claude');
    // Swarm v3 (task #4215): no dialog, so no mode: the PM starts with its
    // owner's own permission settings.
    expect(create.containsKey('permissionMode'), isFalse);
    expect(create['bypassPermission'], isFalse);
    final join = f.connection.joins.single['command'] as Map;
    expect(join['lead'], isTrue);
    expect(join['conversationId'], games);
    // What the person sends in the chat is the server's to deliver: the join
    // carries none.
    expect(join.containsKey('initialMessage'), isFalse);
    expect(starter.statusOf(c, games)?.failed, isFalse);
  });

  test('Start PM in a project with no repo starts it in a new folder of the '
      'Harness projects folder', () async {
    // This computer makes the folder itself: a fixture one, never the disk's.
    final asked = <ProjectFolderRequest>[];
    final f = SuperTabLaunchFixture(
      prepareFolder: (request) async {
        asked.add(request);
        return '/fixture/Harness/${request.folderName}';
      },
    );
    _desk(f, cwd: '/Users/huy/scratch');
    final c = await _swarm(f);
    final games = _games(c);
    await PersonalLeadStarter.of(f.app).start(c, games);
    // Named after the project, numbered past a folder of that name already
    // there rather than refused, as a suggested name is.
    expect(asked.single.folderName, 'Games');
    expect(asked.single.isGenerated, isTrue);
    expect(_create(f)['cwd'], '/fixture/Harness/Games');
    expect((f.connection.joins.single['command'] as Map)['lead'], isTrue);
  });

  test('a failed start says why, and starts again on the next press', () async {
    final f = SuperTabLaunchFixture();
    _desk(f, remote: 'https://github.com/huy/games', cwd: '/Users/huy/games');
    final c = await _swarm(f);
    final games = _games(c);
    final starter = PersonalLeadStarter.of(f.app);
    f.connection
      ..failCreation = true
      ..failCreationCode = 'ENGINE_LAUNCH_REFUSED';
    await starter.start(c, games);
    final status = starter.statusOf(c, games)!;
    expect(status.failed, isTrue);
    expect(status.reason, 'Fixture engine unavailable');
    expect(f.connection.joins, isEmpty);
    f.connection.failCreation = false;
    await starter.start(c, games);
    expect((f.connection.joins.single['command'] as Map)['lead'], isTrue);
  });

  test('two quick presses start one Lead', () async {
    final f = SuperTabLaunchFixture();
    _desk(f, remote: 'https://github.com/huy/games', cwd: '/Users/huy/games');
    final c = await _swarm(f);
    final games = _games(c);
    final starter = PersonalLeadStarter.of(f.app);
    await Future.wait([starter.start(c, games), starter.start(c, games)]);
    expect(_commands(f, 'lead.claim'), hasLength(1));
    expect(
      f.connection.calls.where((call) => call.$1 == 'agent_create'),
      hasLength(1),
    );
  });

  test('a start another of the person\'s machines claimed starts nothing '
      'here and shows as starting', () async {
    final f = SuperTabLaunchFixture();
    _desk(f, remote: 'https://github.com/huy/games', cwd: '/Users/huy/games');
    final c = await _swarm(f);
    final games = _games(c);
    final project = (f.connection.server.state['projects'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((p) => p['leadConversationId'] == games);
    project['leadClaim'] = {'machineId': 'laptop'};
    final starter = PersonalLeadStarter.of(f.app);
    await starter.start(c, games);
    expect(
      f.connection.calls.where((call) => call.$1 == 'agent_create'),
      isEmpty,
    );
    expect(starter.statusOf(c, games)?.failed, isFalse);
  });

  // Task #3449 (anh Dee, 11-05): a PM was seen on Sonnet medium. A Personal
  // project's Lead, started on this Mac, runs Claude on Opus at xhigh as flags
  // of its launch; a Codex Lead takes no Claude flags.
  test(
    'a Claude Lead starts on Opus at xhigh, a Codex Lead with no model flags',
    () async {
      final f = SuperTabLaunchFixture();
      _desk(f, remote: 'https://github.com/huy/games', cwd: '/Users/huy/games');
      final c = await _swarm(f);
      final games = _games(c);
      await PersonalLeadStarter.of(f.app).start(c, games);
      expect(_create(f)['engine'], 'claude');
      expect(_create(f)['model'], 'opus');
      expect(_create(f)['effort'], 'xhigh');

      final codex = SuperTabLaunchFixture();
      _desk(
        codex,
        remote: 'https://github.com/huy/games',
        cwd: '/Users/huy/games',
      );
      final other = await _swarm(codex);
      // Claude Code isn't on this Mac, so the PM is a Codex one.
      codex.app.stateOf('m')!.engines.replace(const [
        EngineAvailability(engine: 'codex', installed: true),
      ]);
      await PersonalLeadStarter.of(codex.app).start(other, _games(other));
      expect(_create(codex)['engine'], 'codex');
      expect(_create(codex).containsKey('model'), isFalse);
      expect(_create(codex).containsKey('effort'), isFalse);
    },
  );

  test('a Team Swarm starts no Lead', () async {
    final f = SuperTabLaunchFixture();
    _desk(f, remote: 'https://github.com/huy/games', cwd: '/Users/huy/games');
    final c = await _swarm(f, personal: false);
    expect(PersonalLeadStarter.of(f.app).wants(c, 'lead'), isFalse);
  });
}
