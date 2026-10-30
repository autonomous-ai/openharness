import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../test/swarm/swarm_fixture.dart';
import '../test/voice_fakes.dart' show MemoryKeyValueStore;

/// Reactions in a Swarm chat on a simulator, dark then light, a screenshot at
/// each step: the counts under messages with the reader's own marked, the
/// long-press picker, a pick counted at once, and a held count naming who
/// gave it.
///
/// Every answer is scripted in memory ([FakeSwarm]): nothing reaches an
/// account, a machine or the backend.
///
///     flutter drive -d <simulator> --driver=test_driver/journey_driver.dart \
///       --target=integration_test/swarm_reactions_shots_test.dart
///
/// Screenshots land in `HARNESS_JOURNEY_OUT` (default `build/journey/`).
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
    final mode = palette.brightness == Brightness.dark ? 'dark' : 'light';
    testWidgets('reactions in a chat, $mode', (tester) async {
      grid.AppTheme.palette.value = palette;
      grid.AppTheme.brightness.value = palette.brightness;
      addTearDown(() {
        grid.AppTheme.palette.value = HarnessPalette.graphite;
        grid.AppTheme.brightness.value = Brightness.dark;
      });
      final walk = _Walk(tester, binding, 'reactions-$mode');
      const conversation = 'g-build';
      const messages =
          '/api/super-tabs/$tab/conversations/$conversation/messages';
      final now = DateTime.now();
      var picked = false;
      Map<String, dynamic> message(
        String id,
        int sequence,
        int minute,
        String text, {
        String author = 'agent-lead',
        Map<String, List<(String, String)>> reactions = const {},
      }) => {
        'id': id,
        'conversationId': conversation,
        'text': text,
        'sequence': sequence,
        'author': author == me
            ? {'kind': 'person', 'id': me, 'name': 'Tony'}
            : {
                'kind': 'agent',
                'id': author,
                'name': author == 'agent-lead' ? 'River' : 'Jasper',
              },
        'attachments': <Object>[],
        'reactions': [
          for (final MapEntry(key: emoji, value: by) in reactions.entries)
            {
              'emoji': emoji,
              'count': by.length,
              'by': [
                for (final (kind, who) in by) {'kind': kind, 'id': who},
              ],
            },
        ],
        'createdAt': DateTime(
          now.year,
          now.month,
          now.day,
          11,
          minute,
        ).toUtc().toIso8601String(),
      };
      List<Map<String, dynamic>> page() => [
        // Agents acknowledge as Slack bots do: River's ✅ on the question it
        // answered, Jasper's 👀 on the plan it is starting.
        message(
          'm1',
          1,
          20,
          'Where are we on the phone build?',
          author: me,
          reactions: {
            'check': [('agent', 'agent-lead')],
          },
        ),
        message(
          'm2',
          2,
          24,
          'Build 214 is green on CI. Kai runs the iPhone test after lunch.',
          reactions: {
            'thumbs_up': [('person', me), ('person', 'person-diego')],
            'rocket': [('agent', 'agent-jasper')],
          },
        ),
        message(
          'm3',
          3,
          31,
          'Jasper fixed the three review findings.',
          author: 'agent-jasper',
          reactions: {
            'tada': [
              ('agent', 'agent-lead'),
              ('person', 'person-diego'),
              if (picked) ('person', me),
            ],
            'eyes': [('person', 'person-diego')],
          },
        ),
        message(
          'm4',
          4,
          33,
          'Jasper: add ✅ to the phone picker next.',
          reactions: {
            'eyes': [('agent', 'agent-jasper')],
          },
        ),
      ];

      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(
          agents: [
            agent('agent-lead', name: 'Lead', displayName: 'River'),
            agent('agent-jasper', displayName: 'Jasper'),
          ],
          groups: [
            groupData(
              conversation,
              title: 'Phone build',
              agentIds: ['agent-lead', 'agent-jasper'],
              status: 'working',
              workerId: 'agent-jasper',
              lastMessageSequence: 4,
            ),
          ],
        ),
        'members': [
          part(me, 1, person(me)),
          part('person-diego', 1, person('person-diego', role: 'collaborator')),
        ],
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      fake.routes[messages] = (_) => {
        'messages': page().reversed.toList(),
        'next': null,
        'reactionSeq': picked ? 1 : 0,
      };
      fake.routes['/api/super-tabs/$tab/commands'] = (_) {
        picked = true;
        return {'result': <String, dynamic>{}};
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
            theme: grid.buildAppTheme(brightness: palette.brightness),
            builder: (context, child) =>
                SwarmScope(notifier: host, child: child!),
            home: const SwarmConversationPage(
              swarmId: tab,
              conversationId: conversation,
            ),
          ),
        ),
      );
      await walk.waitFor(walk.key('swarm-reaction-m2-thumbs_up'));
      await walk.shot('counts');

      await tester.longPress(
        find.text('Jasper fixed the three review findings.'),
      );
      await walk.shot('picker');

      await tester.tap(walk.key('swarm-react-tada'));
      await walk.shot('picked');

      await tester.longPress(walk.key('swarm-reaction-m3-tada'));
      await walk.shot('who-reacted', settle: 300);
      await walk.wait(2500);
    });
  }
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
