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
}) => LeadMachine(
  id: id,
  name: id,
  online: online,
  freeAgents: free,
  repositories: repositories,
  maySleep: maySleep,
  unavailable: unavailable,
  inSwarm: inSwarm,
);

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
      expect(bestLeadMachine(ranked, _repo)?.id, 'studio');
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
      expect(bestLeadMachine([outside], _repo)?.id, 'mine');
      expect(leadMachineDetail(outside, _repo), 'Online · Not in this Swarm');
    });

    test('no machine is best when none is online, free and allowed', () {
      expect(
        bestLeadMachine([
          _machine('offline', online: false),
          _machine('full', free: 0),
          _machine('teammate', unavailable: 'Not yours'),
        ], _repo),
        isNull,
      );
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
}
