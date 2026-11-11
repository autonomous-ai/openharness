import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' show AppControl;
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
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

    /// What [button] draws: its face, inside the box it is laid out in.
    Rect drawn(WidgetTester tester, Finder button) => tester.getRect(
      find.descendant(of: button, matching: find.byType(Material)).first,
    );

    testWidgets('is drawn 44 tall; compact, drawn at a control\'s height in a '
        'box 44 tall', (tester) async {
      await show(tester, SwarmButton(label: 'Reply', onPressed: () {}));
      final button = find.byType(SwarmButton);
      expect(drawn(tester, button).height, minTouchTarget);

      await show(
        tester,
        SwarmButton(label: 'Reply', compact: true, onPressed: () {}),
      );
      expect(drawn(tester, button).height, AppControl.height);
      expect(tester.getSize(button).height, minTouchTarget);
      expect(drawn(tester, button).center, tester.getCenter(button));
    });

    testWidgets('compact, has 12 points of room either side', (tester) async {
      for (final style in SwarmButtonStyle.values) {
        await show(
          tester,
          SwarmButton(
            label: 'Reply',
            style: style,
            compact: true,
            onPressed: () {},
          ),
        );
        expect(
          drawn(tester, find.byType(SwarmButton)).width -
              tester.getSize(find.text('Reply')).width,
          2 * 12,
          reason: '$style',
        );
      }
    });

    testWidgets('compact, is pressed across its 44-point box, in a row as '
        'tall as its words too, and not past it', (tester) async {
      var presses = 0;
      // A row shorter than a thumb, as an Activity row's words can be.
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Center(
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const SizedBox(height: 36, child: Text('Fix login')),
                  SwarmButton(
                    label: 'Reply',
                    compact: true,
                    onPressed: () => presses++,
                  ),
                ],
              ),
            ),
          ),
        ),
      );
      final face = drawn(tester, find.byType(SwarmButton));
      final reach = (minTouchTarget - face.height) / 2;

      await tester.tapAt(face.topCenter - Offset(0, reach - 1));
      await tester.tapAt(face.bottomCenter + Offset(0, reach - 1));
      expect(presses, 2);

      await tester.tapAt(face.topCenter - Offset(0, reach + 2));
      await tester.tapAt(face.bottomCenter + Offset(0, reach + 2));
      expect(presses, 2);
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

  group('a caption with a control', () {
    testWidgets('has it at its right end, centred on its words, a thumb '
        'tall', (tester) async {
      const control = ValueKey('control');
      await show(
        tester,
        const SwarmCaption(
          'Projects',
          trailing: SizedBox(key: control, width: 44, height: 44),
        ),
      );

      final caption = find.byType(SwarmCaption);
      expect(
        tester.getTopRight(find.byKey(control)).dx,
        tester.getTopRight(caption).dx,
      );
      expect(
        tester.getCenter(find.text('Projects')).dy,
        closeTo(tester.getCenter(find.byKey(control)).dy, .5),
      );
      expect(tester.getSize(caption).height, greaterThanOrEqualTo(44));
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

    testWidgets("a project's on Home: its name's bar alone, 16 points in, on "
        'one line a thumb tall', (tester) async {
      await show(
        tester,
        SwarmSkeletonRows(id: 'rows', rows: 1, nameOnly: true),
      );

      final row = find.byType(SwarmSkeletonRow);
      expect(
        find.descendant(of: row, matching: find.byType(SkeletonText)),
        findsOneWidget,
        reason: 'no line under the name',
      );
      final bar = find.descendant(of: row, matching: find.byType(Skeleton));
      expect(bar, findsOneWidget, reason: 'no mark before the name');
      expect(tester.getTopLeft(bar).dx - tester.getTopLeft(row).dx, 16);
      expect(tester.getSize(row).height, minTouchTarget);
    });
  });
}
