import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/terminal/terminal_search.dart';
import 'package:harness/widgets/terminal_composer.dart';
import 'package:harness/widgets/terminal_find_bar.dart';
import 'package:xterm/xterm.dart';

import 'swarm_interactions_test.dart' show chord;
import 'keymap_runtime_test.dart' show native;
import 'keymap_host_test.dart' show key;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

Finder get findField => find.byWidgetPredicate(
  (widget) =>
      widget is TextField && widget.decoration?.hintText == 'Find in terminal…',
);

Future<void> finishFind(WidgetTester tester) async {
  for (var frame = 0; frame < 200; frame++) {
    await tester.pump(const Duration(milliseconds: 1));
    if (!tester
        .widget<TerminalFindBar>(find.byType(TerminalFindBar))
        .search!
        .searching) {
      return;
    }
  }
  fail('Find did not settle');
}

TerminalViewState terminalView(WidgetTester tester, TerminalSession session) =>
    tester.state<TerminalViewState>(
      find.byWidgetPredicate(
        (widget) =>
            widget is TerminalView && widget.terminal == session.terminal,
      ),
    );

Future<void> output(
  TerminalSession session,
  int sequence,
  String text, {
  bool keyframe = false,
}) => session.handleBinary(
  TerminalBinaryFrame(
    kind: keyframe ? TerminalBinaryKind.keyframe : TerminalBinaryKind.output,
    streamId: session.streamId!,
    seq: sequence,
    compressed: false,
    bytes: utf8.encode(text),
    cols: keyframe ? 80 : null,
    rows: keyframe ? 24 : null,
  ),
);

