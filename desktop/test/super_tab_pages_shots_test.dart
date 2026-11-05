// Task #2996 (anh Dee, 11-05): the Swarm with its new sidebar, on each of its three pages, light and dark, for the
// PR's pictures. Writes nothing unless HARNESS_SUPER_TAB_CAPTURE names a folder.
import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm, unreadThread;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];
final _now = DateTime(2026, 11, 5, 9, 30);

String _ago(int minutes) =>
    _now.subtract(Duration(minutes: minutes)).toUtc().toIso8601String();

/// One project with a decision, an agent waiting, two tags and two followed
/// threads, one with unread replies.
ConversationServer _swarm() {
  final server = swarm()..state['swarmBuddy'] = true;
  server.state['people'] = [
    {
      'id': 'owner',
      'email': 'dee@example.com',
      'role': 'owner',
      'username': 'dee',
      'name': 'Dee',
    },
  ];
  server.ask(['Which machine runs the phone tests?']);
  server.decisions.last
    ..['askerName'] = 'Ken'
    ..['options'] = ["Tony's Mac", 'Mac Studio', 'Mac 3']
    ..['recommended'] = 0
    ..['createdAt'] = _ago(70);
  (server.state['conversations'] as List)
      .cast<Map<String, dynamic>>()
      .firstWhere((g) => g['id'] == 'offline')['assignment'] = {
    'id': 'a1',
    'agentId': 'kestrel',
    'status': 'needs_human',
    'askedOf': 'owner',
    'result': 'Okay to turn the switch on in lampOS?',
  };

  String thread(String by, String root, List<(String, String)> replies) {
    server.append(root);
    final id = server.messages.last['id'] as String;
    server.messages.last['author'] = {
      'kind': 'person',
      'id': 'owner',
      'name': by,
    };
    for (final (who, text) in replies) {
      server.append(text);
      server.messages.last
        ..['thread'] = id
        ..['author'] = {
          'kind': 'agent',
          'id': 'kestrel',
          'name': who,
          'displayName': who,
        };
    }
    return id;
  }

  Map<String, dynamic> followed(String id, {int unread = 0, required int ago}) {
    final rows = server.messages.where((m) => m['thread'] == id).toList();
    return unreadThread(id)
      ..['conversationId'] = 'lead'
      ..['root'] = {
        ...(unreadThread(id)['root'] as Map),
        'author': rows.first['author'],
        'text': rows.first['text'],
      }
      ..['replies'] = rows.length - 1
      ..['unreadReplies'] = unread
      ..['lastReplySequence'] = rows.last['sequence']
      ..['lastReplyAt'] = _ago(ago);
  }

  final words = thread(
    'Dee',
    'Proposal words check\n\nProposals feel like bots. Post the owner\'s own '
        'words, or the one line they okayed.',
    [
      ('Larch', 'Plan is up for review.'),
      ('Kestrel', 'Tests are in, red then green.'),
      ('Larch', 'Review: two minor notes, nothing blocking.'),
      ('Kestrel', 'Notes fixed.'),
      ('Larch', '@dee the three tightenings are ready to merge.'),
      ('River', 'Merged, ships in the next release.'),
    ],
  );
  final firms = thread('Dee', 'Law firm list A', [
    ('Kestrel', 'List A is done: 100 firms, CSV attached.'),
  ]);
  server.followedThreads = {
    'unread': [followed(words, unread: 2, ago: 5)],
    'read': [followed(firms, ago: 900)],
    'more': false,
  };
  server.tag(
    'message-${server.revision}',
    text: '@dee the three tightenings are ready to merge.',
    createdAt: _ago(10),
    messageSequence: server.revision,
    threadId: words,
  );
  server.mentions.last['leadName'] = 'Larch';
  server.tag(
    'message-1',
    text: '@dee List A is done: 100 firms, CSV attached.',
    createdAt: _ago(960),
    messageSequence: 1,
  );
  server.mentions.last
    ..['leadName'] = 'Sage'
    ..['resolvedAt'] = _ago(900)
    ..['resolvedBy'] = 'read';
  return server;
}

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('the sidebar and its pages in ${brightness.name}', (
      tester,
    ) async {
      if (shots == null) return;
      await withClock(Clock.fixed(_now), () async {
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previous);
        tester.view.devicePixelRatio = 2;
        tester.view.physicalSize = const Size(2600, 1700);
        addTearDown(tester.view.reset);
        final server = _swarm();
        final c = server.controller(
          account: 'owner',
          initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
        );
        await tester.runAsync(c.refresh);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
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
        for (final page in ['decisions', 'mentions', 'threads']) {
          await tester.tap(find.byKey(ValueKey('super-$page')));
          // The page's reads, then the cards' own.
          for (var i = 0; i < 3; i++) {
            await tester.runAsync(
              () => Future<void>.delayed(const Duration(milliseconds: 60)),
            );
            await tester.pump(const Duration(milliseconds: 50));
          }
          await captureWindow(tester, shots, 'swarm-$page-${brightness.name}');
        }
        // Nothing a picture shows needs saving: no flush, which would wait
        // on the test's clock. Its timers run out before the test ends.
        await tester.pumpWidget(const SizedBox());
        c.dispose();
        await tester.pump(const Duration(seconds: 5));
      });
    });
  }
}
