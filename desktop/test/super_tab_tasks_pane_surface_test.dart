import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/tasks/personal_tasks_pane.dart';

import 'super_tab_personal_tasks_pane_test.dart' show TasksFixture;
import 'super_tab_personal_tasks_test.dart' show task;
import 'support/capture.dart';

/// The Tasks pane is one surface from its top to its bottom (anh Dee,
/// 2026-11-07): in Desktop 1.3.87 the dark theme's pane stopped where its rows
/// ended and the window's own backing showed below them.
///
/// The pane is drawn over a window with nothing behind it, so a pixel the pane
/// leaves unpainted is transparent here, as it is where a person saw grey.
void main() {
  final shots = Platform.environment['HARNESS_TASKS_SURFACE_SHOTS'];
  setUpAll(() => loadCaptureFonts(shots));

  const paneWidth = 340.0, windowHeight = 760.0;

  Future<TasksFixture> mount(
    WidgetTester t,
    Brightness brightness,
    int count,
  ) async {
    final f = TasksFixture();
    addTearDown(f.controller.dispose);
    f.rows
      ..clear()
      ..addAll([
        for (var i = 0; i < count; i++)
          {
            ...task('row$i', 1, 1000 - i),
            'title': 'Task number $i',
            'projectName': i.isEven ? 'Harness' : 'Desktop',
            'status': i == 1 ? 'working' : 'proposal',
            'suggested': false,
          },
      ]);
    await f.controller.refresh();
    t.view.physicalSize = const Size(paneWidth + 200, windowHeight);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
    await t.pumpWidget(
      MaterialApp(
        color: const Color(0x00000000),
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        // The shell's own slot: a fixed-width box in a row, beside the chat.
        home: Row(
          children: [
            const Expanded(child: SizedBox.shrink()),
            SizedBox(
              width: paneWidth,
              child: SuperTabPersonalTasksPane(
                controller: f.controller,
                onOpenTask: (_) {},
              ),
            ),
          ],
        ),
      ),
    );
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    return f;
  }

  Color surface(WidgetTester t) =>
      Theme.of(t.element(find.byType(SuperTabPersonalTasksPane)))
          .colorScheme
          .surface;

  /// The pane's pixels down its left edge, a strip no row reaches: every
  /// one must be the pane's surface, fully opaque.
  Future<List<String>> strayPixels(WidgetTester t) async {
    final pane = t.getRect(find.byType(SuperTabPersonalTasksPane));
    final want = surface(t);
    final stray = <String>[];
    await t.runAsync(() async {
      final view = t.binding.renderViews.first;
      final image = await (view.debugLayer! as OffsetLayer).toImage(
        Offset.zero & view.size,
        pixelRatio: 1,
      );
      final data = (await image.toByteData(
        format: ui.ImageByteFormat.rawRgba,
      ))!;
      int byte(double channel) => (channel * 255).round();
      final x = pane.left.round() + 3;
      for (var y = pane.top.round(); y < pane.bottom.round(); y++) {
        final i = (y * image.width + x) * 4;
        final got = [for (var k = 0; k < 4; k++) data.getUint8(i + k)];
        final expected = [byte(want.r), byte(want.g), byte(want.b), 255];
        if (got.join(',') != expected.join(',')) {
          stray.add('y=$y got $got, the pane surface is $expected');
        }
      }
      image.dispose();
    });
    return stray;
  }

  for (final brightness in Brightness.values) {
    for (final count in [0, 2, 40]) {
      final name =
          '${brightness.name}, ${count == 0
              ? 'no tasks'
              : count == 2
              ? 'two tasks'
              : 'many tasks, scrolling'}';

      testWidgets('the Tasks pane is one surface to the bottom: $name', (
        t,
      ) async {
        await mount(t, brightness, count);
        final pane = t.getRect(find.byType(SuperTabPersonalTasksPane));
        expect(pane.height, windowHeight);
        // Nothing under the pane's top or bottom edge is left unpainted or
        // painted another colour.
        expect(await strayPixels(t), isEmpty);
        await captureWindow(
          t,
          shots,
          'tasks-surface-${brightness.name}-$count',
        );
      });

      testWidgets('the Tasks pane draws its own filled surface: $name', (
        t,
      ) async {
        await mount(t, brightness, count);
        final pane = t.getRect(find.byType(SuperTabPersonalTasksPane));
        // One plain filled box the size of the pane, whatever the list is
        // (a Material's layer is only as large as what it is asked to
        // paint, which is what left the strip below the rows).
        final fills = t
            .widgetList<ColoredBox>(
              find.descendant(
                of: find.byType(SuperTabPersonalTasksPane),
                matching: find.byType(ColoredBox),
              ),
            )
            .where((box) => box.color == surface(t));
        expect(
          fills.where((box) {
            final size = t.getSize(find.byWidget(box));
            return size.width == pane.width && size.height == pane.height;
          }),
          isNotEmpty,
          reason: 'no surface-coloured box covers the whole pane',
        );
      });
    }
  }
}
