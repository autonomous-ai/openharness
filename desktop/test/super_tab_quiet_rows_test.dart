import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/buddy_rows.dart';

/// The Desktop left pane's one row style and its heading (task #4466, anh Dee 11-07): face, name, one quiet detail on
/// the right; 30 high; 13 names, 12 details; bold only for unread; chevrons only on hover.
void main() {
  Future<void> pump(WidgetTester tester, List<Widget> children) async {
    await tester.binding.setSurfaceSize(const Size(300, 400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: children,
          ),
        ),
      ),
    );
  }

  TextStyle styleOf(WidgetTester tester, String text) =>
      tester.widget<Text>(find.text(text)).style!;

  const face = SizedBox.square(
    key: ValueKey('face'),
    dimension: SuperTabQuietRow.faceSize,
  );

  group('a quiet row', () {
    testWidgets('is 30 high, and a face and an icon start every name on one '
        'line', (tester) async {
      await pump(tester, [
        SuperTabQuietRow(
          key: const ValueKey('a'),
          leading: face,
          name: 'River',
          onTap: () {},
        ),
        SuperTabQuietRow(
          key: const ValueKey('b'),
          leading: const Icon(AppIcons.plus, size: AppIcons.inlineSize),
          name: 'New agent',
          onTap: () {},
        ),
      ]);
      expect(SuperTabQuietRow.height, 30);
      // The fill is 30; the 2 under it keeps two lit rows apart.
      expect(
        tester
            .getSize(
              find.descendant(
                of: find.byKey(const ValueKey('a')),
                matching: find.byType(InkWell),
              ),
            )
            .height,
        30,
      );
      expect(
        tester.getTopLeft(find.text('River')).dx,
        tester.getTopLeft(find.text('New agent')).dx,
      );
      expect(tester.getSize(find.byKey(const ValueKey('face'))).width, 20);
    });

    testWidgets('its detail is 12 and tertiary, right-aligned at the row\'s '
        'end, with no brackets', (tester) async {
      await pump(tester, [
        SuperTabQuietRow(
          key: const ValueKey('lead'),
          leading: face,
          name: 'River',
          detail: 'harness',
          onTap: () {},
        ),
        SuperTabQuietRow(
          key: const ValueKey('person'),
          leading: face,
          name: 'dee',
          detail: '120',
          onTap: () {},
        ),
      ]);
      final detail = styleOf(tester, 'harness');
      expect(detail.fontSize, 12);
      expect(detail.color, grid.AppPalette.textFaint);
      expect(find.text('(harness)'), findsNothing);
      // One right edge for every detail, whatever its length.
      expect(
        tester.getTopRight(find.text('harness')).dx,
        tester.getTopRight(find.text('120')).dx,
      );
      expect(
        styleOf(tester, '120').fontFeatures,
        contains(const FontFeature.tabularFigures()),
      );
    });

    testWidgets('a read name is secondary and regular, an unread one primary '
        'and semibold, and only unread is heard', (tester) async {
      final semantics = tester.ensureSemantics();
      await pump(tester, [
        SuperTabQuietRow(leading: face, name: 'Read', onTap: () {}),
        SuperTabQuietRow(
          leading: face,
          name: 'Unread',
          unread: true,
          onTap: () {},
        ),
      ]);
      final read = styleOf(tester, 'Read'), unread = styleOf(tester, 'Unread');
      expect(read.fontSize, 13);
      expect(read.color, grid.AppPalette.textSecondary);
      expect(read.fontWeight, FontWeight.w400);
      expect(unread.fontSize, 13);
      expect(unread.color, grid.AppPalette.textPrimary);
      expect(unread.fontWeight, grid.AppFont.semibold);
      expect(
        find.bySemanticsLabel(RegExp('^Unread\nunread\$')),
        findsOneWidget,
      );
      expect(find.bySemanticsLabel(RegExp('^Read\$')), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('the selected row has the neutral fill and a primary name', (
      tester,
    ) async {
      await pump(tester, [
        SuperTabQuietRow(
          key: const ValueKey('open'),
          leading: face,
          name: 'Open',
          selected: true,
          onTap: () {},
        ),
      ]);
      final fill = tester.widget<Material>(
        find
            .descendant(
              of: find.byKey(const ValueKey('open')),
              matching: find.byType(Material),
            )
            .first,
      );
      expect(fill.color, grid.SidebarInk.selected);
      expect(styleOf(tester, 'Open').color, grid.AppPalette.textPrimary);
      expect(styleOf(tester, 'Open').fontWeight, FontWeight.w400);
    });

    // Task #4645: no marks' column, so every row's detail ends at one right inset.
    testWidgets('every detail ends at the row\'s one right inset', (
      tester,
    ) async {
      await pump(tester, [
        SuperTabQuietRow(
          key: const ValueKey('lead'),
          leading: face,
          name: 'River',
          detail: 'harness',
          onTap: () {},
        ),
        SuperTabQuietRow(
          key: const ValueKey('person'),
          leading: face,
          name: 'dee',
          detail: '120',
          onTap: () {},
        ),
      ]);
      expect(
        tester.getRect(find.byKey(const ValueKey('lead'))).right -
            tester.getTopRight(find.text('harness')).dx,
        grid.AppDesktop.controlGap,
      );
      expect(
        tester.getTopRight(find.text('harness')).dx,
        tester.getTopRight(find.text('120')).dx,
      );
    });

    testWidgets('a long name is cut before the detail, which keeps its whole '
        'word', (tester) async {
      await pump(tester, [
        SuperTabQuietRow(
          leading: face,
          name: 'An agent with a very long name indeed that never fits',
          detail: 'harness',
          onTap: () {},
        ),
      ]);
      final detail = tester.renderObject<RenderParagraph>(find.text('harness'));
      expect(detail.didExceedMaxLines, isFalse);
      expect(tester.takeException(), isNull);
    });
  });

  group('a quiet heading', () {
    Future<TestGesture> hover(WidgetTester tester, Finder target) async {
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      addTearDown(mouse.removePointer);
      await mouse.moveTo(tester.getCenter(target));
      await tester.pump();
      return mouse;
    }

    testWidgets('is 12 and secondary, with its chevron only while hovered', (
      tester,
    ) async {
      var toggled = 0;
      await pump(tester, [
        SuperTabQuietHeading(
          'My agents',
          collapsed: false,
          onTap: () => toggled++,
        ),
      ]);
      final style = styleOf(tester, 'My agents');
      expect(style.fontSize, 12);
      expect(style.color, grid.AppPalette.textSecondary);
      expect(find.byIcon(AppIcons.chevronDown), findsNothing);
      await hover(tester, find.text('My agents'));
      expect(find.byIcon(AppIcons.chevronDown), findsOneWidget);
      await tester.tap(find.text('My agents'));
      expect(toggled, 1);
    });

    testWidgets('folded, its hover chevron points right', (tester) async {
      await pump(tester, [
        SuperTabQuietHeading('My agents', collapsed: true, onTap: () {}),
      ]);
      await hover(tester, find.text('My agents'));
      expect(find.byIcon(AppIcons.chevronRight), findsOneWidget);
    });

    testWidgets('the org name is semibold, 13 and primary, a dropdown that '
        'shows its chevron only on hover', (tester) async {
      await pump(tester, [
        SuperTabQuietHeading.org('autonomous.ai', onTap: () {}),
      ]);
      final style = styleOf(tester, 'autonomous.ai');
      expect(style.fontSize, 13);
      expect(style.fontWeight, grid.AppFont.semibold);
      expect(style.color, grid.AppPalette.textPrimary);
      expect(find.byIcon(AppIcons.chevronDown), findsNothing);
      await hover(tester, find.text('autonomous.ai'));
      expect(find.byIcon(AppIcons.chevronDown), findsOneWidget);
    });

    testWidgets('a heading that only opens a page has no chevron', (
      tester,
    ) async {
      await pump(tester, [SuperTabQuietHeading('Humans', onTap: () {})]);
      await hover(tester, find.text('Humans'));
      expect(find.byIcon(AppIcons.chevronDown), findsNothing);
      expect(find.byIcon(AppIcons.chevronRight), findsNothing);
    });
  });
}
