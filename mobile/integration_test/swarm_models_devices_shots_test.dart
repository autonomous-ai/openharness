import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_start.dart';

import '../test/swarm/swarm_fixture.dart';
import '../test/voice_fakes.dart' show MemoryKeyValueStore;

/// The drawer's Your models and Your devices, and the pages they open, on a
/// simulator in dark and in light, a screenshot at each step.
///
/// Every answer is scripted in memory ([FakeSwarm]): nothing reaches an
/// account, a machine or the backend.
///
///     flutter drive -d <simulator> --driver=test_driver/journey_driver.dart \
///       --target=integration_test/swarm_models_devices_shots_test.dart
///
/// Screenshots land in `HARNESS_JOURNEY_OUT` (default `build/journey/`).
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  for (final (theme, palette) in [
    ('dark', HarnessPalette.graphite),
    ('light', HarnessPalette.paper),
  ]) {
    testWidgets('Your models and Your devices, $theme', (tester) async {
      final walk = _Walk(tester, binding, 'models-devices-$theme');
      grid.AppTheme.palette.value = palette;
      grid.AppTheme.brightness.value = palette.brightness;
      final host = SwarmHost(
        accountId: () => me,
        account: ValueNotifier<String?>(me),
        request: _backend().request,
        notices: SilentSystemNotices(),
        features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
          ..value = {PhoneExperiment.swarm},
        computers: _Computers(),
      );
      addTearDown(host.dispose);
      await tester.pumpWidget(
        grid.BrightnessScope(
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: palette.brightness),
            builder: (context, child) =>
                SwarmScope(notifier: host, child: child!),
            home: const SwarmPage(),
          ),
        ),
      );

      await walk.waitFor(walk.key('swarm-project-$tab-$project'));
      await tester.tap(walk.key('swarm-menu'));
      await walk.waitFor(walk.key('swarm-drawer-models'));
      await walk.shot('drawer');

      await tester.tap(walk.key('swarm-drawer-models'));
      await walk.waitFor(walk.key('swarm-models-api-$tab'));
      await walk.shot('models');

      await tester.tap(walk.key('tty-back'));
      await walk.wait(900);
      await tester.tap(walk.key('swarm-menu'));
      await walk.waitFor(walk.key('swarm-drawer-devices'));
      await tester.tap(walk.key('swarm-drawer-devices'));
      await walk.waitFor(walk.key('swarm-device-0'));
      await walk.shot('devices');
    });
  }
}

/// One Swarm, "Phone Swarm", whose models are on: two APIs and a local model
/// on the grid, and a model shared with Diego's Mac alone.
FakeSwarm _backend() {
  final fake = FakeSwarm();
  fake.routes['/api/super-tabs/list'] = (_) => {
    'tabs': [
      {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
    ],
    'next': null,
  };
  Map<String, dynamic> machine(
    String id,
    String name,
    List<Map<String, dynamic>> models,
  ) => {
    'machineId': id,
    'name': name,
    'observation': {
      'receivedAt': DateTime.now().millisecondsSinceEpoch,
      'localModels': models,
    },
  };
  fake.routes['/api/super-tabs/$tab/parts'] = (_) {
    final data = firstLoad();
    (data['head'] as Map)['data'] = {
      ...headData(
        projects: [
          for (final (id, name) in [
            (project, 'Mobile'),
            ('project-2', 'Website'),
          ])
            {
              'id': id,
              'name': name,
              'ownerId': me,
              'leadConversationId': id == project ? leadChat : 'lead-$id',
              'visibility': 'public',
              'members': <Object>[],
              'updateMinutes': 5,
            },
        ],
      ),
      'localModels': {'grid': 'swarm-grid', 'enabled': true, 'ready': true},
    };
    data['machines'] = [
      part(
        'mac-1',
        1,
        machine('mac-1', 'MacbookPro.local', [
          {
            'grid': 'swarm-grid',
            'model': 'moonshotai/kimi-k3',
            'name': 'moonshotai/kimi-k3 · OpenRouter',
            'kind': 'api',
          },
          {
            'grid': 'swarm-grid',
            'model': 'deepseek/deepseek-v4.1-flash',
            'name': 'deepseek/deepseek-v4.1-flash · OpenRouter',
            'kind': 'api',
          },
        ]),
      ),
      part(
        'mac-2',
        2,
        machine('mac-2', 'Studio Mac', [
          {
            'grid': 'swarm-grid',
            'model': 'qwen3-coder-30b',
            'name': 'Qwen3 Coder 30B',
            'kind': 'local',
          },
        ]),
      ),
      part(
        'mac-3',
        3,
        machine('mac-3', "Diego's Mac", [
          {
            'grid': 'diego-grid',
            'model': 'llama-4-scout',
            'name': 'Llama 4 Scout',
            'kind': 'shared',
          },
        ]),
      ),
    ];
    return data;
  };
  fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
  fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
    'decisions': <Object>[],
  };
  fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
    'mentions': <Object>[],
  };
  return fake;
}

/// The person's computers: two online, one away.
class _Computers extends ChangeNotifier implements SwarmComputers {
  @override
  final List<SwarmComputer> computers = const [
    (name: 'Studio Mac', away: false),
    (name: 'MacBook Pro', away: false),
    (name: 'Office iMac', away: true),
  ];

  @override
  bool get rechecking => false;

  @override
  Future<void> recheck() async {}

  @override
  void add(BuildContext context) {}
}

class _Walk {
  _Walk(this.tester, this.binding, this.name);

  final WidgetTester tester;
  final IntegrationTestWidgetsFlutterBinding binding;
  final String name;
  var _step = 0;

  Future<void> wait([int ms = 600]) async {
    for (var elapsed = 0; elapsed < ms; elapsed += 100) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  Future<void> shot(String step, {int settle = 900}) async {
    await wait(settle);
    _step++;
    await binding.takeScreenshot(
      '$name-${_step.toString().padLeft(2, '0')}-$step',
    );
  }

  Future<void> waitFor(Finder finder, {int seconds = 20}) async {
    for (var i = 0; i < seconds * 10; i++) {
      if (finder.evaluate().isNotEmpty) return;
      await tester.pump(const Duration(milliseconds: 100));
    }
    fail('never appeared: $finder');
  }

  Finder key(String value) => find.byKey(ValueKey(value));
}
