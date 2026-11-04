import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_lead_start.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';
import 'swarm_lead_start_fixture.dart';

void main() {
  late FakeSwarm swarm;
  late SwarmReader reader;
  late FakeLeadComputers computers;

  /// What lead.claim and agent.add answer, by command type.
  late Map<String, FutureOr<Object?> Function(Map<String, dynamic>)> answers;

  Future<void> open([Map<String, dynamic>? load]) async {
    swarm = FakeSwarm();
    answers = {
      'lead.claim': (_) => {
        'result': {'leadStart': 'start'},
      },
      'agent.add': (_) => {'result': <String, Object>{}},
    };
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => load ?? personalLoad();
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    swarm.routes['/api/super-tabs/$tab/commands'] = (body) {
      final command = body!['command'] as Map<String, dynamic>;
      return answers[command['type']]!(command);
    };
    reader = SwarmReader(tabId: tab, accountId: me, request: swarm.request);
    addTearDown(reader.dispose);
    await reader.refresh();
    computers = FakeLeadComputers([
      computer('mac-1', 'Studio', folders: {repo: '/Users/me/games'}),
      computer('mac-2', 'Air', engines: ['claude']),
    ]);
  }

  List<String> sent() => [for (final c in swarm.commands) c['type'] as String];

  test('wants a Lead only in a Personal Swarm\'s empty project chat', () async {
    await open();
    expect(swarmWantsLeadStart(reader, personalChat), isTrue);
    expect(swarmWantsLeadStart(reader, 'g-task'), isFalse);

    await open(personalLoad(leadId: 'agent-lead'));
    expect(swarmWantsLeadStart(reader, personalChat), isFalse);

    await open(personalLoad(name: 'Phone Swarm'));
    expect(swarmWantsLeadStart(reader, personalChat), isFalse);

    await open(personalLoad(people: [me, 'person-dee']));
    expect(swarmWantsLeadStart(reader, personalChat), isFalse);

    await open(personalLoad(role: 'viewer'));
    expect(swarmWantsLeadStart(reader, personalChat), isFalse);
  });

  test('a remote is one string on every computer, as on Desktop', () {
    for (final form in [
      'git@github.com:Acme/Api.git',
      'https://github.com/acme/api',
      'https://user:secret@GitHub.com/acme/api',
      'github.com/acme/api/',
    ]) {
      expect(swarmNormalizedRemote(form), 'github.com/acme/api', reason: form);
    }
    expect(swarmNormalizedRemote('/srv/api'), isNull);
    expect(swarmNormalizedRemote(null), isNull);
    // Desktop's id for this repo's project (personal_projects.dart).
    expect(
      swarmPersonalProjectOperation('github.com/acme/api'),
      'personal-repo-e1dcaa3496b93562cbcd84ea',
    );
  });

  test('the plan is the repo\'s folder on the picked computer, else a new '
      'one', () async {
    await open();
    final first = swarmLeadPlan(reader, computers, personalChat);
    expect(first, (
      machineId: 'mac-1',
      engine: 'claude',
      folder: '/Users/me/games',
    ));
    final air = swarmLeadPlan(
      reader,
      computers,
      personalChat,
      machineId: 'mac-2',
    );
    expect(air, (machineId: 'mac-2', engine: 'claude', folder: null));
    expect(
      swarmLeadPlan(reader, computers, personalChat, engine: 'codex').engine,
      'codex',
    );
  });

  test('the plan says why there is nothing to start on', () async {
    await open();
    computers.leadComputers = [];
    expect(
      () => swarmLeadPlan(reader, computers, personalChat),
      throwsA(
        isA<SuperTabFailure>().having(
          (f) => f.message,
          'message',
          'none of your computers is online',
        ),
      ),
    );
    computers.leadComputers = [computer('mac-1', 'Studio', engines: [])];
    expect(
      () => swarmLeadPlan(reader, computers, personalChat),
      throwsA(
        isA<SuperTabFailure>().having(
          (f) => f.message,
          'message',
          'Claude Code and Codex aren’t signed in on Studio',
        ),
      ),
    );
  });

  test('start claims, starts on the computer, then joins it as Lead', () async {
    await open();
    await SwarmLeadStarter.of(reader).start(
      reader,
      computers,
      personalChat,
      machineId: 'mac-1',
      engine: 'codex',
    );

    expect(sent(), ['lead.claim', 'agent.add']);
    expect(swarm.commands.first, {
      'type': 'lead.claim',
      'projectId': personal,
      'machineId': 'mac-1',
    });
    final (machine, launch) = computers.starts.single;
    expect(machine, 'mac-1');
    expect(launch.engine, 'codex');
    expect(launch.folder, '/Users/me/games');
    expect(launch.projectName, 'games');
    expect(launch.skillMode, 'default');
    expect(
      launch.prompt,
      swarmLeadLaunchPrompt(tabId: tab, conversationId: personalChat),
    );
    expect(
      launch.prompt,
      startsWith('Harness Swarm agent. You are the Lead. '),
    );
    final join = swarm.commands.last;
    expect(join['conversationId'], personalChat);
    expect(join['machineId'], 'mac-1');
    expect(join['harnessId'], 'harness-new');
    expect(join['name'], 'Lead');
    expect(join['lead'], isTrue);
    expect(join['project'], {
      'cwd': '/Users/me/games',
      'repositoryUrl': 'https://github.com/acme/games',
    });
    expect(superTabMap(join['configuration'])['engine'], 'codex');
    expect(
      SwarmLeadStarter.of(reader).statusOf(personalChat)?.failed,
      isFalse,
      reason: 'starting until the chat reads its Lead',
    );
  });

  test('two taps make one claim and one start', () async {
    await open();
    computers.held = Completer();
    final starter = SwarmLeadStarter.of(reader);
    final first = starter.start(
      reader,
      computers,
      personalChat,
      machineId: 'mac-1',
      engine: 'claude',
    );
    await starter.start(
      reader,
      computers,
      personalChat,
      machineId: 'mac-1',
      engine: 'claude',
    );
    computers.held!.complete();
    await first;
    expect(sent(), ['lead.claim', 'agent.add']);
    expect(computers.starts, hasLength(1));
  });

  test('a claim another machine holds starts nothing here and shows '
      'starting', () async {
    await open();
    answers['lead.claim'] = (_) => {
      'result': {'leadStart': 'waiting'},
    };
    final starter = SwarmLeadStarter.of(reader);
    await starter.start(
      reader,
      computers,
      personalChat,
      machineId: 'mac-1',
      engine: 'claude',
    );
    expect(sent(), ['lead.claim']);
    expect(computers.starts, isEmpty);
    expect(starter.statusOf(personalChat)?.failed, isFalse);
  });

  test('a failure shows its reason, and Start again joins the agent already '
      'started', () async {
    await open();
    answers['agent.add'] = (_) => throw const SuperTabFailure(
      'LEAD_EXISTS',
      'This project already has its Lead.',
    );
    final starter = SwarmLeadStarter.of(reader);
    await starter.start(
      reader,
      computers,
      personalChat,
      machineId: 'mac-1',
      engine: 'claude',
    );
    expect(
      starter.statusOf(personalChat)?.reason,
      'This project already has its Lead',
    );

    answers['agent.add'] = (_) => {'result': <String, Object>{}};
    await starter.start(
      reader,
      computers,
      personalChat,
      machineId: 'mac-1',
      engine: 'claude',
    );
    expect(sent(), ['lead.claim', 'agent.add', 'lead.claim', 'agent.add']);
    expect(computers.starts, hasLength(1));
    expect(swarm.commands.last['harnessId'], 'harness-new');
    expect(starter.statusOf(personalChat)?.failed, isFalse);
  });

  test('a computer that could not start it says why, and Start tries '
      'again', () async {
    await open();
    computers.failure = const SuperTabFailure(
      'CREATE_FAILED',
      'Codex isn’t signed in.',
    );
    final starter = SwarmLeadStarter.of(reader);
    await starter.start(
      reader,
      computers,
      personalChat,
      machineId: 'mac-1',
      engine: 'codex',
    );
    expect(starter.statusOf(personalChat)?.reason, 'Codex isn’t signed in');
    expect(sent(), ['lead.claim']);

    computers.failure = null;
    await starter.start(
      reader,
      computers,
      personalChat,
      machineId: 'mac-1',
      engine: 'codex',
    );
    expect(computers.starts, hasLength(2));
    expect(sent(), ['lead.claim', 'lead.claim', 'agent.add']);
  });
  test('Start again after a failed join claims the kept computer and joins '
      'its agent, whatever is picked since', () async {
    await open();
    // The server holds one claim: another computer's claim waits (backend
    // commands.ts lead.claim).
    String? held;
    answers['lead.claim'] = (command) {
      final machine = command['machineId'] as String;
      if (held != null && held != machine) {
        return {
          'result': {'leadStart': 'waiting'},
        };
      }
      held = machine;
      return {
        'result': {'leadStart': 'start'},
      };
    };
    answers['agent.add'] = (_) =>
        throw const SuperTabFailure('UNAVAILABLE', 'The Swarm did not answer.');
    final starter = SwarmLeadStarter.of(reader);
    await starter.start(
      reader,
      computers,
      personalChat,
      machineId: 'mac-1',
      engine: 'codex',
    );
    expect(starter.kept(personalChat), (machineId: 'mac-1', engine: 'codex'));

    answers['agent.add'] = (_) => {'result': <String, Object>{}};
    await starter.start(
      reader,
      computers,
      personalChat,
      machineId: 'mac-2',
      engine: 'claude',
    );
    expect(
      [for (final c in swarm.commands) (c['type'], c['machineId'])],
      [
        ('lead.claim', 'mac-1'),
        ('agent.add', 'mac-1'),
        ('lead.claim', 'mac-1'),
        ('agent.add', 'mac-1'),
      ],
    );
    expect(computers.starts, hasLength(1));
    expect(
      superTabMap(swarm.commands.last['configuration'])['engine'],
      'codex',
    );
    expect(starter.kept(personalChat), isNull);
  });
}
