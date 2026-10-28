import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../test/swarm/swarm_fixture.dart';
import '../test/voice_fakes.dart' show MemoryKeyValueStore;

/// A Swarm project page while it reads, on a simulator, a screenshot at each
/// step: its header and line on their way while the Swarm is read, its sheet's
/// work and team then, the page read on its project chat, a pull in the sheet,
/// and hundreds of older chats opened.
///
/// Every answer is scripted in memory ([FakeSwarm]) and held until the step
/// that shows it: nothing reaches an account, a machine or the backend.
///
///     flutter drive -d <simulator> --driver=test_driver/journey_driver.dart \
///       --target=integration_test/swarm_project_loading_shots_test.dart
///
/// Screenshots land in `HARNESS_JOURNEY_OUT` (default `build/journey/`).
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('a Swarm project page while it reads', (tester) async {
    final walk = _Walk(tester, binding, 'project-loading');
    final fake = FakeSwarm();
    Completer<void> held(String path, Object? Function() answer) {
      final gate = Completer<void>();
      fake.routes[path] = (_) async {
        await gate.future;
        return answer();
      };
      return gate;
    }

    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    final read = held(
      '/api/super-tabs/$tab/parts',
      () => firstLoad(
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          agent('agent-builder', displayName: 'Nova'),
          agent('agent-reviewer', name: 'Reviewer', displayName: 'Ken'),
        ],
        groups: [
          groupData(
            leadChat,
            title: 'Mobile',
            agentIds: ['agent-lead'],
            leadId: 'agent-lead',
          ),
          // Work held by an agent, as work going on is: its avatar and a
          // line under its title.
          for (final (i, (title, worker)) in [
            ('Fix login', 'agent-builder'),
            ('Skeleton rows on Home', 'agent-reviewer'),
            ('Lazy project list', 'agent-builder'),
          ].indexed)
            groupData(
              'g$i',
              title: title,
              number: 4 + i,
              agentIds: ['agent-lead', worker],
              status: 'working',
              workerId: worker,
              lastMessageSequence: 9 - i,
            ),
        ],
      ),
    );
    fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] =
        (_) => {
          'messages': [
            {
              'id': 'm1',
              'conversationId': leadChat,
              'text': 'Morning: Fix login is next, then the skeleton rows.',
              'sequence': 1,
              'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
              'createdAt': '2026-10-28T01:00:00.000Z',
            },
          ],
          'next': null,
        };
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    Completer<void>? pulled;
    fake.routes['/api/super-tabs/$tab/changes'] = (_) async {
      await pulled?.future;
      return changes(cursor: 'c2');
    };
    fake.routes['/api/super-tabs/$tab/groups?dormant=1&projectId=$project'] =
        (_) => {
          'groups': [
            for (var i = 0; i < 300; i++)
              part(
                'old-$i',
                100 + i,
                groupData(
                  'old-$i',
                  title: 'Old work ${300 - i}',
                  lastMessageSequence: 1000 - i,
                  dormant: true,
                ),
              ),
          ],
          'next': null,
        };

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
          home: Builder(
            builder: (context) => Stack(
              children: [
                const SwarmProjectPage(swarmId: tab, projectId: project),
                // The sheet as the page opens it, before the page can.
                Positioned(
                  right: 0,
                  bottom: 0,
                  child: SizedBox.square(
                    key: const ValueKey('shots-sheet'),
                    dimension: 1,
                    child: GestureDetector(
                      onTap: () => showSwarmProjectSheet(
                        context,
                        swarmId: tab,
                        projectId: project,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );

    await walk.waitFor(walk.key('swarm-project-loading'));
    expect(find.text('This project is no longer in the Swarm.'), findsNothing);
    await walk.shot('page-reading');
    await tester.tap(walk.key('shots-sheet'), warnIfMissed: false);
    await walk.waitFor(walk.key('swarm-work-loading'));
    await walk.shot('work-reading');
    await tester.tap(walk.key('swarm-sheet-team'));
    await walk.waitFor(walk.key('swarm-team-loading'));
    await walk.shot('team-reading');

    read.complete();
    await walk.waitFor(walk.key('swarm-agent-agent-builder'));
    await walk.shot('team-read');
    await tester.tap(walk.key('swarm-team-close'));
    await walk.waitFor(walk.key('swarm-pm-chat'));
    await walk.waitFor(find.textContaining('Fix login is next'));
    await walk.shot('page-read');

    // The sheet's work: a pull reads the Swarm again, then the older chats.
    await tester.tap(walk.key('swarm-team-line'));
    await walk.waitFor(walk.key('swarm-conversation-g0'));
    pulled = Completer<void>();
    await tester.fling(
      walk.key('swarm-conversation-g0'),
      const Offset(0, 300),
      1000,
    );
    await walk.shot('work-pulled', settle: 500);
    pulled.complete();
    await walk.wait();

    final sheetList = find
        .descendant(
          of: find.byType(SwarmProjectSheet),
          matching: find.byType(Scrollable),
        )
        .first;
    await tester.tap(walk.key('swarm-older'));
    await walk.waitFor(walk.key('swarm-conversation-old-0'));
    await tester.drag(sheetList, const Offset(0, -500));
    await walk.shot('older-open');
    await tester.scrollUntilVisible(
      walk.key('swarm-conversation-old-299'),
      600,
      maxScrolls: 100,
      scrollable: sheetList,
    );
    await walk.shot('older-last');
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
