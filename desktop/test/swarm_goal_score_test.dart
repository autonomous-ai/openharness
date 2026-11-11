import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/super_tabs/github_issues.dart';
import 'package:harness/super_tabs/goal_score.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'support/focus_in.dart';
import 'support/super_tab_fixture.dart';
import 'support/swarm_goal_gh.dart';
import 'support/swarm_v4_channel.dart';

/// A project's bar says how far its goal is (Swarm plan, rule 1; docs/design/2026-11-11-swarm-goal, option A): `Goal 3 of 7`
/// after the project's name, a dropdown that stays plain text until hovered, whose menu lists the milestones that do not pass
/// yet. Clicked through as a person does, against a `gh` that answers as GitHub does.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  // Seven milestones: three pass, two fail, one has no run and one's run is queued, none beside another of its kind.
  const file = '''
| Milestone | Check |
|---|---|
| Boots in under 20 s | `make boot` |
| Busy room is detected | `make busy-room` |
| Update rolls back on failure | `make rollback` |
| Night mode by voice | `make night` |
| Desk talk is left alone | `make desk-talk` |
| Voice timer survives a restart | `make timer` |
| Alarm rings offline | `make alarm` |
''';
  List<Map<String, Object?>> runs() => [
    goalRun(1, 'Boots in under 20 s', 'SUCCESS'),
    goalRun(3, 'Update rolls back on failure', 'FAILURE'),
    goalRun(4, 'Night mode by voice', 'SUCCESS'),
    goalRun(5, 'Desk talk is left alone', null, status: 'QUEUED'),
    goalRun(6, 'Voice timer survives a restart', 'TIMED_OUT'),
    goalRun(7, 'Alarm rings offline', 'SUCCESS'),
  ];
  FakeGoalGitHub lampos() =>
      FakeGoalGitHub(file: file, landings: [FakeLanding(runs())]);

  /// The Swarm of lampos, whose repository is acme/lampos, as [gh] answers for it.
  ConversationServer server() {
    final server = swarmV4Channel();
    (server.state['projects'] as List).first['repository'] = {
      'repositoryUrl': 'https://github.com/acme/lampos',
    };
    return server;
  }

  Future<void> show(
    WidgetTester tester,
    FakeGoalGitHub gh, {
    String saved = 'channel',
    Size size = const Size(1440, 860),
  }) => openSwarmV4(
    tester,
    server(),
    saved: saved,
    size: size,
    github: gh.github,
  );

  /// Every address the app opens outside itself.
  List<String> links(WidgetTester tester) {
    final opened = <String>[];
    const channel = MethodChannel('plugins.flutter.io/url_launcher');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      if (call.method == 'launch') {
        opened.add((call.arguments as Map)['url'] as String);
      }
      return true;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );
    return opened;
  }

  /// The menu's rows, top to bottom: each milestone and its state word.
  List<(String, String?)> rows(WidgetTester tester) => [
    for (final row in tester.widgetList<AppMenuItem>(find.byType(AppMenuItem)))
      (row.label, row.state),
  ];

  bool chevronShown(WidgetTester tester) => tester
      .widget<Visibility>(
        find.descendant(
          of: key('swarm-goal'),
          matching: find.byType(Visibility),
        ),
      )
      .visible;

  testWidgets(
    'the score follows the project\'s name; hover brings its chevron and the primary ink and moves nothing; a click lists what does not pass, fails first, and a row opens its check on GitHub',
    (tester) async {
      final gh = lampos();
      final opened = links(tester);
      await show(tester, gh);
      expect(find.text('Goal 3 of 7'), findsOneWidget);
      expect(gh.calls, hasLength(1));
      // After the name, on its line, in the bar's metadata style with figures of one width.
      final name = tester.getRect(key('super-project-menu'));
      final score = tester.getRect(find.text('Goal 3 of 7'));
      expect(score.left, greaterThan(name.right));
      expect(score.center.dy, moreOrLessEquals(name.center.dy, epsilon: 1));
      Text words() => tester.widget<Text>(find.text('Goal 3 of 7'));
      expect(words().style!.fontSize, 12);
      expect(words().style!.color, DesktopChrome.muted);
      expect(words().style!.fontFeatures, const [FontFeature.tabularFigures()]);
      expect(chevronShown(tester), isFalse);
      expect(
        find.byTooltip('Goal: 3 of 7 milestones pass on main'),
        findsOneWidget,
      );

      // Hover: the chevron and the primary ink, and nothing moves.
      final find_ = tester.getRect(key('super-find-button'));
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      addTearDown(mouse.removePointer);
      await mouse.moveTo(score.center);
      await tester.pump();
      expect(chevronShown(tester), isTrue);
      expect(words().style!.color, DesktopChrome.foreground);
      expect(tester.getRect(find.text('Goal 3 of 7')), score);
      expect(tester.getRect(key('super-project-menu')), name);
      expect(tester.getRect(key('super-find-button')), find_);
      await mouse.moveTo(Offset.zero);
      await tester.pump();
      expect(chevronShown(tester), isFalse);

      // A click: those that fail, then those not run, each in the file's order.
      await tester.tap(key('swarm-goal'));
      await tester.pumpAndSettle();
      expect(rows(tester), [
        ('Update rolls back on failure', 'fails'),
        ('Voice timer survives a restart', 'fails'),
        ('Busy room is detected', 'not run'),
        ('Desk talk is left alone', 'not run'),
      ]);
      expect(chevronShown(tester), isTrue);
      // Only what failed is red.
      final red = Theme.of(tester.element(key('swarm-goal'))).colorScheme.error;
      expect(tester.widget<Text>(find.text('fails').first).style!.color, red);
      expect(
        tester.widget<Text>(find.text('not run').first).style!.color,
        grid.AppPalette.textFaint,
      );
      // Opened within a minute of the read, it asks GitHub nothing.
      expect(gh.calls, hasLength(1));

      // A row opens its check run, and the menu closes.
      await tester.tap(find.text('Update rolls back on failure'));
      await tester.pumpAndSettle();
      expect(find.byType(AppMenuItem), findsNothing);
      expect(opened, ['https://github.com/acme/lampos/runs/3']);
      // One whose check is only queued opens that run; one with no run opens the goal file.
      await tester.tap(key('swarm-goal'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Desk talk is left alone'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-goal'));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Opens agents/GOAL.md on GitHub'), findsOneWidget);
      await tester.tap(find.text('Busy room is detected'));
      await tester.pumpAndSettle();
      expect(opened.skip(1), [
        'https://github.com/acme/lampos/runs/5',
        'https://github.com/acme/lampos/blob/HEAD/agents/GOAL.md',
      ]);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'the keyboard opens it and Escape closes it, with the keys back on the score',
    (tester) async {
      await show(tester, lampos());
      await tester.tap(key('swarm-goal'));
      await tester.pumpAndSettle();
      expect(find.byType(AppMenuItem), findsNWidgets(4));
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byType(AppMenuItem), findsNothing);
      expect(focusIsIn(key('swarm-goal')), isTrue);
      // Focus shows as hover does.
      expect(chevronShown(tester), isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.byType(AppMenuItem), findsNWidgets(4));
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'every milestone passes: the score is plain text, with no menu to open',
    (tester) async {
      final gh = FakeGoalGitHub(
        file: '| Boots in under 20 s | `make boot` |\n| Alarm rings offline | `make alarm` |',
        landings: [
          FakeLanding([
            goalRun(1, 'Boots in under 20 s', 'SUCCESS'),
            goalRun(2, 'Alarm rings offline', 'SUCCESS'),
          ]),
        ],
      );
      await show(tester, gh);
      expect(find.text('Goal 2 of 2'), findsOneWidget);
      expect(
        find.byTooltip('Goal: all 2 milestones pass on main'),
        findsOneWidget,
      );
      expect(
        find.descendant(of: key('swarm-goal'), matching: find.byType(InkWell)),
        findsNothing,
      );
      expect(
        find.descendant(of: key('swarm-goal'), matching: find.byType(Icon)),
        findsNothing,
      );
      await tester.tap(find.text('Goal 2 of 2'));
      await tester.pumpAndSettle();
      expect(find.byType(AppMenuItem), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'a project with no goal file shows nothing: its bar is as it was',
    (tester) async {
      final gh = FakeGoalGitHub(landings: [FakeLanding(runs())]);
      await show(tester, gh);
      expect(gh.calls, hasLength(1));
      expect(find.textContaining('Goal'), findsNothing);
      // Nothing is laid out after the name, not even the room of one.
      expect(tester.getSize(find.byType(SwarmGoalScore)), Size.zero);
      for (final button in [
        'super-project-menu',
        'super-find-button',
        'swarm-tasks-button',
        'swarm-pulls-button',
      ]) {
        expect(key(button), findsOneWidget, reason: button);
      }
    },
  );

  testWidgets(
    'a read that fails keeps the last score, and the menu\'s first line says why',
    (tester) async {
      final gh = lampos();
      await show(tester, gh);
      expect(find.text('Goal 3 of 7'), findsOneWidget);
      gh.failure = FakeGoalGitHub.signedOut;
      // Opened more than a minute after the read, the menu reads again.
      await tester.pump(const Duration(seconds: 61));
      await tester.tap(key('swarm-goal'));
      await tester.pumpAndSettle();
      expect(gh.calls, hasLength(2));
      expect(find.text('Goal 3 of 7'), findsOneWidget);
      expect(
        tester.widget<Text>(key('swarm-goal-stale')).data,
        'Sign in to GitHub: run gh auth login.',
      );
      expect(
        tester.getRect(key('swarm-goal-stale')).bottom,
        lessThanOrEqualTo(tester.getRect(find.byType(AppMenuItem).first).top),
      );
      expect(rows(tester), hasLength(4));
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      // The next read that answers takes the line away, with what changed: the rollback passes now.
      gh
        ..failure = null
        ..landings = [
          FakeLanding([
            ...runs(),
            goalRun(13, 'Update rolls back on failure', 'SUCCESS'),
          ]),
        ];
      await tester.pump(const Duration(seconds: 61));
      await tester.tap(key('swarm-goal'));
      await tester.pumpAndSettle();
      expect(gh.calls, hasLength(3));
      expect(find.text('Goal 4 of 7'), findsOneWidget);
      expect(key('swarm-goal-stale'), findsNothing);
      expect(rows(tester).first, ('Voice timer survives a restart', 'fails'));
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('a computer that could never read the goal shows no score', (
    tester,
  ) async {
    final gh = lampos()..failure = FakeGoalGitHub.signedOut;
    await show(tester, gh);
    expect(gh.calls, hasLength(1));
    expect(find.textContaining('Goal'), findsNothing);
    expect(tester.getSize(find.byType(SwarmGoalScore)), Size.zero);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'a gh that breaks in a way it has no words for shows no score, and nothing is thrown',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SwarmGoalScore(
              repository: 'acme/lampos',
              github: SwarmGitHub(run: (_) async => throw StateError('no')),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.getSize(find.byType(SwarmGoalScore)), Size.zero);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'the goal is read for the project on screen only: not in an agent\'s chat, and not again on coming back within a minute',
    (tester) async {
      final gh = lampos();
      await show(tester, gh, saved: 'agent-chat-pip');
      expect(gh.calls, isEmpty);
      expect(find.byType(SwarmGoalScore), findsNothing);
      await tester.tap(key('super-project-lampos'));
      await tester.pumpAndSettle();
      expect(find.text('Goal 3 of 7'), findsOneWidget);
      expect(gh.calls, hasLength(1));
      await tester.tap(key('super-agent-pip'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Goal'), findsNothing);
      // Back within a minute: the score kept shows at once, and GitHub is not asked.
      await tester.tap(key('super-project-lampos'));
      await tester.pump();
      expect(find.text('Goal 3 of 7'), findsOneWidget);
      await tester.pumpAndSettle();
      expect(gh.calls, hasLength(1));
      // Back after a minute, it is read again.
      await tester.tap(key('super-agent-pip'));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 61));
      await tester.tap(key('super-project-lampos'));
      await tester.pumpAndSettle();
      expect(gh.calls, hasLength(2));
      await tester.pump(const Duration(milliseconds: 300));
    },
  );

  testWidgets(
    'while it shows it is read again every five minutes, and not while it is out of sight',
    (tester) async {
      final gh = lampos();
      var shown = true;
      late StateSetter set;
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: StatefulBuilder(
              builder: (context, setState) {
                set = setState;
                return TickerMode(
                  enabled: shown,
                  child: SwarmGoalScore(
                    repository: 'acme/lampos',
                    github: gh.github,
                    refreshEvery: const Duration(minutes: 5),
                  ),
                );
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Goal 3 of 7'), findsOneWidget);
      expect(gh.calls, hasLength(1));
      await tester.pump(const Duration(minutes: 4, seconds: 59));
      expect(gh.calls, hasLength(1));
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();
      expect(gh.calls, hasLength(2));
      // Out of sight (another tab, the app hidden): no read, however long.
      set(() => shown = false);
      await tester.pump();
      await tester.pump(const Duration(minutes: 30));
      expect(gh.calls, hasLength(2));
      // Back in sight: read at once, and every five minutes from then.
      set(() => shown = true);
      await tester.pump();
      await tester.pumpAndSettle();
      expect(gh.calls, hasLength(3));
      await tester.pump(const Duration(minutes: 5));
      expect(gh.calls, hasLength(4));
    },
  );

  testWidgets(
    'a long project name gives way before the score does, beside an open pane too',
    (tester) async {
      final gh = lampos();
      final s = server();
      const long =
          'lampos, the lamp that hears a busy room, keeps its timers and plays music by voice, whatever it takes';
      (s.state['projects'] as List).first['name'] = long;
      (s.state['conversations'] as List)
              .cast<Map<String, dynamic>>()
              .firstWhere((g) => g['id'] == 'channel')['title'] =
          long;
      await openSwarmV4(
        tester,
        s,
        saved: 'channel',
        size: const Size(1080, 700),
        github: gh.github,
      );
      await tester.tap(key('swarm-pulls-button'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      final score = tester.getRect(find.text('Goal 3 of 7'));
      expect(score.width, greaterThan(60));
      expect(
        tester.getRect(key('super-project-menu')).right,
        lessThanOrEqualTo(score.left),
      );
      expect(
        tester.getRect(key('swarm-goal')).right,
        lessThanOrEqualTo(tester.getRect(key('super-find-button')).left),
      );
    },
  );

  testWidgets('a phone\'s bar has no score, and reads no goal', (tester) async {
    final gh = lampos();
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final c = server().controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'channel'},
    );
    addTearDown(c.dispose);
    await tester.runAsync(c.refresh);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: WorkspaceChromeScope(
          chrome: const WorkspaceChrome(compactBelow: 700),
          child: Scaffold(
            body: SuperTabView(
              controller: c,
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
              github: gh.github,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(SwarmGoalScore), findsNothing);
    expect(gh.calls, isEmpty);
  });
}
