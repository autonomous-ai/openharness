import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/fake_voice_recorder.dart';
import 'support/super_tab_fixture.dart';

/// Huy and Scholes, 11-04: the Desktop and web composer is the phone's. One
/// rounded box, the text on top and one row under it: the paperclip (attach,
/// anh Dee 11-07, #4467, where + was), the mic and send; an @ typed tags (River, 11-07: no @ button on Desktop). Also send is a small checkbox under a
/// thread's box. The mic shows only with a recorder (River, 11-04: recording
/// is its own task), so nobody sees a button that does nothing.
void main() {
  const fiveLines =
      'Five things for today:\nmeasure prod CPU\ncheck the '
      'release notes\nanswer Diego\nand plan the next batch';

  /// The reader's Buddy chat with its Buddy running, a chat they write in;
  /// Dee reads the Swarm, so @ has someone to offer.
  ConversationServer server() {
    final server = ConversationServer()..threads = true;
    (server.state['people'] as List).add({
      'id': 'dee',
      'email': 'dee@example.com',
      'role': 'collaborator',
    });
    final chat = (server.state['conversations'] as List)[1] as Map;
    chat
      ..['kind'] = 'agent-chat'
      ..['title'] = 'Wren'
      ..['agentIds'] = ['buddy-main'];
    (server.state['agents'] as List).add({
      'id': 'buddy-main',
      'name': 'Wren',
      'displayName': 'Wren',
      'machineId': 'mac',
      'harnessId': 'h-main',
      'contributorId': 'owner',
      'configuration': {'engine': 'claude'},
    });
    server.append('The build fails on the second run.');
    server.append('Which machine was it on?');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1';
    server.append('Measure prod CPU', conversationId: 'offline');
    server.append('On it', conversationId: 'offline');
    server.messages.last
      ..['thread'] = 'message-3'
      ..['replyTo'] = 'message-3';
    return server;
  }

  Future<SuperTabController> show(
    WidgetTester tester, {
    String chat = 'offline',
    String? thread,
    FakeVoiceRecorder? recorder,
  }) async {
    final c = server().controller();
    addTearDown(c.dispose);
    await c.refresh();
    await tester.binding.setSurfaceSize(const Size(1280, 720));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            voiceRecorder: recorder == null ? null : () => recorder,
          ),
        ),
      ),
    );
    await c.select(chat);
    await tester.pumpAndSettle();
    if (thread != null) {
      c.openThread(thread);
      await tester.pumpAndSettle();
    }
    return c;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  /// The focused widget's element is [target]'s or one of its descendants'.
  bool focusedIn(WidgetTester tester, Finder target) {
    final focused = FocusManager.instance.primaryFocus?.context;
    if (focused == null) return false;
    final element = tester.element(target);
    if (focused == element) return true;
    var inside = false;
    focused.visitAncestorElements((e) {
      inside = e == element;
      return !inside;
    });
    return inside;
  }

  group('the main chat', () {
    Finder attach() => find.descendant(
      of: key('super-message-composer-surface'),
      matching: key('new-harness-attach'),
    );
    Finder send() => find.byTooltip('Send message');

    testWidgets(
      'holds the paperclip in the pill on the text\'s line, and send beside '
      'the pill (#4529)',
      (tester) async {
        await show(tester);
        await tester.enterText(key('super-message-composer'), 'One line');
        await tester.pumpAndSettle();
        final field = tester.getRect(key('super-message-composer'));
        final surface = tester.getRect(key('super-message-composer-surface'));
        final plus = tester.getRect(attach());
        final arrow = tester.getRect(send());
        expect(plus.right, lessThanOrEqualTo(field.left));
        expect(arrow.left, greaterThanOrEqualTo(surface.right));
        for (final button in [plus, arrow]) {
          expect(button.center.dy, closeTo(field.center.dy, 4));
        }
        expect(
          find.descendant(
            of: attach(),
            matching: find.byIcon(AppIcons.paperclip),
          ),
          findsOneWidget,
        );
        expect(key('super-composer-tag'), findsNothing);
      },
    );

    testWidgets('shows no mic without a recorder, and no Also send', (
      tester,
    ) async {
      await show(tester);
      expect(key('super-composer-mic'), findsNothing);
      expect(key('super-thread-also-send'), findsNothing);
    });

    testWidgets('puts the mic where send goes while there is nothing to '
        'send, and a click starts a take for the chat', (tester) async {
      final recorder = FakeVoiceRecorder();
      await show(tester, recorder: recorder);
      final mic = tester.getRect(key('super-composer-mic'));
      expect(send(), findsNothing);
      expect(
        mic.left,
        greaterThanOrEqualTo(
          tester.getRect(key('super-message-composer-surface')).right,
        ),
      );
      await tester.tap(key('super-composer-mic'));
      await tester.pump();
      expect(recorder.calls, ['allowed', 'start']);
      expect(key('super-voice-row'), findsOneWidget);
      // A take is never dictation: the box stays as it was.
      expect(
        tester
            .widget<TextField>(key('super-message-composer'))
            .controller!
            .text,
        isEmpty,
      );
    });

    testWidgets('Tab goes from the text to send; the paperclip is the stop '
        'before the text', (tester) async {
      await show(tester, recorder: FakeVoiceRecorder());
      await tester.enterText(key('super-message-composer'), 'Ready');
      await tester.pump();
      expect(focusedIn(tester, key('super-message-composer')), isTrue);
      // With text, send stands in the mic's place.
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      expect(focusedIn(tester, send()), isTrue);
      // The paperclip, before the text in the row, is the stop before it.
      await tester.tap(key('super-message-composer'));
      await tester.pump();
      await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
      await tester.pump();
      expect(focusedIn(tester, attach()), isTrue);
      // The draft's save runs out.
      await tester.pump(const Duration(seconds: 1));
    });
  });

  group('a thread', () {
    Finder attach() => find.descendant(
      of: key('super-thread-composer-surface'),
      matching: key('new-harness-attach'),
    );

    testWidgets(
      'holds the paperclip under the text, send at the right end, and Also '
      'send on its own line under the box',
      (tester) async {
        await show(tester, thread: 'message-3');
        await tester.enterText(key('super-thread-composer'), fiveLines);
        await tester.pumpAndSettle();
        final field = tester.getRect(key('super-thread-composer'));
        final surface = tester.getRect(key('super-thread-composer-surface'));
        final plus = tester.getRect(attach());
        final send = tester.getRect(key('super-thread-send'));
        for (final button in [plus, send]) {
          expect(button.top, greaterThanOrEqualTo(field.bottom));
          expect(button.bottom, lessThanOrEqualTo(surface.bottom));
        }
        expect(plus.right, lessThan(send.left));
        expect(
          find.descendant(
            of: attach(),
            matching: find.byIcon(AppIcons.paperclip),
          ),
          findsOneWidget,
        );
        // Also send is under the box, whatever room the row has.
        final also = tester.getRect(key('super-thread-also-send'));
        expect(also.top, greaterThanOrEqualTo(surface.bottom));
        expect(
          find.descendant(
            of: key('super-thread-also-line'),
            matching: key('super-thread-also-send'),
          ),
          findsOneWidget,
        );
        expect(find.text('Also send to the main chat'), findsOneWidget);
        expect(key('super-thread-mic'), findsNothing);
      },
    );

    testWidgets('puts the mic left of send, and a click starts a take for the '
        'thread', (tester) async {
      final recorder = FakeVoiceRecorder();
      await show(tester, thread: 'message-3', recorder: recorder);
      expect(
        tester.getRect(key('super-thread-mic')).right,
        lessThanOrEqualTo(tester.getRect(key('super-thread-send')).left),
      );
      await tester.tap(key('super-thread-mic'));
      await tester.pump();
      expect(recorder.calls, ['allowed', 'start']);
      expect(key('super-thread-voice-row'), findsOneWidget);
    });
  });
}
