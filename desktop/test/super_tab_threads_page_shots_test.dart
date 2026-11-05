// Task #2996 (anh Dee, 11-05): the Threads page for the PR's pictures, light and dark. Writes nothing unless
// HARNESS_SUPER_TAB_CAPTURE names a folder.
import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/threads_page.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'package:harness/super_tabs/activity.dart';

import 'super_tab_activity_lists_test.dart' show swarm, unreadThread;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];
final _now = DateTime(2026, 11, 5, 9, 30);

/// A message as the pictures show it: who, then what.
Widget _message(SuperTabMessage m) => Padding(
  padding: const EdgeInsets.symmetric(vertical: grid.AppDesktop.listRowGap),
  child: Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        (m.author['displayName'] ?? m.author['name']) as String,
        style: DesktopChrome.control().copyWith(
          fontWeight: grid.AppFont.semibold,
        ),
      ),
      Text(m.text, style: DesktopChrome.control()),
    ],
  ),
);

/// The Swarm read, as the lists test reads it.
Future<SuperTabActivity> _load(
  WidgetTester tester,
  ConversationServer server,
) async {
  final c = server.controller(account: 'owner');
  // Nothing a picture shows needs saving on this computer: the controller
  // goes without a flush, which would wait on the test's clock.
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
  return (await tester.runAsync(() async {
    await c.refresh();
    final activity = SuperTabActivity.of(c);
    await activity.mentions.load();
    await activity.decisions.load();
    await activity.attention.load();
    return activity;
  }))!;
}

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('Threads in ${brightness.name}', (tester) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(1440, 1800);
      addTearDown(tester.view.reset);
      final server = swarm();
      String thread(
        String conversationId,
        String by,
        String root,
        List<(String, String)> replies,
      ) {
        server.append(root, conversationId: conversationId);
        final id = server.messages.last['id'] as String;
        server.messages.last['author'] = {
          'kind': 'person',
          'id': by.toLowerCase(),
          'name': by,
        };
        for (final (who, text) in replies) {
          server.append(text, conversationId: conversationId);
          server.messages.last
            ..['thread'] = id
            ..['author'] = {
              'kind': 'agent',
              'id': who.toLowerCase(),
              'name': who,
              'displayName': who,
            };
        }
        return id;
      }

      Map<String, dynamic> followed(
        String conversationId,
        String id, {
        int unread = 0,
        required int minutesAgo,
      }) {
        final rows = server.messages.where((m) => m['thread'] == id).toList();
        return unreadThread(id)
          ..['conversationId'] = conversationId
          ..['root'] = {
            ...(unreadThread(id)['root'] as Map),
            'author': rows.first['author'],
            'text': rows.first['text'],
          }
          ..['replies'] = rows.length - 1
          ..['unreadReplies'] = unread
          ..['lastReplySequence'] = rows.last['sequence']
          ..['lastReplyAt'] = _now
              .subtract(Duration(minutes: minutesAgo))
              .toUtc()
              .toIso8601String();
      }

      final words = thread(
        'lead',
        'Dee',
        'Proposal words check\n\n'
            'Proposals feel like bots. Post the owner\'s own words, or the one '
            'line they okayed.',
        [
          ('Larch', 'Plan is up for review.'),
          ('Kestrel', 'Tests are in, red then green.'),
          ('Larch', 'Review: two minor notes, nothing blocking.'),
          ('Kestrel', 'Notes fixed.'),
          ('Larch', '@dee the three tightenings are ready to merge.'),
          ('River', 'Merged, ships in the next release.'),
        ],
      );
      final firms = thread('offline', 'Sage', 'Law firm list A', [
        ('Kestrel', 'List A is done: 100 firms, CSV attached.'),
      ]);
      server.followedThreads = {
        'unread': [followed('lead', words, unread: 2, minutesAgo: 5)],
        'read': [followed('offline', firms, minutesAgo: 90)],
        'more': false,
      };
      await withClock(Clock.fixed(_now), () async {
        final activity = await _load(tester, server);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: Scaffold(
              body: SizedBox(
                width: 720,
                child: SuperTabThreadsPage(
                  activity: activity,
                  onOpenThread: (_, _) {},
                  message: _message,
                  now: () => _now,
                ),
              ),
            ),
          ),
        );
        for (var i = 0; i < 3; i++) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 30)),
          );
          await tester.pumpAndSettle();
        }
        await captureWindow(tester, shots, 'threads-page-${brightness.name}');
      });
    });
  }
}
