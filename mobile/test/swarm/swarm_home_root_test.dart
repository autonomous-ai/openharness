import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_drawer.dart';
import 'package:harness_mobile/swarm/swarm_home_root.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import '../widget_rebuilds.dart';
import 'swarm_fixture.dart';

/// Swarm Home and Harness side by side at the root: going to Harness and back
/// finds Home as it was left, and Home out of sight costs nothing and mutes
/// no notice.
void main() {
  /// One Swarm with more projects than fit on the screen, and one decision
  /// waiting on the person.
  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    const derived = {'decisionsWaiting': 1, 'mentionsWaiting': 0};
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      derived: derived,
      head: headData(
        projects: [
          for (var i = 0; i < 10; i++)
            {
              'id': 'project-$i',
              'name': 'Project $i',
              'ownerId': me,
              'leadConversationId': 'lead-$i',
              'visibility': 'public',
              'members': <Object>[],
              'updateMinutes': 5,
            },
        ],
      ),
      agents: [agent('agent-lead', name: 'Lead', displayName: 'River')],
    );
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': [
        {
          'id': 'd1',
          'conversationId': 'g9',
          'askerName': 'River',
          'question': 'Ship it?',
          'options': ['Yes', 'No'],
        },
      ],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    return fake;
  }

  late FakeSwarm fake;
  late _Notices notices;
  late SwarmHost host;
  late SwarmHomeChoice choice;

  Future<void> pump(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    fake = backend();
    notices = _Notices();
    host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: notices,
      features: features,
    )..foreground = false;
    addTearDown(host.dispose);
    choice = SwarmHomeChoice(features);
    addTearDown(choice.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: SwarmHomeRoot(
          choice: choice,
          harness: const Text('the terminal'),
          swarm: (_) => SwarmPage(onHarness: choice.showHarness),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  Future<void> toHarnessAndBack(WidgetTester tester) async {
    choice.showHarness();
    await tester.pumpAndSettle();
    expect(find.byType(SwarmPage), findsNothing);
    choice.showSwarm();
    await tester.pumpAndSettle();
  }

  Finder homeList() => find.descendant(
    of: find.byType(SwarmPage),
    matching: find.byType(Scrollable),
  );

  double offset(WidgetTester tester) =>
      tester.state<ScrollableState>(homeList()).position.pixels;

  testWidgets('Home keeps its scroll position after Harness and back', (
    tester,
  ) async {
    await pump(tester);
    await tester.drag(homeList(), const Offset(0, -600));
    await tester.pumpAndSettle();
    final scrolled = offset(tester);
    expect(scrolled, greaterThan(0));

    await toHarnessAndBack(tester);

    expect(offset(tester), scrolled);
  });

  testWidgets('Harness from the drawer and back: Home, its drawer closed', (
    tester,
  ) async {
    await pump(tester);
    await tester.tap(key('swarm-menu'));
    await tester.pumpAndSettle();
    // Under the projects, Your models and Your devices: Harness is below
    // the fold of this Swarm's long drawer.
    await tester.ensureVisible(key('swarm-drawer-harness'));
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-drawer-harness'));
    await tester.pumpAndSettle();
    expect(find.text('the terminal'), findsOneWidget);

    choice.showSwarm();
    await tester.pump();

    expect(find.byType(SwarmPage), findsOneWidget);
    expect(find.byType(SwarmDrawer), findsNothing);
  });

  testWidgets('Home out of sight mutes no notice', (tester) async {
    await pump(tester);
    final need = host.session!.inbox.needs.single;
    choice.showHarness();
    await tester.pumpAndSettle();

    host.session!.announce(need);

    expect(notices.shown.single.title, 'River asks you');
  });

  testWidgets('Home dropped while out of sight (Swarm turned off) leaves '
      'another Swarm screen muting them', (tester) async {
    await pump(tester);
    final session = host.session!;
    final need = session.inbox.needs.single;
    choice.showHarness();
    await tester.pumpAndSettle();
    // Another Swarm screen up meanwhile (a chat).
    session.enter();

    choice.features.value = const {};
    await tester.pumpAndSettle();
    expect(find.byType(SwarmPage, skipOffstage: false), findsNothing);
    session.announce(need);

    expect(notices.shown, isEmpty, reason: 'Home left once, when hidden');
  });

  testWidgets('Home in sight mutes them, as before', (tester) async {
    await pump(tester);

    host.session!.announce(host.session!.inbox.needs.single);

    expect(notices.shown, isEmpty);
  });

  testWidgets('Home out of sight builds nothing when its Swarms change', (
    tester,
  ) async {
    await pump(tester);
    choice.showHarness();
    await tester.pumpAndSettle();

    final rebuilt = countRebuildsUnder<SwarmPage>();
    await host.session!.inbox.refresh();
    await tester.pumpAndSettle();

    expect(rebuilt(), 0);
  });

  testWidgets('Home shown again reads its Swarms again', (tester) async {
    await pump(tester);
    int lists() =>
        fake.paths.where((path) => path == '/api/super-tabs/list').length;
    final before = lists();

    await toHarnessAndBack(tester);

    expect(lists(), before + 1);
  });
}

class _Notices extends SilentSystemNotices {
  final shown = <SwarmNoticeMessage>[];

  @override
  Future<void> showSwarm(SwarmNoticeMessage message) async =>
      shown.add(message);
}
