import 'dart:async';

import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/appearance_prefs_store.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_devices_page.dart';
import 'package:harness_mobile/swarm/swarm_models_page.dart';
import 'package:harness_mobile/swarm/swarm_profile_sheet.dart';
import 'package:harness_mobile/swarm/swarm_row.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_start.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';
import 'package:harness_mobile/swarm/swarm_you_page.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../voice_fakes.dart';
import 'swarm_computers_fake.dart';
import 'swarm_fixture.dart';

/// The phone's notice centre, counting each time it is asked to notify.
class _AskedNotices extends SilentSystemNotices {
  var asked = 0;

  @override
  Future<bool?> requestPermission() async {
    asked++;
    return null;
  }
}

/// You, as Tony's prototype C4 draws it (2026-10-30): who the person is in
/// the Swarm Home shows, which opens their profile; Your models and Your
/// devices with what is ready; and Notifications, Theme and Settings.
void main() {
  /// The Swarms [swarms], each with the person as tony@example.com, [status]
  /// and [name] set when given, its models on, and [models] served by the person's
  /// machine Studio, read just now; and [others], more machines read just
  /// now, as given.
  FakeSwarm backend({
    List<Map<String, dynamic>> models = const [],
    List<Map<String, dynamic>> others = const [],
    Map<String, dynamic>? status,
    String? name,
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
            'name': ?name,
            'status': ?status,
          }),
        ];
        data['machines'] = [
          part('mac-1', 1, {
            'machineId': 'mac-1',
            'name': 'Studio',
            'contributorId': me,
            'observation': {
              'receivedAt': DateTime.now().millisecondsSinceEpoch,
              'localModels': [
                for (final m in models) {'grid': 'grid-${s.id}', ...m},
              ],
            },
          }),
          for (final m in others)
            part(m['machineId'] as String, 1, {
              ...m,
              'observation': {
                'receivedAt': DateTime.now().millisecondsSinceEpoch,
                'localModels': [
                  for (final model in m['models'] as List)
                    {'grid': 'grid-${s.id}', ...model as Map},
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
  late AppearancePrefsStore appearance;

  /// You under a Swarm that is on, on an iPhone's screen; its Notifications
  /// on [notices] when given, its Theme on a store of its own.
  Future<void> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    SwarmComputers? computers,
    ValueListenable<bool>? hidden,
    SystemNotices? notices,
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
    appearance = AppearancePrefsStore(storage: MemoryKeyValueStore());
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        onGenerateRoute: (_) => CupertinoPageRoute<void>(
          builder: (_) {
            final page = SwarmYouPage(
              onSettings: (_) => settingsOpened.add('settings'),
              notices: notices,
              appearance: appearance,
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
  SwarmOwnComputer own(SwarmComputer computer) =>
      (id: computer.name, name: computer.name, away: computer.away);
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

  testWidgets('who you are: your face, your name and your Swarm, and a tap '
      'there opens your profile', (tester) async {
    await pump(tester, backend());

    expect(
      tester.widget<Text>(find.byKey(const ValueKey('swarm-title'))).data,
      'You',
    );
    expect(inside('swarm-you-me', find.text('tony')), findsOneWidget);
    expect(inside('swarm-you-me', find.text('Autonomous')), findsOneWidget);
    expect(inside('swarm-you-me', find.byType(SwarmAvatar)), findsOneWidget);
    expect(
      inside('swarm-you-me', find.byIcon(LucideIcons.chevronRight300)),
      findsOneWidget,
      reason: 'it says it opens',
    );
    expect(
      tester.getSemantics(key('swarm-you-me')),
      isSemantics(isButton: true, hasTapAction: true),
    );

    await tester.tap(key('swarm-you-me'));
    await tester.pumpAndSettle();

    expect(find.byType(SwarmProfileSheet), findsOneWidget);
  });

  testWidgets('nothing under the header opens the profile again: no Profile, '
      'no Username, no status line, no Change', (tester) async {
    await pump(
      tester,
      backend(
        name: 'Minh Nguyen',
        status: {'text': 'Focusing', 'emoji': '🎯'},
      ),
    );

    expect(inside('swarm-you-me', find.text('Minh Nguyen')), findsOne);
    expect(find.byType(SwarmCaption), findsNothing);
    for (final gone in ['profile', 'username', 'status', 'name']) {
      expect(key('swarm-you-$gone'), findsNothing, reason: gone);
    }
    expect(find.byIcon(LucideIcons.atSign300), findsNothing);
    expect(find.text('Change'), findsNothing);
    expect(find.text('🎯 Focusing'), findsNothing);
  });

  testWidgets('under the header: Your models and Your devices, then '
      'Notifications, Theme and Settings in one card', (tester) async {
    await pump(tester, backend(), notices: _AskedNotices());

    double top(String row) => tester.getTopLeft(key('swarm-you-$row')).dy;
    final order = ['me', 'models', 'devices', 'notifications', 'theme'];
    for (final (i, row) in order.indexed) {
      expect(
        top(row),
        lessThan(top(i + 1 < order.length ? order[i + 1] : 'settings')),
        reason: row,
      );
    }
    SwarmGroup cardOf(String row) => tester.widget<SwarmGroup>(
      find.ancestor(of: key('swarm-you-$row'), matching: find.byType(SwarmGroup)),
    );
    expect(cardOf('notifications'), same(cardOf('settings')));
    expect(cardOf('theme'), same(cardOf('settings')));
    expect(cardOf('models'), same(cardOf('devices')));
    expect(cardOf('models'), isNot(same(cardOf('settings'))));
    // Drawn as You's own rows, each led by its glyph.
    for (final (row, glyph) in [
      ('notifications', LucideIcons.bell300),
      ('theme', LucideIcons.sunMoon300),
    ]) {
      expect(inside('swarm-you-$row', find.byType(SwarmRow)), findsOne);
      expect(inside('swarm-you-$row', find.byIcon(glyph)), findsOne);
    }
  });

  testWidgets('Notifications asks the phone, with no line under it', (
    tester,
  ) async {
    final notices = _AskedNotices();
    await pump(tester, backend(), notices: notices);

    expect(
      inside('swarm-you-notifications', find.text('Notifications')),
      findsOne,
    );
    expect(
      inside('swarm-you-notifications', find.textContaining('needs you')),
      findsNothing,
    );
    await tester.tap(key('swarm-you-notifications'));
    await tester.pumpAndSettle();
    expect(notices.asked, 1);
  });

  testWidgets('with no notice centre to ask, as in the sample, Notifications '
      'is no row', (tester) async {
    await pump(tester, backend());

    expect(key('swarm-you-notifications'), findsNothing);
    expect(find.text('Notifications'), findsNothing);
    expect(key('swarm-you-theme'), findsOne);
  });

  testWidgets('Theme: System, Dark and Light, and a tap keeps the choice', (
    tester,
  ) async {
    await pump(tester, backend());

    for (final label in ['System', 'Dark', 'Light']) {
      expect(inside('swarm-you-theme', find.text(label)), findsOne);
    }
    await tester.tap(inside('swarm-you-theme', find.text('Light')));
    await tester.pumpAndSettle();
    expect(appearance.value.themeMode, AppThemeMode.light);
  });

  testWidgets('a long name and Swarm stay on one line each, the chevron and '
      'Theme on screen, on a small phone at large text', (tester) async {
    const name = 'Maximilian Alexander Featherstonehaugh-Wolfeschlegel';
    const swarm = 'The Autonomous Research and Design Laboratory';
    await pump(
      tester,
      backend(name: name, swarms: const [(id: tab, name: swarm)]),
    );
    tester.view.physicalSize = const Size(960, 1704);
    tester.platformDispatcher.textScaleFactorTestValue = 1.6;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    final header = tester.getRect(key('swarm-you-me'));
    expect(header.right, lessThanOrEqualTo(320));
    expect(
      tester
          .getRect(
            inside('swarm-you-me', find.byIcon(LucideIcons.chevronRight300)),
          )
          .right,
      lessThanOrEqualTo(header.right),
    );
    for (final line in [name, swarm]) {
      expect(
        tester.widget<Text>(inside('swarm-you-me', find.text(line))).maxLines,
        1,
        reason: line,
      );
    }
    expect(tester.getRect(key('swarm-you-theme')).right, lessThanOrEqualTo(320));
  });

  testWidgets('a status set is the profile\'s, not a line on You', (
    tester,
  ) async {
    await pump(
      tester,
      backend(status: {'text': 'In a meeting', 'emoji': '📅'}),
    );
    expect(find.text('📅 In a meeting'), findsNothing);
    expect(find.text('Active'), findsNothing);

    await tester.tap(key('swarm-you-me'));
    await tester.pumpAndSettle();
    expect(
      find.descendant(
        of: find.byType(SwarmProfileSheet),
        matching: find.text('📅 In a meeting'),
      ),
      findsOneWidget,
    );
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

  testWidgets('Your models counts only what the person\'s own machines '
      'offer: not a teammate\'s, nor their Harness Team account\'s; and '
      'opens on those alone', (tester) async {
    await pump(
      tester,
      backend(
        models: [threeModels[1]],
        others: [
          {
            'machineId': 'mac-ken',
            'name': 'Ken Workstation',
            'contributorId': 'ken',
            'models': [
              {'model': 'gemma-4', 'name': 'Gemma 4', 'kind': 'local'},
              {'model': 'mistral-9', 'name': 'Mistral 9', 'kind': 'shared'},
            ],
          },
          {
            // The person's Harness Team account on Studio: it runs
            // teammates' work.
            'machineId': 'team-1',
            'name': 'Harness Team',
            'contributorId': me,
            'hostMachineId': 'mac-1',
            'models': [
              {'model': 'phi-5', 'name': 'Phi 5', 'kind': 'local'},
            ],
          },
        ],
      ),
    );

    expect(inside('swarm-you-models', find.text('1 ready now')), findsOne);

    await tester.tap(key('swarm-you-models'));
    await tester.pumpAndSettle();

    expect(find.text('Qwen3 Coder'), findsOneWidget);
    for (final theirs in [
      'Gemma 4',
      'Mistral 9',
      'Phi 5',
      'Ken Workstation',
      'Harness Team',
    ]) {
      expect(find.textContaining(theirs), findsNothing, reason: theirs);
    }
  });

  testWidgets('Your models with one, and with none running', (tester) async {
    await pump(tester, backend(models: [threeModels[1]]));
    expect(inside('swarm-you-models', find.text('1 ready now')), findsOne);

    await pump(tester, backend());
    expect(inside('swarm-you-models', find.text('None ready now')), findsOne);
  });

  testWidgets('Your devices counts the person\'s own computers online and '
      'offline, follows them, and opens them', (tester) async {
    final computers = FakeComputers(const [studio, laptop, mini])
      ..own = [own(studio), own(laptop), own(mini)];
    await pump(tester, backend(), computers: computers);

    expect(
      inside('swarm-you-devices', find.text('2 online · 1 offline')),
      findsOneWidget,
    );

    computers
      ..own = [own(studio)]
      ..set(const [studio]);
    await tester.pump();
    expect(inside('swarm-you-devices', find.text('1 online')), findsOne);

    computers
      ..own = []
      ..set(const []);
    await tester.pump();
    expect(
      inside('swarm-you-devices', find.text('No computers yet')),
      findsOne,
    );

    await tester.tap(key('swarm-you-devices'));
    await tester.pumpAndSettle();
    expect(find.byType(SwarmDevicesPage), findsOneWidget);
  });

  testWidgets('Your devices counts none shared with the person, nor a Harness '
      'Team account, nor one waiting for a link: of five on the account, '
      'their own two', (tester) async {
    const shared = (name: 'Ken MacBook', away: false);
    const team = (name: 'Harness Team', away: false);
    const unlinked = (name: 'New Mac', away: true);
    final computers = FakeComputers(const [
      studio,
      mini,
      shared,
      team,
      unlinked,
    ])..own = [own(studio), own(mini)];
    await pump(tester, backend(), computers: computers);

    expect(
      inside('swarm-you-devices', find.text('1 online · 1 offline')),
      findsOneWidget,
    );
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
    final computers = FakeComputers(const [studio, laptop])
      ..own = [own(studio), own(laptop)];
    final hidden = ValueNotifier(false);
    addTearDown(hidden.dispose);
    await pump(tester, backend(), computers: computers, hidden: hidden);
    expect(inside('swarm-you-devices', find.text('2 online')), findsOne);

    hidden.value = true;
    await tester.pump();
    computers
      ..own = [own(studio), own(laptop), own(mini)]
      ..set(const [studio, laptop, mini]);
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
    expect(
      inside('swarm-you-me', find.byIcon(LucideIcons.chevronRight300)),
      findsNothing,
      reason: 'no way in',
    );
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
    for (final row in ['models', 'devices', 'theme', 'settings']) {
      expect(key('swarm-you-$row'), findsOneWidget, reason: row);
    }
    expect(
      inside('swarm-you-me', find.byIcon(LucideIcons.chevronRight300)),
      findsNothing,
    );

    await tester.tap(key('swarm-you-me'));
    await tester.pumpAndSettle();
    expect(find.byType(SwarmProfileSheet), findsNothing);
  });

  testWidgets('every row takes a thumb', (tester) async {
    await pump(
      tester,
      backend(models: threeModels),
      computers: FakeComputers(const [studio])..own = [own(studio)],
      notices: _AskedNotices(),
    );

    for (final row in [
      'me',
      'models',
      'devices',
      'notifications',
      'theme',
      'settings',
    ]) {
      final size = tester.getSize(key('swarm-you-$row'));
      expect(size.height, greaterThanOrEqualTo(44), reason: row);
      expect(size.width, greaterThanOrEqualTo(44), reason: row);
    }
  });
}
