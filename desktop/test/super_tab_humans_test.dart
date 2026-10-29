import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/detail_dialog.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/roster.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

/// The leaderboard lives in the right pane's Humans section (Dee, 2026-10-27),
/// built to the desktop design system (2026-10-28): a small week picker, then
/// everyone, most points first, by display
/// name. Each row is a bold rank in its own column, avatar, name, a quiet line
/// of the non-zero numbers in words, and the points as the one number,
/// right-aligned (Dee, 2026-10-29: one number per person, no team total line).
/// Number one wears a crown beside their name (People are celebrated, design
/// system); no cups, trophies or medal colours. A tap shows what the numbers
/// are made of. There is no separate leaderboard view.
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

  Finder within(String id, String text) =>
      find.descendant(of: person(id), matching: find.text(text));
  // Number one's name carries the crown beside it in the same line.
  Finder nameIn(String id, String name) =>
      find.descendant(of: person(id), matching: find.textContaining(name));
  Finder part(String kind, String id) =>
      find.byKey(ValueKey('leaderboard-$kind-$id'));
  TextStyle styleOf(WidgetTester tester, Finder text) =>
      tester.widget<Text>(text).style!;

  testWidgets(
    'ranks each person with a bold numeral in its own right-aligned column',
    (tester) async {
      final controller = await show(tester, humansSwarm());
      final ranks = {
        'peer': '1',
        'owner': '2',
        'tony': '3',
        'scholes': '4',
        'diego': '5',
        'huy': '6',
        'maximilian.alexander.longname': '6',
      };
      for (final MapEntry(key: id, value: rank) in ranks.entries) {
        expect(
          find.descendant(of: part('rank', id), matching: find.text(rank)),
          findsOneWidget,
          reason: id,
        );
      }
      final right = tester.getTopRight(part('rank', 'peer')).dx;
      for (final id in ranks.keys) {
        expect(tester.getTopRight(part('rank', id)).dx, right, reason: id);
      }
      // The rank stands before the avatar, in its own column.
      final avatar = find.descendant(
        of: person('peer'),
        matching: find.byType(SuperTabAvatar),
      );
      expect(right, lessThanOrEqualTo(tester.getTopLeft(avatar).dx));
      final rank = styleOf(
        tester,
        find.descendant(of: part('rank', 'peer'), matching: find.text('1')),
      );
      expect(rank.fontWeight, FontWeight.w700);
      expect(rank.fontFeatures, grid.AppFont.tabularFigures);
      await close(tester, controller);
    },
  );

  testWidgets(
    'gives each person their points as the one emphasized number, right-aligned',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final controller = await show(tester, humansSwarm());
      expect(within('peer', '21'), findsOneWidget);
      expect(within('owner', '13'), findsOneWidget);
      // No unit repeated on every row; it is said once to a screen reader.
      expect(find.textContaining('pts'), findsNothing);
      expect(find.bySemanticsLabel(RegExp(r'\b21 points\b')), findsOneWidget);
      semantics.dispose();
      // A fixed column, as wide as the board's widest points.
      final width = tester.getSize(part('points', 'peer')).width;
      final right = tester.getTopRight(part('points', 'peer')).dx;
      expect(tester.getSize(part('points', 'huy')).width, width);
      for (final id in [
        'owner',
        'tony',
        'huy',
        'maximilian.alexander.longname',
      ]) {
        expect(tester.getTopRight(part('points', id)).dx, right, reason: id);
      }
      final points = styleOf(tester, within('peer', '21'));
      expect(points.fontWeight, grid.AppFont.semibold);
      expect(points.fontFeatures, grid.AppFont.tabularFigures);
      expect(points.color, grid.AppPalette.textPrimary);
      // The rank is quieter than the points.
      final rank = styleOf(
        tester,
        find.descendant(of: part('rank', 'peer'), matching: find.text('1')),
      );
      expect(rank.color, grid.AppPalette.textSecondary);
      // A long name is cut short rather than pushing the points out.
      final name = tester.widget<Text>(
        within(
          'maximilian.alexander.longname',
          'maximilian.alexander.longname',
        ),
      );
      expect(name.overflow, TextOverflow.ellipsis);
      expect(tester.takeException(), isNull);
      await close(tester, controller);
    },
  );

  testWidgets(
    'writes the three numbers as one quiet line under the name, hiding zeros',
    (tester) async {
      final controller = await show(tester, humansSwarm());
      // Each person's whole line, in full words on hover.
      final lines = {
        'peer': '6 shipped · 3 unblocked',
        'owner': '1 shipped · 4 unblocked · 20 agent-hours lent',
        'tony': '2 shipped',
        'scholes': '2 unblocked · 10 agent-hours lent',
        'diego': '1 unblocked · 10 agent-hours lent',
      };
      String shown(String id) => tester
          .widget<Text>(
            find.descendant(of: part('meta', id), matching: find.byType(Text)),
          )
          .data!;
      for (final MapEntry(key: id, value: line) in lines.entries) {
        expect(find.byTooltip(line), findsOneWidget, reason: id);
        // What fits is whole items from the start, never part of a word.
        final full = line.replaceAll('agent-hours', 'hours');
        final text = shown(id);
        expect(full.startsWith(text), isTrue, reason: '$id: $text');
        expect(
          text == full || full.substring(text.length).startsWith(' · '),
          isTrue,
          reason: '$id: $text',
        );
        final paragraph = tester.renderObject<RenderParagraph>(
          find.descendant(
            of: part('meta', id),
            matching: find.byType(RichText),
          ),
        );
        expect(paragraph.didExceedMaxLines, isFalse, reason: id);
      }
      expect(shown('tony'), '2 shipped');
      // Ken's line is too long for the pane: whole items fall off its end.
      expect(
        shown('owner'),
        isNot(lines['owner']!.replaceAll('agent-hours', 'hours')),
      );
      // Nothing to say, no line at all.
      expect(part('meta', 'huy'), findsNothing);
      final style = styleOf(
        tester,
        find.descendant(of: part('meta', 'peer'), matching: find.byType(Text)),
      );
      expect(style.fontSize, grid.AppType.captionSize);
      expect(style.color, grid.AppPalette.textSecondary);
      // The line starts where the name does.
      expect(
        tester.getTopLeft(part('meta', 'peer')).dx,
        tester.getTopLeft(nameIn('peer', 'Dee')).dx,
      );
      await close(tester, controller);
    },
  );

  Finder crown(String id) => part('crown', id);

  testWidgets(
    'crowns number one beside their name, said in words, and no one else',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final controller = await show(tester, humansSwarm());
      // Dee is first with 21.
      expect(crown('peer'), findsOneWidget);
      for (final id in [
        'owner',
        'tony',
        'scholes',
        'diego',
        'huy',
        'maximilian.alexander.longname',
      ]) {
        expect(crown(id), findsNothing, reason: id);
      }
      expect(
        find.bySemanticsLabel(RegExp('Number one this week')),
        findsOneWidget,
      );
      // After the name, before the points; the numeral stays.
      expect(
        tester.getTopLeft(crown('peer')).dx,
        greaterThan(tester.getTopLeft(nameIn('peer', 'Dee')).dx),
      );
      expect(
        tester.getTopRight(crown('peer')).dx,
        lessThan(tester.getTopLeft(part('points', 'peer')).dx),
      );
      expect(
        find.descendant(of: part('rank', 'peer'), matching: find.text('1')),
        findsOneWidget,
      );
      // A crowned row is as tall as one without; the columns hold.
      expect(
        tester.getSize(person('peer')).height,
        tester.getSize(person('owner')).height,
      );
      expect(
        tester.getTopRight(part('points', 'peer')).dx,
        tester.getTopRight(part('points', 'owner')).dx,
      );
      semantics.dispose();
      await close(tester, controller);
    },
  );

  testWidgets("on a past week the crown names that week, not this one", (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    final controller = await show(tester, humansSwarm());
    await tester.tap(find.byKey(const ValueKey('leaderboard-week')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Last week').last);
    await tester.pumpAndSettle();
    expect(crown('peer'), findsOneWidget);
    expect(
      find.bySemanticsLabel(RegExp('Number one last week')),
      findsOneWidget,
    );
    expect(find.bySemanticsLabel(RegExp('this week')), findsNothing);
    semantics.dispose();
    await close(tester, controller);
  });

  testWidgets('crowns no one in a week where no one has points yet', (
    tester,
  ) async {
    final server = humansSwarm();
    for (final score in server.leaderboard!['people'] as List) {
      score['points'] = 0;
      score['rank'] = 1;
      score['medal'] = null;
    }
    final controller = await show(tester, server);
    expect(find.byKey(const ValueKey('leaderboard-crown-peer')), findsNothing);
    expect(find.bySemanticsLabel(RegExp('Number one this week')), findsNothing);
    await close(tester, controller);
  });

  testWidgets(
    'draws no emoji but the crown, and no cups, sparkles or medal colours',
    (tester) async {
      final controller = await show(tester, humansSwarm(), settle: false);
      final emoji = RegExp(
        '[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{231A}-\u{23FF}]',
        unicode: true,
      );
      final roster = find.byType(SuperTabRoster);
      // Every emoji drawn in the people and agents, the crown's placeholder
      // aside: the crown is its own Text, the one emoji allowed.
      final drawn = [
        for (final widget in tester.widgetList<RichText>(
          find.descendant(of: roster, matching: find.byType(RichText)),
        ))
          ...emoji
              .allMatches(widget.text.toPlainText())
              .map((match) => match[0]!),
      ];
      expect(drawn, ['\u{1F451}']);
      expect(
        find.descendant(of: crown('peer'), matching: find.text('\u{1F451}')),
        findsOneWidget,
      );
      expect(find.byIcon(AppIcons.trophy), findsNothing);
      expect(find.byIcon(AppIcons.sparkles), findsNothing);
      expect(find.byKey(const ValueKey('leaderboard-sparkle')), findsNothing);
      expect(find.byKey(const ValueKey('leaderboard-cup-peer')), findsNothing);
      await tester.pumpAndSettle();
      await close(tester, controller);
    },
  );

  testWidgets("fills the viewer's own row as the selected row, and no other", (
    tester,
  ) async {
    final controller = await show(tester, humansSwarm());
    Color? fill(String id) => tester
        .widget<Material>(
          find.ancestor(of: person(id), matching: find.byType(Material)).first,
        )
        .color;
    // The viewer is Dee.
    expect(fill('peer'), grid.AppSurface.selectedFill);
    expect(fill('owner'), Colors.transparent);
    await close(tester, controller);
  });

  testWidgets('keeps every column with enlarged text', (tester) async {
    // Wide enough that the people stay beside the chat at double size.
    await tester.binding.setSurfaceSize(const Size(2400, 1400));
    final controller = humansSwarm().controller(
      account: 'peer',
      initial: {'tabId': 'tab', 'accountId': 'peer', 'selectedId': 'lead'},
    );
    await controller.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: const TextScaler.linear(2)),
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
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    final right = tester.getTopRight(part('rank', 'peer')).dx;
    expect(tester.getTopRight(part('rank', 'huy')).dx, right);
    final points = tester.getTopRight(part('points', 'peer')).dx;
    expect(tester.getTopRight(part('points', 'owner')).dx, points);
    await close(tester, controller);
    await tester.binding.setSurfaceSize(null);
  });

  testWidgets('has no team total line above the people', (tester) async {
    final controller = await show(tester, humansSwarm());
    expect(find.byKey(const ValueKey('leaderboard-goal')), findsNothing);
    expect(find.textContaining('shipped this week'), findsNothing);
    expect(find.textContaining('Team goal'), findsNothing);
    // The people follow the heading.
    expect(person('peer'), findsOneWidget);
    await close(tester, controller);
  });

  testWidgets('puts the waiting line in the quiet metadata hierarchy', (
    tester,
  ) async {
    final controller = await show(tester, humansSwarm());
    final waiting = find.byKey(const ValueKey('leaderboard-waiting'));
    final heading = find.descendant(
      of: waiting,
      matching: find.text('1 agent is waiting on you'),
    );
    expect(heading, findsOneWidget);
    expect(styleOf(tester, heading).fontSize, grid.AppType.captionSize);
    expect(styleOf(tester, heading).color, grid.AppPalette.textSecondary);
    expect(find.textContaining('Dee 1'), findsNothing);
    expect(styleOf(tester, heading).fontSize, grid.AppType.captionSize);
    await close(tester, controller);
  });

  testWidgets('says in words how many agents wait on whom, the viewer as you', (
    tester,
  ) async {
    final server = humansSwarm();
    server.leaderboard!['waiting'] = {
      'total': 4,
      'people': [
        {
          'personId': 'owner',
          'count': 3,
          'conversationIds': ['g1'],
        },
        {
          'personId': 'peer',
          'count': 1,
          'conversationIds': ['offline'],
        },
      ],
    };
    final controller = await show(tester, server);
    final waiting = find.byKey(const ValueKey('leaderboard-waiting'));
    Finder line(String text) =>
        find.descendant(of: waiting, matching: find.text(text));
    expect(line('3 agents are waiting on Ken'), findsOneWidget);
    expect(line('1 agent is waiting on you'), findsOneWidget);
    await close(tester, controller);
  });

  testWidgets(
    'keeps a row with no points in rank order, its 0 in the points style',
    (tester) async {
      final controller = await show(tester, humansSwarm());
      final zero = styleOf(
        tester,
        find.descendant(of: part('points', 'huy'), matching: find.text('0')),
      );
      final points = styleOf(tester, within('tony', '6'));
      // One rule for every points value (Numbers and rankings).
      expect(zero.color, grid.AppPalette.textPrimary);
      expect(zero.fontWeight, grid.AppFont.semibold);
      expect(zero.fontFeatures, grid.AppFont.tabularFigures);
      expect(zero, points);
      expect(
        tester.getTopLeft(person('huy')).dy,
        greaterThan(tester.getTopLeft(person('diego')).dy),
      );
      await close(tester, controller);
    },
  );

  testWidgets(
    "shows hover and keyboard focus over the viewer's own row's fill",
    (tester) async {
      final controller = await show(tester, humansSwarm());
      // The viewer's row: its fill, under the ink of hover and focus.
      final ink = Material.of(tester.element(person('peer'))) as RenderObject;
      expect(ink, isNot(paints..rrect(color: grid.AppSurface.hoverFill)));

      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: tester.getCenter(person('peer')));
      addTearDown(mouse.removePointer);
      await tester.pumpAndSettle();
      expect(ink, paints..rrect(color: grid.AppSurface.hoverFill));

      await mouse.moveTo(Offset.zero);
      await tester.pumpAndSettle();
      expect(ink, isNot(paints..rrect(color: grid.AppSurface.hoverFill)));

      FocusManager.instance.highlightStrategy =
          FocusHighlightStrategy.alwaysTraditional;
      addTearDown(
        () => FocusManager.instance.highlightStrategy =
            FocusHighlightStrategy.automatic,
      );
      Focus.of(
        tester.element(
          find
              .descendant(of: person('peer'), matching: find.byType(Padding))
              .first,
        ),
      ).requestFocus();
      await tester.pumpAndSettle();
      expect(ink, paints..rrect(color: grid.AppSurface.hoverFill));
      await close(tester, controller);
    },
  );

  testWidgets(
    "names each person by display name, else their email's first part",
    (tester) async {
      final controller = await show(tester, humansSwarm());
      Finder within(String id, String text) =>
          find.descendant(of: person(id), matching: find.text(text));
      expect(nameIn('peer', 'Dee'), findsOneWidget);
      expect(within('owner', 'Ken'), findsOneWidget);
      // A server from before names: the email's first part, as before.
      expect(within('scholes', 'scholes'), findsOneWidget);
      expect(find.text('dee'), findsNothing);
      // On hover the whole name, which a long one needs when it is cut, then the email.
      expect(find.byTooltip('Dee\ndee@example.com'), findsOneWidget);

      await close(tester, controller);
    },
  );

  testWidgets(
    'shows one number per person: no arrow or change against last week',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final controller = await show(tester, humansSwarm());
      // Dee 21 from 15, Ken 13 from 20: still only their points.
      for (final id in ['peer', 'owner', 'tony', 'scholes']) {
        expect(part('trend', id), findsNothing, reason: id);
        expect(part('trend-column', id), findsNothing, reason: id);
      }
      final roster = find.byType(SuperTabRoster);
      for (final arrow in [AppIcons.arrowUp, AppIcons.arrowDown]) {
        expect(
          find.descendant(of: roster, matching: find.byIcon(arrow)),
          findsNothing,
        );
      }
      expect(find.byTooltip('Up 6 from last week'), findsNothing);
      expect(find.bySemanticsLabel(RegExp('from last week')), findsNothing);
      // The points are the row's last column.
      expect(within('peer', '6'), findsNothing);
      expect(within('owner', '7'), findsNothing);
      semantics.dispose();
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
      final dialog = find.byType(SuperTabDetailDialog);
      Finder inDialog(String text) =>
          find.descendant(of: dialog, matching: find.text(text));
      expect(inDialog('Dee'), findsOneWidget);
      // Who they are on one line under the name (Ken, 2026-10-28).
      expect(inDialog('dee@example.com · Can collaborate'), findsOneWidget);
      // This week's points in words, and last week's beside them rather than a difference.
      expect(inDialog('21 points this week · 15 last week'), findsOneWidget);
      expect(find.textContaining('pts'), findsNothing);
      expect(find.widgetWithText(TextButton, 'Close'), findsNothing);
      expect(inDialog('Shipped'), findsOneWidget);
      expect(inDialog('Unblocked'), findsOneWidget);
      expect(inDialog('Lent'), findsOneWidget);
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
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();

      await tester.tap(person('owner'));
      await tester.pumpAndSettle();
      expect(inDialog('13 points this week · 20 last week'), findsOneWidget);
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
      final dialog = find.byType(SuperTabDetailDialog);
      Finder inDialog(String text) =>
          find.descendant(of: dialog, matching: find.text(text));
      expect(inDialog('scholes'), findsOneWidget);
      expect(inDialog('Nothing landed yet'), findsOneWidget);
      expect(inDialog('No pull requests merged yet'), findsNothing);
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
    // A count, the newest five, and the rest one click away; not a wall of links cut off at the bottom.
    expect(find.text('20'), findsOneWidget);
    expect(find.text('Pull request 4'), findsOneWidget);
    expect(find.text('Pull request 5'), findsNothing);
    await tester.tap(find.text('Show all 20'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.text('No machines lent yet'),
      100,
      scrollable: find.descendant(
        of: find.byType(SuperTabDetailDialog),
        matching: find.byType(Scrollable),
      ),
    );
    expect(find.text('Pull request 19'), findsOneWidget);
    expect(find.text('No machines lent yet'), findsOneWidget);
    expect(tester.takeException(), isNull);
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
      expect(part('points', 'peer'), findsNothing);
      expect(part('rank', 'peer'), findsNothing);
      expect(find.textContaining('leaderboard'), findsNothing);
      await close(tester, controller);
    },
  );
}
