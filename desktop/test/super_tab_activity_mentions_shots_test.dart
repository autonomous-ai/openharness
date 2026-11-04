// Task #2887 (Diego, 11-04): Activity's Mentions and Threads for the PR's pictures, light and dark. Writes nothing
// unless ACTIVITY_SHOTS names a folder.
import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/activity_view.dart';

import 'super_tab_activity_lists_test.dart' show load, swarm, unreadThread;
import 'support/capture.dart';

final shots = Platform.environment['ACTIVITY_SHOTS'];
final _now = DateTime(2026, 11, 4, 18, 30);

String _ago(int minutes) =>
    _now.subtract(Duration(minutes: minutes)).toUtc().toIso8601String();

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('Mentions and Threads in ${brightness.name}', (tester) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(1440, 1000);
      addTearDown(tester.view.reset);
      final server = swarm();
      (server.state['people'] as List).add({
        'id': 'diego',
        'email': 'diego@autonomous.ai',
        'role': 'member',
        'name': 'Diego',
      });
      // River's tags: two the server resolved when Diego answered (still
      // unread), one waiting, and one he read past (not listed).
      void tag(int i, int sequence, String text, {String? resolvedBy}) {
        server.tag(
          'message-$i',
          messageSequence: sequence,
          leadId: 'river',
          text: text,
          createdAt: _ago(i * 7),
        );
        server.mentions.last['leadName'] = 'River';
        if (resolvedBy != null) {
          server.mentions.last
            ..['resolvedAt'] = _ago(1)
            ..['resolvedBy'] = resolvedBy;
        }
      }

      tag(1, 30, 'Diego, the Activity fix is ready for your look.');
      tag(
        2,
        28,
        'Screenshots for #2887 are in the task chat.',
        resolvedBy: 'answer',
      );
      tag(3, 26, 'Which tab should Activity open on?', resolvedBy: 'answer');
      tag(4, 3, 'Seen this one already.', resolvedBy: 'answer');
      server.tag(
        'message-5',
        messageSequence: 24,
        leadId: 'kestrel',
        text: 'Kestrel needs a decision on the release window.',
        createdAt: _ago(50),
      );
      server.mentions.last['leadName'] = 'Kestrel';
      server.state['readMarks'] = {
        'owner': {'lead': 10},
      };
      final diego = {
        'kind': 'person',
        'id': 'diego',
        'name': 'diego@autonomous.ai',
      };
      server.followedThreads = {
        'unread': [
          unreadThread('message-1')
            ..['root'] = {
              ...(unreadThread('message-1')['root'] as Map),
              'author': diego,
              'text': 'Mentions show tags I never opened as read',
            }
            ..['lastReplier'] = {
              'kind': 'agent',
              'id': 'kestrel',
              'name': 'Builder',
              'displayName': 'Kestrel',
            }
            ..['lastReplyAt'] = _ago(4),
        ],
        'read': [],
        'more': false,
      };
      await withClock(Clock.fixed(_now), () async {
        final activity = (await tester.runAsync(() => load(server)))!;
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: Scaffold(
              body: SizedBox(
                width: 720,
                child: SuperTabActivityView(
                  activity: activity,
                  onOpenMention: (_) {},
                  onOpenThread: (_, _) {},
                  onOpenConversation: (_) {},
                  now: () => _now,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('super-activity-tab-mentions')),
        );
        await tester.pumpAndSettle();
        await captureWindow(tester, shots, 'mentions-${brightness.name}');
        await tester.tap(
          find.byKey(const ValueKey('super-activity-tab-threads')),
        );
        await tester.pumpAndSettle();
        await captureWindow(tester, shots, 'threads-${brightness.name}');
      });
    });
  }
}
