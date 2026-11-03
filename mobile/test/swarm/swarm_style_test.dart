import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';

/// [child] at the top left of a screen, as big as it asks to be.
Future<void> show(WidgetTester tester, Widget child) => tester.pumpWidget(
  MaterialApp(
    home: Scaffold(
      body: Align(alignment: Alignment.topLeft, child: child),
    ),
  ),
);

void main() {
  group('a card of rows', () {
    testWidgets('is rounded at the card radius, 12', (tester) async {
      await show(tester, const SwarmGroup(children: [Text('a'), Text('b')]));

      final clip = tester.widget<ClipRRect>(
        find.descendant(
          of: find.byType(SwarmGroup),
          matching: find.byType(ClipRRect),
        ),
      );
      expect(clip.borderRadius, BorderRadius.circular(12));
    });
  });

  group('a caption', () {
    Future<double> top(WidgetTester tester, {required bool first}) async {
      await show(tester, SwarmCaption('Needs you', first: first));
      return tester.getTopLeft(find.text('Needs you')).dy -
          tester.getTopLeft(find.byType(SwarmCaption)).dy;
    }

    testWidgets('leaves 8 above the first on a screen, 24 above the rest', (
      tester,
    ) async {
      expect(await top(tester, first: true), 8);
      expect(await top(tester, first: false), 24);
    });

    testWidgets('is set in 13 points, a count beside it as well', (
      tester,
    ) async {
      await show(tester, const SwarmCaption('Needs you', count: 3));

      expect(tester.widget<Text>(find.text('Needs you')).style?.fontSize, 13);
      expect(find.text('3'), findsOneWidget);
    });
  });

  group('a count badge', () {
    testWidgets('is a pill 22 points tall', (tester) async {
      await show(tester, const UnconstrainedBox(child: SwarmBadge(3)));

      expect(tester.getSize(find.byType(SwarmBadge)).height, 22);
      final decoration = tester
          .widget<Container>(
            find.descendant(
              of: find.byType(SwarmBadge),
              matching: find.byType(Container),
            ),
          )
          .decoration;
      expect(decoration, isA<ShapeDecoration>());
      expect((decoration! as ShapeDecoration).shape, const StadiumBorder());
    });

    testWidgets('takes dark ink on the warning fill, white on the accent', (
      tester,
    ) async {
      await show(tester, const SwarmBadge(3, warn: true));
      expect(
        tester.widget<Text>(find.text('3')).style?.color,
        const Color(0xFF1A1200),
      );

      await show(tester, const SwarmBadge(3));
      expect(
        tester.widget<Text>(find.text('3')).style?.color,
        const Color(0xFFFFFFFF),
      );
    });

    testWidgets('keeps the room of its figure: 8 points each side', (
      tester,
    ) async {
      await show(tester, const UnconstrainedBox(child: SwarmBadge(1234)));

      final text = tester.getSize(find.text('1234')).width;
      expect(tester.getSize(find.byType(SwarmBadge)).width, text + 16);
    });
  });

  group('a button', () {
    Future<double> room(WidgetTester tester, SwarmButtonStyle style) async {
      await show(
        tester,
        SwarmButton(label: 'Open chat', style: style, onPressed: () {}),
      );
      return tester.getSize(find.byType(SwarmButton)).width -
          tester.getSize(find.text('Open chat')).width;
    }

    testWidgets('has 16 points of room either side, a link 12', (tester) async {
      expect(await room(tester, SwarmButtonStyle.plain), 2 * 16);
      expect(await room(tester, SwarmButtonStyle.fill), 2 * 16);
      expect(await room(tester, SwarmButtonStyle.link), 2 * 12);
    });

    testWidgets('rounds at 10, rimmed when plain', (tester) async {
      await show(tester, SwarmButton(label: 'Open chat', onPressed: () {}));

      final shape =
          tester
                  .widget<Material>(
                    find.descendant(
                      of: find.byType(SwarmButton),
                      matching: find.byType(Material),
                    ),
                  )
                  .shape!
              as RoundedRectangleBorder;
      expect(shape.borderRadius, BorderRadius.circular(10));
      expect(shape.side, isNot(BorderSide.none));
    });

    testWidgets('writes the main action in white on the accent', (
      tester,
    ) async {
      await show(
        tester,
        SwarmButton(
          label: 'Open chat',
          style: SwarmButtonStyle.fill,
          onPressed: () {},
        ),
      );

      expect(
        tester.widget<Text>(find.text('Open chat')).style?.color,
        const Color(0xFFFFFFFF),
      );
    });
  });

  group('a person and a project', () {
    testWidgets("an avatar's initial is white on its colour", (tester) async {
      await show(tester, const SwarmAvatar(id: 'agent-1', name: 'Nova'));

      expect(
        tester.widget<Text>(find.text('N')).style?.color,
        const Color(0xFFFFFFFF),
      );
    });

    testWidgets("a project's tile rounds at the inset radius, 8", (
      tester,
    ) async {
      await show(tester, const SwarmProjectTile('Mobile'));

      final tile = tester.widget<Container>(
        find.descendant(
          of: find.byType(SwarmProjectTile),
          matching: find.byType(Container),
        ),
      );
      expect(
        (tile.decoration! as BoxDecoration).borderRadius,
        BorderRadius.circular(8),
      );
    });
  });

  group('a top bar', () {
    testWidgets('is 52 points tall, with a subtitle too', (tester) async {
      Future<double> height({String? subtitle}) async {
        await show(
          tester,
          SwarmTopBar(
            leading: const SizedBox.square(dimension: 44),
            title: 'Swarm',
            subtitle: subtitle,
          ),
        );
        return tester.getSize(find.byType(SwarmTopBar)).height;
      }

      expect(await height(), 52);
      expect(await height(subtitle: 'Mobile'), 52);
    });
  });

  group('a card row on its way', () {
    testWidgets("puts its mark 16 points in, as the real row's words are", (
      tester,
    ) async {
      await show(tester, SwarmSkeletonRows(id: 'rows', rows: 1));

      final row = find.byType(SwarmSkeletonRow);
      final mark = find.descendant(of: row, matching: find.byType(Skeleton));
      expect(tester.getTopLeft(mark.first).dx - tester.getTopLeft(row).dx, 16);
    });
  });
}
