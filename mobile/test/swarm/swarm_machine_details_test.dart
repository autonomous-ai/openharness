import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_machine_details.dart';

import 'swarm_fixture.dart';

/// What a machine's details read from its Swarm reading, as Desktop's
/// (`machines.dart` `_subscriptions`, `_quotaRow`, `MachineResources.fromJson`)
/// read it.
void main() {
  final now = DateTime.utc(2026, 11, 3, 4);
  final fresh = now.subtract(const Duration(seconds: 5));

  Map<String, dynamic> machine({
    String id = 'mac-1',
    Object? engines = const ['claude', 'codex'],
    List<Map<String, dynamic>> quotas = const [],
    Map<String, dynamic>? readiness,
    DateTime? at,
    bool reported = true,
  }) => {
    'machineId': id,
    'name': 'Mac',
    'contributorId': me,
    'engines': ?engines,
    'observation': {
      if (reported) 'receivedAt': (at ?? fresh).millisecondsSinceEpoch,
      'quotas': quotas,
      'readiness': ?readiness,
    },
  };

  Map<String, dynamic> quota(
    String engine,
    List<Map<String, dynamic>> windows, {
    bool known = true,
  }) => {'engine': engine, 'known': known, 'windows': windows};

  SuperTabSnapshot snapshot(List<Map<String, dynamic>> machines) {
    final data = firstLoad();
    data['machines'] = [
      for (final (i, m) in machines.indexed)
        part(m['machineId'] as String, 1 + i, m),
    ];
    return SuperTabSnapshot.fromJson(SuperTabParts.firstLoad(data).state);
  }

  ({List<String>? engines, List<SwarmMachineAllowance> allowances}) read(
    Map<String, dynamic> pool, {
    bool dim = false,
  }) {
    final s = snapshot([pool]);
    return swarmMachineSubscriptions(
      s,
      'mac-1',
      reading: s.pool('mac-1'),
      readingDim: dim,
      now: now,
    );
  }

  group('engines', () {
    test('the Claude and Codex its pool offers, in its order', () {
      expect(read(machine(engines: ['codex', 'claude'])).engines, [
        'codex',
        'claude',
      ]);
      expect(read(machine(engines: ['claude', 'cursor'])).engines, ['claude']);
    });

    test('a pool that names none says nothing', () {
      expect(read(machine(engines: null)).engines, isNull);
      expect(read(machine(engines: 'claude')).engines, isNull);
    });

    test(
      'a list naming a retired engine reads them from its quotas and installs',
      () {
        expect(read(machine(engines: ['opencode'])).engines, isEmpty);
        expect(
          read(
            machine(
              engines: ['opencode'],
              quotas: [
                quota('codex', [
                  {'name': 'Weekly', 'usedPercent': 10},
                ]),
              ],
              readiness: {
                'engines': [
                  {'engine': 'claude', 'installed': true, 'signedIn': null},
                ],
              },
            ),
          ).engines,
          ['claude', 'codex'],
        );
      },
    );
  });

  group('allowances', () {
    test('the share of the tightest window, its windows tightest first', () {
      final allowance = read(
        machine(
          quotas: [
            quota('claude', [
              {
                'name': '5-hour',
                'usedPercent': 30,
                'resetsAt': now
                    .add(const Duration(minutes: 45, seconds: 30))
                    .toIso8601String(),
              },
              {'name': 'Weekly', 'usedPercent': 99.5},
            ]),
          ],
        ),
      ).allowances.single;
      expect(allowance.engine, 'claude');
      expect(allowance.name, 'Claude Code');
      expect(allowance.figure, '<1%');
      expect(allowance.windows, [
        (window: 'Weekly', left: 0.5, reset: null),
        (window: '5-hour', left: 70.0, reset: 'resets in 45m'),
      ]);
    });

    test('an allowance with no figure is left out', () {
      for (final q in [
        quota('claude', [
          {'name': 'Weekly', 'usedPercent': 10},
        ], known: false),
        quota('claude', const []),
        quota('claude', [
          {'name': 'Weekly', 'usedPercent': 10},
          {'name': '5-hour'},
        ]),
        quota('claude', [
          {'name': 'Weekly', 'usedPercent': double.nan},
        ]),
        quota('opencode', [
          {'name': 'Weekly', 'usedPercent': 10},
        ]),
      ]) {
        expect(read(machine(quotas: [q])).allowances, isEmpty, reason: '$q');
      }
    });

    test('times no date can hold are no times, and never throw', () {
      final pool = machine(
        quotas: [
          quota('claude', [
            {'name': 'Weekly', 'usedPercent': 10, 'resetsAt': 1e300},
          ]),
        ],
      );
      expect(read(pool).allowances.single.windows.single.reset, isNull);
      (pool['observation'] as Map<String, dynamic>)['receivedAt'] = 1e300;
      expect(read(pool).allowances, isEmpty);
    });

    test('a machine that never reported has no allowances', () {
      expect(
        read(
          machine(
            reported: false,
            quotas: [
              quota('claude', [
                {'name': 'Weekly', 'usedPercent': 10},
              ]),
            ],
          ),
        ).allowances,
        isEmpty,
      );
    });

    test('a window reset since a current reading leaves it out; an old reading keeps its figures', () {
      final pool = machine(
        quotas: [
          quota('codex', [
            {
              'name': 'Weekly',
              'usedPercent': 40,
              // In seconds, as some readings send it.
              'resetsAt':
                  now
                      .subtract(const Duration(minutes: 1))
                      .millisecondsSinceEpoch ~/
                  1000,
            },
          ]),
        ],
      );
      expect(read(pool).allowances, isEmpty);
      final old = read(pool, dim: true).allowances.single;
      expect(old.figure, '60%');
      expect(old.windows.single, (window: 'Weekly', left: 60.0, reset: null));
    });
  });

  test(
    "a Mac's allowances are its own pool's, not its Harness Team account's",
    () {
      final mac = machine(
        quotas: [
          quota('claude', [
            {'name': 'Weekly', 'usedPercent': 25},
          ]),
        ],
      )..['contributorId'] = 'person-dee';
      final team =
          machine(
              id: 'team-1',
              quotas: [
                quota('claude', [
                  {'name': 'Weekly', 'usedPercent': 90},
                ]),
              ],
            )
            ..['contributorId'] = 'person-dee'
            ..['hostMachineId'] = 'mac-1';
      final s = snapshot([mac, team]);
      final result = swarmMachineSubscriptions(
        s,
        'mac-1',
        reading: s.readingPoolOf('mac-1', me),
        readingDim: false,
        now: now,
      );
      expect(s.readingPoolOf('mac-1', me)?['machineId'], 'team-1');
      expect(result.allowances.single.figure, '75%');
    },
  );

  test('resources out of range are no readings', () {
    final r = SwarmMachineResources.read({
      'cpuPercent': 101,
      'gpuPercent': -1,
      'memoryUsedBytes': 9,
      'memoryTotalBytes': 8,
      'diskFreeBytes': 5,
      'diskTotalBytes': 0,
      'projectDiskFreeBytes': double.infinity,
      'deviceType': 'Mac Studio',
      'chip': '',
      'os': 42,
    });
    expect(r.cpuPercent, isNull);
    expect(r.gpuPercent, isNull);
    expect(r.memoryUsedBytes, isNull);
    expect(r.memoryTotalBytes, isNull);
    expect(r.diskFreeBytes, isNull);
    expect(r.diskTotalBytes, isNull);
    expect(r.projectDiskFreeBytes, isNull);
    expect(r.deviceType, 'Mac Studio');
    expect(r.chip, isNull);
    expect(r.os, isNull);

    final ok = SwarmMachineResources.read({
      'cpuPercent': 12.5,
      'memoryUsedBytes': 4,
      'memoryTotalBytes': 8,
    });
    expect(ok.cpuPercent, 12.5);
    expect(ok.memoryUsedBytes, 4);
    expect(ok.memoryTotalBytes, 8);
  });
}
