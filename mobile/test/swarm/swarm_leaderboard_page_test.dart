import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/swarm/swarm_leaderboard.dart';
import 'package:harness_mobile/swarm/swarm_leaderboard_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../theme/sheet_shape.dart';
import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The leaderboard page over a scripted backend, built to the design system's
/// Numbers and rankings at phone sizes: skeleton rows while it reads, the
/// team's total as quiet text with the week picker, then each person as a row
/// of rank, avatar, name over their non-zero numbers, change against last
/// week and points; a week picker and a person's week in bottom sheets.
void main() {
  const path = '/api/super-tabs/$tab/leaderboard?projectId=$project';
  // Wednesday 28 October 2026; this week's Monday is the 26th.
  final now = DateTime.utc(2026, 10, 28, 2);
  final monday = DateTime.utc(2026, 10, 26).millisecondsSinceEpoch;
  final lastWeek = monday - swarmWeekMs;

  /// This week's board: diego up from 20, ken down from 25, the viewer level,
  /// and dee, who has left, on 0.
  Map<String, dynamic> board() {
    final data = leaderboardData(week: monday);
    final people = (data['people'] as List).cast<Map<String, dynamic>>();
    people[0]['prevWeekPoints'] = 20;
    people[1]['prevWeekPoints'] = 25;
    people.insert(
      2,
      scoreData(me, points: 5, rank: 3, medal: 'bronze', unblocked: 2)
        ..['prevWeekPoints'] = 5,
    );
    people.last['rank'] = 4;
    return data;
  }

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
        part('diego', 1, {
          ...person('diego', role: 'collaborator'),
          'avatar': {'kind': 'preset', 'key': 'owl'},
        }),
        part('ken', 1, person('ken', role: 'collaborator')),
      ],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes[path] = (_) => board();
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
      return board();
    };
    await pump(tester, fake);
    await tester.pump();

    expect(key('swarm-leaderboard-loading'), findsOneWidget);
    expect(find.textContaining('pts'), findsNothing);

    gate.complete();
    await tester.pumpAndSettle();

    expect(key('swarm-leaderboard-loading'), findsNothing);
    expect(find.text('Leaderboard'), findsOneWidget);
    // The team's total leads, as quiet text, with the week picker beside it.
    const team = 'swarm-leaderboard-team';
    final total = inside(
      team,
      find.text('19 shipped this week · 11 last week'),
    );
    expect(total, findsOneWidget);
    expect(tester.widget<Text>(total).style!.fontSize, AppType.captionSize);
    expect(tester.widget<Text>(total).style!.color, AppPalette.textSecondary);
    expect(
      inside(team, inside('swarm-leaderboard-week', find.text('This week'))),
      findsOneWidget,
    );
    expect(
      y(tester, team),
      lessThan(y(tester, 'swarm-leaderboard-person-diego')),
    );

    const diego = 'swarm-leaderboard-person-diego';
    expect(inside(diego, find.text('diego')), findsOneWidget);
    // The face diego chose, not the initial.
    expect(inside(diego, find.text('🦉')), findsOneWidget);
    expect(inside(diego, find.text('D')), findsNothing);
    expect(
      tester.getSemantics(key(diego)),
      isSemantics(
        label:
            'diego, place 1, 28 points, 8 shipped, 1 unblocked, '
            '40 hours lent, up 8 from last week',
        isButton: true,
      ),
    );
    // The label says what the row shows: a number at zero is left out.
    expect(
      tester.getSemantics(key('swarm-leaderboard-person-ken')),
      isSemantics(
        label: 'ken, place 2, 21 points, 3 shipped, down 4 from last week',
        isButton: true,
      ),
    );
    expect(
      tester.getSemantics(key('swarm-leaderboard-person-dee')),
      isSemantics(label: 'Former member, place 4, 0 points', isButton: true),
    );
    expect(
      tester.getSize(key(diego)).height,
      greaterThanOrEqualTo(minTouchTarget),
      reason: 'a thumb',
    );
    expect(
      y(tester, diego),
      lessThan(y(tester, 'swarm-leaderboard-person-ken')),
    );
    const dee = 'swarm-leaderboard-person-dee';
    expect(inside(dee, find.text('Former member')), findsOneWidget);
    expect(y(tester, 'swarm-leaderboard-person-ken'), lessThan(y(tester, dee)));
    expect(fake.paths.where((p) => p.contains('/leaderboard')), [path]);
  });

  testWidgets('a display name from the board wins over the email name', (
    tester,
  ) async {
    final fake = backend();
    fake.routes[path] = (_) {
      final data = board();
      (data['people'] as List<Map<String, dynamic>>)[1]['displayName'] =
          'Ken Nguyen';
      return data;
    };
    await pump(tester, fake);
    await tester.pumpAndSettle();
    const ken = 'swarm-leaderboard-person-ken';
    expect(inside(ken, find.text('Ken Nguyen')), findsOneWidget);
    expect(find.text('ken'), findsNothing);
    expect(
      tester.getSemantics(key(ken)).label,
      startsWith('Ken Nguyen, place 2'),
    );
    // Its sheet is titled the same.
    await tester.tap(key(ken));
    await tester.pumpAndSettle();
    expect(
      inside('swarm-leaderboard-sheet', find.text('Ken Nguyen')),
      findsOneWidget,
    );
  });

  testWidgets('a bold rank in its own column and the points as the one '
      'emphasized number, each right-aligned', (tester) async {
    await pump(tester, backend());
    await tester.pumpAndSettle();
    final ids = ['diego', 'ken', me, 'dee'];
    for (final (i, id) in ids.indexed) {
      expect(
        inside('swarm-leaderboard-rank-$id', find.text('${i + 1}')),
        findsOneWidget,
        reason: id,
      );
    }
    double right(String value) => tester.getTopRight(key(value)).dx;
    for (final id in ids) {
      expect(
        right('swarm-leaderboard-rank-$id'),
        right('swarm-leaderboard-rank-diego'),
      );
      expect(
        right('swarm-leaderboard-points-$id'),
        right('swarm-leaderboard-points-diego'),
      );
    }
    TextStyle style(String value, String text) =>
        tester.widget<Text>(inside(value, find.text(text))).style!;
    final rank = style('swarm-leaderboard-rank-diego', '1');
    expect(rank.fontWeight, FontWeight.w700);
    expect(rank.color, AppPalette.textSecondary);
    expect(rank.fontFeatures, const [FontFeature.tabularFigures()]);
    final points = style('swarm-leaderboard-points-diego', '28');
    expect(points.fontWeight, FontWeight.w600);
    expect(points.color, AppPalette.textPrimary);
    expect(points.fontFeatures, const [FontFeature.tabularFigures()]);
    expect(find.textContaining('pts'), findsNothing);
    // No points yet: the 0 holds the column in the points style, one rule
    // for every value.
    expect(style('swarm-leaderboard-points-dee', '0'), points);
  });

  testWidgets('the numbers in words under the name: zeros left out, whole '
      'items only', (tester) async {
    await pump(tester, backend());
    await tester.pumpAndSettle();
    String? shown(String id) {
      final line = key('swarm-leaderboard-meta-$id');
      if (line.evaluate().isEmpty) return null;
      return tester
          .widget<Text>(find.descendant(of: line, matching: find.byType(Text)))
          .data;
    }

    const diego = '8 shipped · 1 unblocked · 40 hours lent';
    final text = shown('diego')!;
    expect(diego.startsWith(text), isTrue, reason: text);
    expect(
      text == diego || diego.substring(text.length).startsWith(' · '),
      isTrue,
      reason: text,
    );
    expect(shown('ken'), '3 shipped');
    expect(shown(me), '2 unblocked');
    expect(shown('dee'), isNull, reason: 'nothing to say, no line');
    final style = tester
        .widget<Text>(
          find.descendant(
            of: key('swarm-leaderboard-meta-ken'),
            matching: find.byType(Text),
          ),
        )
        .style!;
    expect(style.fontSize, AppType.captionSize);
    expect(style.color, AppPalette.textSecondary);
  });

  testWidgets('an arrow against last week, by shape and colour, and none '
      'when level', (tester) async {
    await pump(tester, backend());
    await tester.pumpAndSettle();
    Icon arrow(String id) => tester.widget<Icon>(
      inside('swarm-leaderboard-trend-$id', find.byType(Icon)),
    );
    expect(
      inside('swarm-leaderboard-trend-diego', find.text('8')),
      findsOneWidget,
    );
    expect(arrow('diego').color, AppPalette.online);
    expect(
      inside('swarm-leaderboard-trend-ken', find.text('4')),
      findsOneWidget,
    );
    expect(arrow('ken').icon, isNot(arrow('diego').icon));
    final context = tester.element(key('swarm-leaderboard-trend-ken'));
    expect(arrow('ken').color, Theme.of(context).colorScheme.error);
    expect(key('swarm-leaderboard-trend-$me'), findsNothing);
    expect(key('swarm-leaderboard-trend-dee'), findsNothing);
  });

  testWidgets("the viewer's own row has the selected fill, no other", (
    tester,
  ) async {
    await pump(tester, backend());
    await tester.pumpAndSettle();
    Color? fill(String id) => tester
        .widget<Material>(
          find
              .ancestor(
                of: key('swarm-leaderboard-person-$id'),
                matching: find.byType(Material),
              )
              .first,
        )
        .color;
    expect(fill(me), AppSurface.selectedFill);
    expect(fill('diego'), Colors.transparent);
  });

  testWidgets("a hardware keyboard's focus shows over the viewer's own fill", (
    tester,
  ) async {
    await pump(tester, backend());
    await tester.pumpAndSettle();
    final row = key('swarm-leaderboard-person-$me');
    final ink = Material.of(tester.element(row)) as RenderObject;
    final focus = Theme.of(tester.element(row)).focusColor;
    expect(ink, isNot(paints..rrect(color: focus)));
    FocusManager.instance.highlightStrategy =
        FocusHighlightStrategy.alwaysTraditional;
    addTearDown(
      () => FocusManager.instance.highlightStrategy =
          FocusHighlightStrategy.automatic,
    );
    Focus.of(
      tester.element(
        find.descendant(of: row, matching: find.byType(Padding)).first,
      ),
    ).requestFocus();
    await tester.pumpAndSettle();
    expect(ink, paints..rrect(color: focus));
  });

  testWidgets('no cups, medals, sparkles or emoji of its own', (tester) async {
    await pump(tester, backend());
    await tester.pump();
    await tester.pump();
    for (final mark in ['🥇', '🥈', '🥉', '🚀', '✨']) {
      expect(find.textContaining(mark), findsNothing, reason: mark);
    }
    expect(key('swarm-leaderboard-sparkle'), findsNothing);
    await tester.pumpAndSettle();
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
    expect(
      inside(team, find.text('11 shipped last week · 11 the week before')),
      findsOneWidget,
    );
    expect(key('swarm-leaderboard-person-diego'), findsNothing);
    expect(
      inside('swarm-leaderboard-points-ken', find.text('9')),
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
    // What the CLI hands on for a backend with no such route: Fastify's own
    // 404 carries no code (cli/src/superTabs/wire.ts).
    final fake = backend()
      ..routes[path] = (_) => throw const SuperTabFailure(
        'BACKEND_UNAVAILABLE',
        'Route GET:/api/super-tabs/$tab/leaderboard not found',
        statusCode: 404,
      );
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

  group('what the person may no longer read never stays', () {
    int boardReads(FakeSwarm fake) =>
        fake.paths.where((p) => p.contains('/leaderboard')).length;

    testWidgets('the Swarm taken away while open: its rows go at once, and '
        'none are read again', (tester) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await tester.pumpAndSettle();
      expect(key('swarm-leaderboard-person-diego'), findsOneWidget);
      final reads = boardReads(fake);

      // Removed from the Swarm: the list no longer has it.
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': <Object>[],
        'next': null,
      };
      await host.session!.inbox.refresh();
      await tester.pump();

      expect(key('swarm-leaderboard-person-diego'), findsNothing);
      expect(find.text('Mobile'), findsNothing, reason: "the project's name");
      expect(
        tester.widget<Text>(key('swarm-leaderboard-gone')).data,
        'This Swarm is no longer available.',
      );
      expect(key('swarm-leaderboard-loading'), findsNothing);

      await tester.pump(const Duration(minutes: 11));
      expect(boardReads(fake), reads, reason: 'nothing read once it is gone');
    });

    testWidgets('an answer on its way when the Swarm is taken away is '
        'dropped', (tester) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await tester.pumpAndSettle();
      final gate = Completer<void>();
      fake.routes[path] = (_) async {
        await gate.future;
        return board();
      };
      await tester.fling(
        key('swarm-leaderboard-person-diego'),
        const Offset(0, 400),
        1000,
      );
      await tester.pump(const Duration(seconds: 1));

      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': <Object>[],
        'next': null,
      };
      await host.session!.inbox.refresh();
      gate.complete();
      await tester.pumpAndSettle();

      expect(key('swarm-leaderboard-person-diego'), findsNothing);
      expect(key('swarm-leaderboard-gone'), findsOneWidget);
    });

    testWidgets('the project taken away while open: its rows go at once, '
        'and its board is read no more', (tester) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await tester.pumpAndSettle();
      expect(key('swarm-leaderboard-person-diego'), findsOneWidget);
      final reads = boardReads(fake);

      // The project went private, or was deleted: the Swarm no longer
      // shows it.
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c3'),
        'head': part('head', 2, headData(projects: [])),
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pump();

      expect(key('swarm-leaderboard-person-diego'), findsNothing);
      expect(find.text('Mobile'), findsNothing, reason: "the project's name");
      expect(
        tester.widget<Text>(key('swarm-leaderboard-gone')).data,
        'This project is no longer in the Swarm.',
      );
      expect(key('swarm-leaderboard-loading'), findsNothing);

      await tester.pump(const Duration(minutes: 11));
      expect(boardReads(fake), reads, reason: 'nothing read once it is gone');
    });

    testWidgets("a project the Swarm doesn't show reads as gone, even if a "
        'board answers for it', (tester) async {
      final fake = backend();
      // Another Swarm's project, or a private one: the snapshot has
      // neither, whatever the board read says.
      const elsewhere = 'project-elsewhere';
      final other = '/api/super-tabs/$tab/leaderboard?projectId=$elsewhere';
      fake.routes[other] = (_) => board();
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
      await host.session!.inbox.refresh();
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) =>
              SwarmScope(notifier: host, child: child!),
          home: SwarmLeaderboardPage(
            swarmId: tab,
            projectId: elsewhere,
            now: () => now,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(key('swarm-leaderboard-person-diego'), findsNothing);
      expect(
        tester.widget<Text>(key('swarm-leaderboard-gone')).data,
        'This project is no longer in the Swarm.',
      );
      expect(key('swarm-leaderboard-loading'), findsNothing);
      expect(fake.paths.where((p) => p.startsWith(other)), isEmpty);
    });

    testWidgets('a refusal while open clears the rows and offers Try '
        'again', (tester) async {
      final fake = backend();
      await pump(tester, fake);
      await tester.pumpAndSettle();
      expect(key('swarm-leaderboard-person-diego'), findsOneWidget);

      fake.routes[path] = (_) => throw const SuperTabFailure(
        'FORBIDDEN',
        'You no longer have access to this Super Tab.',
        statusCode: 403,
      );
      await tester.fling(
        key('swarm-leaderboard-person-diego'),
        const Offset(0, 400),
        1000,
      );
      await tester.pumpAndSettle();

      expect(key('swarm-leaderboard-person-diego'), findsNothing);
      expect(
        find.text('You no longer have access to this Super Tab.'),
        findsOneWidget,
      );
      expect(find.text('Try again'), findsOneWidget);
      expect(key('swarm-leaderboard-loading'), findsNothing);
    });

    testWidgets('a list of Swarms that cannot be read never loads forever', (
      tester,
    ) async {
      final fake = backend();
      final list = fake.routes['/api/super-tabs/list']!;
      var fail = true;
      fake.routes['/api/super-tabs/list'] = (body) => fail
          ? throw const SuperTabFailure('OFFLINE', 'No computer answered.')
          : list(body);
      await pump(tester, fake);
      await tester.pumpAndSettle();

      expect(key('swarm-leaderboard-loading'), findsNothing);
      expect(find.text('No computer answered.'), findsOneWidget);

      fail = false;
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(key('swarm-leaderboard-person-diego'), findsOneWidget);
      expect(find.text('No computer answered.'), findsNothing);
    });
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
      expect(find.textContaining('shipped this week'), findsNothing);

      await tester.pumpAndSettle();
      expect(key('swarm-leaderboard-person-diego'), findsNothing);
      expect(
        inside('swarm-leaderboard-points-ken', find.text('9')),
        findsOneWidget,
      );
      expect(
        inside(
          'swarm-leaderboard-team',
          find.text('2 shipped this week · 11 last week'),
        ),
        findsOneWidget,
      );
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
