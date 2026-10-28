import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

/// The leaderboard lives in the right pane's Humans section (Dee, 2026-10-27):
/// a small "🚀 N shipped" chip with a small week picker, then everyone, most
/// points first, by display name, each one aligned row with a quiet line of
/// their three numbers as icons. The top three have cups, #1 a sparkle as the
/// board opens, and each an arrow against last week; a tap shows what the
/// numbers are made of (Dee, 2026-10-28). There is no separate leaderboard view.
void main() {
  Finder person(String id) => find.byKey(ValueKey('super-person-$id'));

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    Size size = const Size(1300, 900),
    bool settle = true,
    bool reduceMotion = false,
  }) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = server.controller(
      account: 'peer',
      initial: {'tabId': 'tab', 'accountId': 'peer', 'selectedId': 'lead'},
    );
    await controller.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(disableAnimations: reduceMotion),
          child: child!,
        ),
        home: Scaffold(
          body: SuperTabView(
            controller: controller,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Studio',
          ),
        ),
      ),
    );
    if (settle) {
      await tester.pumpAndSettle();
    } else {
      // The board's read lands; the rows' first frame.
      for (var i = 0; i < 5; i++) {
        await tester.pump();
      }
    }
    return controller;
  }

  Future<void> close(WidgetTester tester, SuperTabController controller) async {
    await tester.pumpWidget(const SizedBox());
    await controller.flush();
    controller.dispose();
  }

  testWidgets('lists every person, most points first, with no cut-off', (
    tester,
  ) async {
    final controller = await show(tester, humansSwarm());
    final ids = [
      'peer',
      'owner',
      'tony',
      'scholes',
      'diego',
      'huy',
      'maximilian.alexander.longname',
    ];
    for (final id in ids) {
      expect(person(id), findsOneWidget);
    }
    expect(find.textContaining('Show '), findsNothing);
    final tops = [for (final id in ids) tester.getTopLeft(person(id)).dy];
    expect(tops, [...tops]..sort());
    await close(tester, controller);
  });

  testWidgets(
    'gives each person their points on the right and a quiet line of their three numbers',
    (tester) async {
      final controller = await show(tester, humansSwarm());
      Finder within(String id, String text) =>
          find.descendant(of: person(id), matching: find.text(text));
      expect(within('peer', '21 pts'), findsOneWidget);
      expect(within('peer', '🚀 6'), findsOneWidget);
      expect(within('peer', '🔓 3'), findsOneWidget);
      expect(within('peer', '💻 0 h'), findsOneWidget);
      expect(within('owner', '13 pts'), findsOneWidget);
      expect(within('owner', '💻 20 h'), findsOneWidget);
      // Each icon says what it counts on hover.
      expect(find.byTooltip('6 shipped'), findsOneWidget);
      expect(find.byTooltip('3 unblocked'), findsOneWidget);
      expect(find.byTooltip('20 agent-hours lent'), findsOneWidget);
      // Fixed columns: points end at one edge, and each number starts where
      // the one above it does.
      final right = tester.getTopRight(within('peer', '21 pts')).dx;
      expect(tester.getTopRight(within('owner', '13 pts')).dx, right);
      expect(tester.getTopRight(within('huy', '0 pts')).dx, right);
      expect(
        tester.getTopLeft(within('owner', '🔓 4')).dx,
        tester.getTopLeft(within('peer', '🔓 3')).dx,
      );
      expect(
        tester.getTopLeft(within('owner', '💻 20 h')).dx,
        tester.getTopLeft(within('peer', '💻 0 h')).dx,
      );
      // A long name is cut short rather than pushing the points out.
      final name = tester.widget<Text>(
        within(
          'maximilian.alexander.longname',
          'maximilian.alexander.longname',
        ),
      );
      expect(name.overflow, TextOverflow.ellipsis);
      expect(
        tester.getTopRight(within('maximilian.alexander.longname', '0 pts')).dx,
        right,
      );
      expect(tester.takeException(), isNull);
      await close(tester, controller);
    },
  );

  testWidgets(
    'puts a small shipped chip above the people, with no open count',
    (tester) async {
      final controller = await show(tester, humansSwarm());
      final goal = find.byKey(const ValueKey('leaderboard-goal'));
      expect(
        find.descendant(
          of: goal,
          matching: find.text('🚀 7 shipped this week'),
        ),
        findsOneWidget,
      );
      expect(find.textContaining('open'), findsNothing);
      expect(find.textContaining('Team goal'), findsNothing);
      // The week before and the median are on hover.
      expect(
        find.byTooltip('4 shipped last week\nMedian ask to ship 2 h'),
        findsOneWidget,
      );
      expect(
        tester.getTopLeft(goal).dy,
        lessThan(tester.getTopLeft(person('peer')).dy),
      );
      await close(tester, controller);
    },
  );

  testWidgets(
    "names each person by display name, else their email's first part",
    (tester) async {
      final controller = await show(tester, humansSwarm());
      Finder within(String id, String text) =>
          find.descendant(of: person(id), matching: find.text(text));
      expect(within('peer', 'Dee'), findsOneWidget);
      expect(within('owner', 'Ken'), findsOneWidget);
      // A server from before names: the email's first part, as before.
      expect(within('scholes', 'scholes'), findsOneWidget);
      expect(find.text('dee'), findsNothing);
      // The email stays on hover.
      expect(find.byTooltip('dee@example.com'), findsOneWidget);
      // Who agents wait on reads the same name.
      expect(find.text('Dee 1'), findsOneWidget);
      await close(tester, controller);
    },
  );

  testWidgets(
    'shows an up or down arrow against last week, and none when level or unknown',
    (tester) async {
      final controller = await show(tester, humansSwarm());
      Finder trend(String id) => find.byKey(ValueKey('leaderboard-trend-$id'));
      // Dee 21 from 15, Ken 13 from 20.
      expect(
        find.descendant(of: trend('peer'), matching: find.text('6')),
        findsOneWidget,
      );
      expect(find.byTooltip('Up 6 from last week'), findsOneWidget);
      expect(
        find.descendant(of: trend('owner'), matching: find.text('7')),
        findsOneWidget,
      );
      expect(find.byTooltip('Down 7 from last week'), findsOneWidget);
      // Tony level at 6; Scholes from a server without last week.
      expect(trend('tony'), findsNothing);
      expect(trend('scholes'), findsNothing);
      await close(tester, controller);
    },
  );

  testWidgets('gives the top three gold, silver and bronze cups', (
    tester,
  ) async {
    final controller = await show(tester, humansSwarm());
    Finder cup(String id) => find.byKey(ValueKey('leaderboard-cup-$id'));
    expect(
      find.descendant(of: person('peer'), matching: cup('peer')),
      findsOneWidget,
    );
    expect(find.byTooltip('Gold cup: 1st this week'), findsOneWidget);
    expect(find.byTooltip('Silver cup: 2nd this week'), findsOneWidget);
    expect(find.byTooltip('Bronze cup: 3rd this week'), findsOneWidget);
    expect({
      for (final id in ['peer', 'owner', 'tony'])
        tester
            .widget<Icon>(
              find.descendant(of: cup(id), matching: find.byType(Icon)),
            )
            .color,
    }, hasLength(3));
    expect(cup('scholes'), findsNothing);
    await close(tester, controller);
  });

  testWidgets(
    'sparkles #1 once as the board opens, and never with Reduce Motion',
    (tester) async {
      final sparkle = find.byKey(const ValueKey('leaderboard-sparkle'));
      var controller = await show(tester, humansSwarm(), settle: false);
      expect(
        find.descendant(of: person('peer'), matching: sparkle),
        findsOneWidget,
      );
      await tester.pumpAndSettle();
      expect(sparkle, findsNothing);
      await close(tester, controller);
      controller = await show(
        tester,
        humansSwarm(),
        settle: false,
        reduceMotion: true,
      );
      expect(sparkle, findsNothing);
      await close(tester, controller);
    },
  );

  testWidgets('reads another week from the small week picker', (tester) async {
    final server = humansSwarm();
    final controller = await show(tester, server);
    final picker = find.byKey(const ValueKey('leaderboard-week'));
    expect(tester.getSize(picker).height, lessThanOrEqualTo(32));
    await tester.tap(picker);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Last week').last);
    await tester.pumpAndSettle();
    expect(server.leaderboardReads.last, contains('&week='));
    await close(tester, controller);
  });

  testWidgets('has no separate leaderboard view or trophy', (tester) async {
    final controller = await show(
      tester,
      humansSwarm(),
      size: const Size(1500, 900),
    );
    expect(find.byKey(const ValueKey('super-leaderboard')), findsNothing);
    expect(find.byKey(const ValueKey('super-board-pane')), findsNothing);
    expect(find.byTooltip('Leaderboard'), findsNothing);
    await close(tester, controller);
  });

  testWidgets(
    'shows what shipped, what was unblocked and what was lent when a person is tapped',
    (tester) async {
      const channel = MethodChannel('plugins.flutter.io/url_launcher');
      final launches = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        if (call.method == 'launch') {
          launches.add((call.arguments as Map)['url'] as String);
        }
        return true;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      final controller = await show(tester, humansSwarm());
      await tester.tap(person('peer'));
      await tester.pumpAndSettle();
      final dialog = find.byType(AlertDialog);
      Finder inDialog(String text) =>
          find.descendant(of: dialog, matching: find.text(text));
      expect(inDialog('Dee'), findsOneWidget);
      expect(inDialog('21 pts · up 6 from last week'), findsOneWidget);
      expect(inDialog('🚀 Shipped'), findsOneWidget);
      expect(inDialog('🔓 Unblocked'), findsOneWidget);
      expect(inDialog('💻 Lent'), findsOneWidget);
      expect(inDialog('Which sign-in page ships first?'), findsOneWidget);
      expect(inDialog('waited 1.6 h'), findsOneWidget);
      // Dee lent nothing this week.
      expect(inDialog('No machines lent yet'), findsOneWidget);
      // A pull request title opens the pull request; one without a link is text.
      await tester.tap(
        inDialog('Desktop: a machine shows its agents as one count'),
      );
      await tester.pumpAndSettle();
      expect(launches, [
        'https://github.com/autonomous-ai/openharness/pull/1824',
      ]);
      await tester.tap(inDialog('Swarm digest pauses with the Swarm'));
      await tester.pumpAndSettle();
      expect(launches, hasLength(1));
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();

      await tester.tap(person('owner'));
      await tester.pumpAndSettle();
      expect(inDialog('13 pts · down 7 from last week'), findsOneWidget);
      expect(inDialog('No pull requests merged yet'), findsOneWidget);
      expect(inDialog('No questions answered yet'), findsOneWidget);
      // The machine as it calls itself, without .local.
      expect(inDialog('MACs-Mac-Studio'), findsOneWidget);
      expect(inDialog('12.5 h busy'), findsOneWidget);
      expect(inDialog('7 h busy'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await close(tester, controller);
    },
  );

  testWidgets(
    "shows a person's week as before where the server has no details",
    (tester) async {
      final controller = await show(tester, humansSwarm());
      await tester.tap(person('scholes'));
      await tester.pumpAndSettle();
      final dialog = find.byType(AlertDialog);
      Finder inDialog(String text) =>
          find.descendant(of: dialog, matching: find.text(text));
      expect(inDialog('scholes'), findsOneWidget);
      expect(inDialog('Nothing landed yet'), findsOneWidget);
      expect(inDialog('🚀 Shipped'), findsNothing);
      expect(find.textContaining('last week'), findsNothing);
      await close(tester, controller);
    },
  );

  testWidgets('opens only web links, and shows any other link as plain text', (
    tester,
  ) async {
    const channel = MethodChannel('plugins.flutter.io/url_launcher');
    final launches = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      if (call.method == 'launch') {
        launches.add((call.arguments as Map)['url'] as String);
      }
      return true;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );
    final server = humansSwarm();
    final dee = (server.leaderboard!['people'] as List).first as Map;
    (dee['details'] as Map)['shipped'] = [
      {'title': 'A file', 'prUrl': 'file:///etc/hosts'},
      {'title': 'A script', 'prUrl': 'javascript:alert(1)'},
      {'title': 'An app', 'prUrl': 'x-harness://open'},
      {'title': 'Plain web', 'prUrl': 'http://example.com/pull/1'},
    ];
    final controller = await show(tester, server);
    await tester.tap(person('peer'));
    await tester.pumpAndSettle();
    for (final title in ['A file', 'A script', 'An app', 'Plain web']) {
      await tester.tap(find.text(title));
      await tester.pumpAndSettle();
    }
    expect(launches, ['http://example.com/pull/1']);
    // Only the web link reads as a link.
    expect(
      find.ancestor(of: find.text('A file'), matching: find.byType(InkWell)),
      findsNothing,
    );
    await close(tester, controller);
  });

  testWidgets('keeps a long list of details inside the window', (tester) async {
    final server = humansSwarm();
    final dee = (server.leaderboard!['people'] as List).first as Map;
    (dee['details'] as Map)['shipped'] = [
      for (var i = 0; i < 20; i++)
        {'title': 'Pull request $i', 'prUrl': 'https://example.com/$i'},
    ];
    final controller = await show(tester, server, size: const Size(1300, 600));
    await tester.tap(person('peer'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.scrollUntilVisible(
      find.text('No machines lent yet'),
      100,
      scrollable: find.descendant(
        of: find.byType(AlertDialog),
        matching: find.byType(Scrollable),
      ),
    );
    expect(find.text('No machines lent yet'), findsOneWidget);
    await close(tester, controller);
  });

  testWidgets('opens the waiting conversation from Answer', (tester) async {
    final controller = await show(tester, humansSwarm());
    await tester.tap(find.text('Answer'));
    await tester.pumpAndSettle();
    expect(controller.selectedId, 'offline');
    await close(tester, controller);
  });

  testWidgets('reads the board of the open conversation’s project', (
    tester,
  ) async {
    final server = humansSwarm();
    final controller = await show(tester, server);
    expect(server.leaderboardReads, [
      '/api/super-tabs/tab/leaderboard?projectId=lead',
    ]);
    await close(tester, controller);
  });

  testWidgets(
    'lists people without numbers, quietly, where the server has no leaderboard',
    (tester) async {
      final server = humansSwarm()..leaderboard = null;
      final controller = await show(tester, server);
      expect(person('peer'), findsOneWidget);
      expect(find.textContaining('pts'), findsNothing);
      expect(find.textContaining('leaderboard'), findsNothing);
      await close(tester, controller);
    },
  );
}