void main() {
  testWidgets('Find edits Unicode with readline keys without sending input', (
    tester,
  ) async {
    final app = createApp();
    final input = <TerminalBinaryFrame>[];
    final session = terminal('a0', input);
    await output(session, 0, 'run 🐙\r\nrun report\r\n', keyframe: true);
    app.adoptSessionForTest(session);
    addTearDown(app.dispose);
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyF);
    await tester.enterText(findField, 'run 🐙');
    await finishFind(tester);
    final controller = tester.widget<TextField>(findField).controller!;
    final search = tester
        .widget<TerminalFindBar>(find.byType(TerminalFindBar))
        .search!;
    expect(search.count, 1);
    await key(tester, LogicalKeyboardKey.keyH, ctrl: true);
    await finishFind(tester);
    expect(controller.text, 'run ');
    expect(search.count, 2);
    await key(tester, LogicalKeyboardKey.keyU, ctrl: true);
    await finishFind(tester);
    expect(controller.text, isEmpty);
    await key(tester, LogicalKeyboardKey.keyY, ctrl: true);
    await finishFind(tester);
    expect(controller.text, 'run ');
    expect(search.count, 2);
    expect(input, isEmpty);
    await key(tester, LogicalKeyboardKey.escape);
    await key(tester, LogicalKeyboardKey.arrowLeft);
    await tester.pump(const Duration(milliseconds: 10));
    expect(input.single.bytes, [27, 91, 68]);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('compact Find options own keys and return to the query', (
    tester,
  ) async {
    final app = createApp();
    final input = <TerminalBinaryFrame>[];
    final session = terminal('a0', input);
    await output(session, 0, 'Marker\r\nmarker\r\n', keyframe: true);
    app.adoptSessionForTest(session);
    addTearDown(app.dispose);
    await mount(tester, app);
    tester.view.physicalSize = const Size(600, 800);
    tester.platformDispatcher.textScaleFactorTestValue = 1.7;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pump();
    await chord(tester, LogicalKeyboardKey.keyF);
    await tester.enterText(findField, 'marker');
    await finishFind(tester);
    final search = tester
        .widget<TerminalFindBar>(find.byType(TerminalFindBar))
        .search!;
    expect(search.count, 2);
    // Tab reaches the compact actions. Enter opens them and chooses their
    // first item, rather than stepping a match or sending input underneath.
    await key(tester, LogicalKeyboardKey.tab);
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pump();
    expect(find.text('Match case'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.enter);
    await finishFind(tester);
    expect(search.caseSensitive, isTrue);
    expect(search.count, 1);
    expect(tester.widget<TextField>(findField).focusNode!.hasFocus, isTrue);
    await tester.tap(find.byTooltip('Find options'));
    await tester.pump();
    await key(tester, LogicalKeyboardKey.escape);
    expect(find.text('Match case'), findsNothing);
    expect(findField, findsOneWidget);
    await key(tester, LogicalKeyboardKey.escape);
    expect(findField, findsNothing);
    expect(input, isEmpty);
    expect(tester.takeException(), isNull);
    await chord(tester, LogicalKeyboardKey.keyF);
    await tester.tap(find.byTooltip('Find options'));
    await tester.pump();
    expect(find.text('Match case'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
    expect(find.text('Match case'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  for (final nativeEntry in [false, true]) {
    testWidgets(
      'opening Find owns input before its first frame (native=$nativeEntry)',
      (tester) async {
        final app = createApp();
        app.machineStates['m']!.nodeOnline = true;
        final input = <TerminalBinaryFrame>[];
        final session = terminal('a0', input);
        await output(session, 0, 'first marker\r\n', keyframe: true);
        app.adoptSessionForTest(session);
        try {
          await mount(tester, app, nativeTabs: nativeEntry);
          if (nativeEntry) {
            await native(tester, 'findTerminal');
          } else {
            await tester.sendKeyDownEvent(LogicalKeyboardKey.meta);
            await tester.sendKeyEvent(LogicalKeyboardKey.keyF);
            await tester.sendKeyUpEvent(LogicalKeyboardKey.meta);
          }
          await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
          tester.testTextInput.enterText('marker');
          await tester.pump();
          await finishFind(tester);
          expect(input, isEmpty);
          expect(
            tester.widget<TextField>(findField).controller!.text,
            'marker',
          );
          expect(
            tester.widget<TextField>(findField).focusNode!.hasFocus,
            isTrue,
          );
          expect(
            tester
                .widget<TerminalFindBar>(find.byType(TerminalFindBar))
                .search!
                .count,
            1,
          );
        } finally {
          await tester.pumpWidget(const SizedBox());
          app.dispose();
        }
      },
    );
  }

  testWidgets('Find can close before its first frame without sending Escape', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    final input = <TerminalBinaryFrame>[];
    final session = terminal('a0', input);
    await output(session, 0, 'first marker\r\n', keyframe: true);
    app.adoptSessionForTest(session);
    try {
      await mount(tester, app);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.meta);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyF);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.meta);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(input, isEmpty);
      expect(findField, findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 10));
      expect(input.single.bytes, [27, 91, 68]);
    } finally {
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    }
  });

  testWidgets('Find preserves composition started before its first frame', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    final input = <TerminalBinaryFrame>[];
    final session = terminal('a0', input);
    await output(session, 0, '日本語\r\n', keyframe: true);
    app.adoptSessionForTest(session);
    try {
      await mount(tester, app);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.meta);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyF);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.meta);
      const editing = TextEditingValue(
        text: '日本',
        selection: TextSelection.collapsed(offset: 2),
        composing: TextRange(start: 0, end: 2),
      );
      tester.testTextInput.updateEditingValue(editing);
      expect(await tester.sendKeyEvent(LogicalKeyboardKey.escape), isFalse);
      await tester.pump();
      await finishFind(tester);
      expect(input, isEmpty);
      expect(tester.widget<TextField>(findField).controller!.value, editing);
      expect(tester.widget<TextField>(findField).focusNode!.hasFocus, isTrue);
    } finally {
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    }
  });

  testWidgets('only the focused pane prepares an idle Find editor', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    final sessions = <TerminalSession>[];
    final input = <TerminalBinaryFrame>[];
    for (var workspace = 0; workspace < 4; workspace++) {
      if (workspace > 0) app.newSwarm();
      for (var pane = 0; pane < 4; pane++) {
        final session = terminal('a${workspace * 4 + pane}', input);
        await output(session, 0, 'first marker\r\n', keyframe: true);
        sessions.add(session);
        app.adoptSessionForTest(session);
      }
    }
    final previousObserver = debugOnRebuildDirtyWidget;
    try {
      await mount(tester, app);
      for (final workspace in app.swarms) {
        app.selectSwarm(workspace.id);
        await tester.pump();
      }
      await tester.pump();
      expect(find.byType(TerminalView, skipOffstage: false), findsNWidgets(16));
      final bars = find.byType(TerminalFindBar, skipOffstage: false);
      expect(bars, findsOneWidget);
      expect(tester.widget<TerminalFindBar>(bars).search, isNull);
      final editor = find.descendant(
        of: bars,
        matching: find.byType(TextField, skipOffstage: false),
        skipOffstage: false,
      );
      expect(
        tester.widget<TextField>(editor).focusNode!.canRequestFocus,
        isFalse,
      );
      final focus = FocusManager.instance.primaryFocus;
      var builds = 0;
      debugOnRebuildDirtyWidget = (element, _) {
        if (element.widget is TextField || element.widget is TerminalFindBar) {
          builds++;
        }
      };
      for (final session in sessions) {
        await output(session, 1, 'later marker\r\n');
        await tester.pump();
      }
      debugOnRebuildDirtyWidget = previousObserver;
      expect(builds, 0);
      expect(FocusManager.instance.primaryFocus, same(focus));
      expect(input, isEmpty);
      expect(tester.widget<TerminalFindBar>(bars).search, isNull);
      app.focusPane(app.panes.first.id);
      await tester.pump();
      await tester.pump();
      expect(bars, findsOneWidget);
      expect(tester.widget<TerminalFindBar>(bars).search, isNull);
    } finally {
      debugOnRebuildDirtyWidget = previousObserver;
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    }
  });

  for (final closeWithEscape in [true, false]) {
    testWidgets(
      'closing Find returns the next key before a frame (Escape=$closeWithEscape)',
      (tester) async {
        final app = createApp();
        app.machineStates['m']!.nodeOnline = true;
        final input = <TerminalBinaryFrame>[];
        final session = terminal('a0', input);
        await output(session, 0, 'first marker\r\n', keyframe: true);
        app.adoptSessionForTest(session);
        try {
          await mount(tester, app);
          await chord(tester, LogicalKeyboardKey.keyF);
          await tester.enterText(findField, 'marker');
          await finishFind(tester);
          final view = terminalView(tester, session);
          final renderer = view.renderTerminal;
          if (closeWithEscape) {
            await tester.sendKeyEvent(LogicalKeyboardKey.escape);
          } else {
            await tester.tap(find.byTooltip('Close find (Esc)'));
          }
          // Two input events can arrive before the next frame. Search should
          // have relinquished both hardware keys and the native text client.
          await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
          tester.testTextInput.enterText('resume');
          await tester.pump(const Duration(milliseconds: 10));
          expect(findField, findsNothing);
          expect(view.renderTerminal, same(renderer));
          expect(input.expand((frame) => frame.bytes).toList(), [
            27,
            91,
            68,
            ...utf8.encode('resume'),
          ]);
          await chord(tester, LogicalKeyboardKey.keyF);
          expect(
            tester.widget<TextField>(findField).controller!.text,
            'marker',
          );
        } finally {
          await tester.pumpWidget(const SizedBox());
          app.dispose();
        }
      },
    );
  }

  testWidgets('closing Find returns rapid typing to the visible composer', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    final input = <TerminalBinaryFrame>[];
    final session = terminal('a0', input);
    await output(session, 0, 'first marker\r\n', keyframe: true);
    app.adoptSessionForTest(session);
    app.toggleComposer(app.focusedPaneId!);
    final composer = find.descendant(
      of: find.byType(TerminalComposer),
      matching: find.byType(TextField),
    );
    try {
      await mount(tester, app);
      await tester.enterText(composer, 'draft');
      final controller = tester.widget<TextField>(composer).controller!;
      await chord(tester, LogicalKeyboardKey.keyF);
      await tester.enterText(findField, 'marker');
      await finishFind(tester);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      expect(controller.selection, const TextSelection.collapsed(offset: 4));
      tester.testTextInput.enterText('draft continued');
      await tester.pump(const Duration(milliseconds: 10));
      expect(findField, findsNothing);
      expect(controller.text, 'draft continued');
      expect(tester.widget<TextField>(composer).focusNode!.hasFocus, isTrue);
      expect(input, isEmpty, reason: 'the composer sends only on submission');
      await chord(tester, LogicalKeyboardKey.keyF);
      expect(tester.widget<TextField>(findField).controller!.text, 'marker');
    } finally {
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    }
  });

  testWidgets(
    'live output refreshes matches without rebuilding the Find editor',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      await output(
        session,
        0,
        'first marker\r\nsecond marker\r\n',
        keyframe: true,
      );
      app.adoptSessionForTest(session);
      final previousObserver = debugOnRebuildDirtyWidget;
      try {
        await mount(tester, app);
        await chord(tester, LogicalKeyboardKey.keyF);
        await tester.enterText(findField, 'marker');
        await finishFind(tester);
        final field = tester.widget<TextField>(findField);
        final search = tester
            .widget<TerminalFindBar>(find.byType(TerminalFindBar))
            .search!;
        final selected = search.match;
        final view = terminalView(tester, session);
        final renderer = view.renderTerminal;
        field.controller!.value = field.controller!.value.copyWith(
          selection: const TextSelection.collapsed(offset: 3),
          composing: const TextRange(start: 0, end: 6),
        );
        await tester.pump();
        final editing = field.controller!.value;
        var editorBuilds = 0;
        debugOnRebuildDirtyWidget = (element, _) {
          if (element.widget is TextField &&
              (element.widget as TextField).controller == field.controller) {
            editorBuilds++;
          }
        };
        for (var sequence = 1; sequence <= 10; sequence++) {
          await output(session, sequence, 'next marker $sequence\r\n');
          await finishFind(tester);
        }
        debugOnRebuildDirtyWidget = previousObserver;
        debugPrint('FIND_OUTPUT: editorBuilds=$editorBuilds');
        expect(search.count, 12);
        expect(search.match, selected);
        expect(view.renderTerminal, same(renderer));
        expect(field.controller!.value, editing);
        expect(field.focusNode!.hasFocus, isTrue);
        expect(input, isEmpty);
        expect(editorBuilds, 0);
      } finally {
        debugOnRebuildDirtyWidget = previousObserver;
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  for (final key in [
    LogicalKeyboardKey.enter,
    LogicalKeyboardKey.numpadEnter,
    LogicalKeyboardKey.escape,
  ]) {
    testWidgets('Find leaves ${key.keyLabel} to active text composition', (
      tester,
    ) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      await output(session, 0, '日本語 one\r\n日本語 two\r\n', keyframe: true);
      app.adoptSessionForTest(session);
      try {
        await mount(tester, app);
        await chord(tester, LogicalKeyboardKey.keyF);
        await tester.enterText(findField, '日本語');
        await finishFind(tester);
        final search = tester
            .widget<TerminalFindBar>(find.byType(TerminalFindBar))
            .search!;
        final controller = tester.widget<TextField>(findField).controller!;
        final selected = search.selected;
        controller.value = controller.value.copyWith(
          composing: const TextRange(start: 0, end: 3),
        );
        await tester.pump();
        final handled = await tester.sendKeyEvent(key);
        await tester.pump();
        expect(findField, findsOneWidget);
        expect(search.selected, selected);
        expect(
          handled,
          isFalse,
          reason: 'the input method still owns this key',
        );
        expect(controller.text, '日本語');
        expect(tester.widget<TextField>(findField).focusNode!.hasFocus, isTrue);
        expect(input, isEmpty);

        controller.clearComposing();
        await tester.sendKeyEvent(key);
        await tester.pump();
        if (key == LogicalKeyboardKey.escape) {
          expect(findField, findsNothing);
          await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
          await tester.pump(const Duration(milliseconds: 5));
          expect(input.single.bytes, [27, 91, 68]);
        } else {
          expect(search.selected, (selected + 1) % search.count);
          await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
          await tester.sendKeyEvent(key);
          await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
          await tester.pump();
          expect(search.selected, selected);
          expect(input, isEmpty);
        }
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    });
  }

  testWidgets(
    'a narrow find bar supports large text and a large result count',
    (tester) async {
      final terminal = Terminal()..resize(80, 4);
      terminal.write('needle\r\n' * 9998);
      final search = TerminalSearch(terminal);
      await tester.runAsync(() async {
        search.setQuery('needle');
        await search.settled;
      });
      final semantics = tester.ensureSemantics();
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(2)),
            child: child!,
          ),
          home: Scaffold(
            body: Center(
              child: SizedBox(
                width: 260,
                height: 38,
                child: TerminalFindBar(
                  search: search,
                  readOnly: true,
                  onQuery: (query, sensitive) =>
                      search.setQuery(query, caseSensitive: sensitive),
                  onStep: search.step,
                  onClose: () {},
                  onFocus: () {},
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(tester.getSize(findField).height, lessThanOrEqualTo(38));
      expect(tester.getSize(findField).width, greaterThan(24));
      expect(
        find.bySemanticsLabel(
          'Match ${search.selected + 1} of ${search.count}',
        ),
        findsOneWidget,
      );
      await tester.tap(find.byTooltip('Find options'));
      await tester.pump();
      await tester.tap(find.text('Match case'));
      await tester.pump();
      expect(tester.widget<TextField>(findField).focusNode!.hasFocus, isTrue);
      await tester.pumpWidget(const SizedBox());
      search.dispose();
      semantics.dispose();
    },
  );

  testWidgets(
    'find opens in one frame without resizing, preserves selection and returns to prior scroll',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      session.terminal.write(
        List.generate(
          180,
          (i) => 'Line $i${i % 50 == 0 ? ' needle' : ''}\r\n',
        ).join(),
      );
      app.adoptSessionForTest(session);
      await mount(tester, app);
      final view = terminalView(tester, session);
      final renderer = view.renderTerminal;
      final size = renderer.size;
      final dimensions = (
        session.terminal.viewWidth,
        session.terminal.viewHeight,
      );
      final scroll = view.widget.scrollController!;
      scroll.jumpTo(renderer.lineHeight * 20.5);
      final previousScroll = scroll.offset;
      final controller = view.widget.controller!;
      controller.setSelection(
        session.terminal.buffer.createAnchor(0, 5),
        session.terminal.buffer.createAnchor(4, 5),
      );
      final previousSelection = controller.selection;
      await tester.pump();
      await tester.sendKeyDownEvent(LogicalKeyboardKey.meta);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyF);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.meta);
      await tester.pump();
      expect(findField, findsOneWidget);
      expect(tester.widget<TextField>(findField).focusNode!.hasFocus, isTrue);
      expect(view.renderTerminal, same(renderer));
      expect(renderer.size, size);
      expect((
        session.terminal.viewWidth,
        session.terminal.viewHeight,
      ), dimensions);
      await tester.enterText(findField, 'needle');
      await finishFind(tester);
      final search = tester
          .widget<TerminalFindBar>(find.byType(TerminalFindBar))
          .search!;
      expect(search.count, 4);
      expect(search.selected, 1);
      expect(controller.highlights, hasLength(1));
      expect(
        session.terminal.buffer.getText(controller.highlights.single.range),
        'needle',
      );
      expect(controller.selection, previousSelection);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(search.selected, 2);
      await chord(tester, LogicalKeyboardKey.keyG);
      expect(search.selected, 3);
      await chord(tester, LogicalKeyboardKey.keyG, shift: true);
      expect(search.selected, 2);
      expect(input, isEmpty);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(findField, findsNothing);
      expect(controller.highlights, isEmpty);
      expect(controller.selection, previousSelection);
      expect(scroll.offset, closeTo(previousScroll, 0.01));
      expect(renderer.size, size);
      await chord(tester, LogicalKeyboardKey.keyG);
      await finishFind(tester);
      expect(
        tester
            .widget<TerminalFindBar>(find.byType(TerminalFindBar))
            .search!
            .selected,
        3,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(scroll.offset, closeTo(previousScroll, 0.01));
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 10));
      expect(input.single.bytes, [27, 91, 68]);
      for (final key in [LogicalKeyboardKey.keyF, LogicalKeyboardKey.keyG]) {
        await tester.sendKeyDownEvent(LogicalKeyboardKey.control);
        await tester.sendKeyEvent(key);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.control);
        await tester.pump(const Duration(milliseconds: 10));
      }
      expect(input.skip(1).map((frame) => frame.bytes.single), [6, 7]);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'hidden find does no indexing and returns to the same query with current output',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final a = terminal('a0', []);
      final b = terminal('a1', []);
      await output(a, 0, 'first marker\r\n', keyframe: true);
      app.adoptSessionForTest(a);
      final first = app.activeSwarm;
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyF);
      await tester.enterText(findField, 'marker');
      await finishFind(tester);
      final search = tester
          .widget<TerminalFindBar>(find.byType(TerminalFindBar))
          .search!;
      expect(search.count, 1);
      app.newSwarm();
      app.adoptSessionForTest(b);
      await tester.pump();
      await tester.pump();
      expect(search.count, 0);
      expect(findField, findsNothing);
      await output(a, 1, 'second marker\r\n');
      expect(tester.binding.hasScheduledFrame, isFalse);
      app.selectSwarm(first.id, attachPending: false);
      await tester.pump();
      await finishFind(tester);
      expect(search.count, 2);
      expect(tester.widget<TextField>(findField).controller!.text, 'marker');
      expect(tester.widget<TextField>(findField).focusNode!.hasFocus, isTrue);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'a real keyframe replaces the emulator without sending find text to the agent',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      await output(session, 0, 'old marker\r\n', keyframe: true);
      app.adoptSessionForTest(session);
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyF);
      await tester.enterText(findField, 'marker');
      await finishFind(tester);
      final old = session.terminal;
      final text = tester.widget<TextField>(findField).controller!;
      text.value = text.value.copyWith(
        selection: const TextSelection.collapsed(offset: 3),
        composing: const TextRange(start: 0, end: 6),
      );
      await tester.pump();
      final editing = text.value;
      await output(
        session,
        10,
        'new marker\r\nsecond marker\r\n',
        keyframe: true,
      );
      await tester.pump();
      await finishFind(tester);
      expect(session.terminal, isNot(same(old)));
      expect(tester.widget<TextField>(findField).controller, same(text));
      expect(text.value, editing);
      expect(tester.widget<TextField>(findField).focusNode!.hasFocus, isTrue);
      expect(
        tester
            .widget<TerminalFindBar>(find.byType(TerminalFindBar))
            .search!
            .count,
        2,
      );
      await tester.enterText(findField, 'new');
      await finishFind(tester);
      expect(
        tester
            .widget<TerminalFindBar>(find.byType(TerminalFindBar))
            .search!
            .count,
        1,
      );
      expect(input, isEmpty);
      old.buffer.lines.forEach((line) => expect(line.anchors, isEmpty));
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets('taken-over terminals can be searched without retry or input', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    final input = <TerminalBinaryFrame>[];
    final session = terminal('a0', input);
    session.terminal.write('Retained Error\r\n');
    app.adoptSessionForTest(session);
    session.status = TerminalSessionStatus.takenOver;
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyF);
    expect(find.text('TERMINAL FROZEN'), findsNothing);
    expect(find.byTooltip('This terminal is read only'), findsOneWidget);
    await tester.enterText(findField, 'error');
    await finishFind(tester);
    final search = tester
        .widget<TerminalFindBar>(find.byType(TerminalFindBar))
        .search!;
    expect(search.count, 1);
    await tester.tap(find.byTooltip('Match case'));
    await finishFind(tester);
    expect(search.count, 0);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(session.status, TerminalSessionStatus.takenOver);
    expect(find.text('TERMINAL FROZEN'), findsNothing);
    expect(find.text('Take control'), findsOneWidget);
    expect(input, isEmpty);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
}
