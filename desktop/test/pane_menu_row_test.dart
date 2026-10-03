// The live action's active state and the retained legacy row's column geometry.
// PaneMenuRow is no longer used by production menus.
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/theme/app_theme.dart';
import 'package:harness/widgets/model_picker_chrome.dart';
import 'package:harness/widgets/pane_menu.dart';

void main() {
  Future<void> show(WidgetTester tester, List<Widget> rows) async {
    tester.view.physicalSize = const Size(900, 700);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(width: 420, child: Column(children: rows)),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Widget item(Widget row) => paneMenuItem(onTap: () {}, child: row);

  testWidgets(
    'active fill and saved checkmark stay distinct without moving the row',
    (tester) async {
      await show(tester, [
        ModelPickerRow(
          selected: true,
          title: 'chosen',
          subtitle: 'here',
          onTap: () {},
        ),
        ModelPickerRow(
          selected: false,
          title: 'other',
          subtitle: 'there',
          onTap: () {},
        ),
      ]);

      final chosen = find.widgetWithText(TextButton, 'chosen');
      final other = find.widgetWithText(TextButton, 'other');
      Material material(Finder row) => tester.widget<Material>(
        find.descendant(of: row, matching: find.byType(Material)),
      );
      expect(material(chosen).color, grid.AppSurface.accentWash);
      expect(material(other).color, Colors.transparent);
      expect(
        find.descendant(of: chosen, matching: find.byIcon(AppIcons.check)),
        findsOneWidget,
      );
      expect(
        find.descendant(of: other, matching: find.byIcon(AppIcons.check)),
        findsNothing,
      );
      final before = tester.getRect(other);
      final shape = material(other).shape;
      final pointer = await tester.createGesture(
        kind: ui.PointerDeviceKind.mouse,
      );
      await pointer.addPointer(location: const Offset(800, 600));
      addTearDown(pointer.removePointer);
      await pointer.moveTo(tester.getCenter(other));
      await tester.pumpAndSettle();
      expect(material(other).color, grid.AppDesktop.selection);
      expect(
        tester.widget<Text>(find.text('other')).style!.color,
        grid.AppDesktop.onSelection,
      );
      expect(
        tester.widget<Text>(find.text('there')).style!.color,
        grid.AppDesktop.onSelection,
      );
      expect(material(chosen).color, grid.AppSurface.accentWash);
      expect(material(other).shape, shape);
      expect(tester.getRect(other), before);

      await pointer.moveTo(const Offset(800, 600));
      Focus.of(tester.element(find.text('other'))).requestFocus();
      await tester.pumpAndSettle();
      expect(material(other).color, grid.AppDesktop.selection);
      expect(material(other).shape, shape);
      expect(tester.getRect(other), before);
      expect(find.byIcon(AppIcons.check), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('only the chosen row is filled', (tester) async {
    await show(tester, [
      item(const PaneMenuRow(selected: true, title: 'chosen', status: 'here')),
      item(const PaneMenuRow(selected: false, title: 'other', status: 'there')),
    ]);

    BoxDecoration? fillOf(String text) =>
        tester
                .widget<Container>(
                  find
                      .ancestor(
                        of: find.text(text),
                        matching: find.byType(Container),
                      )
                      .first,
                )
                .decoration
            as BoxDecoration?;
    expect(fillOf('chosen')?.color, AppColors.selected);
    expect(fillOf('other')?.color, isNull);
  });

  testWidgets(
    'trailing metadata shares one right edge, whatever the row holds',
    (tester) async {
      // Every trailing field was a `Flexible`, whose flex is ONE — so a row's spare width was split
      // evenly between the title and each field beside it. A row with two fields put them a third
      // and two thirds across; a row with one put it halfway. Three columns, three offsets.
      await show(tester, [
        item(const PaneMenuRow(selected: false, title: 'one', status: 'a')),
        item(
          const PaneMenuRow(
            selected: false,
            title: 'two',
            status: 'firmware-engineer-daniel',
          ),
        ),
        item(
          const PaneMenuRow(
            selected: false,
            title: 'three',
            detail: '7f0c59',
            status: '11% remaining',
          ),
        ),
      ]);

      final edges = [
        tester.getRect(find.text('a')).right,
        tester.getRect(find.text('firmware-engineer-daniel')).right,
        tester.getRect(find.text('11% remaining')).right,
      ];
      for (final edge in edges) {
        expect((edge - edges.first).abs(), lessThan(0.5));
      }
    },
  );

  testWidgets('a long trailing field ellipsizes instead of eating the title', (
    tester,
  ) async {
    const long =
        'a-machine-name-far-longer-than-any-column-should-ever-be-allowed-to-grow';
    await show(tester, [
      item(const PaneMenuRow(selected: false, title: 'model', status: long)),
    ]);

    expect(
      tester.getRect(find.text(long)).width,
      lessThanOrEqualTo(kPaneMenuMetaMaxWidth + 0.5),
    );
    // The row is named after its title, so that is the text that keeps its width.
    expect(tester.getRect(find.text('model')).width, greaterThan(0));
    expect(tester.takeException(), isNull);
  });
}
