import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/voice_row.dart';

import 'support/fake_voice_recorder.dart';
import 'support/voice_server.dart';

/// #2665: on macOS and the web the composer's mic records a voice message and
/// sends it as audio through #2887's path (people hear it, agents read its
/// words). While a take is under way its row takes the composer row's place:
/// X, the red dot and time, the wave, and Send. A refused microphone says so
/// in one line, with the way to allow it.
void main() {
  late VoiceServer server;
  late FakeVoiceRecorder mic;

  Finder key(String value) => find.byKey(ValueKey(value));

  Future<SuperTabController> show(
    WidgetTester tester, {
    String chat = 'lead',
    String? thread,
  }) async {
    server = VoiceServer()..threads = true;
    server.append('The build fails on the second run.');
    server.append('Measure prod CPU', conversationId: 'offline');
    mic = FakeVoiceRecorder();
    final c = server.controller();
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
            voiceRecorder: () => mic,
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

  group('the main chat', () {
    testWidgets('the mic records in place of the row and keeps the text', (
      tester,
    ) async {
      await show(tester);
      await tester.enterText(key('super-message-composer'), 'half a thought');
      await tester.tap(key('super-composer-mic'));
      await tester.pump();
      expect(key('super-voice-row'), findsOneWidget);
      expect(key('super-message-composer-actions'), findsNothing);
      expect(key('super-voice-dot'), findsOneWidget);
      expect(find.text('0:00'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      expect(find.text('0:03'), findsOneWidget);
      expect(
        tester.widget<TextField>(key('super-message-composer')).controller!.text,
        'half a thought',
      );
      await tester.tap(key('super-voice-discard'));
      await tester.pumpAndSettle();
    });

    testWidgets('X throws the take away and sends nothing', (tester) async {
      await show(tester);
      await tester.tap(key('super-composer-mic'));
      await tester.pump();
      await tester.tap(key('super-voice-discard'));
      await tester.pumpAndSettle();
      expect(mic.calls.last, 'cancel');
      expect(key('super-voice-row'), findsNothing);
      expect(key('super-message-composer-actions'), findsOneWidget);
      expect(server.uploads, isEmpty);
      expect(server.lastSend(), isNull);
    });

    testWidgets('Send posts one voice message to the chat', (tester) async {
      await show(tester);
      await tester.tap(key('super-composer-mic'));
      await tester.pump();
      await tester.tap(key('super-voice-send'));
      await tester.pumpAndSettle();
      expect(server.uploads.single['name'], 'Voice message.wav');
      final send = server.lastSend()!;
      expect(send['conversationId'], 'lead');
      expect(send['text'], '');
      expect(send['attachmentIds'], [server.uploads.single['id']]);
      expect(send['replyTo'], isNull);
      expect(key('super-voice-row'), findsNothing);
      expect(key('super-message-composer-actions'), findsOneWidget);
    });

    testWidgets('another chat holds the take for its own chat', (
      tester,
    ) async {
      final c = await show(tester);
      await tester.tap(key('super-composer-mic'));
      await tester.pump();
      await c.select('offline');
      await tester.pumpAndSettle();
      expect(mic.calls.last, 'stop');
      expect(key('super-voice-row'), findsNothing);
      expect(key('super-message-composer-actions'), findsOneWidget);
      expect(server.lastSend(), isNull);
      await c.select('lead');
      await tester.pumpAndSettle();
      expect(key('super-voice-row'), findsOneWidget);
      await tester.tap(key('super-voice-send'));
      await tester.pumpAndSettle();
      expect(server.lastSend()!['conversationId'], 'lead');
    });

    testWidgets('a refused microphone says so, with System Settings', (
      tester,
    ) async {
      final opened = <Uri>[];
      final before = superTabOpenSettings;
      superTabOpenSettings = (url) async {
        opened.add(url);
        return true;
      };
      addTearDown(() => superTabOpenSettings = before);
      await show(tester);
      mic.allow = false;
      await tester.tap(key('super-composer-mic'));
      await tester.pumpAndSettle();
      expect(key('super-voice-row'), findsNothing);
      expect(key('super-voice-refused'), findsOneWidget);
      expect(
        find.textContaining("Harness can't use the microphone"),
        findsOneWidget,
      );
      await tester.tap(key('super-voice-settings'));
      expect(opened, [superTabMicrophoneSettings]);
    });
  });

  group('a thread', () {
    testWidgets("the thread's mic sends a reply to its root", (tester) async {
      await show(tester, thread: 'message-1');
      await tester.tap(key('super-thread-mic'));
      await tester.pump();
      expect(key('super-thread-voice-row'), findsOneWidget);
      // The main chat's composer keeps its own row.
      expect(key('super-voice-row'), findsNothing);
      await tester.tap(key('super-thread-voice-send'));
      await tester.pumpAndSettle();
      final send = server.lastSend()!;
      expect(send['conversationId'], 'lead');
      expect(send['replyTo'], 'message-1');
      expect(key('super-thread-voice-row'), findsNothing);
    });

    testWidgets('closing the thread holds its take', (tester) async {
      final c = await show(tester, thread: 'message-1');
      await tester.tap(key('super-thread-mic'));
      await tester.pump();
      c.closeThread();
      await tester.pumpAndSettle();
      expect(mic.calls.last, 'stop');
      expect(server.lastSend(), isNull);
    });
  });
}
