import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_leaderboard.dart';
import 'package:harness_mobile/swarm/swarm_leaderboard_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../theme/sheet_shape.dart';
import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The leaderboard page over a scripted backend: skeleton rows while it
/// reads, each person in place with their cup or place, a week picker and a
/// person's week in bottom sheets, and a sparkle on first place as it opens.
void main() {
  const path = '/api/super-tabs/$tab/leaderboard?projectId=$project';
  // Wednesday 28 October 2026; this week's Monday is the 26th.
  final now = DateTime.utc(2026, 10, 28, 2);
  final monday = DateTime.utc(2026, 10, 26).millisecondsSinceEpoch;
  final lastWeek = monday - swarmWeekMs;

  /// One Swarm whose members are the viewer, diego and ken; dee scores on
  /// the board but has left.
  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(),
      'members': [
        part(me, 1, person(me)),
        part('diego', 1, person('diego', role: 'collaborator')),
        part('ken', 1, person('ken', role: 'collaborator')),
      ],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes[path] = (_) => leaderboardData(week: monday);
    fake.routes['$path&week=$lastWeek'] = (_) => leaderboardData(
      week: lastWeek,
      shipped: 11,
      people: [scoreData('ken', points: 9, rank: 1, medal: 'gold', shipped: 2)],
    );
    return fake;
  }

  /// The page under a signed-in shell's Swarm whose list has been read.
  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    bool still = false,
    ValueNotifier<String?>? signedIn,
  }) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = signedIn ?? ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
    )..foreground = false;
    addTearDown(host.dispose);
    await host.session!.inbox.refresh();
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: still),
          child: SwarmScope(notifier: host, child: child!),
        ),
        home: SwarmLeaderboardPage(
          swarmId: tab,
          projectId: project,
          now: () => now,
        ),
      ),
    );
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  Finder inside(String value, Finder matching) =>
      find.descendant(of: key(value), matching: matching);
  double y(WidgetTester tester, String value) =>
      tester.getTopLeft(key(value)).dy;

  testWidgets('skeleton rows while it reads, then each person in place', (
    tester,
  ) async {
    final fake = backend();
    final gate = Completer<void>();
    fake.routes[path] = (_) async {
      await gate.future;
      return leaderboardData(week: monday);
    };
    await pump(tester, fake);
    await tester.pump();

    expect(key('swarm-leaderboard-loading'), findsOneWidget);
    expect(find.textContaining('pts'), findsNothing);

    gate.complete();
    await tester.pumpAndSettle();

    expect(key('swarm-leaderboard-loading'), findsNothing);
    expect(find.text('Leaderboard'), findsOneWidget);
    // Team first: the team's week leads, the week picker in it.
    const team = 'swarm-leaderboard-team';
    expect(inside(team, find.text('Team this week')), findsOneWidget);
    expect(inside(team, find.text('🚀')), findsOneWidget);
    expect(inside(team, find.text('19')), findsOneWidget);
    expect(inside(team, find.text('shipped')), findsOneWidget);
    expect(inside(team, find.text('11 shipped last week')), findsOneWidget);
    expect(
      inside(team, inside('swarm-leaderboard-week', find.text('This week'))),
      findsOneWidget,
    );
    expect(find.text('Who moved it'), findsOneWidget);
    expect(
      y(tester, team),
      lessThan(y(tester, 'swarm-leaderboard-person-diego')),
    );

    const diego = 'swarm-leaderboard-person-diego';
    expect(inside(diego, find.text('🥇')), findsOneWidget);
    expect(inside(diego, find.text('diego')), findsOneWidget);
    expect(inside(diego, find.text('D')), findsOneWidget, reason: 'initial');
    expect(inside(diego, find.text('28 pts')), findsOneWidget);
    expect(
      inside(diego, find.text('8 shipped · 1 unblocked · 40h lent')),
      findsOneWidget,
      reason: 'the stats in words',
    );
    expect(
      inside('swarm-leaderboard-person-ken', find.text('🥈')),
      findsOneWidget,
    );
    const dee = 'swarm-leaderboard-person-dee';
    expect(inside(dee, find.text('Former member')), findsOneWidget);
    expect(inside(dee, find.text('0 pts')), findsOneWidget);
    for (final cup in ['🥇', '🥈', '🥉', '4']) {
      expect(inside(dee, find.text(cup)), findsNothing, reason: 'no cup');
    }
    expect(
      inside(dee, find.text('0 shipped · 0 unblocked · 0h lent')),
      findsOneWidget,
    );

    expect(
      y(tester, diego),
      lessThan(y(tester, 'swarm-leaderboard-person-ken')),
    );
    expect(y(tester, 'swarm-leaderboard-person-ken'), lessThan(y(tester, dee)));
    expect(
      tester.getSemantics(key(diego)),
      isSemantics(
        label:
            'diego, place 1, 28 points, 8 shipped, 1 unblocked, '
            '40 hours lent',
        isButton: true,
      ),
    );
    expect(
      tester.getSize(key(diego)).height,
      greaterThanOrEqualTo(44),
      reason: 'a thumb',
    );
    expect(fake.paths.where((p) => p.contains('/leaderboard')), [path]);
  });

  testWidgets('the week picker shows another week', (tester) async {
    final fake = backend();
    await pump(tester, fake);
    await tester.pumpAndSettle();
    expect(
      tester.getSize(key('swarm-leaderboard-week')).height,
      greaterThanOrEqualTo(44),
    );

    await tester.tap(key('swarm-leaderboard-week'));
    await tester.pumpAndSettle();
    expect(sheetTopRadius(tester), 12);
    for (final name in ['Last week', '2 weeks ago', '3 weeks ago']) {
      expect(find.text(name), findsOneWidget);
    }

    await tester.tap(find.text('Last week'));
    await tester.pumpAndSettle();

    expect(fake.paths.last, '$path&week=$lastWeek');
    expect(
      inside('swarm-leaderboard-week', find.text('Last week')),
      findsOneWidget,
    );
    const team = 'swarm-leaderboard-team';
    expect(inside(team, find.text('Team last week')), findsOneWidget);
    expect(inside(team, find.text('11')), findsOneWidget);
    expect(
      inside(team, find.text('11 shipped the week before')),
      findsOneWidget,
    );
    expect(key('swarm-leaderboard-person-diego'), findsNothing);
    expect(
      inside('swarm-leaderboard-person-ken', find.text('9 pts')),
      findsOneWidget,
    );

    await tester.tap(key('swarm-leaderboard-week'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('This week').last);
    await tester.pumpAndSettle();
    expect(fake.paths.last, path);
  });

  testWidgets("tapping a person opens their week", (tester) async {
    await pump(tester, backend());
    await tester.pumpAndSettle();

    await tester.tap(key('swarm-leaderboard-person-diego'));
    await tester.pumpAndSettle();

    const sheet = 'swarm-leaderboard-sheet';
    expect(sheetTopRadius(tester), 12);
    expect(inside(sheet, find.text('diego')), findsOneWidget);
    for (final line in [
      '28 this week · place 1',
      '8 asks landed · median 3 h to ship',
      '1 answered · median 4 min · 6 min of agent time freed',
      '2 machines · 40 agent-hours',
      '3 days shipping',
    ]) {
      expect(inside(sheet, find.text(line)), findsOneWidget, reason: line);
    }

    await tester.tap(key('swarm-leaderboard-sheet-close'));
    await tester.pumpAndSettle();
    expect(key(sheet), findsNothing);

    await tester.tap(key('swarm-leaderboard-person-dee'));
    await tester.pumpAndSettle();
    for (final line in [
      '0 this week',
      'Nothing landed yet',
      'Nothing answered yet',
      'Nothing lent yet',
      'No streak yet',
    ]) {
      expect(inside(sheet, find.text(line)), findsOneWidget, reason: line);
    }
  });

  testWidgets('first place sparkles as the page opens, once', (tester) async {
    await pump(tester, backend());
    await tester.pump();
    await tester.pump();

    expect(
      inside(
        'swarm-leaderboard-person-diego',
        key('swarm-leaderboard-sparkle'),
      ),
      findsOneWidget,
    );

    await tester.pumpAndSettle();
    expect(key('swarm-leaderboard-sparkle'), findsNothing, reason: 'it ends');

    await tester.tap(key('swarm-leaderboard-week'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Last week'));
    await tester.pump();
    await tester.pump();
    expect(
      key('swarm-leaderboard-sparkle'),
      findsNothing,
      reason: 'only as the page opens',
    );
  });

  testWidgets('with Reduce Motion on, nothing sparkles', (tester) async {
    await pump(tester, backend(), still: true);
    await tester.pump();
    await tester.pump();

    expect(key('swarm-leaderboard-person-diego'), findsOneWidget);
    expect(key('swarm-leaderboard-sparkle'), findsNothing);
  });

  testWidgets('a read that fails with nothing shown offers Try again', (
    tester,
  ) async {
    final fake = backend();
    var fail = true;
    fake.routes[path] = (_) => fail
        ? throw const SuperTabFailure('OFFLINE', 'No computer answered.')
        : leaderboardData(week: monday);
    await pump(tester, fake);
    await tester.pumpAndSettle();

    expect(find.text('No computer answered.'), findsOneWidget);
    expect(key('swarm-leaderboard-person-diego'), findsNothing);

    fail = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(key('swarm-leaderboard-person-diego'), findsOneWidget);
    expect(find.text('No computer answered.'), findsNothing);
  });

  testWidgets('a server without a leaderboard says it has none', (
    tester,
  ) async {
    final fake = backend()..routes.remove(path);
    await pump(tester, fake);
    await tester.pumpAndSettle();

    expect(
      find.text("This Swarm's server has no leaderboard yet."),
      findsOneWidget,
    );
    expect(key('swarm-leaderboard-loading'), findsNothing);
  });

  testWidgets('a pull reads the board again', (tester) async {
    final fake = backend();
    await pump(tester, fake);
    await tester.pumpAndSettle();

    await tester.fling(
      key('swarm-leaderboard-person-diego'),
      const Offset(0, 400),
      1000,
    );
    await tester.pumpAndSettle();

    expect(fake.paths.where((p) => p == path), hasLength(2));
  });

  group("another account's board never stays", () {
    /// The backend as each account reads it: the old account's board has
    /// diego first; the next account's has only ken.
    FakeSwarm twoAccounts(ValueNotifier<String?> account) {
      final fake = backend();
      fake.routes[path] = (_) => account.value == me
          ? leaderboardData(week: monday)
          : leaderboardData(
              week: monday,
              shipped: 2,
              people: [scoreData('ken', points: 9, rank: 1, medal: 'gold')],
            );
      return fake;
    }

    testWidgets('an account switch shows only the new account\'s board', (
      tester,
    ) async {
      final account = ValueNotifier<String?>(me);
      final fake = twoAccounts(account);
      await pump(tester, fake, signedIn: account);
      await tester.pumpAndSettle();
      expect(key('swarm-leaderboard-person-diego'), findsOneWidget);
      final before = fake.paths.where((p) => p.startsWith(path)).length;

      account.value = 'person-other';
      await tester.pump();

      expect(
        key('swarm-leaderboard-person-diego'),
        findsNothing,
        reason: 'the old account\'s board is gone at once',
      );
      expect(key('swarm-leaderboard-team'), findsNothing);

      await tester.pumpAndSettle();
      expect(key('swarm-leaderboard-person-diego'), findsNothing);
      expect(
        inside('swarm-leaderboard-person-ken', find.text('9 pts')),
        findsOneWidget,
      );
      expect(inside('swarm-leaderboard-team', find.text('2')), findsOneWidget);
      expect(
        fake.paths.where((p) => p.startsWith(path)).length,
        before + 1,
        reason: 'read once for the new account',
      );
    });

    testWidgets('a sign-out clears the board and reads no more', (
      tester,
    ) async {
      final account = ValueNotifier<String?>(me);
      final fake = twoAccounts(account);
      await pump(tester, fake, signedIn: account);
      await tester.pumpAndSettle();
      expect(key('swarm-leaderboard-person-diego'), findsOneWidget);
      final reads = fake.paths.length;

      account.value = null;
      await tester.pumpAndSettle();

      expect(key('swarm-leaderboard-person-diego'), findsNothing);
      expect(key('swarm-leaderboard-team'), findsNothing);
      expect(key('swarm-leaderboard-loading'), findsNothing);

      await tester.pump(const Duration(minutes: 11));
      expect(fake.paths.length, reads, reason: 'nothing read once signed out');
    });
  });
}
