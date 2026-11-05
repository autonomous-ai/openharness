import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../test/swarm/swarm_fixture.dart';
import '../test/voice_fakes.dart' show MemoryKeyValueStore;

/// Swarm Home as anh Dee's mockup draws it (2026-11-04), on a simulator, in
/// dark then light: the need-you line, one heading per Swarm, an unread
/// project with its dot, the + in the top bar; then the Swarm switcher, with
/// Sort and filter.
///
/// Every answer is scripted in memory ([FakeSwarm]): nothing reaches an
/// account, a machine or the backend.
///
///     flutter drive -d <simulator> --driver=test_driver/journey_driver.dart \
///       --target=integration_test/swarm_home_simple_shots_test.dart
///
/// Screenshots land in `HARNESS_JOURNEY_OUT` (default `build/journey/`).
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Swarm Home, simplified, in both themes', (tester) async {
    const personal = 'tab-personal';
    Map<String, dynamic> projectOf(String id, String name) => {
      'id': id,
      'name': name,
      'ownerId': me,
      'leadConversationId': 'lead-$id',
      'visibility': 'public',
      'members': <Object>[],
      'updateMinutes': 5,
    };
    final now = DateTime.now();
    Map<String, dynamic> leadOf(String projectId, {int sequence = 0}) => {
      ...groupData(
        'lead-$projectId',
        title: projectId,
        lastMessageSequence: sequence,
      ),
      'projectId': projectId,
    };
    // When each chat last changed, on its part, as a read carries it.
    Map<String, dynamic> timed(
      Map<String, dynamic> load,
      Map<String, int> minutesAgo,
    ) => {
      ...load,
      'groups': [
        for (final part in load['groups'] as List)
          {
            ...part as Map<String, dynamic>,
            if (minutesAgo[part['key']] case final ago?)
              'changedAt': now
                  .subtract(Duration(minutes: ago))
                  .millisecondsSinceEpoch,
          },
      ],
    };
    FakeSwarm backend() {
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'autonomous.ai', 'ownerId': me},
          {'id': personal, 'name': 'Personal', 'ownerId': me},
        ],
        'next': null,
      };
      const derived = {'decisionsWaiting': 2};
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => timed(
        firstLoad(
          derived: derived,
          head: headData(
            name: 'autonomous.ai',
            projects: [
              for (final name in [
                'openharness',
                'spaceship',
                'lamp',
                'computer',
              ])
                projectOf(name, name),
            ],
          ),
          groups: [
            leadOf('openharness', sequence: 4),
            leadOf('spaceship'),
            leadOf('lamp'),
            leadOf('computer'),
          ],
        ),
        {
          'lead-openharness': 2,
          'lead-spaceship': 20,
          'lead-lamp': 40,
          'lead-computer': 60,
        },
      );
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2', derived: derived);
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': [
          for (final (id, question) in [
            ('d1', 'Ship the login fix behind a flag?'),
            ('d2', 'Merge the voice messages batch?'),
          ])
            {
              'id': id,
              'projectName': 'spaceship',
              'conversationId': 'lead-spaceship',
              'conversationTitle': 'spaceship',
              'askerName': 'River',
              'question': question,
              'options': ['Yes', 'No'],
            },
        ],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      fake.routes['/api/super-tabs/$personal/parts'] = (_) => timed(
        firstLoad(
          tabId: personal,
          head: headData(
            id: personal,
            name: 'Personal',
            projects: [projectOf('storage', 'storage')],
          ),
          groups: [leadOf('storage')],
        ),
        {'lead-storage': 90},
      );
      fake.routes['/api/super-tabs/$personal/changes'] = (_) =>
          changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$personal/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$personal/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/conversations/'] = (_) => {
        'messages': <Object>[],
        'next': null,
      };
      return fake;
    }

    Finder key(String value) => find.byKey(ValueKey(value));
    Future<void> settle() async {
      for (var i = 0; i < 12; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      final fake = backend();
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: features,
        readMarks: MemoryKeyValueStore(),
      )..foreground = false;
      await tester.pumpWidget(
        MaterialApp(
          key: UniqueKey(),
          debugShowCheckedModeBanner: false,
          theme: buildAppTheme(brightness: brightness),
          builder: (_, child) => SwarmScope(notifier: host, child: child!),
          home: const SwarmPage(),
        ),
      );
      for (
        var i = 0;
        i < 100 && key('swarm-need-line').evaluate().isEmpty;
        i++
      ) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      // Read once: what was there is read; then openharness moves on.
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        derived: const {'decisionsWaiting': 2},
        groups: [
          {
            ...part('lead-openharness', 30, leadOf('openharness', sequence: 6)),
            'changedAt': now.millisecondsSinceEpoch,
          },
        ],
      );
      await host.session!.inbox.refresh();
      await settle();
      expect(key('swarm-project-$tab-openharness'), findsOneWidget);
      await binding.takeScreenshot('home-simple-home-${brightness.name}');
      await tester.tap(key('swarm-title-button'));
      await settle();
      await binding.takeScreenshot('home-simple-switcher-${brightness.name}');
      await tester.pumpWidget(const SizedBox());
      host.dispose();
      account.dispose();
    }
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  });
}
