import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Swarm Home on opening the app: the signed-in shell is up before the account
/// is read, and that is no reason to say Swarm is off.
void main() {
  Finder key(String value) => find.byKey(ValueKey(value));

  Future<void> frames(WidgetTester tester) async {
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad();
    return fake;
  }

  Future<SwarmHost> pump(
    WidgetTester tester, {
    required ValueNotifier<String?> account,
    bool Function()? reading,
    ExperimentalFeaturesStore? features,
  }) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final host = SwarmHost(
      accountId: () => account.value,
      accountReading: reading,
      account: account,
      request: backend().request,
      notices: SilentSystemNotices(),
      features:
          features ??
          (ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
            ..value = {PhoneExperiment.swarm}),
      readMarks: MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmPage(),
      ),
    );
    await frames(tester);
    return host;
  }

  testWidgets('while the account is on its way, Home is skeletons and never '
      'says Swarm is off', (tester) async {
    final account = ValueNotifier<String?>(null);
    final host = await pump(tester, account: account, reading: () => true);

    expect(host.session, isNull);
    expect(key('swarm-unavailable'), findsNothing);
    expect(find.textContaining('Swarm is off'), findsNothing);
    expect(key('swarm-title-loading'), findsOneWidget);
    expect(key('swarm-title'), findsNothing);
    expect(key('swarm-projects-loading'), findsOneWidget);
  });

  testWidgets('the account read: the Swarm comes where its skeleton was', (
    tester,
  ) async {
    final account = ValueNotifier<String?>(null);
    var reading = true;
    final host = await pump(tester, account: account, reading: () => reading);
    final title = tester.getTopLeft(key('swarm-title-loading'));
    final rows = tester.getTopLeft(key('swarm-projects-loading'));

    reading = false;
    account.value = me;
    await tester.pumpAndSettle();

    expect(host.session, isNotNull);
    expect(key('swarm-account-coming'), findsNothing);
    expect(key('swarm-unavailable'), findsNothing);
    expect(tester.widget<Text>(key('swarm-title')).data, 'Phone Swarm');
    expect(tester.getTopLeft(key('swarm-title')).dx, closeTo(title.dx, .01));
    expect(
      tester.getTopLeft(key('swarm-project-$tab-$project')).dx,
      closeTo(rows.dx, .01),
    );
  });

  testWidgets('a kept account opens Swarm with no skeleton of the account, and '
      'the account naming another starts over', (tester) async {
    final account = ValueNotifier<String?>(me);
    final host = await pump(tester, account: account, reading: () => false);
    final kept = host.session;

    expect(kept?.accountId, me);
    expect(key('swarm-account-coming'), findsNothing);
    expect(key('swarm-unavailable'), findsNothing);

    account.value = 'someone-else';
    await frames(tester);

    expect(host.session?.accountId, 'someone-else');
    expect(identical(host.session, kept), isFalse);
  });

  testWidgets('a tap on the title with no account yet does nothing', (
    tester,
  ) async {
    await pump(
      tester,
      account: ValueNotifier<String?>(null),
      reading: () => true,
    );

    await tester.tap(key('swarm-title-button'));
    await frames(tester);

    expect(tester.takeException(), isNull);
    expect(key('swarm-switch-join'), findsNothing);
  });

  testWidgets('with Swarm off, says so even while the account is read', (
    tester,
  ) async {
    await pump(
      tester,
      account: ValueNotifier<String?>(null),
      reading: () => true,
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore()),
    );

    expect(key('swarm-unavailable'), findsOneWidget);
    expect(key('swarm-title-loading'), findsNothing);
    expect(key('swarm-projects-loading'), findsNothing);
  });

  testWidgets('signed out, says so: no account is coming', (tester) async {
    await pump(
      tester,
      account: ValueNotifier<String?>(null),
      reading: () => false,
    );

    expect(key('swarm-unavailable'), findsOneWidget);
    expect(key('swarm-title-loading'), findsNothing);
  });

  testWidgets('where nobody can tell an account is coming, says so', (
    tester,
  ) async {
    await pump(tester, account: ValueNotifier<String?>(null));

    expect(key('swarm-unavailable'), findsOneWidget);
    expect(key('swarm-title-loading'), findsNothing);
  });

  testWidgets('Swarm turned on while the account is read: the skeletons, at '
      'once', (tester) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore());
    await pump(
      tester,
      account: ValueNotifier<String?>(null),
      reading: () => true,
      features: features,
    );
    expect(key('swarm-unavailable'), findsOneWidget);

    await features.set(PhoneExperiment.swarm, true);
    await frames(tester);

    expect(key('swarm-unavailable'), findsNothing);
    expect(key('swarm-projects-loading'), findsOneWidget);
  });
}
