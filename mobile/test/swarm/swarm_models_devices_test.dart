import 'dart:async';

import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_devices_page.dart';
import 'package:harness_mobile/swarm/swarm_models_page.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_start.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';
import 'package:harness_mobile/swarm/swarm_you_page.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// You's Your models and Your devices, and the two read-only pages they
/// open: the models a Swarm can use now, and the
/// person's computers — each with rows on their way while it is read, and
/// words for when there is nothing to list.
void main() {
  /// One Swarm whose models are on, [models] served by its machine Studio
  /// (read just now); its read waits for [held] when given.
  FakeSwarm backend({
    List<Map<String, dynamic>> models = const [],
    bool modelsOn = true,
    Completer<void>? held,
    List<({String id, String name})> swarms = const [
      (id: tab, name: 'Phone Swarm'),
    ],
  }) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        for (final s in swarms) {'id': s.id, 'name': s.name, 'ownerId': me},
      ],
      'next': null,
    };
    for (final s in swarms) {
      fake.routes['/api/super-tabs/${s.id}/parts'] = (_) async {
        await held?.future;
        final data = firstLoad(tabId: s.id);
        (data['head'] as Map)['data'] = {
          ...headData(id: s.id, name: s.name),
          if (modelsOn)
            'localModels': {'grid': 'grid-${s.id}', 'enabled': true},
        };
        data['machines'] = [
          part('mac-1', 1, {
            'machineId': 'mac-1',
            'name': 'Studio',
            // The person's own machine: Your models lists what it offers.
            'contributorId': me,
            'observation': {
              'receivedAt': DateTime.now().millisecondsSinceEpoch,
              'localModels': [
                for (final m in models) {'grid': 'grid-${s.id}', ...m},
              ],
            },
          }),
        ];
        return data;
      };
      fake.routes['/api/super-tabs/${s.id}/changes'] = (_) =>
          changes(cursor: 'c2');
      fake.routes['/api/super-tabs/${s.id}/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/${s.id}/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
    }
    return fake;
  }

  /// [home] under a Swarm that is on, on an iPhone's screen.
  Future<void> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    Widget home = const SwarmPage(),
    SwarmComputers? computers,
    bool settle = true,
  }) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
      computers: computers,
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        onGenerateRoute: (_) => CupertinoPageRoute<void>(builder: (_) => home),
      ),
    );
    unawaited(host.session!.inbox.refresh());
    // A skeleton breathes for as long as it shows: nothing settles under it.
    if (settle) {
      await tester.pumpAndSettle();
    } else {
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
    }
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  Finder inside(String k, Finder matching) =>
      find.descendant(of: key(k), matching: matching);
  double y(WidgetTester tester, String k) => tester.getTopLeft(key(k)).dy;

  group('from You', () {
    testWidgets('lists Your models and Your devices under the status', (
      tester,
    ) async {
      await pump(
        tester,
        backend(),
        home: const SwarmYouPage(),
        computers: _Computers(const [(name: 'Studio Mac', away: false)]),
      );

      expect(
        inside('swarm-you-models', find.text('Your models')),
        findsOneWidget,
      );
      expect(
        inside('swarm-you-devices', find.text('Your devices')),
        findsOneWidget,
      );
      expect(
        y(tester, 'swarm-you-status'),
        lessThan(y(tester, 'swarm-you-models')),
      );
      expect(
        y(tester, 'swarm-you-models'),
        lessThan(y(tester, 'swarm-you-devices')),
      );
      expect(
        tester.getSize(key('swarm-you-models')).height,
        greaterThanOrEqualTo(44),
        reason: "a thumb's tap",
      );
    });

    testWidgets('Your devices shows where the computers are not known: it '
        "has the Swarm's machines too", (tester) async {
      await pump(tester, backend(), home: const SwarmYouPage());

      await tester.tap(key('swarm-you-devices'));
      await tester.pumpAndSettle();
      expect(find.text('Your computers'), findsNothing);
      expect(key('swarm-machine-section-$tab'), findsOneWidget);
    });

    testWidgets('Your models opens its page', (tester) async {
      await pump(
        tester,
        backend(
          models: [
            {'model': 'qwen3-coder', 'name': 'Qwen3 Coder', 'kind': 'local'},
          ],
        ),
        home: const SwarmYouPage(),
      );

      await tester.tap(key('swarm-you-models'));
      await tester.pumpAndSettle();

      expect(find.byType(SwarmModelsPage), findsOneWidget);
      expect(find.text('Qwen3 Coder'), findsOneWidget);
    });

    testWidgets('Your devices opens its page', (tester) async {
      await pump(
        tester,
        backend(),
        home: const SwarmYouPage(),
        computers: _Computers(const [(name: 'Studio Mac', away: false)]),
      );

      await tester.tap(key('swarm-you-devices'));
      await tester.pumpAndSettle();

      expect(find.byType(SwarmDevicesPage), findsOneWidget);
      expect(find.text('Studio Mac'), findsOneWidget);
    });
  });

  group('Your models', () {
    testWidgets('rows on their way while the Swarm is read', (tester) async {
      final held = Completer<void>();
      await pump(
        tester,
        backend(held: held),
        home: const SwarmModelsPage(),
        settle: false,
      );

      expect(key('swarm-models-loading-$tab'), findsOneWidget);

      held.complete();
      await tester.pumpAndSettle();
      expect(key('swarm-models-loading-$tab'), findsNothing);
    });

    testWidgets('APIs, local models and one-computer models, under headings', (
      tester,
    ) async {
      await pump(
        tester,
        backend(
          models: [
            {
              'model': 'moonshotai/kimi-k3',
              'name': 'moonshotai/kimi-k3 · OpenRouter',
              'kind': 'api',
            },
            {'model': 'qwen3-coder', 'name': 'Qwen3 Coder', 'kind': 'local'},
            {'model': 'llama-4', 'name': 'Llama 4', 'kind': 'shared'},
          ],
        ),
        home: const SwarmModelsPage(),
      );

      expect(find.text('API models'), findsOneWidget);
      expect(find.text('Local models'), findsOneWidget);
      expect(find.text('On one computer only'), findsOneWidget);
      expect(find.text('kimi-k3'), findsOneWidget);
      expect(find.text('OpenRouter'), findsOneWidget);
      expect(find.text('Qwen3 Coder'), findsOneWidget);
      expect(find.text('Llama 4'), findsOneWidget);
      expect(find.textContaining('Studio'), findsWidgets);
      expect(
        tester.getTopLeft(find.text('kimi-k3')).dy,
        lessThan(tester.getTopLeft(find.text('Qwen3 Coder')).dy),
      );
      expect(
        tester.getTopLeft(find.text('Qwen3 Coder')).dy,
        lessThan(tester.getTopLeft(find.text('Llama 4')).dy),
      );
    });

    testWidgets('a Swarm with nothing running says so', (tester) async {
      await pump(tester, backend(), home: const SwarmModelsPage());

      expect(key('swarm-models-none-$tab'), findsOneWidget);
      expect(
        find.text('None of your models is running for this Swarm right now.'),
        findsOneWidget,
      );
    });

    testWidgets('nothing to list is a line under the caption, as on Home', (
      tester,
    ) async {
      await pump(tester, backend(), home: const SwarmModelsPage());

      expect(
        find.ancestor(
          of: key('swarm-models-none-$tab'),
          matching: find.byType(SwarmGroup),
          matchRoot: true,
        ),
        findsNothing,
        reason: "Home's empty states are words, not a card",
      );
    });

    testWidgets('its lines sit 12 in from the edge, the words 4 more', (
      tester,
    ) async {
      await pump(tester, backend(), home: const SwarmModelsPage());

      expect(tester.getTopLeft(key('swarm-models-none-$tab')).dx, 12);
      expect(
        tester
            .getTopLeft(
              find.text(
                'None of your models is running for this Swarm right now.',
              ),
            )
            .dx,
        12 + 4,
      );
    });

    testWidgets('pulling down reads the Swarms again, as on Home', (
      tester,
    ) async {
      final fake = backend();
      await pump(tester, fake, home: const SwarmModelsPage());
      int lists() => fake.paths.where((p) => p.endsWith('/list')).length;
      final before = lists();

      await tester.fling(
        find.byType(Scrollable).first,
        const Offset(0, 400),
        1000,
      );
      await tester.pumpAndSettle();

      expect(lists(), greaterThan(before));
    });

    testWidgets('a Swarm whose models are not set up says who sets them up', (
      tester,
    ) async {
      await pump(
        tester,
        backend(modelsOn: false),
        home: const SwarmModelsPage(),
      );

      expect(key('swarm-models-off-$tab'), findsOneWidget);
      expect(
        find.text(
          "Models aren't set up for this Swarm yet. "
          'Its owner sets them up on a computer.',
        ),
        findsOneWidget,
      );
    });

    testWidgets('several Swarms: one block each, under its name', (
      tester,
    ) async {
      await pump(
        tester,
        backend(
          swarms: const [
            (id: 'tab-a', name: 'Alpha'),
            (id: 'tab-b', name: 'Beta'),
          ],
        ),
        home: const SwarmModelsPage(),
      );

      expect(find.text('Alpha'), findsOneWidget);
      expect(find.text('Beta'), findsOneWidget);
      expect(key('swarm-models-none-tab-a'), findsOneWidget);
      expect(key('swarm-models-none-tab-b'), findsOneWidget);
    });
  });

  group('Your devices', () {
    testWidgets('rows on their way until the computers are known', (
      tester,
    ) async {
      final computers = _Computers(null);
      await pump(
        tester,
        backend(),
        home: const SwarmDevicesPage(),
        computers: computers,
        settle: false,
      );

      expect(key('swarm-devices-loading'), findsOneWidget);

      computers.set(const [(name: 'Studio Mac', away: false)]);
      await tester.pumpAndSettle();
      expect(key('swarm-devices-loading'), findsNothing);
      expect(find.text('Studio Mac'), findsOneWidget);
    });

    testWidgets('each computer, online or offline, with nothing to tap', (
      tester,
    ) async {
      await pump(
        tester,
        backend(),
        home: const SwarmDevicesPage(),
        computers: _Computers(const [
          (name: 'Studio Mac', away: false),
          (name: 'Office iMac', away: true),
        ]),
      );

      expect(inside('swarm-device-0', find.text('Studio Mac')), findsOneWidget);
      expect(inside('swarm-device-0', find.text('Online')), findsOneWidget);
      expect(
        inside('swarm-device-1', find.text('Office iMac')),
        findsOneWidget,
      );
      expect(inside('swarm-device-1', find.text('Offline')), findsOneWidget);
      expect(
        find.descendant(
          of: key('swarm-device-0'),
          matching: find.byType(InkWell),
        ),
        findsNothing,
        reason: 'read only',
      );
    });

    testWidgets('pulling down reads the computers again', (tester) async {
      final computers = _Computers(const [(name: 'Studio Mac', away: false)]);
      await pump(
        tester,
        backend(),
        home: const SwarmDevicesPage(),
        computers: computers,
      );

      await tester.fling(
        find.byType(Scrollable).first,
        const Offset(0, 400),
        1000,
      );
      await tester.pumpAndSettle();

      expect(computers.rechecks, 1);
    });

    testWidgets('no computer yet is a line under the caption, as on Home', (
      tester,
    ) async {
      await pump(
        tester,
        backend(),
        home: const SwarmDevicesPage(),
        computers: _Computers(const []),
      );

      expect(
        find.ancestor(
          of: key('swarm-devices-none'),
          matching: find.byType(SwarmGroup),
          matchRoot: true,
        ),
        findsNothing,
      );
    });

    testWidgets('its lines sit 12 in from the edge, the words 4 more', (
      tester,
    ) async {
      await pump(
        tester,
        backend(),
        home: const SwarmDevicesPage(),
        computers: _Computers(const []),
      );

      expect(tester.getTopLeft(key('swarm-devices-none')).dx, 12);
      expect(
        tester.getTopLeft(find.text('No computers on your account yet.')).dx,
        12 + 4,
      );
    });

    testWidgets('no computer yet says so', (tester) async {
      await pump(
        tester,
        backend(),
        home: const SwarmDevicesPage(),
        computers: _Computers(const []),
      );

      expect(key('swarm-devices-none'), findsOneWidget);
      expect(find.text('No computers on your account yet.'), findsOneWidget);
    });
  });
}

/// The person's computers as a test sets them.
class _Computers extends ChangeNotifier implements SwarmComputers {
  @override
  List<SwarmOwnComputer> get own => const [];

  @override
  Future<Map<String, dynamic>> ask(
    String machineId,
    Map<String, dynamic> payload,
  ) async => throw UnimplementedError();

  _Computers(this.computers);

  @override
  List<SwarmComputer>? computers;

  @override
  bool get rechecking => false;

  void set(List<SwarmComputer>? next) {
    computers = next;
    notifyListeners();
  }

  var rechecks = 0;

  @override
  Future<void> recheck() async => rechecks++;

  @override
  void add(BuildContext context) {}
}
