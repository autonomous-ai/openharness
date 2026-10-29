import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_reactions.dart';

import 'swarm_fixture.dart';
import '../theme/sheet_shape.dart';

/// Emoji reactions on a Swarm message, as Desktop draws them (backend
/// reactions.ts): the counts under it, the reader's own marked, and the seven
/// a long-press offers.
void main() {
  group('the reaction counter', () {
    SuperTabConversation g1(Map<String, dynamic> extra) =>
        SuperTabSnapshot.fromJson(
          SuperTabParts.firstLoad(
            firstLoad(
              groups: [
                {...groupData('g1', title: 'Fix login'), ...extra},
              ],
            ),
          ).state,
        ).conversation('g1')!;

    test('a conversation carries the counter its read sends', () {
      expect(g1({'reactionSeq': 7}).reactionSeq, 7);
    });

    test('a conversation nobody reacted in counts none', () {
      expect(g1(const {}).reactionSeq, 0);
    });
  });

  List<SuperTabReactionCount> counts(Map<String, List<(String, String)>> by) =>
      SuperTabReactionCount.listFromJson([
        for (final MapEntry(key: emoji, value: who) in by.entries)
          {
            'emoji': emoji,
            'count': who.length,
            'by': [
              for (final (kind, id) in who) {'kind': kind, 'id': id},
            ],
          },
      ]);

  Future<void> show(WidgetTester tester, Widget child) => tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(body: Center(child: child)),
    ),
  );

  String nameOf(String kind, String id) => switch (id) {
    me => 'You',
    'agent-lead' => 'River',
    _ => 'Ann',
  };

  Finder chip(SuperTabReactionEmoji emoji) =>
      find.byKey(ValueKey('swarm-reaction-m1-${emoji.key}'));

  group('the reaction bar', () {
    testWidgets("shows each emoji with its count, the reader's own marked", (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await show(
        tester,
        SwarmReactionBar(
          messageId: 'm1',
          reactions: counts({
            'tada': [('agent', 'agent-lead'), ('person', me)],
            'eyes': [('person', 'person-ann')],
          }),
          readerId: me,
          nameOf: nameOf,
          onReact: (_) {},
        ),
      );

      expect(
        tester.getSemantics(chip(SuperTabReactionEmoji.tada)),
        isSemantics(
          label: '🎉 2, River and You',
          isButton: true,
          isEnabled: true,
          isSelected: true,
          hasTapAction: true,
        ),
      );
      expect(
        tester.getSemantics(chip(SuperTabReactionEmoji.eyes)),
        isSemantics(
          label: '👀 1, Ann',
          isButton: true,
          isEnabled: true,
          isSelected: false,
          hasTapAction: true,
        ),
      );
      semantics.dispose();
    });

    testWidgets('a tap on a count reacts with its emoji; each is a '
        "finger's size", (tester) async {
      final picked = <SuperTabReactionEmoji>[];
      await show(
        tester,
        SwarmReactionBar(
          messageId: 'm1',
          reactions: counts({
            'rocket': [('person', 'person-ann')],
          }),
          readerId: me,
          nameOf: nameOf,
          onReact: picked.add,
        ),
      );

      await tester.tap(chip(SuperTabReactionEmoji.rocket));

      expect(picked, [SuperTabReactionEmoji.rocket]);
      final size = tester.getSize(chip(SuperTabReactionEmoji.rocket));
      expect(size.height, greaterThanOrEqualTo(44));
      expect(size.width, greaterThanOrEqualTo(44));
    });

    testWidgets('holding a count names who gave it', (tester) async {
      await show(
        tester,
        SwarmReactionBar(
          messageId: 'm1',
          reactions: counts({
            'heart': [('agent', 'agent-lead'), ('person', 'person-ann')],
          }),
          readerId: me,
          nameOf: nameOf,
          onReact: (_) {},
        ),
      );

      await tester.longPress(chip(SuperTabReactionEmoji.heart));
      await tester.pump();

      expect(find.text('River and Ann'), findsOneWidget);
      await tester.pumpAndSettle(const Duration(seconds: 3));
    });

    testWidgets('the bar sits 4 points under its message, and a count is '
        'padded 8 points across, on the spacing scale', (tester) async {
      await show(
        tester,
        SwarmReactionBar(
          messageId: 'm1',
          reactions: counts({
            'rocket': [('person', 'person-ann')],
          }),
          readerId: me,
          nameOf: nameOf,
          onReact: (_) {},
        ),
      );

      expect(
        tester
            .widget<Padding>(
              find
                  .descendant(
                    of: find.byType(SwarmReactionBar),
                    matching: find.byType(Padding),
                  )
                  .first,
            )
            .padding,
        const EdgeInsets.only(top: 4),
      );
      expect(
        tester
            .widget<Container>(
              find.descendant(
                of: chip(SuperTabReactionEmoji.rocket),
                matching: find.byType(Container),
              ),
            )
            .padding,
        const EdgeInsets.symmetric(horizontal: 8),
      );
    });

    testWidgets("an agent's 👀 ✅ 🚀 show in that order, named by the agent; "
        "an emoji this build does not know is skipped", (tester) async {
      final semantics = tester.ensureSemantics();
      await show(
        tester,
        SwarmReactionBar(
          messageId: 'm1',
          // In the server's order (backend REACTIONS), with one from a newer server.
          reactions: counts({
            'eyes': [('agent', 'agent-lead')],
            'check': [('agent', 'agent-lead')],
            'skull': [('agent', 'agent-lead')],
            'rocket': [('agent', 'agent-lead')],
          }),
          readerId: me,
          nameOf: nameOf,
          onReact: (_) {},
        ),
      );

      final keys = find.byWidgetPredicate(
        (w) =>
            w.key is ValueKey<String> &&
            (w.key! as ValueKey<String>).value.startsWith('swarm-reaction-m1-'),
      );
      expect(
        tester.widgetList(keys).map((w) => (w.key! as ValueKey<String>).value),
        [
          'swarm-reaction-m1-eyes',
          'swarm-reaction-m1-check',
          'swarm-reaction-m1-rocket',
        ],
      );
      expect(
        tester.getSemantics(chip(SuperTabReactionEmoji.check)),
        isSemantics(
          label: '✅ 1, River',
          isButton: true,
          isEnabled: true,
          isSelected: false,
          hasTapAction: true,
        ),
      );
      semantics.dispose();
    });

    testWidgets('a message with no reactions draws nothing', (tester) async {
      await show(
        tester,
        SwarmReactionBar(
          messageId: 'm1',
          reactions: const [],
          readerId: me,
          nameOf: nameOf,
          onReact: (_) {},
        ),
      );

      expect(tester.getSize(find.byType(SwarmReactionBar)), Size.zero);
    });
  });

  group('the reaction picker', () {
    late List<String> haptics;

    setUp(() {
      haptics = [];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (call) async {
            if (call.method == 'HapticFeedback.vibrate') {
              haptics.add(call.arguments as String? ?? call.method);
            }
            return null;
          });
    });
    tearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null),
    );

    Future<Future<SuperTabReactionEmoji?>> open(
      WidgetTester tester,
      List<SuperTabReactionCount> reactions,
    ) async {
      late BuildContext context;
      await show(
        tester,
        Builder(
          builder: (c) {
            context = c;
            return const SizedBox();
          },
        ),
      );
      final picked = showSwarmReactionPicker(
        context,
        reactions: reactions,
        readerId: me,
      );
      await tester.pumpAndSettle();
      expect(sheetTopRadius(tester), 12);
      return picked;
    }

    testWidgets("offers Desktop's seven emoji with a light tap of the phone, "
        "each a finger's size, and answers the one picked", (tester) async {
      final picked = await open(tester, const []);

      expect(
        SuperTabReactionEmoji.values.map((e) => e.glyph).join(),
        '👍🎉❤️😄👀✅🚀',
      );

      expect(haptics, ['HapticFeedbackType.lightImpact']);
      for (final emoji in SuperTabReactionEmoji.values) {
        final option = find.byKey(ValueKey('swarm-react-${emoji.key}'));
        expect(option, findsOneWidget);
        expect(tester.getSize(option).height, greaterThanOrEqualTo(44));
        expect(tester.getSize(option).width, greaterThanOrEqualTo(44));
      }
      await tester.tap(find.byKey(const ValueKey('swarm-react-rocket')));
      await tester.pumpAndSettle();

      expect(await picked, SuperTabReactionEmoji.rocket);
      expect(find.byKey(const ValueKey('swarm-react-rocket')), findsNothing);
    });

    testWidgets("fits all seven on a 375-point phone, each still a finger's "
        'size', (tester) async {
      tester.view.physicalSize = const Size(375, 667);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final picked = await open(tester, const []);

      expect(tester.takeException(), isNull);
      for (final emoji in SuperTabReactionEmoji.values) {
        final option = find.byKey(ValueKey('swarm-react-${emoji.key}'));
        expect(tester.getSize(option).width, greaterThanOrEqualTo(44));
        expect(tester.getSize(option).height, greaterThanOrEqualTo(44));
        expect(tester.getRect(option).right, lessThanOrEqualTo(375 - 16));
      }
      await tester.tap(find.byKey(const ValueKey('swarm-react-check')));
      await tester.pumpAndSettle();
      expect(await picked, SuperTabReactionEmoji.check);
    });

    testWidgets('dims the page as every sheet does, and draws each emoji at '
        "an icon's size, 24 points", (tester) async {
      final picked = await open(tester, const []);

      final route = ModalRoute.of(
        tester.element(find.byKey(const ValueKey('swarm-react-rocket'))),
      )!;
      expect(route.barrierColor, Colors.black54);
      expect(
        tester.widget<Text>(find.text('🚀')).style!.fontSize,
        24,
        reason: 'a glyph alone in a control, like AppIconSize.standalone',
      );

      await tester.tapAt(const Offset(20, 20));
      await tester.pumpAndSettle();
      expect(await picked, isNull);
    });

    testWidgets('the sheet is inset 16 across and 16 below, 8 above, with a '
        'grabber 36 by 4', (tester) async {
      final picked = await open(tester, const []);

      expect(
        tester
            .widget<Padding>(
              find.byWidgetPredicate((w) => w is Padding && w.child is Column),
            )
            .padding,
        const EdgeInsets.fromLTRB(16, 8, 16, 16),
      );
      final grabber = find.byWidgetPredicate(
        (w) => w is Container && w.constraints?.maxWidth == 36,
      );
      expect(
        tester.getSize(
          find.descendant(of: grabber, matching: find.byType(DecoratedBox)),
        ),
        const Size(36, 4),
      );
      expect(
        tester.widget<Container>(grabber).margin,
        const EdgeInsets.only(bottom: 12),
      );

      await tester.tapAt(const Offset(20, 20));
      await tester.pumpAndSettle();
      expect(await picked, isNull);
    });

    testWidgets("marks the reader's own, and closes with none picked", (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      final picked = await open(
        tester,
        counts({
          'heart': [('person', me)],
          'eyes': [('person', 'person-ann')],
        }),
      );

      expect(
        tester.getSemantics(find.byKey(const ValueKey('swarm-react-heart'))),
        isSemantics(
          label: 'heart, yours',
          isButton: true,
          isSelected: true,
          hasTapAction: true,
        ),
      );
      expect(
        tester.getSemantics(find.byKey(const ValueKey('swarm-react-eyes'))),
        isSemantics(
          label: 'eyes',
          isButton: true,
          isSelected: false,
          hasTapAction: true,
        ),
      );
      await tester.tapAt(const Offset(20, 20));
      await tester.pumpAndSettle();
      expect(await picked, isNull);
      semantics.dispose();
    });
  });
}
