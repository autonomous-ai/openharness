import 'dart:async';
import 'dart:convert';

import 'package:desktop_drop/desktop_drop.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';

import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

final _png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
);

class _HeldImage extends DropItemFile {
  _HeldImage() : super.fromData(_png, name: 'fixture.png');
  final reading = Completer<void>();
  final release = Completer<Uint8List>();

  @override
  Stream<Uint8List> openRead([int? start, int? end]) {
    if (!reading.isCompleted) reading.complete();
    return Stream.fromFuture(release.future);
  }
}

void drop(DropTarget target, DropItem file) {
  target.onDragDone!(
    DropDoneDetails(
      files: [file],
      localPosition: const Offset(20, 20),
      globalPosition: const Offset(20, 20),
    ),
  );
}

void main() {
  const clipboard = MethodChannel('harness/clipboard_image');

  testWidgets('one image drop reaches only the visible pane across tabs', (
    tester,
  ) async {
    var writes = 0;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(clipboard, (
      _,
    ) async {
      writes++;
      return true;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        clipboard,
        null,
      ),
    );
    final app = createApp(connected: true);
    app.machineStates['m']!.localOnly = true;
    final firstInput = <TerminalBinaryFrame>[];
    final secondInput = <TerminalBinaryFrame>[];
    final first = app.adoptSessionForTest(terminal('a0', firstInput));
    await mount(tester, app);
    app.newSwarm(name: 'Second');
    final second = app.adoptSessionForTest(terminal('a1', secondInput));
    await tester.pump(const Duration(milliseconds: 100));
    final targets = tester
        .widgetList<DropTarget>(find.byType(DropTarget, skipOffstage: false))
        .toList();
    expect(targets, hasLength(2));
    expect(targets.where((target) => target.enable), hasLength(1));
    // Also exercise a callback queued before its tab became hidden.
    for (final target in targets) {
      drop(target, DropItemFile.fromData(_png, name: 'fixture.png'));
    }
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    expect(writes, 1);
    expect(firstInput, isEmpty);
    expect(secondInput, hasLength(1));
    expect(app.focusedPane, same(second));
    app.selectSwarm(app.swarms.first.id);
    await tester.pump();
    expect(
      tester
          .widget<DropTarget>(
            find.byKey(ValueKey('pane-file-drop-${first.id}')),
          )
          .enable,
      isTrue,
    );
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  for (final change in ['tab', 'stream', 'readonly']) {
    testWidgets('an image still being read cannot cross a $change change', (
      tester,
    ) async {
      var writes = 0;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        clipboard,
        (_) async {
          writes++;
          return true;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          clipboard,
          null,
        ),
      );
      final app = createApp(connected: true);
      app.machineStates['m']!.localOnly = true;
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      final pane = app.adoptSessionForTest(session);
      await mount(tester, app);
      final target = tester.widget<DropTarget>(
        find.byKey(ValueKey('pane-file-drop-${pane.id}')),
      );
      final file = _HeldImage();
      drop(target, file);
      await tester.pump();
      expect(file.reading.isCompleted, isTrue);
      switch (change) {
        case 'tab':
          app.newSwarm(name: 'Different work');
        case 'stream':
          session.streamId = 'replacement';
        case 'readonly':
          session.watching = true;
      }
      await tester.pump();
      file.release.complete(_png);
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 100));
      expect(writes, 0);
      expect(input, isEmpty);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
  }

  testWidgets('zoomed-out panes do not register drop handlers', (tester) async {
    final app = createApp(connected: true);
    app.adoptSessionForTest(terminal('a0', []));
    app.adoptSessionForTest(terminal('a1', []));
    app.toggleZoomPane();
    await mount(tester, app);
    expect(
      tester
          .widgetList<DropTarget>(find.byType(DropTarget, skipOffstage: false))
          .where((target) => target.enable),
      hasLength(1),
    );
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
}
