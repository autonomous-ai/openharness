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

/// Swarm Home and its drawer while they read, on a simulator, a screenshot
/// at each step: before the list answers (rows on their way in Needs you,
/// Chat with PM and the projects, and in the drawer); the Swarm read while
/// what waits on the person is still being read; then everything read.
///
/// Every answer is scripted in memory ([FakeSwarm]) and held until the step
/// that shows it: nothing reaches an account, a machine or the backend.
///
///     flutter drive -d <simulator> --driver=test_driver/journey_driver.dart \
///       --target=integration_test/swarm_home_loading_shots_test.dart
///
/// Screenshots land in `HARNESS_JOURNEY_OUT` (default `build/journey/`).
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Swarm Home and its drawer while they read', (tester) async {
    final walk = _Walk(tester, binding, 'home-loading');
    const web = 'project-2';
    final fake = FakeSwarm();
    Completer<void> held(String path, Object? Function() answer) {
      final gate = Completer<void>();
      fake.routes[path] = (_) async {
        await gate.future;
        return answer();
      };
      return gate;
    }

    final listed = held(
      '/api/super-tabs/list',
      () => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      },
    );
    final read = held(
      '/api/super-tabs/$tab/parts',
      () => firstLoad(
        derived: const {'decisionsWaiting': 1},
        head: headData(
          projects: [
            {
              'id': project,
              'name': 'Mobile',
              'ownerId': me,
              'leadConversationId': leadChat,
              'visibility': 'public',
              'members': <Object>[],
              'updateMinutes': 5,
            },
            {
              'id': web,
              'name': 'Web',
              'ownerId': me,
              'leadConversationId': 'group-lead-web',
              'visibility': 'public',
              'members': <Object>[],
              'updateMinutes': 5,
            },
          ],
        ),
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          agent('agent-builder', displayName: 'Nova'),
          {
            ...agent('agent-cleo', name: 'Lead', displayName: 'Cleo'),
            'projectId': web,
          },
        ],
        groups: [
          groupData(
            'g1',
            title: 'Fix login',
            number: 4,
            agentIds: ['agent-lead', 'agent-builder'],
            lastMessageSequence: 9,
          ),
          {
            ...groupData(
              'group-lead-web',
              title: 'Web',
              agentIds: ['agent-cleo'],
              leadId: 'agent-cleo',
            ),
            'projectId': web,
          },
        ],
      ),
    );
    final asked = held(
      '/api/super-tabs/$tab/decisions?state=open',
      () => {
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
      },
    );
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: const {'decisionsWaiting': 1});

    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
    )..foreground = false;
    addTearDown(host.dispose);
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

    await walk.waitFor(walk.key('swarm-projects-loading'));
    await walk.shot('home-before-list');
    await tester.tap(walk.key('swarm-menu'));
    await walk.shot('drawer-before-list');
    await tester.tap(walk.key('swarm-drawer-close'));
    await walk.wait();

    listed.complete();
    read.complete();
    await walk.waitFor(walk.key('swarm-project-$tab-$project'));
    expect(walk.key('swarm-needs-loading'), findsOneWidget);
    await walk.shot('home-asks-reading');

    asked.complete();
    await walk.waitFor(walk.key('swarm-need-decision:d1'));
    await walk.shot('home-read');
    await tester.tap(walk.key('swarm-menu'));
    await walk.shot('drawer-read');
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
