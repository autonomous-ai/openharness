import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/lead_placement.dart';

const _repo = 'https://github.com/autonomous-ai/autonomous-os.git';

LeadMachine _machine(
  String id, {
  bool online = true,
  int free = 4,
  Set<String> repositories = const {},
  bool maySleep = false,
  String? unavailable,
  bool inSwarm = true,
  bool own = true,
  Map<String, String> engineRefusals = const {},
}) => LeadMachine(
  id: id,
  name: id,
  online: online,
  freeAgents: free,
  repositories: repositories,
  maySleep: maySleep,
  unavailable: unavailable,
  inSwarm: inSwarm,
  own: own,
  engineRefusals: engineRefusals,
);

const _claudeOff = {'claude': 'Claude Code isn’t offered here'};

void main() {
  group('leadRepositoryKey', () {
    test('reads HTTPS, SSH and bare remotes as one repository', () {
      for (final remote in [
        'https://github.com/Autonomous-AI/autonomous-os.git',
        'git@github.com:autonomous-ai/autonomous-os.git',
        'ssh://git@github.com/autonomous-ai/autonomous-os',
        'github.com/autonomous-ai/autonomous-os/',
      ]) {
        expect(
          leadRepositoryKey(remote),
          'github.com/autonomous-ai/autonomous-os',
          reason: remote,
        );
      }
      expect(leadRepositoryKey(null), isNull);
      expect(leadRepositoryKey(''), isNull);
    });
  });

  group('rankLeadMachines', () {
    test('an always-on machine with the repo and room comes first', () {
      final ranked = rankLeadMachines([
        _machine('offline', online: false, free: 30),
        _machine(
          'laptop',
          maySleep: true,
          free: 9,
          repositories: {'github.com/autonomous-ai/autonomous-os'},
        ),
        _machine('rig', free: 14),
        _machine(
          'studio',
          free: 9,
          repositories: {'github.com/autonomous-ai/autonomous-os'},
        ),
        _machine('teammate', free: 20, unavailable: 'Not yours'),
        _machine(
          'full',
          free: 0,
          repositories: {'github.com/autonomous-ai/autonomous-os'},
        ),
      ], _repo);
      expect(ranked.map((m) => m.id), [
        'studio',
        'rig',
        'laptop',
        'full',
        'teammate',
        'offline',
      ]);
    });

    test('more free agents wins among otherwise equal machines', () {
      final ranked = rankLeadMachines([
        _machine('a', free: 2),
        _machine('b', free: 8),
      ], null);
      expect(ranked.map((m) => m.id), ['b', 'a']);
    });

    test('one of the person’s machines the Swarm does not list comes after '
        'the Swarm’s own and is still startable', () {
      final outside = LeadMachine(
        id: 'mine',
        name: 'Mine',
        online: true,
        freeAgents: null,
        inSwarm: false,
      );
      final ranked = rankLeadMachines([
        outside,
        _machine('laptop', maySleep: true, free: 1),
      ], _repo);
      expect(ranked.map((m) => m.id), ['laptop', 'mine']);
      expect(outside.startable, isTrue);
      expect(leadMachineDetail(outside, _repo), 'Online · Not in this Swarm');
    });
  });

  group('leadMachineDetail', () {
    test('says each state in words', () {
      expect(
        leadMachineDetail(
          _machine(
            's',
            free: 9,
            repositories: {'github.com/autonomous-ai/autonomous-os'},
          ),
          _repo,
        ),
        'Online · 9 agents free · Has repo',
      );
      expect(
        leadMachineDetail(_machine('l', free: 1, maySleep: true), _repo),
        'Online · 1 agent free · May sleep',
      );
      expect(
        leadMachineDetail(_machine('f', free: 0), _repo),
        'Online · No agents free',
      );
      expect(leadMachineDetail(_machine('o', online: false), _repo), 'Offline');
      expect(
        leadMachineDetail(_machine('t', unavailable: 'Diego’s machine'), _repo),
        'Diego’s machine',
      );
    });
  });

  group('capacity is what starts can use', () {
    test("another person's machine shows why, never its free count", () {
      final theirs = _machine(
        'rig',
        free: 3,
        unavailable: 'Another person’s machine',
      );
      expect(leadMachineDetail(theirs, null), 'Another person’s machine');
    });

    test(
      'your own machine shows the free count that starts are admitted by',
      () {
        expect(
          leadMachineDetail(_machine('mac', free: 3), null),
          'Online · 3 agents free',
        );
        expect(
          leadMachineDetail(_machine('mac', free: 0), null),
          'Online · No agents free',
        );
        expect(_machine('mac', free: 0).startable, isFalse);
      },
    );
  });

  group('engines', () {
    test('a machine offering only Codex still starts a Product Manager', () {
      final rig = _machine('rig', engineRefusals: _claudeOff);
      expect(rig.runs('claude'), isFalse);
      expect(rig.leadEngines, ['codex']);
      expect(rig.startable, isTrue);
    });

    test('a machine that runs no Product Manager engine is not startable', () {
      final rig = _machine(
        'rig',
        engineRefusals: const {
          'claude': 'Claude Code isn’t offered here',
          'codex': 'Codex isn’t signed in',
        },
      );
      expect(rig.startable, isFalse);
      expect(rig.runs('codex'), isFalse);
      expect(rig.leadEngines, isEmpty);
    });
  });
}
