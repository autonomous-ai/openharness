import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/engine_availability.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/swarm/swarm_computers.dart';
import 'package:harness_mobile/swarm/swarm_lead_start.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import '../viewer_app_fixture.dart';

/// The app's own computers start a Personal project's Lead (task #2941): the
/// person's connected computers with the engines signed in there and the
/// folders of the repos their agents work in, and the start itself, asked of
/// the computer as Desktop asks it.
void main() {
  Map<String, dynamic> created(Map<String, dynamic> payload, String id) => {
    'creationId': payload['creationId'],
    'state': 'created',
    'agent': agentJson(
      id,
      extra: {
        'project': {
          'name': 'games',
          'cwd': payload['cwd'] ?? '/Users/me/Harness/games',
          'remote': payload['cwd'] == null ? null : 'github.com/acme/games',
        },
      },
    ),
  };

  EngineAvailability engine(String id, {bool? signedIn = true}) =>
      EngineAvailability(engine: id, installed: true, signedIn: signedIn);

  test('leadComputers lists the person\'s own connected computers with their '
      'signed-in engines and repo folders', () async {
    final rig = await signedInWith({'m': [], 'n': []});
    addTearDown(rig.app.dispose);
    rig.conn('m').answers['agents_list'] = (_) => {
      'agents': [
        agentJson(
          'a1',
          extra: {
            'project': {
              'name': 'games',
              'cwd': '/Users/me/games/web',
              'root': '/Users/me/games',
              'remote': 'github.com/Acme/Games',
            },
          },
        ),
      ],
    };
    await rig.app.syncAgentsForTest('m');
    rig.app.stateOf('m')!.engines.replace([
      engine('claude'),
      engine('codex', signedIn: false),
    ]);
    rig.app.stateOf('n')!.engines.replace([engine('codex')]);
    final computers = AppSwarmComputers(rig.app);
    addTearDown(computers.dispose);

    final listed = {for (final c in computers.leadComputers) c.id: c};
    expect(listed.keys, {'m', 'n'});
    expect(listed['m']!.engines, ['claude']);
    expect(listed['m']!.folders, {'github.com/acme/games': '/Users/me/games'});
    expect(listed['n']!.engines, ['codex']);
    expect(listed['n']!.folders, isEmpty);
  });

  test(
    'a computer not connected, shared, or a Team account is left out',
    () async {
      final rig = await signedInWith({'m': [], 't': [], 's': []});
      addTearDown(rig.app.dispose);
      rig.app.stateOf('t')!.machine = Machine(
        machineId: 't',
        authMode: MachineAuthMode.remote,
        name: 'Team',
        status: 'online',
        sessionKind: 'team',
      );
      rig.app.stateOf('s')!.machine = Machine(
        machineId: 's',
        authMode: MachineAuthMode.remote,
        name: 'Shared',
        status: 'online',
        shared: true,
      );
      final computers = AppSwarmComputers(rig.app);
      addTearDown(computers.dispose);
      expect([for (final c in computers.leadComputers) c.id], ['m']);
      // An engine list not read yet offers Claude Code, as Desktop does.
      expect(computers.leadComputers.single.engines, ['claude']);
    },
  );

  test('startLead creates the Lead in the repo\'s folder and answers what it '
      'started', () async {
    final rig = await signedInWith({'m': []});
    addTearDown(rig.app.dispose);
    rig.conn('m').answers['agent_create'] = (p) => created(p, 'lead');
    final computers = AppSwarmComputers(rig.app);
    addTearDown(computers.dispose);

    final started = await computers.startLead('m', (
      engine: 'claude',
      folder: '/Users/me/games',
      projectName: 'games',
      prompt: 'Harness Swarm agent. You are the Lead.',
      skillMode: 'default',
    ));

    expect(started.harnessId, 'lead');
    expect(started.cwd, '/Users/me/games');
    expect(started.remote, 'github.com/acme/games');
    final asked = rig.conn('m').payloadsOf('agent_create').single;
    expect(asked['engine'], 'claude');
    expect(asked['cwd'], '/Users/me/games');
    expect(asked['permissionMode'], 'full');
    expect(asked['swarmRole'], 'lead');
    expect(asked['swarmSkillMode'], 'default');
    expect(asked['prompt'], 'Harness Swarm agent. You are the Lead.');
    expect(asked['model'], 'opus');
    expect(asked['effort'], 'xhigh');
  });

  test('with no repo there, a new folder named after the project; Codex runs '
      'its own model', () async {
    final rig = await signedInWith({'m': []});
    addTearDown(rig.app.dispose);
    rig.conn('m').answers['agent_create'] = (p) => created(p, 'lead');
    final computers = AppSwarmComputers(rig.app);
    addTearDown(computers.dispose);

    await computers.startLead('m', (
      engine: 'codex',
      folder: null,
      projectName: 'games',
      prompt: 'Lead',
      skillMode: 'orchestration',
    ));

    final asked = rig.conn('m').payloadsOf('agent_create').single;
    expect(asked.containsKey('cwd'), isFalse);
    expect(asked['projectSource'], 'new');
    expect(asked['projectName'], 'games');
    expect(asked.containsKey('model'), isFalse);
  });

  test('a computer that refuses says why', () async {
    final rig = await signedInWith({'m': []});
    addTearDown(rig.app.dispose);
    rig.conn('m').answers['agent_create'] = (_) => {
      'error': 'TMUX_UNAVAILABLE',
    };
    final computers = AppSwarmComputers(rig.app);
    addTearDown(computers.dispose);

    expect(
      computers.startLead('m', (
        engine: 'claude',
        folder: '/Users/me/games',
        projectName: 'games',
        prompt: 'Lead',
        skillMode: 'default',
      )),
      throwsA(
        isA<SuperTabFailure>().having(
          (f) => f.message,
          'message',
          contains('tmux'),
        ),
      ),
    );
  });
}
