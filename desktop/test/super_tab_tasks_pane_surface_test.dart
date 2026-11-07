import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/tasks/personal_tasks.dart';
import 'package:harness/super_tabs/tasks/personal_tasks_pane.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_personal_tasks_pane_test.dart' show TasksFixture;
import 'super_tab_personal_tasks_test.dart' show task;
import 'support/capture.dart';
import 'swarm_state_test.dart' show createApp;

/// The Tasks pane is one surface from its top to its bottom (anh Dee,
/// 2026-11-07). In Desktop 1.3.87 its dark background ended where its rows
/// ended and a light grey filled the rest.
///
/// The grey was Flutter's release-build error box (a 0xF0C0C0C0 square over the
/// dark surface reads 181, as in his screenshot): a task with no agent yet, such
/// as a Buddy's proposal nobody was assigned, sends `agent: null`, and building
/// its row threw "Invalid Swarm response". The error box then took the whole
/// rest of the list. A pixel test cannot tell a failed row from a good one
/// unless the data has that row, so these tests feed it.
void main() {
  final shots = Platform.environment['HARNESS_TASKS_SURFACE_SHOTS'];
  setUpAll(() => loadCaptureFonts(shots));

  const windowWidth = 1600.0, windowHeight = 1000.0;
  // Nothing in the app is this colour, so a pixel left unpainted shows it.
  const behind = Color(0xFFFF00FF);

  /// Tasks as the server sends them: every third one has no agent yet.
  List<Map<String, dynamic>> rowsOf(int count) => [
    for (var i = 0; i < count; i++)
      {
        ...task('row$i', 1, 1000 - i),
        'title': 'Task number $i',
        'projectName': i.isEven ? 'Harness' : 'Desktop',
        'status': 'proposal',
        'suggested': false,
        if (i % 3 == 1) 'agent': null,
      },
  ];

  Future<TasksFixture> mount(
    WidgetTester t,
    Brightness brightness,
    int count,
  ) async {
    final f = TasksFixture();
    addTearDown(f.controller.dispose);
    f.rows
      ..clear()
      ..addAll(rowsOf(count));
    await f.controller.refresh();
    final app = createApp();
    addTearDown(app.dispose);
    t.view.physicalSize = const Size(windowWidth, windowHeight);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
    await t.pumpWidget(
      MaterialApp(
        color: behind,
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        // The real Desktop shell, over a window of a colour of its own.
        home: ColoredBox(
          color: behind,
          child: Material(
            type: MaterialType.transparency,
            child: SuperTabView(
              controller: f.controller,
              app: app,
              board: true,
              machineName: (_) => 'Computer',
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              onNewSwarm: () {},
            ),
          ),
        ),
      ),
    );
    await t.pump();
    await t.pump(const Duration(seconds: 1));
    return f;
  }

  Color surface(WidgetTester t) =>
      Theme.of(t.element(find.byType(SuperTabPersonalTasksPane)))
          .colorScheme
          .surface;

  /// The pane's pixels down a strip no row reaches: every one must be the
  /// pane's surface, fully opaque.
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

  test('a task with no agent yet has no agent and no error', () {
    final noAgent = SuperTabPersonalTask({...task('a', 1, 1), 'agent': null});
    expect(noAgent.agentId, isNull);
    expect(noAgent.agent, isEmpty);
    final missing = SuperTabPersonalTask(
      Map.of(task('a', 1, 1))..remove('agent'),
    );
    expect(missing.agentId, isNull);
  });

  for (final brightness in Brightness.values) {
    for (final count in [0, 2, 40]) {
      final name =
          '${brightness.name}, ${count == 0
              ? 'no tasks'
              : count == 2
              ? 'two tasks'
              : 'many tasks, scrolling'}';

      testWidgets('every row of the Tasks pane is its surface: $name', (
        t,
      ) async {
        await mount(t, brightness, count);
        // A row that failed to build is an exception, and in a release build
        // a grey box that fills the rest of the list.
        expect(t.takeException(), isNull);
        final pane = t.getRect(find.byType(SuperTabPersonalTasksPane));
        expect(pane.size, const Size(340, windowHeight));
        if (count == 0) {
          expect(
            find.text(
              'No tasks yet. Tasks your agents start or propose show here.',
            ),
            findsOneWidget,
          );
        } else {
          expect(find.text('Task number 0'), findsOneWidget);
          // The card with no agent is on screen, as the person's own task, with no agent avatar (#4204's cards
          // name nobody).
          if (count > 1) {
            final card = find.byKey(const ValueKey('personal-task-row1'));
            expect(card, findsOneWidget);
            expect(
              find.descendant(
                of: card,
                matching: find.byWidgetPredicate(
                  (w) => w is SuperTabAvatar && w.identity.startsWith('agent:'),
                ),
              ),
              findsNothing,
            );
          }
        }
        expect(await strayPixels(t), isEmpty);
        await captureWindow(
          t,
          shots,
          'tasks-surface-${brightness.name}-$count',
        );
      });
    }
  }

  testWidgets('the pane draws its own filled surface under its list', (
    t,
  ) async {
    await mount(t, Brightness.dark, 2);
    final pane = t.getRect(find.byType(SuperTabPersonalTasksPane));
    // A plain filled box the size of the slot, whatever the list is, so the
    // pane never shows what is behind it if its list is short or fails.
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
    );
  });
}
