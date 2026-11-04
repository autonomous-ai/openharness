import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../test/swarm/swarm_fixture.dart';
import '../test/voice_fakes.dart' show MemoryKeyValueStore;

/// The app icon's count on a simulator, through the real notice centre and
/// its `harness/app_badge` bridge: a decision, a tag and work waiting on the
/// person, so the drawer's waiting badge and the icon both say 3. With
/// `--dart-define=SWARM_BADGE_STEP=clear` the person then signs out, and the
/// icon's count goes.
///
/// The icon is on the home screen, outside the app: the host takes that
/// screenshot once the run ends (`xcrun simctl io <sim> screenshot`). The OS
/// draws a count only once badges are allowed, so the notification prompt
/// this run shows is answered on the simulator.
///
/// Every answer is scripted in memory ([FakeSwarm]): nothing reaches an
/// account, a machine or the backend.
///
///     flutter drive -d <simulator> --driver=test_driver/journey_driver.dart \
///       --target=integration_test/swarm_icon_badge_shots_test.dart
///
/// Screenshots land in `HARNESS_JOURNEY_OUT` (default `build/journey/`).
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  const step = String.fromEnvironment(
    'SWARM_BADGE_STEP',
    defaultValue: 'count',
  );

  testWidgets("the app icon's count", (tester) async {
    final walk = _Walk(tester, binding, 'icon-badge-$step');
    final notices = LocalSystemNotices();
    // The prompt waits on the simulator until it is answered there, for up to
    // two minutes; the count is set whatever it says.
    unawaited(notices.requestPermission());
    for (var i = 0; i < 120 && await notices.enabled() != true; i++) {
      await Future<void>.delayed(const Duration(seconds: 1));
    }

    const derived = {'decisionsWaiting': 1, 'mentionsWaiting': 1};
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      derived: derived,
      agents: [
        agent('agent-lead', name: 'Lead', displayName: 'River'),
        agent('agent-builder', displayName: 'Nova'),
      ],
      groups: [
        {
          ...groupData('g1', title: 'Fix login', number: 4, status: 'blocked'),
          'assignment': {
            'id': 'attempt-g1',
            'agentId': 'agent-builder',
            'status': 'blocked',
            'result': 'No access to the repository.',
          },
        },
      ],
    );
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': [
        {
          'id': 'd1',
          'projectName': 'Mobile',
          'conversationId': 'g1',
          'conversationTitle': 'Fix login',
          'askerName': 'River',
          'question': 'Ship the login fix behind a flag?',
          'options': ['Yes', 'No'],
        },
      ],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': [
        {
          'id': 'm1',
          'projectName': 'Mobile',
          'conversationId': 'g1',
          'conversationTitle': 'Fix login',
          'messageId': 'msg-1',
          'leadName': 'River',
          'text': 'Can you check the copy?',
        },
      ],
    };

    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: notices,
      features: features,
    );
    // Ending the session is a sign-out, which takes the count off the icon:
    // the count step leaves it up for the home screen's screenshot.
    if (step == 'clear') addTearDown(host.dispose);
    await tester.pumpWidget(
      grid.BrightnessScope(
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          builder: (context, child) =>
              SwarmScope(notifier: host, child: child!),
          home: const SwarmPage(),
        ),
      ),
    );

    await walk.waitFor(walk.key('swarm-need-decision:d1'));
    expect(host.session!.inbox.needs, hasLength(3));
    await tester.tap(walk.key('swarm-menu'));
    await walk.shot('drawer');

    if (step == 'clear') {
      account.value = null;
      await walk.wait();
      expect(host.session, isNull);
    }
  });
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
