import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/pane_layout.dart';
import 'package:harness/widgets/pane_resize_handle.dart';

import 'swarm_state_test.dart' show MemoryStore;

class _SlowStore extends MemoryStore {
  final readResult = Completer<String?>();
  @override
  Future<String?> read(String key) => readResult.future;
}

void main() {
  final left = find.byKey(const ValueKey('super-left-pane'));
  final center = find.byKey(const ValueKey('super-center-pane'));
  final right = find.byKey(const ValueKey('super-right-pane'));
  final leftHandle = find.byKey(const ValueKey('super-resize-left'));
  final rightHandle = find.byKey(const ValueKey('super-resize-right'));

  Future<void> mount(
    WidgetTester tester,
    MemoryStore store, {
    bool sides = true,
    double scale = 1,
    double rightDefault = SuperTabPaneLayout.rightWidth,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: Scaffold(
          body: SuperTabPaneLayout(
            storage: store,
            onLeave: () {},
            rightDefault: rightDefault,
            left: sides ? const ColoredBox(color: Colors.black) : null,
            right: sides ? const ColoredBox(color: Colors.black) : null,
            center: const TextField(key: ValueKey('draft')),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
    'both dividers resize and persist without replacing the conversation',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1400, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final store = MemoryStore();
      await mount(tester, store);
      expect(tester.getSize(left).width, 300);
      expect(tester.getSize(right).width, 280);
      await tester.enterText(find.byType(TextField), 'Keep this draft');
      final editor = tester.state<EditableTextState>(find.byType(EditableText));
      final focus = editor.widget.focusNode;
      await tester.drag(leftHandle, const Offset(100, 0));
      await tester.pumpAndSettle();
      expect(tester.getSize(left).width, closeTo(400, 1));
      expect(tester.getSize(right).width, 280);
      expect(focus.hasFocus, isTrue);
      await tester.drag(rightHandle, const Offset(-60, 0));
      await tester.pumpAndSettle();
      expect(tester.getSize(right).width, closeTo(340, 1));
      expect(tester.getSize(center).width, closeTo(660, 1));
      expect(
        tester.state<EditableTextState>(find.byType(EditableText)),
        same(editor),
      );
      expect(find.text('Keep this draft'), findsOneWidget);
      final saved = jsonDecode(store.values[SuperTabPaneLayout.storageKey]!);
      expect(saved['left'], closeTo(400, 1));
      expect(saved['right'], closeTo(340, 1));

      // Responsive overlays do not forget the preferred sizes or edit state.
      await mount(tester, store, sides: false);
      expect(find.byType(PaneResizeHandle), findsNothing);
      expect(
        tester.state<EditableTextState>(find.byType(EditableText)),
        same(editor),
      );
      await mount(tester, store);
      expect(tester.getSize(left).width, closeTo(400, 1));
      expect(tester.getSize(right).width, closeTo(340, 1));
      await tester.pumpWidget(const SizedBox());
      await mount(tester, store);
      expect(tester.getSize(left).width, closeTo(400, 1));
      expect(tester.getSize(right).width, closeTo(340, 1));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'resize limits protect all panes, support keys and survive a smaller window',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1400, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final store = MemoryStore();
      await mount(tester, store);
      await tester.drag(leftHandle, const Offset(-1000, 0));
      await tester.pumpAndSettle();
      expect(tester.getSize(left).width, closeTo(180, 1));
      await tester.drag(rightHandle, const Offset(1000, 0));
      await tester.pumpAndSettle();
      expect(tester.getSize(right).width, closeTo(280, 1));
      await tester.drag(leftHandle, const Offset(1000, 0));
      await tester.pumpAndSettle();
      expect(tester.getSize(center).width, closeTo(360, 1));
      final preferred = tester.getSize(left).width;
      await tester.binding.setSurfaceSize(const Size(1080, 800));
      await tester.pumpAndSettle();
      expect(tester.getSize(center).width, greaterThanOrEqualTo(360));
      expect(tester.getSize(right).width, greaterThanOrEqualTo(280));
      await tester.binding.setSurfaceSize(const Size(1400, 800));
      await tester.pumpAndSettle();
      expect(tester.getSize(left).width, preferred);

      final focus = tester
          .widget<Focus>(
            find.descendant(of: leftHandle, matching: find.byType(Focus)),
          )
          .focusNode!;
      focus.requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pumpAndSettle();
      expect(tester.getSize(left).width, closeTo(preferred - 28, 1));
      await tester.tap(leftHandle);
      await tester.pump(const Duration(milliseconds: 70));
      await tester.tap(leftHandle);
      await tester.pumpAndSettle();
      expect(
        tester.getSize(left).width,
        closeTo(tester.getSize(center).width, 1),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('a late saved preference cannot undo a resize', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final store = _SlowStore();
    await mount(tester, store);
    await tester.drag(rightHandle, const Offset(-60, 0));
    await tester.pumpAndSettle();
    store.readResult.complete('{"left":200,"right":300}');
    await tester.pumpAndSettle();
    expect(tester.getSize(right).width, closeTo(340, 1));
  });

  testWidgets('large text and invalid saved sizes retain usable panes', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(2400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final store = MemoryStore()
      ..values[SuperTabPaneLayout.storageKey] = '{"left":-2,"right":"bad"}';
    await mount(tester, store, scale: 2);
    expect(tester.getSize(left).width, 360);
    expect(tester.getSize(right).width, 560);
    expect(tester.getSize(center).width, greaterThanOrEqualTo(720));
    expect(tester.takeException(), isNull);
  });

  testWidgets('a thread opens at its own default width, the roster keeps '
      'its own, and a width set by the divider wins for both', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final store = MemoryStore();
    const thread = SuperTabPaneLayout.threadWidth;
    await mount(tester, store, rightDefault: thread);
    expect(tester.getSize(right).width, 340);
    await mount(tester, store);
    expect(tester.getSize(right).width, 280);
    await mount(tester, store, rightDefault: thread);
    expect(tester.getSize(right).width, 340);
    // Moving the left divider leaves the right pane's default alone.
    await tester.drag(leftHandle, const Offset(40, 0));
    await tester.pumpAndSettle();
    expect(tester.getSize(right).width, 340);
    expect(
      jsonDecode(store.values[SuperTabPaneLayout.storageKey]!),
      isNot(contains('right')),
    );

    await tester.drag(rightHandle, const Offset(40, 0));
    await tester.pumpAndSettle();
    expect(tester.getSize(right).width, closeTo(300, 1));
    await mount(tester, store);
    expect(tester.getSize(right).width, closeTo(300, 1));
    await tester.pumpWidget(const SizedBox());
    await mount(tester, store, rightDefault: thread);
    expect(tester.getSize(right).width, closeTo(300, 1));
    expect(tester.takeException(), isNull);
  });

  testWidgets('a thread narrower than its default only where the window '
      'leaves the chat no more than its minimum, never below 280', (
    tester,
  ) async {
    final store = MemoryStore();
    const thread = SuperTabPaneLayout.threadWidth;
    await tester.binding.setSurfaceSize(const Size(1080, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await mount(tester, store, rightDefault: thread);
    expect(tester.getSize(right).width, 340);
    expect(tester.getSize(center).width, greaterThan(360));

    await tester.binding.setSurfaceSize(const Size(960, 800));
    await tester.pumpAndSettle();
    expect(tester.getSize(center).width, closeTo(360, 1));
    expect(tester.getSize(right).width, closeTo(300, 1));

    await tester.binding.setSurfaceSize(const Size(900, 800));
    await tester.pumpAndSettle();
    expect(tester.getSize(right).width, closeTo(280, 1));
    expect(tester.takeException(), isNull);
  });

  test('a thread drawer is as wide as a thread, within its share of the '
      'window', () {
    const thread = SuperTabPaneLayout.threadWidth;
    expect(SuperTabPaneLayout.drawerWidth(1000), 280);
    expect(SuperTabPaneLayout.drawerWidth(1000, max: thread), 340);
    expect(SuperTabPaneLayout.drawerWidth(400, max: thread), 280);
  });

  testWidgets('a saved 280 from older builds, written with any divider move, '
      'leaves a thread at its own default', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final store = MemoryStore()
      ..values[SuperTabPaneLayout.storageKey] = '{"left":400,"right":280}';
    await mount(tester, store, rightDefault: SuperTabPaneLayout.threadWidth);
    expect(tester.getSize(left).width, 400);
    expect(tester.getSize(right).width, 340);
    await mount(tester, store);
    expect(tester.getSize(right).width, 280);

    final chosen = MemoryStore()
      ..values[SuperTabPaneLayout.storageKey] = '{"left":400,"right":310}';
    await tester.pumpWidget(const SizedBox());
    await mount(tester, chosen, rightDefault: SuperTabPaneLayout.threadWidth);
    expect(tester.getSize(right).width, 310);
  });

  testWidgets('a thread dragged to its 280px minimum keeps 280 after a '
      'restart, and the roster keeps its own', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final store = MemoryStore();
    const thread = SuperTabPaneLayout.threadWidth;
    await mount(tester, store, rightDefault: thread);
    expect(tester.getSize(right).width, 340);
    await tester.drag(rightHandle, const Offset(1000, 0));
    await tester.pumpAndSettle();
    expect(tester.getSize(right).width, closeTo(280, 1));
    final saved = jsonDecode(store.values[SuperTabPaneLayout.storageKey]!);
    expect(saved['right'], closeTo(280, 1));
    expect(saved['rightChosen'], isTrue);

    // A restart: the layout is built afresh from what was saved.
    await tester.pumpWidget(const SizedBox());
    await mount(tester, store, rightDefault: thread);
    expect(tester.getSize(right).width, closeTo(280, 1));
    await tester.pumpWidget(const SizedBox());
    await mount(tester, store);
    expect(tester.getSize(right).width, closeTo(280, 1));

    // Moving the left divider afterwards keeps the choice.
    await tester.drag(leftHandle, const Offset(40, 0));
    await tester.pumpAndSettle();
    final again = jsonDecode(store.values[SuperTabPaneLayout.storageKey]!);
    expect(again['rightChosen'], isTrue);
    await tester.pumpWidget(const SizedBox());
    await mount(tester, store, rightDefault: thread);
    expect(tester.getSize(right).width, closeTo(280, 1));
    expect(tester.takeException(), isNull);
  });

  testWidgets('a saved width marked as chosen is kept exactly; an old one '
      'without the mark keeps today\'s reading', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    const thread = SuperTabPaneLayout.threadWidth;
    for (final (saved, expected) in [
      ('{"left":400,"right":280,"rightChosen":true}', 280.0),
      ('{"left":400,"right":310,"rightChosen":true}', 310.0),
      ('{"left":400,"right":280}', 340.0),
      ('{"left":400,"right":310}', 310.0),
      ('{"left":400,"right":280,"rightChosen":"yes"}', 340.0),
    ]) {
      final store = MemoryStore()
        ..values[SuperTabPaneLayout.storageKey] = saved;
      await tester.pumpWidget(const SizedBox());
      await mount(tester, store, rightDefault: thread);
      expect(tester.getSize(right).width, expected, reason: saved);
      expect(tester.getSize(left).width, 400, reason: saved);
    }
  });
}
