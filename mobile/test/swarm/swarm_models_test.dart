import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_models_page.dart';

import 'swarm_fixture.dart';

/// What Your models lists for a Swarm: the models its machines' fresh
/// readings say it can use now, as Desktop's machine details read them — an
/// API a member shares, a member's model on the Swarm's grid, or a model
/// shared with one machine's owner, usable on that machine alone.
void main() {
  final now = DateTime.utc(2026, 10, 28, 4);
  final fresh = now.subtract(const Duration(seconds: 10));
  final stale = now.subtract(const Duration(minutes: 2));

  Map<String, dynamic> machine(
    String id,
    String name,
    List<Map<String, dynamic>> models, {
    DateTime? at,
  }) => {
    'machineId': id,
    'name': name,
    'observation': {
      'receivedAt': (at ?? fresh).millisecondsSinceEpoch,
      'localModels': models,
    },
  };

  SuperTabSnapshot snapshot({
    Map<String, dynamic>? localModels = const {
      'grid': 'swarm-grid',
      'enabled': true,
      'ready': true,
    },
    List<Map<String, dynamic>> machines = const [],
  }) {
    final data = firstLoad();
    (data['head'] as Map)['data'] = {
      ...headData(),
      'localModels': ?localModels,
    };
    data['machines'] = [
      for (final (i, m) in machines.indexed)
        part(m['machineId'] as String, 1 + i, m),
    ];
    return SuperTabSnapshot.fromJson(SuperTabParts.firstLoad(data).state);
  }

  test('a Swarm whose models were never turned on lists none', () {
    expect(swarmModelList(snapshot(localModels: null), now: now), isNull);
    expect(
      swarmModelList(
        snapshot(localModels: {'grid': 'swarm-grid', 'enabled': false}),
        now: now,
      ),
      isNull,
    );
  });

  test('APIs, local models and one-computer models, each where it runs', () {
    final list = swarmModelList(
      snapshot(
        machines: [
          machine('mac-1', 'MacbookPro.local', [
            {
              'grid': 'swarm-grid',
              'model': 'moonshotai/kimi-k3',
              'name': 'moonshotai/kimi-k3 · OpenRouter',
              'kind': 'api',
            },
            {
              'grid': 'swarm-grid',
              'model': 'qwen3-coder-30b',
              'name': 'Qwen3 Coder 30B',
              'kind': 'local',
            },
          ]),
          machine('mac-2', "Diego's Mac", [
            {
              'grid': 'diego-grid',
              'model': 'llama-4-scout',
              'name': 'Llama 4 Scout',
              'kind': 'shared',
            },
          ]),
        ],
      ),
      now: now,
    )!;

    expect(list.apis, [
      (name: 'kimi-k3', provider: 'OpenRouter', machine: 'MacbookPro.local'),
    ]);
    expect(list.local, [
      (name: 'Qwen3 Coder 30B', provider: null, machine: 'MacbookPro.local'),
    ]);
    expect(list.oneComputer, [
      (name: 'Llama 4 Scout', provider: null, machine: "Diego's Mac"),
    ]);
    expect(list.isEmpty, isFalse);
  });

  test('an old reading, or a model still starting, is not usable now', () {
    final list = swarmModelList(
      snapshot(
        machines: [
          machine('mac-1', 'Studio', [
            {'grid': 'swarm-grid', 'model': 'old', 'kind': 'local'},
          ], at: stale),
          machine('mac-2', 'Mini', [
            {
              'grid': 'swarm-grid',
              'model': 'warming',
              'kind': 'local',
              'starting': true,
            },
          ]),
        ],
      ),
      now: now,
    )!;

    expect(list.isEmpty, isTrue);
  });

  test('a model two machines offer is listed once', () {
    final model = {
      'grid': 'swarm-grid',
      'model': 'deepseek/deepseek-v4.1-flash',
      'name': 'deepseek/deepseek-v4.1-flash · OpenRouter',
      'kind': 'api',
    };
    final list = swarmModelList(
      snapshot(
        machines: [
          machine('mac-1', 'Studio', [model]),
          machine('mac-2', 'Mini', [model]),
        ],
      ),
      now: now,
    )!;

    expect(list.apis, [
      (name: 'deepseek-v4.1-flash', provider: 'OpenRouter', machine: 'Studio'),
    ]);
  });
}
