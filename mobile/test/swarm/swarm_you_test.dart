import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_devices_page.dart';
import 'package:harness_mobile/swarm/swarm_models_page.dart';
import 'package:harness_mobile/swarm/swarm_profile_sheet.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_start.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';
import 'package:harness_mobile/swarm/swarm_you_page.dart';

import '../voice_fakes.dart';
import 'swarm_computers_fake.dart';
import 'swarm_fixture.dart';

/// You, as Tony's prototype C4 draws it (2026-10-30): who the person is in
/// the Swarm Home shows, their status and the way to change it, Your models
/// and Your devices with what is ready, and Settings.
void main() {
  /// The Swarms [swarms], each with the person as tony@example.com, [status]
  /// set when given, its models on, and [models] served by its machine
  /// Studio, read just now.
  FakeSwarm backend({
    List<Map<String, dynamic>> models = const [],
    Map<String, dynamic>? status,
    List<({String id, String name})> swarms = const [
      (id: tab, name: 'Autonomous'),
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
      fake.routes['/api/super-tabs/${s.id}/parts'] = (_) {
        final data = firstLoad(tabId: s.id);
        (data['head'] as Map)['data'] = {
          ...headData(id: s.id, name: s.name),
          'localModels': {'grid': 'grid-${s.id}', 'enabled': true},
        };
        data['members'] = [
          part(me, 1, {
            ...person(me),
            'email': 'tony@example.com',
            'status': ?status,
          }),
        ];
        data['machines'] = [
          part('mac-1', 1, {
            'machineId': 'mac-1',
            'name': 'Studio',
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

  late SwarmHost host;
  late List<String> settingsOpened;

  /// You under a Swarm that is on, on an iPhone's screen.
  Future<void> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    SwarmComputers? computers,
    ValueListenable<bool>? hidden,
  }) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
      computers: computers,
    )..foreground = false;
    addTearDown(host.dispose);
    settingsOpened = [];
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        onGenerateRoute: (_) => CupertinoPageRoute<void>(
          builder: (_) {
            final page = SwarmYouPage(
              onSettings: (_) => settingsOpened.add('settings'),
            );
            if (hidden == null) return page;
            return ValueListenableBuilder(
              valueListenable: hidden,
              builder: (_, value, child) =>
                  OutOfSight(hidden: value, child: child!),
              child: page,
            );
          },
        ),
      ),
    );
    unawaited(host.session!.inbox.refresh());
    await tester.pumpAndSettle();
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  Finder inside(String k, Finder matching) =>
      find.descendant(of: key(k), matching: matching);

  const studio = (name: 'Studio', away: false);
  const laptop = (name: 'Laptop', away: false);
  const mini = (name: 'Mini', away: true);
  const threeModels = [
    {
      'model': 'moonshotai/kimi-k3',
      'name': 'moonshotai/kimi-k3 · OpenRouter',
      'kind': 'api',
    },
    {'model': 'qwen3-coder', 'name': 'Qwen3 Coder', 'kind': 'local'},
    {'model': 'llama-4', 'name': 'Llama 4', 'kind': 'shared'},
  ];

  testWidgets('who you are: your face, your name and your Swarm, Active '
      'with no status set, and Change opens your profile', (tester) async {
    await pump(tester, backend());

    expect(
      tester.widget<Text>(find.byKey(const ValueKey('swarm-title'))).data,
      'You',
    );
    expect(inside('swarm-you-me', find.text('tony')), findsOneWidget);
    expect(inside('swarm-you-me', find.text('Autonomous')), findsOneWidget);
    expect(inside('swarm-you-me', find.byType(SwarmAvatar)), findsOneWidget);
    expect(inside('swarm-you-status', find.text('Active')), findsOneWidget);
    expect(inside('swarm-you-status', find.text('Change')), findsOneWidget);

    await tester.tap(key('swarm-you-status'));
    await tester.pumpAndSettle();

    expect(find.byType(SwarmProfileSheet), findsOneWidget);
  });

  testWidgets('a status set shows in place of Active', (tester) async {
    await pump(
      tester,
      backend(status: {'text': 'In a meeting', 'emoji': '📅'}),
    );

    expect(
      inside('swarm-you-status', find.text('📅 In a meeting')),
      findsOneWidget,
    );
    expect(inside('swarm-you-status', find.text('Active')), findsNothing);
  });

  testWidgets('a status that ends goes back to Active when it ends', (
    tester,
  ) async {
    final until = clock.now().add(const Duration(minutes: 30));
    await pump(
      tester,
      backend(
        status: {
          'text': 'In a meeting',
          'emoji': '📅',
          'until': until.toUtc().toIso8601String(),
        },
      ),
    );
    expect(
      inside('swarm-you-status', find.text('📅 In a meeting')),
      findsOneWidget,
    );

    await tester.pump(const Duration(minutes: 31));

    expect(inside('swarm-you-status', find.text('Active')), findsOneWidget);
    expect(find.text('📅 In a meeting'), findsNothing);
  });

  testWidgets('Your models counts what every Swarm can use now, and opens '
      'them', (tester) async {
    await pump(
      tester,
      backend(
        models: threeModels,
        swarms: const [
          (id: tab, name: 'Autonomous'),
          (id: 'tab-2', name: 'Design Lab'),
        ],
      ),
    );

    expect(inside('swarm-you-models', find.text('6 ready now')), findsOne);

    await tester.tap(key('swarm-you-models'));
    await tester.pumpAndSettle();

    expect(find.byType(SwarmModelsPage), findsOneWidget);
  });

  testWidgets('Your models with one, and with none running', (tester) async {
    await pump(tester, backend(models: [threeModels[1]]));
    expect(inside('swarm-you-models', find.text('1 ready now')), findsOne);

    await pump(tester, backend());
    expect(inside('swarm-you-models', find.text('None ready now')), findsOne);
  });

  testWidgets('Your devices counts the computers online and offline, follows '
      'them, and opens them', (tester) async {
    final computers = FakeComputers(const [studio, laptop, mini]);
    await pump(tester, backend(), computers: computers);

    expect(
      inside('swarm-you-devices', find.text('2 online · 1 offline')),
      findsOneWidget,
    );

    computers.set(const [studio]);
    await tester.pump();
    expect(inside('swarm-you-devices', find.text('1 online')), findsOne);

    computers.set(const []);
    await tester.pump();
    expect(
      inside('swarm-you-devices', find.text('No computers yet')),
      findsOne,
    );

    await tester.tap(key('swarm-you-devices'));
    await tester.pumpAndSettle();
    expect(find.byType(SwarmDevicesPage), findsOneWidget);
  });

  testWidgets('before the computers are read, Your devices counts none and '
      'is no row on its way', (tester) async {
    await pump(tester, backend(), computers: FakeComputers(null));

    expect(inside('swarm-you-devices', find.text('Your devices')), findsOne);
    expect(
      find.descendant(
        of: key('swarm-you-devices'),
        matching: find.textContaining('online'),
      ),
      findsNothing,
    );
    expect(find.byType(SwarmSkeletonRows), findsNothing);
  });

  testWidgets('out of sight, as under another tab, You draws nothing new, '
      'and what changed meanwhile once back', (tester) async {
    final computers = FakeComputers(const [studio, laptop]);
    final hidden = ValueNotifier(false);
    addTearDown(hidden.dispose);
    await pump(tester, backend(), computers: computers, hidden: hidden);
    expect(inside('swarm-you-devices', find.text('2 online')), findsOne);

    hidden.value = true;
    await tester.pump();
    computers.set(const [studio, laptop, mini]);
    await tester.pump();

    expect(inside('swarm-you-devices', find.text('2 online')), findsOne);

    hidden.value = false;
    await tester.pump();

    expect(
      inside('swarm-you-devices', find.text('2 online · 1 offline')),
      findsOne,
    );
  });

  testWidgets('Settings opens the phone\'s Settings', (tester) async {
    await pump(tester, backend());

    await tester.tap(key('swarm-you-settings'));
    await tester.pumpAndSettle();

    expect(settingsOpened, ['settings']);
  });

  testWidgets('a Swarm whose read is taken away while You is open leaves '
      'nothing of it: no name, no Swarm, no models', (tester) async {
    final fake = backend(models: threeModels);
    await pump(tester, fake);
    expect(inside('swarm-you-me', find.text('Autonomous')), findsOneWidget);

    Never refuse(_) => throw SuperTabFailure('FORBIDDEN', 'No access');
    fake.routes['/api/super-tabs/$tab/changes'] = refuse;
    fake.routes['/api/super-tabs/$tab/parts'] = refuse;
    await host.session!.inbox.reader(tab)!.refresh();
    await tester.pumpAndSettle();

    expect(find.text('Autonomous'), findsNothing);
    expect(find.text('tony'), findsNothing);
    expect(inside('swarm-you-me', find.text('You')), findsOneWidget);
    expect(find.textContaining('ready now'), findsNothing);
  });

  testWidgets('a read that fails shows You with no rows on their way', (
    tester,
  ) async {
    final fake = backend();
    fake.routes['/api/super-tabs/$tab/parts'] = (_) =>
        throw SuperTabFailure('UNAVAILABLE', 'Try again');
    await pump(tester, fake);

    expect(inside('swarm-you-me', find.text('You')), findsOneWidget);
    expect(find.byType(SwarmSkeletonRows), findsNothing);
    expect(find.textContaining('ready now'), findsNothing);
    for (final row in ['status', 'models', 'devices', 'settings']) {
      expect(key('swarm-you-$row'), findsOneWidget, reason: row);
    }
  });

  testWidgets('every row takes a thumb', (tester) async {
    await pump(
      tester,
      backend(models: threeModels),
      computers: FakeComputers(const [studio]),
    );

    for (final row in ['status', 'models', 'devices', 'settings']) {
      final size = tester.getSize(key('swarm-you-$row'));
      expect(size.height, greaterThanOrEqualTo(44), reason: row);
      expect(size.width, greaterThanOrEqualTo(44), reason: row);
    }
  });
}
