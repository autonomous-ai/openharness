import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
    expect(fake.paths.where((p) => p.contains('/leaderboard')), [
      '$path&period=7d',
    ]);
  });

  group('the rolling periods', () {
    Map<String, dynamic> rolling(String name, int shipped) => {
      ...leaderboardData(week: monday, shipped: shipped),
      'period': {'name': name, 'start': 1, 'end': 2},
      if (name == '30d')
        'goal': {
          'openRequests': 4,
          'thisWeek': {'shipped': shipped},
          'lastWeek': null,
        },
    };
    FakeSwarm periods() => backend()
      ..routes['$path&period=7d'] = ((_) => rolling('7d', 19))
      ..routes['$path&period=24h'] = ((_) => rolling('24h', 2))
      ..routes['$path&period=30d'] = (_) => rolling('30d', 40);

    testWidgets('opens on Last 7d, picks a period, and says what it covers', (
      tester,
    ) async {
      final fake = periods();
      await pump(tester, fake);
      await tester.pumpAndSettle();
      expect(
        inside('swarm-leaderboard-week', find.text('Last 7d')),
        findsOneWidget,
      );
      expect(
        find.text('19 shipped in the last 7 days · 11 the 7 days before'),
        findsOneWidget,
      );

      await tester.tap(key('swarm-leaderboard-week'));
      await tester.pumpAndSettle();
      expect(find.text('This week'), findsNothing);
      expect(key('swarm-leaderboard-period-24h'), findsOneWidget);
      await tester.tap(key('swarm-leaderboard-period-30d'));
      await tester.pumpAndSettle();
      expect(fake.paths.last, '$path&period=30d');
      expect(
        inside('swarm-leaderboard-week', find.text('Last 30d')),
        findsOneWidget,
      );
      // Only five weeks are kept: Last 30d has nothing to compare with.
      expect(find.text('40 shipped in the last 30 days'), findsOneWidget);
    });

    testWidgets('from a server before periods: the week picker, as before', (
      tester,
    ) async {
      final fake = backend();
      fake.routes['$path&period=7d'] = (_) => throw const SuperTabFailure(
        'VALIDATION',
        'Unrecognized key',
        statusCode: 400,
      );
      await pump(tester, fake);
      await tester.pumpAndSettle();
      expect(
        inside('swarm-leaderboard-week', find.text('This week')),
        findsOneWidget,
      );
      await tester.tap(key('swarm-leaderboard-week'));
      await tester.pumpAndSettle();
      expect(find.text('Last week'), findsOneWidget);
      expect(key('swarm-leaderboard-period-30d'), findsNothing);
    });

    testWidgets(
      'signed out with the picker up: it closes and nothing is read',
      (tester) async {
        final fake = periods();
        final account = ValueNotifier<String?>(me);
        await pump(tester, fake, signedIn: account);
        await tester.pumpAndSettle();
        await tester.tap(key('swarm-leaderboard-week'));
        await tester.pumpAndSettle();
        expect(key('swarm-leaderboard-period-30d'), findsOneWidget);
        final reads = fake.paths.length;
        account.value = null;
        await tester.pumpAndSettle();
        expect(key('swarm-leaderboard-period-30d'), findsNothing);
        expect(fake.paths.length, reads);
      },
    );
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

  group("a person's details, as the desktop's person card shows them", () {
    const sheet = 'swarm-leaderboard-sheet';

    /// This week's board, diego's and ken's numbers with what they are made
    /// of: [shipped] stands for diego's pull requests when given.
    /// [brought] is ken's machines, from a server that reads Brought.
    FakeSwarm detailed({
      List<Map<String, dynamic>>? shipped,
      List<Object>? brought,
    }) {
      final fake = backend();
      fake.routes[path] = (_) {
        final data = board();
        final people = (data['people'] as List).cast<Map<String, dynamic>>();
        people[0]['details'] = {
          'shipped':
              shipped ??
              [
                {
                  'title': 'Desktop: a machine shows its agents as one count',
                  'prUrl':
                      'https://github.com/autonomous-ai/openharness/pull/1824',
                  'mergedAt': 2,
                },
                {
                  'title': 'Swarm digest pauses with the Swarm',
                  'prUrl': 'file:///etc/hosts',
                  'mergedAt': 1,
                },
              ],
          'unblocked': [
            {
              'title': 'Which sign-in page ships first?',
              'conversationId': 'c1',
              'kind': 'decision',
              'waitedMinutes': 96,
            },
          ],
          'lent': <Object>[],
        };
        people[1]['details'] = {
          'shipped': <Object>[],
          'unblocked': <Object>[],
          'lent': [
            {'machineName': 'MACs-Mac-Studio.local', 'busyHours': 12.5},
            {'machineName': 'build-box', 'busyHours': 7},
          ],
          'brought': ?brought,
        };
        return data;
      };
      return fake;
    }

    /// Records what the phone asks the system to open.
    List<Object?> launches(WidgetTester tester) {
      final opened = <Object?>[];
      const launcher = MethodChannel('plugins.flutter.io/url_launcher');
      final messenger = tester.binding.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(launcher, (call) async {
        if (call.method == 'launch') {
          opened.add((call.arguments as Map)['url']);
        }
        return true;
      });
      addTearDown(() => messenger.setMockMethodCallHandler(launcher, null));
      return opened;
    }

    testWidgets('the points, then what shipped, was unblocked and was lent, '
        'and saying so where nothing was', (tester) async {
      await pump(tester, detailed());
      await tester.pumpAndSettle();

      await tester.tap(key('swarm-leaderboard-person-diego'));
      await tester.pumpAndSettle();

      expect(inside(sheet, find.text('diego')), findsOneWidget);
      final points = inside(
        sheet,
        find.text('28 points this week · 20 last week'),
      );
      expect(points, findsOneWidget);
      expect(tester.widget<Text>(points).style!.fontSize, AppType.captionSize);
      double top(String section) =>
          tester.getTopLeft(key('swarm-leaderboard-details-$section')).dy;
      expect(tester.getTopLeft(points).dy, lessThan(top('shipped')));
      expect(top('shipped'), lessThan(top('unblocked')));
      expect(top('unblocked'), lessThan(top('lent')));
      Finder within(String section, String text) =>
          inside('swarm-leaderboard-details-$section', find.text(text));
      // Each list's count beside its heading.
      expect(within('shipped', 'Shipped'), findsOneWidget);
      expect(within('shipped', '2'), findsOneWidget);
      expect(
        within('shipped', 'Desktop: a machine shows its agents as one count'),
        findsOneWidget,
      );
      expect(within('unblocked', 'Unblocked'), findsOneWidget);
      expect(within('unblocked', '1'), findsOneWidget);
      expect(
        within('unblocked', 'Which sign-in page ships first?'),
        findsOneWidget,
      );
      expect(within('unblocked', 'waited 1.6 h'), findsOneWidget);
      expect(within('lent', 'No machines lent yet'), findsOneWidget);
      // The numbers line by line are a server's without details.
      expect(inside(sheet, find.text('Streak')), findsNothing);
      expect(inside(sheet, find.text('3 days shipping')), findsNothing);
      expect(
        tester.getSemantics(
          find.ancestor(
            of: within('unblocked', 'waited 1.6 h'),
            matching: find.byType(MergeSemantics),
          ),
        ),
        isSemantics(label: 'Which sign-in page ships first?\nwaited 1.6 h'),
      );
      expect(tester.takeException(), isNull);

      await tester.tap(key('swarm-leaderboard-sheet-close'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-leaderboard-person-ken'));
      await tester.pumpAndSettle();
      expect(
        inside(sheet, find.text('21 points this week · 25 last week')),
        findsOneWidget,
      );
      expect(within('shipped', 'No pull requests merged yet'), findsOneWidget);
      expect(within('unblocked', 'No questions answered yet'), findsOneWidget);
      // The machine as it calls itself, without .local, busiest first.
      expect(within('lent', 'MACs-Mac-Studio'), findsOneWidget);
      expect(within('lent', '12.5 h busy'), findsOneWidget);
      expect(within('lent', '7 h busy'), findsOneWidget);
      expect(
        tester.getTopLeft(within('lent', 'MACs-Mac-Studio')).dy,
        lessThan(tester.getTopLeft(within('lent', 'build-box')).dy),
      );
    });

    /// Ken's two machines: one with a subscription read, one not read yet.
    List<Object> machines() => [
      {
        'machineId': 'studio',
        'machineName': 'MACs-Mac-Studio.local',
        'shipped': 5,
        'busyHours': 31,
        'subscriptions': [
          {
            'engine': 'claude',
            'usedPercent': 38,
            'resetsAt': DateTime.now()
                .add(const Duration(days: 3, hours: 2))
                .millisecondsSinceEpoch,
          },
          {'engine': 'codex', 'usedPercent': null, 'resetsAt': null},
        ],
      },
      {
        'machineId': 'box',
        'machineName': 'build-box',
        'shipped': 0,
        'busyHours': 0,
        'subscriptions': <Object>[],
      },
    ];

    testWidgets('from a server with Brought, the machines the person brought '
        'stand in place of Lent, each subscription\'s week under its '
        'machine', (tester) async {
      await pump(tester, detailed(brought: machines()));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-leaderboard-person-ken'));
      await tester.pumpAndSettle();

      Finder within(String text) =>
          inside('swarm-leaderboard-details-brought', find.text(text));
      expect(key('swarm-leaderboard-details-lent'), findsNothing);
      expect(within('Brought'), findsOneWidget);
      expect(within('2'), findsOneWidget, reason: 'its count');
      // Named without .local, as the desktop does.
      expect(within('MACs-Mac-Studio'), findsOneWidget);
      expect(within('5 shipped · 31 h for others'), findsOneWidget);
      expect(within('Claude'), findsOneWidget);
      expect(within('38% used · resets in 3d'), findsOneWidget);
      expect(within('Codex'), findsOneWidget);
      expect(within('not read yet'), findsOneWidget);
      expect(within('build-box'), findsOneWidget);
      expect(within('0 shipped · 0 h for others'), findsOneWidget);
      // Each subscription under its machine, set in and quieter.
      final studio = tester.getTopLeft(within('MACs-Mac-Studio'));
      final claude = tester.getTopLeft(within('Claude'));
      final codex = tester.getTopLeft(within('Codex'));
      final box = tester.getTopLeft(within('build-box'));
      expect(studio.dy, lessThan(claude.dy));
      expect(claude.dy, lessThan(codex.dy));
      expect(codex.dy, lessThan(box.dy));
      expect(claude.dx, greaterThan(studio.dx));
      expect(
        tester.widget<Text>(within('Claude')).style!.color,
        AppPalette.textSecondary,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('from a server with Brought and nothing brought, it says so', (
      tester,
    ) async {
      await pump(tester, detailed(brought: <Object>[]));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-leaderboard-person-ken'));
      await tester.pumpAndSettle();

      expect(
        inside(
          'swarm-leaderboard-details-brought',
          find.text('No machines brought yet'),
        ),
        findsOneWidget,
      );
      expect(key('swarm-leaderboard-details-lent'), findsNothing);
    });

    testWidgets('a 320pt phone with large text fits a brought machine\'s '
        'lines', (tester) async {
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(320 * 2, 568 * 2);
      addTearDown(tester.view.reset);
      tester.platformDispatcher.textScaleFactorTestValue = 1.3;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await pump(tester, detailed(brought: machines()));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-leaderboard-person-ken'));
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      final sheet = tester.getRect(key('swarm-leaderboard-details'));
      for (final text in [
        '5 shipped · 31 h for others',
        '38% used · resets in 3d',
      ]) {
        final line = tester.getRect(
          inside('swarm-leaderboard-details-brought', find.text(text)),
        );
        expect(line.right, lessThanOrEqualTo(sheet.right), reason: text);
      }
      // The machine's name keeps its room beside its measure.
      final name = tester.getRect(
        inside(
          'swarm-leaderboard-details-brought',
          find.text('MACs-Mac-Studio'),
        ),
      );
      expect(name.width, greaterThan(0));
      expect(
        name.right,
        lessThan(
          tester
              .getRect(
                inside(
                  'swarm-leaderboard-details-brought',
                  find.text('5 shipped · 31 h for others'),
                ),
              )
              .left,
        ),
      );
    });

    testWidgets('a pull request opens in the in-app browser; one without a '
        'web link is text', (tester) async {
      final opened = launches(tester);
      await pump(tester, detailed());
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-leaderboard-person-diego'));
      await tester.pumpAndSettle();

      const web = 'Desktop: a machine shows its agents as one count';
      const file = 'Swarm digest pauses with the Swarm';
      expect(
        tester.widget<Text>(find.text(web)).style!.color,
        AppPalette.swarmAccent,
      );
      expect(
        tester.widget<Text>(find.text(file)).style!.color,
        AppPalette.textPrimary,
      );
      expect(
        tester
            .getSize(
              find.ancestor(of: find.text(web), matching: find.byType(InkWell)),
            )
            .height,
        greaterThanOrEqualTo(minTouchTarget),
        reason: 'a thumb',
      );
      expect(
        tester.getSemantics(
          find.ancestor(of: find.text(web), matching: find.byType(InkWell)),
        ),
        isSemantics(label: web, isLink: true, hasTapAction: true),
      );

      await tester.tap(find.text(web));
      await tester.pumpAndSettle();
      expect(opened, [
        'https://github.com/autonomous-ai/openharness/pull/1824',
      ]);
      await tester.tap(find.text(file));
      await tester.pumpAndSettle();
      expect(opened, hasLength(1), reason: 'only a web page opens');
      expect(
        find.ancestor(of: find.text(file), matching: find.byType(InkWell)),
        findsNothing,
      );
      // The sheet stays: nothing behind it was tapped.
      expect(key(sheet), findsOneWidget);
    });

    testWidgets('a long list shows its newest five, Show all the rest, and '
        'scrolls inside the sheet on a small phone', (tester) async {
      await tester.binding.setSurfaceSize(const Size(375, 667));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await pump(
        tester,
        detailed(
          shipped: [
            for (var i = 0; i < 20; i++)
              {'title': 'Pull request $i', 'prUrl': 'https://x.dev/pull/$i'},
          ],
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-leaderboard-person-diego'));
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      expect(
        inside('swarm-leaderboard-details-shipped', find.text('20')),
        findsOneWidget,
      );
      expect(find.text('Pull request 4'), findsOneWidget);
      expect(find.text('Pull request 5'), findsNothing);
      // Never over the status bar.
      expect(tester.getSize(key(sheet)).height, lessThanOrEqualTo(667 * .82));

      await tester.tap(find.text('Show all 20'));
      await tester.pumpAndSettle();
      expect(find.text('Show all 20'), findsNothing);
      final scroll = find.descendant(
        of: key('swarm-leaderboard-details'),
        matching: find.byType(Scrollable),
      );
      await tester.scrollUntilVisible(
        find.text('No machines lent yet'),
        100,
        scrollable: scroll.first,
      );
      expect(find.text('Pull request 19'), findsOneWidget);
      expect(find.text('No machines lent yet'), findsOneWidget);
      // The sheet's title stays above what scrolls.
      expect(inside(sheet, find.text('diego')), findsOneWidget);
      expect(
        tester.getBottomLeft(inside(sheet, find.text('diego'))).dy,
        lessThanOrEqualTo(
          tester.getTopLeft(key('swarm-leaderboard-details')).dy,
        ),
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('five or fewer have no Show all', (tester) async {
      await pump(
        tester,
        detailed(
          shipped: [
            for (var i = 0; i < 5; i++)
              {'title': 'Pull request $i', 'prUrl': 'https://x.dev/pull/$i'},
          ],
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-leaderboard-person-diego'));
      await tester.pumpAndSettle();
      expect(find.text('Pull request 4'), findsOneWidget);
      expect(find.textContaining('Show all'), findsNothing);
    });
  });

  group("a person's week closes when what opened it is lost", () {
    const sheet = 'swarm-leaderboard-sheet';

    /// The page over the scripted Swarm with diego's week open.
    Future<({FakeSwarm fake, SwarmHost host, ValueNotifier<String?> account})>
    withSheet(WidgetTester tester) async {
      final fake = backend();
      final account = ValueNotifier<String?>(me);
      final host = await pump(tester, fake, signedIn: account);
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-leaderboard-person-diego'));
      await tester.pumpAndSettle();
      expect(inside(sheet, find.text('diego')), findsOneWidget);
      return (fake: fake, host: host, account: account);
    }

    int boardReads(FakeSwarm fake) =>
        fake.paths.where((p) => p.contains('/leaderboard')).length;

    testWidgets('it stays while nothing is lost, a refresh included', (
      tester,
    ) async {
      final (:fake, :host, account: _) = await withSheet(tester);

      await host.session!.inbox.refresh();
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(inside(sheet, find.text('diego')), findsOneWidget);
    });

    testWidgets('the Swarm leaving the account\'s list closes it, clears the '
        'board and reads no more', (tester) async {
      final (:fake, :host, account: _) = await withSheet(tester);
      final reads = boardReads(fake);

      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': <Object>[],
        'next': null,
      };
      await host.session!.inbox.refresh();
      await tester.pumpAndSettle();

      expect(key(sheet), findsNothing);
      expect(find.text('diego'), findsNothing);
      expect(key('swarm-leaderboard-person-diego'), findsNothing);
      expect(
        key('swarm-leaderboard-loading'),
        findsNothing,
        reason: 'no loading for an answer that will not come',
      );
      await tester.pump(const Duration(minutes: 11));
      expect(boardReads(fake), reads, reason: 'nothing read once revoked');
    });

    testWidgets('the project going from the Swarm closes it', (tester) async {
      final (:fake, :host, account: _) = await withSheet(tester);

      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c3'),
        'head': part('head', 2, headData(projects: [])),
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(host.session!.inbox.reader(tab)!.snapshot!.projects, isEmpty);
      expect(key(sheet), findsNothing);
      expect(find.text('diego'), findsNothing);
    });

    testWidgets('a sign-out closes it', (tester) async {
      final (:fake, host: _, :account) = await withSheet(tester);
      final reads = boardReads(fake);

      account.value = null;
      await tester.pumpAndSettle();

      expect(key(sheet), findsNothing);
      expect(find.text('diego'), findsNothing);
      await tester.pump(const Duration(minutes: 11));
      expect(boardReads(fake), reads);
    });

    testWidgets('another account closes it, and its board is the new one\'s', (
      tester,
    ) async {
      final (:fake, host: _, :account) = await withSheet(tester);

      account.value = 'person-other';
      await tester.pumpAndSettle();

      expect(key(sheet), findsNothing);
    });

    testWidgets('the page asked for another project closes it', (tester) async {
      final fake = backend();
      final account = ValueNotifier<String?>(me);
      final host = await pump(tester, fake, signedIn: account);
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-leaderboard-person-diego'));
      await tester.pumpAndSettle();
      expect(key(sheet), findsOneWidget);

      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) =>
              SwarmScope(notifier: host, child: child!),
          home: SwarmLeaderboardPage(
            swarmId: tab,
            projectId: 'project-other',
            now: () => now,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(key(sheet), findsNothing);
      expect(find.text('diego'), findsNothing);
      expect(key('swarm-leaderboard-person-diego'), findsNothing);
      expect(key('swarm-leaderboard-loading'), findsNothing);
      expect(
        fake.paths.where((p) => p.contains('projectId=project-other')),
        isEmpty,
        reason: 'a project the Swarm does not have is not asked for',
      );
    });

    testWidgets('the project back on the Swarm reads its board again', (
      tester,
    ) async {
      final (:fake, :host, account: _) = await withSheet(tester);
      final reads = boardReads(fake);
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c3'),
        'head': part('head', 2, headData(projects: [])),
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(key('swarm-leaderboard-person-diego'), findsNothing);

      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c4'),
        'head': part('head', 3, headData()),
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(key('swarm-leaderboard-person-diego'), findsOneWidget);
      expect(boardReads(fake), reads + 1);
      expect(key(sheet), findsNothing, reason: 'the week stays closed');
    });

    /// The page with diego's row tapped and no frame drawn since: the sheet
    /// is pushed but has not been built.
    Future<({FakeSwarm fake, SwarmHost host})> tappedNotDrawn(
      WidgetTester tester,
    ) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-leaderboard-person-diego'));
      expect(key(sheet), findsNothing, reason: 'no frame since the tap');
      return (fake: fake, host: host);
    }

    testWidgets('access refused between the tap and the first frame of the '
        'week: it does not stay', (tester) async {
      final (:fake, :host) = await tappedNotDrawn(tester);

      host.session!.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();

      expect(key(sheet), findsNothing);
      expect(find.text('diego'), findsNothing);
    });

    testWidgets('the Swarm dropped from the list between the tap and the '
        'first frame of the week: it does not stay', (tester) async {
      final (:fake, :host) = await tappedNotDrawn(tester);

      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': <Object>[],
        'next': null,
      };
      await host.session!.inbox.refresh();
      await tester.pumpAndSettle();

      expect(key(sheet), findsNothing);
      expect(find.text('diego'), findsNothing);
    });

    testWidgets('the project removed between the tap and the first frame of '
        'the week: it does not stay', (tester) async {
      final (:fake, :host) = await tappedNotDrawn(tester);

      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c3'),
        'head': part('head', 2, headData(projects: [])),
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(key(sheet), findsNothing);
      expect(find.text('diego'), findsNothing);
    });

    testWidgets('a signed-out account between the tap and the first frame '
        'of the week: it does not stay', (tester) async {
      final fake = backend();
      final account = ValueNotifier<String?>(me);
      await pump(tester, fake, signedIn: account);
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-leaderboard-person-diego'));

      account.value = null;
      await tester.pumpAndSettle();

      expect(key(sheet), findsNothing);
      expect(find.text('diego'), findsNothing);
    });

    testWidgets('a board read still out when access is lost shows nothing '
        'when it lands', (tester) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await tester.pumpAndSettle();
      final gate = Completer<void>();
      fake.routes[path] = (_) async {
        await gate.future;
        return board();
      };
      // A pull: the board is read again, and the answer is still out.
      await tester.fling(
        key('swarm-leaderboard-person-diego'),
        const Offset(0, 400),
        1000,
      );
      for (var i = 0; i < 20 && boardReads(fake) < 2; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(boardReads(fake), 2, reason: 'the pull is out');

      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': <Object>[],
        'next': null,
      };
      await host.session!.inbox.refresh();
      gate.complete();
      await tester.pumpAndSettle();

      expect(key('swarm-leaderboard-person-diego'), findsNothing);
      expect(find.text('diego'), findsNothing);
      expect(key('swarm-leaderboard-team'), findsNothing);
    });
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

    expect(fake.paths.where((p) => p.startsWith(path)), hasLength(2));
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
