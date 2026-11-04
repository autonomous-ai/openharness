import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/voice_recorder.dart';

import 'support/super_tab_fixture.dart';

/// The takes a mic started, as (conversation, thread root).
class _Recorder implements SuperTabVoiceRecorder {
  final takes = <(String, String?)>[];

  @override
  Future<void> start({required String conversationId, String? root}) async =>
      takes.add((conversationId, root));
}

/// Huy and Scholes, 11-04: the Desktop and web composer is the phone's. One
/// rounded box, the text on top and one row under it: + (attach), @ Tag, the
/// New session chip, the mic and send. Also send is a small checkbox under a
/// thread's box. The mic shows only with a recorder (River, 11-04: recording
/// is its own task), so nobody sees a button that does nothing.
void main() {
  const fiveLines =
      'Five things for today:\nmeasure prod CPU\ncheck the '
      'release notes\nanswer Diego\nand plan the next batch';

  /// The reader's Buddy chat with its Buddy running, so the row offers New
  /// session; Dee reads the Swarm, so @ has someone to offer.
  ConversationServer server() {
    final server = ConversationServer()..threads = true;
    server.state['threadSessions'] = true;
    server.state['sessionsFromChat'] = true;
    (server.state['people'] as List).add({
      'id': 'dee',
      'email': 'dee@example.com',
      'role': 'collaborator',
    });
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
    SuperTabVoiceRecorder? recorder,
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
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            voiceRecorder: recorder,
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

    testWidgets('holds +, @ Tag and New session under the text, and send at '
        'the row\'s right end', (tester) async {
      await show(tester);
      for (final text in ['One line', fiveLines]) {
        await tester.enterText(key('super-message-composer'), text);
        await tester.pumpAndSettle();
        final field = tester.getRect(key('super-message-composer'));
        final surface = tester.getRect(key('super-message-composer-surface'));
        final plus = tester.getRect(attach());
        final tag = tester.getRect(key('super-composer-tag'));
        final session = tester.getRect(key('super-chat-new-session'));
        final arrow = tester.getRect(send());
        expect(key('super-message-composer-actions'), findsOneWidget);
        for (final button in [plus, tag, session, arrow]) {
          expect(button.top, greaterThanOrEqualTo(field.bottom), reason: text);
        }
        expect(plus.left, lessThan(tag.left));
        expect(tag.left, lessThan(session.left));
        expect(session.right, lessThan(arrow.left));
        // Send keeps the box's bottom-right corner however long the message
        // (Scholes, 11-03), the box's inset from its edges.
        expect(
          surface.right - arrow.right,
          lessThanOrEqualTo(grid.AppDesktop.groupGap),
        );
        expect(
          surface.bottom - arrow.bottom,
          lessThanOrEqualTo(grid.AppDesktop.groupGap),
        );
      }
      expect(
        find.descendant(of: attach(), matching: find.byIcon(AppIcons.plus)),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: key('super-composer-tag'),
          matching: find.byIcon(AppIcons.atSign),
        ),
        findsOneWidget,
      );
    });

    testWidgets('shows no mic without a recorder, and no Also send', (
      tester,
    ) async {
      await show(tester);
      expect(key('super-composer-mic'), findsNothing);
      expect(key('super-thread-also-send'), findsNothing);
    });

    testWidgets('puts the mic left of send, and a click starts a take for the '
        'chat', (tester) async {
      final recorder = _Recorder();
      await show(tester, recorder: recorder);
      final mic = tester.getRect(key('super-composer-mic'));
      expect(mic.right, lessThanOrEqualTo(tester.getRect(send()).left));
      expect(
        mic.left,
        greaterThan(tester.getRect(key('super-chat-new-session')).right),
      );
      await tester.tap(key('super-composer-mic'));
      await tester.pump();
      expect(recorder.takes, [('offline', null)]);
      // A take is never dictation: the box stays as it was.
      expect(
        tester
            .widget<TextField>(key('super-message-composer'))
            .controller!
            .text,
        isEmpty,
      );
    });

    testWidgets('@ Tag types @ at the caret and opens the tag list', (
      tester,
    ) async {
      await show(tester);
      await tester.enterText(key('super-message-composer'), 'hi');
      await tester.pump();
      await tester.tap(key('super-composer-tag'));
      await tester.pumpAndSettle();
      final field = tester.widget<TextField>(key('super-message-composer'));
      expect(field.controller!.text, 'hi @');
      expect(field.controller!.selection.baseOffset, 4);
      expect(key('super-composer-completions'), findsOneWidget);
      expect(focusedIn(tester, key('super-message-composer')), isTrue);
      // Enter picks from the list, as for an @ typed.
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(field.controller!.text, startsWith('hi @'));
      expect(field.controller!.text.length, greaterThan(4));
    });

    testWidgets('Tab goes from the text to +, @ Tag, New session, the mic and '
        'send, in the row\'s order', (tester) async {
      await show(tester, recorder: _Recorder());
      await tester.enterText(key('super-message-composer'), 'Ready');
      await tester.pump();
      expect(focusedIn(tester, key('super-message-composer')), isTrue);
      for (final next in [
        attach(),
        key('super-composer-tag'),
        key('super-chat-new-session'),
        key('super-composer-mic'),
        send(),
      ]) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
        expect(focusedIn(tester, next), isTrue, reason: '$next');
      }
      // The draft's save runs out.
      await tester.pump(const Duration(seconds: 1));
    });
  });

  group('a thread', () {
    Finder attach() => find.descendant(
      of: key('super-thread-composer-surface'),
      matching: key('new-harness-attach'),
    );

    testWidgets('holds +, @ Tag and New session under the text, send at the '
        'right end, and Also send on its own line under the box', (
      tester,
    ) async {
      await show(tester, thread: 'message-3');
      await tester.enterText(key('super-thread-composer'), fiveLines);
      await tester.pumpAndSettle();
      final field = tester.getRect(key('super-thread-composer'));
      final surface = tester.getRect(key('super-thread-composer-surface'));
      final plus = tester.getRect(attach());
      final tag = tester.getRect(key('super-thread-tag'));
      final session = tester.getRect(key('super-thread-new-session'));
      final send = tester.getRect(key('super-thread-send'));
      for (final button in [plus, tag, session, send]) {
        expect(button.top, greaterThanOrEqualTo(field.bottom));
        expect(button.bottom, lessThanOrEqualTo(surface.bottom));
      }
      expect(plus.left, lessThan(tag.left));
      expect(tag.left, lessThan(session.left));
      expect(session.right, lessThan(send.left));
      expect(
        find.descendant(of: attach(), matching: find.byIcon(AppIcons.plus)),
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
    });

    testWidgets('names the project chat in Also send', (tester) async {
      await show(tester, chat: 'lead', thread: 'message-1');
      expect(find.text('Also send to #Pilot'), findsOneWidget);
      expect(
        tester.getRect(key('super-thread-also-send')).top,
        greaterThanOrEqualTo(
          tester.getRect(key('super-thread-composer-surface')).bottom,
        ),
      );
    });

    testWidgets('puts the mic left of send, and a click starts a take for the '
        'thread', (tester) async {
      final recorder = _Recorder();
      await show(tester, thread: 'message-3', recorder: recorder);
      expect(
        tester.getRect(key('super-thread-mic')).right,
        lessThanOrEqualTo(tester.getRect(key('super-thread-send')).left),
      );
      await tester.tap(key('super-thread-mic'));
      await tester.pump();
      expect(recorder.takes, [('offline', 'message-3')]);
    });

    testWidgets('@ Tag types @ at the caret and opens the tag list', (
      tester,
    ) async {
      await show(tester, chat: 'lead', thread: 'message-1');
      await tester.tap(key('super-thread-tag'));
      await tester.pumpAndSettle();
      final field = tester.widget<TextField>(key('super-thread-composer'));
      expect(field.controller!.text, '@');
      expect(key('super-thread-completions'), findsOneWidget);
    });
  });
}
