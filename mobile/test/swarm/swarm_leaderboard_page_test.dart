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
import 'package:harness_mobile/swarm/swarm_style.dart' show SwarmAvatar;

import '../theme/sheet_shape.dart';
import '../voice_fakes.dart';
import 'leaderboard_fixture.dart';
import 'swarm_fixture.dart';

/// The leaderboard page over a scripted backend, built to the design system's
/// Numbers and rankings at phone sizes, with the desktop's member list's
/// rows on one screen, no tabs: Humans with the week picker, skeleton rows
/// while it reads, then each person as a row of rank, avatar, name (number
/// one's with the crown) over their non-zero numbers, and points, the one
/// number; then the PM and Buddies, ranked the same way with their Team
/// line, read only; then the models, each with only the share of its work
/// approved at its first review; a week picker and a person's week in
/// bottom sheets.
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
    // The desktop's Agents and Models for the same week
    // (desktop/test/super_tab_leaderboard_tabs_test.dart).
    data['agents'] = [
      agentScoreData(
        'agent-lead',
        displayName: 'River',
        points: 36,
        rank: 1,
        shipped: 12,
      ),
      agentScoreData(
        'buddy-ken',
        displayName: 'Aria',
        kind: 'buddy',
        personId: 'ken',
        points: 12,
        rank: 2,
        shipped: 4,
      ),
    ];
    data['byModel'] = [
      modelScoreData(
        'claude',
        model: 'opus',
        effort: 'high',
        points: 93,
        rank: 1,
        shipped: 31,
        medianAttemptMs: 47 * 60000,
        medianRequestMs: 3 * 3600000,
        reviewed: 34,
        passed: 28,
      ),
      modelScoreData(
        'codex',
        model: 'gpt-5.5',
        points: 52,
        rank: 2,
        shipped: 17,
      ),
      modelScoreData(
        'codex',
        model: 'gpt-5.5',
        effort: 'medium',
        points: 5,
        rank: 3,
        reviews: 5,
      ),
    ];
    return data;
  }

  /// One Swarm whose members are the viewer, diego and ken; dee scores on
  /// the board but has left. Its agents are the fixture's, River the PM,
  /// unless [agents] says otherwise.
  FakeSwarm backend({List<Map<String, dynamic>>? agents}) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        agents: agents,
        machines: [
          {
            'machineId': 'mac-1',
            'name': 'Mac Studio.local',
            'contributorId': me,
          },
        ],
      ),
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
    // Humans leads, the week picker at its right, then the rows.
    expect(
      inside('swarm-leaderboard-heading-humans', key('swarm-leaderboard-week')),
      findsOneWidget,
    );
    expect(
      inside('swarm-leaderboard-week', find.text('This week')),
      findsOneWidget,
    );
    expect(
      y(tester, 'swarm-leaderboard-week'),
      lessThan(y(tester, 'swarm-leaderboard-person-diego')),
    );

    const diego = 'swarm-leaderboard-person-diego';
    expect(inside(diego, find.textContaining('diego')), findsOneWidget);
    // The face diego chose, not the initial.
    expect(inside(diego, find.text('🦉')), findsOneWidget);
    expect(inside(diego, find.text('D')), findsNothing);
    expect(
      tester.getSemantics(key(diego)),
      isSemantics(
        label:
            'diego, place 1, 28 points, number one this week, 8 shipped, '
            '1 unblocked, 40 hours lent',
        isButton: true,
      ),
    );
    // The label says what the row shows: a number at zero is left out.
    expect(
      tester.getSemantics(key('swarm-leaderboard-person-ken')),
      isSemantics(label: 'ken, place 2, 21 points, 3 shipped', isButton: true),
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

  testWidgets('one number per row: no change against last week, and no '
      "team's total", (tester) async {
    await pump(tester, backend());
    await tester.pumpAndSettle();
    // diego moved up 8 and ken down 4 against last week: neither says so.
    for (final id in ['diego', 'ken', me, 'dee']) {
      final row = key('swarm-leaderboard-person-$id');
      expect(
        find.descendant(of: row, matching: find.byType(Icon)),
        findsNothing,
      );
      expect(key('swarm-leaderboard-trend-$id'), findsNothing);
      expect(
        tester.getSemantics(row).label,
        isNot(contains('last week')),
        reason: id,
      );
    }
    expect(
      inside('swarm-leaderboard-person-diego', find.text('8')),
      findsNothing,
    );
    expect(key('swarm-leaderboard-team'), findsNothing);
    expect(find.textContaining('shipped this week'), findsNothing);
    expect(find.textContaining('11 last week'), findsNothing);
  });

  testWidgets("number one's crown beside their name, said in words, and "
      "nobody's at the start of a week", (tester) async {
    final fake = backend();
    await pump(tester, fake);
    await tester.pumpAndSettle();
    const crown = 'swarm-leaderboard-crown-diego';
    expect(
      inside('swarm-leaderboard-person-diego', key(crown)),
      findsOneWidget,
    );
    expect(inside(crown, find.text('👑')), findsOneWidget);
    expect(find.text('👑'), findsOneWidget, reason: 'only number one');
    // At the metadata size, so a crowned row is as tall as any other.
    expect(
      tester.widget<Text>(inside(crown, find.text('👑'))).style!.fontSize,
      AppType.captionSize,
    );
    expect(
      tester.getSize(key('swarm-leaderboard-person-diego')).height,
      tester.getSize(key('swarm-leaderboard-person-ken')).height,
    );

    // Last week's number one wears it for last week.
    await tester.tap(key('swarm-leaderboard-week'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Last week'));
    await tester.pumpAndSettle();
    expect(key('swarm-leaderboard-crown-ken'), findsOneWidget);
    expect(
      tester.getSemantics(key('swarm-leaderboard-person-ken')).label,
      contains('number one last week'),
    );

    // Monday morning: everyone on 0, nobody has taken #1 yet.
    fake.routes[path] = (_) => leaderboardData(
      week: monday,
      people: [
        scoreData('diego', points: 0, rank: 1),
        scoreData('ken', points: 0, rank: 1),
      ],
    );
    await tester.tap(key('swarm-leaderboard-week'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('This week').last);
    await tester.pumpAndSettle();
    expect(key('swarm-leaderboard-person-diego'), findsOneWidget);
    expect(find.text('👑'), findsNothing);
  });

  group('Humans, Agents and Models on one screen', () {
    /// A phone tall enough for the whole board, so every list is built.
    void tall(WidgetTester tester) {
      tester.view.physicalSize = const Size(1170, 4500);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
    }

    Finder row(String id) => key('swarm-leaderboard-row-$id');
    Finder inRow(String id, Finder finder) =>
        find.descendant(of: row(id), matching: finder);
    Finder model(String name) => key('swarm-leaderboard-model-$name');
    Finder inModel(String name, Finder finder) =>
        find.descendant(of: model(name), matching: finder);

    /// [id]'s line holds [parts]: what fits shown, whole parts from its
    /// start, and all of them heard.
    void hasLine(WidgetTester tester, String id, List<String> parts) {
      final full = parts.join(' · ');
      final shown = tester
          .widget<Text>(
            find.descendant(
              of: key('swarm-leaderboard-line-$id'),
              matching: find.byType(Text),
            ),
          )
          .data!;
      expect(shown, startsWith(parts.first));
      expect(
        shown == full || full.substring(shown.length).startsWith(' · '),
        isTrue,
        reason: shown,
      );
      expect(tester.getSemantics(row(id)).label, endsWith(parts.join(', ')));
    }

    /// Three models' first reviews this week: Opus at two efforts (11 of
    /// 12), GPT-5.6 Sol (13 of 16), Sonnet (7 of 10), and one with nothing
    /// reviewed.
    Map<String, dynamic> withModels() => {
      ...board(),
      'byModel': [
        modelScoreData('codex', model: 'gpt-5.6-sol', reviewed: 16, passed: 13),
        modelScoreData(
          'claude',
          model: 'claude-opus-5-5',
          effort: 'high',
          reviewed: 8,
          passed: 7,
        ),
        modelScoreData(
          'claude',
          model: 'claude-opus-5-5',
          effort: 'xhigh',
          reviewed: 4,
          passed: 4,
        ),
        modelScoreData(
          'claude',
          model: 'claude-sonnet-5-5',
          reviewed: 10,
          passed: 7,
        ),
        modelScoreData('codex', model: 'gpt-5.5', effort: 'medium', reviews: 5),
      ],
    };

    testWidgets('no tabs: Humans with the week picker, then Agents, then '
        'Models, all from one read, and the week sets all three', (
      tester,
    ) async {
      tall(tester);
      final fake = backend();
      fake.routes[path] = (_) => withModels();
      await pump(tester, fake);
      await tester.pumpAndSettle();
      for (final name in ['humans', 'agents', 'models']) {
        expect(key('swarm-leaderboard-tab-$name'), findsNothing, reason: name);
      }
      expect(find.text('Humans'), findsOneWidget);
      expect(find.text('Agents'), findsOneWidget);
      expect(find.text('Models'), findsOneWidget);
      final order = [
        y(tester, 'swarm-leaderboard-heading-humans'),
        y(tester, 'swarm-leaderboard-person-diego'),
        y(tester, 'swarm-leaderboard-person-dee'),
        y(tester, 'swarm-leaderboard-heading-agents'),
        y(tester, 'swarm-leaderboard-row-agent-agent-lead'),
        y(tester, 'swarm-leaderboard-row-agent-buddy-ken'),
        y(tester, 'swarm-leaderboard-heading-models'),
        y(tester, 'swarm-leaderboard-model-Opus 5.5'),
      ];
      expect(order, [...order]..sort(), reason: 'top to bottom');
      for (final heading in ['Humans', 'Agents', 'Models']) {
        expect(
          tester.getSemantics(find.text(heading)),
          isSemantics(label: heading, isHeader: true),
        );
      }
      expect(fake.paths.where((p) => p.contains('/leaderboard')), [
        path,
      ], reason: 'one read serves all three lists');

      // Last week's board has people only: no Agents or Models to show.
      await tester.tap(key('swarm-leaderboard-week'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Last week'));
      await tester.pumpAndSettle();
      expect(key('swarm-leaderboard-person-ken'), findsOneWidget);
      expect(find.text('Agents'), findsNothing);
      expect(find.text('Models'), findsNothing);
      expect(key('swarm-leaderboard-loading'), findsNothing);
    });

    testWidgets('the PM and Buddies: role, the line their Team row gives, '
        "the engine's mark and points; no crown; read only", (tester) async {
      tall(tester);
      await pump(tester, backend());
      await tester.pumpAndSettle();
      const pm = 'agent-agent-lead', buddy = 'agent-buddy-ken';
      expect(inRow(pm, find.textContaining('River')), findsOneWidget);
      expect(inRow(pm, find.textContaining('  PM')), findsOneWidget);
      // What it is doing, where and on what, as the desktop's row says it.
      hasLine(tester, pm, ['Idle', 'Mac Studio', 'Opus · high']);
      expect(key('swarm-leaderboard-engine-$pm'), findsOneWidget);
      expect(inRow(pm, find.text('36')), findsOneWidget);
      expect(inRow(pm, find.text('1')), findsOneWidget, reason: 'its place');
      // Aria, Buddy of ken, is in no Swarm read here: its name and person
      // as the board and the members give them, and nothing more.
      expect(inRow(buddy, find.textContaining('Aria')), findsOneWidget);
      expect(inRow(buddy, find.textContaining('Buddy · ken')), findsOneWidget);
      expect(key('swarm-leaderboard-line-$buddy'), findsNothing);
      expect(key('swarm-leaderboard-engine-$buddy'), findsNothing);
      expect(inRow(buddy, find.text('12')), findsOneWidget);
      // What they shipped is not the line any more.
      expect(find.textContaining('shipped', findRichText: true), findsWidgets);
      expect(inRow(pm, find.textContaining('12 shipped')), findsNothing);
      // The crown is the top person's alone.
      expect(key('swarm-leaderboard-crown-$pm'), findsNothing);
      expect(find.text('👑'), findsOneWidget);
      expect(
        tester.getSemantics(row(pm)),
        isSemantics(
          label: 'River, PM, place 1, 36 points, Idle, Mac Studio, Opus · high',
          isButton: false,
        ),
      );
      expect(
        tester.getSemantics(row(buddy)).label,
        'Aria, Buddy · ken, place 2, 12 points',
      );
      // Rank and points each hold one right-aligned column, the people's too.
      double right(Finder finder) => tester.getTopRight(finder).dx;
      expect(
        right(inRow(pm, find.text('36'))),
        right(inRow(buddy, find.text('12'))),
      );
      expect(
        right(inRow(pm, find.text('36'))),
        right(inside('swarm-leaderboard-person-diego', find.text('28'))),
      );
      expect(
        right(inRow(pm, find.text('1'))),
        right(inRow(buddy, find.text('2'))),
      );
      // Read only: a tap opens nothing.
      await tester.tap(row(pm));
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
    });

    testWidgets("a Buddy's person is named as their own row names them; one "
        'who has left, not at all', (tester) async {
      tall(tester);
      final fake = backend();
      fake.routes[path] = (_) {
        final data = board();
        (data['people'] as List<Map<String, dynamic>>)[1]['displayName'] =
            'Ken Nguyen';
        (data['agents'] as List<Map<String, dynamic>>).add(
          agentScoreData(
            'buddy-dee',
            displayName: 'Old Buddy',
            kind: 'buddy',
            personId: 'dee',
            points: 0,
            rank: 3,
          ),
        );
        return data;
      };
      await pump(tester, fake);
      await tester.pumpAndSettle();
      expect(
        inside('swarm-leaderboard-person-ken', find.text('Ken Nguyen')),
        findsOneWidget,
      );
      expect(
        tester.getSemantics(row('agent-buddy-ken')).label,
        'Aria, Buddy · Ken Nguyen, place 2, 12 points',
      );
      // dee is on the board but no longer a member: the Buddy names nobody.
      expect(
        tester.getSemantics(row('agent-buddy-dee')).label,
        'Old Buddy, Buddy, place 3, 0 points',
      );
    });

    testWidgets("a Buddy of this project reads Idle or Down; an effort that "
        'names none is left out', (tester) async {
      tall(tester);
      final fake = backend(
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          {
            ...agent('buddy-ken', name: 'Aria', displayName: 'Aria'),
            'buddyOf': {'personId': 'ken'},
            'configuration': {
              'engine': 'codex',
              'model': 'gpt-5.6-sol',
              'effort': 'auto',
            },
          },
        ],
      );
      final host = await pump(tester, fake);
      await tester.pumpAndSettle();
      const buddy = 'agent-buddy-ken';
      hasLine(tester, buddy, ['Idle', 'Mac Studio', 'GPT-5.6 Sol']);
      expect(key('swarm-leaderboard-engine-$buddy'), findsOneWidget);

      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c3'),
        'agents': [
          part('buddy-ken', 2, {
            ...agent('buddy-ken', name: 'Aria', displayName: 'Aria'),
            'buddyOf': {'personId': 'ken'},
            'downSince': '2026-10-28T01:00:00.000Z',
          }),
        ],
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      hasLine(tester, buddy, ['Down', 'Mac Studio', 'Opus · high']);
    });

    testWidgets('models: the share of their work approved at its first '
        'review, the most approved first, and nothing else', (tester) async {
      tall(tester);
      final fake = backend();
      fake.routes[path] = (_) => withModels();
      await pump(tester, fake);
      await tester.pumpAndSettle();
      expect(inModel('Opus 5.5', find.text('92%')), findsOneWidget);
      expect(inModel('GPT-5.6 Sol', find.text('81%')), findsOneWidget);
      expect(inModel('Sonnet 5.5', find.text('70%')), findsOneWidget);
      // Nothing reviewed this week: no share, no row.
      expect(model('GPT-5.5'), findsNothing);
      expect(
        y(tester, 'swarm-leaderboard-model-Opus 5.5'),
        lessThan(y(tester, 'swarm-leaderboard-model-GPT-5.6 Sol')),
      );
      expect(
        y(tester, 'swarm-leaderboard-model-GPT-5.6 Sol'),
        lessThan(y(tester, 'swarm-leaderboard-model-Sonnet 5.5')),
      );
      // The name and the number alone: no place, points, effort or mark.
      expect(
        find.descendant(of: model('Opus 5.5'), matching: find.byType(Text)),
        findsNWidgets(2),
      );
      expect(inModel('Opus 5.5', find.textContaining('high')), findsNothing);
      expect(find.text('👑'), findsOneWidget, reason: "the top person's");
      // A screen reader hears the counts behind the share.
      expect(
        tester.getSemantics(model('Opus 5.5')),
        isSemantics(
          label: 'Opus 5.5, 92% approved, 11 of 12 passed first review',
        ),
      );
      // The name starts where the faces do; the share ends where points do.
      final face = find.descendant(
        of: key('swarm-leaderboard-person-diego'),
        matching: find.byType(SwarmAvatar),
      );
      expect(
        tester.getTopLeft(inModel('Opus 5.5', find.text('Opus 5.5'))).dx,
        tester.getTopLeft(face).dx,
      );
      expect(
        tester.getTopRight(inModel('Opus 5.5', find.text('92%'))).dx,
        tester
            .getTopRight(
              inside('swarm-leaderboard-person-diego', find.text('28')),
            )
            .dx,
      );
    });

    testWidgets('no agent and no model reviewed: no Agents or Models, and '
        'the people as ever', (tester) async {
      tall(tester);
      final fake = backend();
      fake.routes[path] = (_) => {
        ...board(),
        'agents': <Object>[],
        'byModel': [modelScoreData('codex', model: 'gpt-5.5', shipped: 3)],
      };
      await pump(tester, fake);
      await tester.pumpAndSettle();
      expect(key('swarm-leaderboard-person-diego'), findsOneWidget);
      expect(find.text('Agents'), findsNothing);
      expect(find.text('Models'), findsNothing);
      expect(key('swarm-leaderboard-loading'), findsNothing);
    });

    testWidgets("an agent id reused in another project wears none of that "
        "agent's face, line or engine", (tester) async {
      tall(tester);
      final owl = {'kind': 'preset', 'key': 'owl'};
      final fake = backend(
        agents: [
          {
            ...agent('agent-lead', name: 'Lead', displayName: 'River'),
            'avatar': owl,
          },
          // The same terminal added again in another project: the backend
          // names the one this board credits "Former Buddy" and gives no
          // person.
          {
            ...agent('agent-moved', name: 'Moved', displayName: 'Sol'),
            'projectId': 'project-2',
            'avatar': {'kind': 'preset', 'key': 'fox'},
          },
        ],
      );
      fake.routes[path] = (_) => {
        ...board(),
        'agents': [
          agentScoreData(
            'agent-lead',
            displayName: 'River',
            points: 36,
            rank: 1,
            shipped: 12,
          ),
          agentScoreData(
            'agent-moved',
            displayName: 'Former Buddy',
            kind: 'buddy',
            points: 3,
            rank: 2,
            shipped: 1,
          ),
        ],
      };
      await pump(tester, fake);
      await tester.pumpAndSettle();
      expect(inRow('agent-agent-lead', find.text('🦉')), findsOneWidget);
      const moved = 'agent-agent-moved';
      expect(inRow(moved, find.textContaining('Former Buddy')), findsOneWidget);
      expect(inRow(moved, find.text('🦊')), findsNothing, reason: 'its face');
      expect(inRow(moved, find.textContaining('Sol')), findsNothing);
      expect(key('swarm-leaderboard-line-$moved'), findsNothing);
      expect(key('swarm-leaderboard-engine-$moved'), findsNothing);
      // No person given: no one named as its owner.
      expect(
        tester.getSemantics(row(moved)).label,
        'Former Buddy, Buddy, place 2, 3 points',
      );
    });
  });

  testWidgets("a person's status beside their name while it lasts", (
    tester,
  ) async {
    final fake = backend();
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(),
      'members': [
        part(me, 1, person(me)),
        part('diego', 1, {
          ...person('diego', role: 'collaborator'),
          'status': {'text': 'Coffee break', 'emoji': '☕'},
        }),
        part('ken', 1, {
          ...person('ken', role: 'collaborator'),
          'status': {'text': 'At lunch', 'until': '2026-10-01T00:00:00.000Z'},
        }),
      ],
    };
    await pump(tester, fake);
    await tester.pumpAndSettle();
    const diego = 'swarm-leaderboard-person-diego';
    expect(
      inside(diego, find.textContaining('Coffee break', findRichText: true)),
      findsOneWidget,
    );
    expect(
      tester.getSemantics(key(diego)).label,
      startsWith(
        'diego, place 1, 28 points, number one this week, '
        'Coffee break, 8 shipped',
      ),
    );
    // Over: not shown.
    expect(find.textContaining('At lunch', findRichText: true), findsNothing);
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

  testWidgets("no cups, medals or sparkles: number one's crown is its one "
      'mark', (tester) async {
    await pump(tester, backend());
    await tester.pump();
    await tester.pump();
    for (final mark in ['🥇', '🥈', '🥉', '🏆', '🚀', '✨']) {
      expect(find.textContaining(mark), findsNothing, reason: mark);
    }
    expect(key('swarm-leaderboard-sparkle'), findsNothing);
    await tester.pumpAndSettle();
    expect(find.text('👑'), findsOneWidget);
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
      expect(key('swarm-leaderboard-person-ken'), findsNothing);

      await tester.pumpAndSettle();
      expect(key('swarm-leaderboard-person-diego'), findsNothing);
      expect(
        inside('swarm-leaderboard-points-ken', find.text('9')),
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
      expect(key('swarm-leaderboard-tab-humans'), findsNothing);
      expect(key('swarm-leaderboard-loading'), findsNothing);

      await tester.pump(const Duration(minutes: 11));
      expect(fake.paths.length, reads, reason: 'nothing read once signed out');
    });
  });
}
