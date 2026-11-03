import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_COMPOSER_CHIPS_SHOTS'];

/// Scholes, 11-03: the chips beside the message (New session, attach, send)
/// stay at the bottom-right of the box as the message grows, level with its
/// last line, rather than drifting to the middle of a tall box; one line
/// reads as before. The thread reply box keeps its chips on their own row
/// under the text.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  const fiveLines =
      'Five things for today:\nmeasure prod CPU\ncheck the '
      'release notes\nanswer Diego\nand plan the next batch';

  /// The reader's own Buddy chat with its Buddy running: the main chat offers
  /// New session beside attach and send.
  ConversationServer buddyChat() {
    final server = ConversationServer()..threads = true;
    server.state['threadSessions'] = true;
    server.state['sessionsFromChat'] = true;
    final chat = (server.state['conversations'] as List)[1] as Map;
    chat
      ..['kind'] = 'buddy'
      ..['buddyOwnerId'] = 'owner'
      ..['title'] = 'Wren'
      ..['agentIds'] = ['buddy-main'];
    (server.state['agents'] as List).add({
      'id': 'buddy-main',
      'name': 'Wren',
      'displayName': 'Wren',
      'machineId': 'mac',
      'harnessId': 'h-main',
      'contributorId': 'owner',
      'buddyOf': {'personId': 'owner', 'generation': 'g1'},
      'configuration': {'engine': 'claude'},
    });
    server.append(
      'Measure prod CPU for the last day',
      conversationId: 'offline',
    );
    server.append('On it', conversationId: 'offline');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1';
    return server;
  }

  final picture = GlobalKey();

  Future<SuperTabController> show(
    WidgetTester tester, {
    Brightness brightness = Brightness.light,
    bool thread = false,
  }) async {
    final c = buddyChat().controller();
    addTearDown(c.dispose);
    await c.refresh();
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
    await tester.binding.setSurfaceSize(const Size(1280, 720));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (context, child) =>
            RepaintBoundary(key: picture, child: child),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
          ),
        ),
      ),
    );
    await c.select('offline');
    await tester.pumpAndSettle();
    if (thread) {
      c.openThread('message-1');
      await tester.pumpAndSettle();
    }
    return c;
  }

  Finder field({required bool thread}) => find.byKey(
    ValueKey(thread ? 'super-thread-composer' : 'super-message-composer'),
  );

  /// The global rect of the last line of [text] in the field: where the caret
  /// sits at its end.
  Rect lastLine(WidgetTester tester, Finder box) {
    final state = tester.state<EditableTextState>(
      find.descendant(of: box, matching: find.byType(EditableText)),
    );
    final editable = state.renderEditable;
    final caret = editable.getLocalRectForCaret(
      TextPosition(offset: state.textEditingValue.text.length),
    );
    return MatrixUtils.transformRect(editable.getTransformTo(null), caret);
  }

  Future<void> type(WidgetTester tester, Finder box, String text) async {
    await tester.enterText(box, text);
    await tester.pumpAndSettle();
  }

  group('the main chat', () {
    final chips = [
      find.byKey(const ValueKey('super-chat-new-session')),
      find.byKey(const ValueKey('new-harness-attach')),
      find.byTooltip('Send message'),
    ];
    final surface = find.byKey(
      const ValueKey('super-message-composer-surface'),
    );

    testWidgets('one line: the chips are centered on the line, as before', (
      tester,
    ) async {
      await show(tester);
      final box = field(thread: false);
      await type(tester, box, 'Check the release notes.');
      final line = lastLine(tester, box);
      for (final chip in chips) {
        expect(
          (tester.getCenter(chip).dy - line.center.dy).abs(),
          lessThan(1),
          reason: '$chip',
        );
      }
      // The box is as tall as before: one control row inside its padding.
      expect(
        tester.getRect(surface).height,
        closeTo(grid.AppControl.heightFieldScaled + 16, 1),
      );
    });

    testWidgets('five lines: the chips stay at the bottom-right, level with '
        'the last line', (tester) async {
      await show(tester);
      final box = field(thread: false);
      await type(tester, box, fiveLines);
      final line = lastLine(tester, box);
      final first = tester.getRect(box).top;
      expect(line.top - first, greaterThan(line.height * 3.5));
      for (final chip in chips) {
        final rect = tester.getRect(chip);
        expect(
          (rect.center.dy - line.center.dy).abs(),
          lessThan(1),
          reason: '$chip',
        );
        expect(rect.bottom, lessThanOrEqualTo(tester.getRect(surface).bottom));
      }
      // Send at the right end, and the text keeps its width.
      expect(
        tester.getRect(chips.last).right,
        greaterThan(tester.getRect(surface).right - 16),
      );
      expect(
        tester.getRect(box).right,
        lessThanOrEqualTo(tester.getRect(chips.first).left),
      );
    });
  });

  testWidgets('the thread reply box: its chips stay on their own row under the '
      'last line, at the right', (tester) async {
    await show(tester, thread: true);
    final box = field(thread: true);
    await type(tester, box, fiveLines);
    final line = lastLine(tester, box);
    final surface = tester.getRect(
      find.byKey(const ValueKey('super-thread-composer-surface')),
    );
    final send = tester.getRect(
      find.byKey(const ValueKey('super-thread-send')),
    );
    expect(send.top, greaterThanOrEqualTo(line.bottom));
    expect(send.right, greaterThan(surface.right - 16));
    expect(send.bottom, lessThanOrEqualTo(surface.bottom));
  });

  for (final brightness in Brightness.values) {
    for (final scene in ['chat-1', 'chat-5', 'thread-1', 'thread-5']) {
      testWidgets('screenshots for review ($scene, ${brightness.name})', (
        tester,
      ) async {
        final thread = scene.startsWith('thread');
        await show(tester, brightness: brightness, thread: thread);
        await type(
          tester,
          field(thread: thread),
          scene.endsWith('5') ? fiveLines : 'Check the release notes.',
        );
        await tester.runAsync(() async {
          final boundary =
              picture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 2);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File('$shots/composer-chips-$scene-${brightness.name}.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
        await tester.pumpWidget(const SizedBox());
      }, skip: shots == null);
    }
  }
}
