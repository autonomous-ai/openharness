import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_home_cache.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/waiting_work.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// A cold start draws the last Home at once, before any computer answers
/// (owner, 2026-10-27: 4 to 5 seconds of "Reading your Swarms…" on the
/// iPhone 14), then reads.
void main() {
  /// The Home kept: project Mobile, its Product Manager River, Nova waiting
  /// on the person in Fix login.
  SwarmHomeEntry kept() {
    final state = SuperTabParts.firstLoad(
      firstLoad(
        groups: [
          {
            ...groupData(
              'g1',
              title: 'Fix login',
              number: 4,
              agentIds: ['agent-builder'],
              status: 'needs_human',
            ),
            'partnerId': me,
          },
        ],
      ),
    ).state;
    return (
      id: tab,
      name: 'Phone Swarm',
      view: swarmHomeSwarm(
        SuperTabSnapshot.fromJson(state),
        swarmPartners(state),
      ),
    );
  }

  testWidgets(
    'a cold start draws the Home kept before the first read answers',
    (tester) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      final cache = memoryHomeCache();
      await tester.runAsync(() => cache.write(me, [kept()]));
      // No computer answers: the list never comes back.
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => Completer<Object?>().future;
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
          ..value = {PhoneExperiment.swarm},
        homeCache: cache,
      );
      addTearDown(host.dispose);

      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) =>
              SwarmScope(notifier: host, child: child!),
          home: const SwarmPage(),
        ),
      );
      // The kept view is read off disk: real time, then a frame, until it is.
      for (var i = 0; i < 100 && host.session!.inbox.swarms.isEmpty; i++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 10)),
        );
        await tester.pump();
      }

      await tester.pump();

      expect(
        find.byKey(const ValueKey('swarm-project-$tab-$project')),
        findsOneWidget,
      );
      expect(find.text('Mobile'), findsWidgets);
      expect(find.text('River'), findsOneWidget, reason: 'its Chat with PM');
      expect(find.textContaining('Fix login'), findsOneWidget);
      expect(host.session!.inbox.loaded, isFalse, reason: 'nothing read yet');
      expect(fake.paths, ['/api/super-tabs/list']);
    },
  );
}
