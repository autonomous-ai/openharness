import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/laid_out_list.dart';

/// A hovered row whose tooltip opens in the frame the row falls past the
/// list's trailing cache edge: the trigger of the frozen mouse.
const _viewport = 500.0;
const _rowHeight = 40.0;

Widget _row(int i) => Tooltip(
  message: 'row $i',
  waitDuration: Duration.zero,
  child: InkWell(
    onTap: () {},
    child: SizedBox(height: _rowHeight, child: Text('row $i')),
  ),
);

Widget _frame(Widget list) => MaterialApp(
  home: Scaffold(
    body: Align(
      alignment: Alignment.topCenter,
      child: SizedBox(height: _viewport, child: list),
    ),
  ),
);

Future<TestGesture> _openTooltipAsRowLeaves(
  WidgetTester tester,
  ScrollController controller,
) async {
  final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
  addTearDown(mouse.removePointer);
  // Starts below the list, so nothing is hovered yet.
  await mouse.addPointer(location: const Offset(5, _viewport + 50));
  await tester.pump();
  await mouse.moveTo(const Offset(5, _viewport - 20));
  controller.jumpTo(controller.offset - 1500);
  await tester.pump();
  return mouse;
}

void main() {
  group('LaidOutListView', () {
    testWidgets('a plain ListView shows the bug this list exists to prevent', (
      tester,
    ) async {
      final controller = ScrollController(initialScrollOffset: 4000);
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _frame(
          ListView.builder(
            controller: controller,
            itemCount: 200,
            itemBuilder: (context, i) => _row(i),
          ),
        ),
      );
      final errors = <FlutterErrorDetails>[];
      final previous = FlutterError.onError;
      FlutterError.onError = errors.add;
      addTearDown(() => FlutterError.onError = previous);
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: const Offset(5, _viewport + 50));
      await tester.pump();
      await mouse.moveTo(const Offset(5, _viewport - 20));
      controller.jumpTo(controller.offset - 1500);
      Object? thrown;
      try {
        await tester.pump();
        await mouse.moveTo(const Offset(5, 100));
      } catch (error) {
        thrown = error;
      }
      FlutterError.onError = previous;
      final all = [
        ...errors.map((e) => e.exceptionAsString()),
        '$thrown',
        '${tester.takeException()}',
      ].join('\n');
      expect(all, contains('never been laid out'));
      // The tree is broken on purpose; replace it so teardown stays quiet.
      FlutterError.onError = (_) {};
      try {
        await tester.pumpWidget(const SizedBox());
      } catch (_) {}
      tester.takeException();
      FlutterError.onError = previous;
    });

    testWidgets('a row leaving as its tooltip opens stays hit-testable', (
      tester,
    ) async {
      final controller = ScrollController(initialScrollOffset: 4000);
      addTearDown(controller.dispose);
      var tapped = 0;
      await tester.pumpWidget(
        _frame(
          LaidOutListView.builder(
            controller: controller,
            itemCount: 200,
            itemBuilder: (context, i) => Tooltip(
              message: 'row $i',
              waitDuration: Duration.zero,
              child: InkWell(
                onTap: () => tapped++,
                child: SizedBox(height: _rowHeight, child: Text('row $i')),
              ),
            ),
          ),
        ),
      );
      final mouse = await _openTooltipAsRowLeaves(tester, controller);
      expect(tester.takeException(), isNull);
      await mouse.moveTo(const Offset(5, 100));
      expect(tester.takeException(), isNull);
      await tester.pump(const Duration(seconds: 1));
      expect(tester.takeException(), isNull);
      // Clicks still land.
      await mouse.down(const Offset(5, 100));
      await mouse.up();
      await tester.pump(const Duration(seconds: 1));
      expect(tapped, 1);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a kept-alive row scrolled back still works', (tester) async {
      final controller = ScrollController(initialScrollOffset: 4000);
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _frame(
          LaidOutListView.builder(
            controller: controller,
            itemCount: 200,
            itemBuilder: (context, i) => _row(i),
          ),
        ),
      );
      await _openTooltipAsRowLeaves(tester, controller);
      controller.jumpTo(4000);
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(tester.takeException(), isNull);
      expect(find.text('row 112'), findsWidgets);
    });

    testWidgets('a separated list leaving as its tooltip opens stays safe', (
      tester,
    ) async {
      final controller = ScrollController(initialScrollOffset: 4000);
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _frame(
          LaidOutListView.separated(
            controller: controller,
            itemCount: 200,
            itemBuilder: (context, i) => _row(i),
            separatorBuilder: (context, i) => const SizedBox.shrink(),
          ),
        ),
      );
      final mouse = await _openTooltipAsRowLeaves(tester, controller);
      expect(tester.takeException(), isNull);
      await mouse.moveTo(const Offset(5, 100));
      expect(tester.takeException(), isNull);
    });

    testWidgets('a grid is safe as a plain GridView', (tester) async {
      final controller = ScrollController(initialScrollOffset: 4000);
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _frame(
          GridView.builder(
            controller: controller,
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 1,
              mainAxisExtent: _rowHeight,
            ),
            itemCount: 200,
            itemBuilder: (context, i) => _row(i),
          ),
        ),
      );
      final mouse = await _openTooltipAsRowLeaves(tester, controller);
      expect(tester.takeException(), isNull);
      await mouse.moveTo(const Offset(5, 100));
      expect(tester.takeException(), isNull);
    });

    testWidgets('a list with an item extent is safe as a plain ListView', (
      tester,
    ) async {
      final controller = ScrollController(initialScrollOffset: 4000);
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _frame(
          ListView.builder(
            controller: controller,
            itemExtent: _rowHeight,
            itemCount: 200,
            itemBuilder: (context, i) => _row(i),
          ),
        ),
      );
      final mouse = await _openTooltipAsRowLeaves(tester, controller);
      expect(tester.takeException(), isNull);
      await mouse.moveTo(const Offset(5, 100));
      expect(tester.takeException(), isNull);
    });
  });

  test('Lists use LaidOutListView unless their rows are tightly sized', () {
    final bare = RegExp(
      r'(?<![\w.<])(ListView(\.builder|\.separated|\.custom)?'
      r'|SliverList(\.builder|\.list|\.separated)?)\(',
    );
    final offenders = <String>[];
    for (final dir in ['lib']) {
      for (final file in Directory(dir).listSync(recursive: true)) {
        if (file is! File || !file.path.endsWith('.dart')) continue;
        if (file.path.endsWith('laid_out_list.dart')) continue;
        final source = file.readAsStringSync();
        for (final match in bare.allMatches(source)) {
          var depth = 0;
          var end = match.end - 1;
          do {
            if (source[end] == '(') depth++;
            if (source[end] == ')') depth--;
            end++;
          } while (depth > 0 && end < source.length);
          final call = source.substring(match.start, end);
          if (!call.contains('itemExtent')) {
            offenders.add('${file.path}: ${match.group(0)}');
          }
        }
      }
    }
    expect(offenders, isEmpty);
  });
}
