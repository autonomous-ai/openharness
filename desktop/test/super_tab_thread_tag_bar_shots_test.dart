import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/attention.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_THREAD_TAG_SHOTS'];

const _lead = {'kind': 'agent', 'id': 'lead-agent', 'name': 'River'};
const _peer = {'kind': 'person', 'id': 'peer', 'name': 'peer@example.com'};

/// A chat with tags of the reader in two threads: its top row, then Open at
/// the oldest reply, lit (#2814).
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      final server = ConversationServer()..threads = true;
      (server.state['people'] as List).add({
        'id': 'peer',
        'email': 'peer@example.com',
        'role': 'collaborator',
      });
      void say(String text, Map<String, Object> author, {String? root}) {
        server.append(text);
        server.messages.last['author'] = author;
        if (root != null) {
          server.messages.last
            ..['thread'] = root
            ..['replyTo'] = root;
        }
      }

      say('Build the import fix for compressed uploads.', _lead);
      say(
        'On it: the upload keeps its gzip header now.',
        _peer,
        root: 'message-1',
      );
      say(
        '@owner can you try the import with your archive?',
        _peer,
        root: 'message-1',
      );
      say('Release notes for 1.4.2 are up.', _lead);
      say('The phone fixture cleanup race is fixed.', _lead);
      say(
        '@owner the race is in your screen too, please look.',
        _peer,
        root: 'message-5',
      );
      // The server counts a tagged person among a thread's people.
      for (final m in server.messages) {
        if ((m['text'] as String).startsWith('@owner')) {
          m['mentions'] = ['owner'];
        }
      }
      server.tag('message-3', threadId: 'message-1', messageSequence: 3);
      server.tag('message-6', threadId: 'message-5', messageSequence: 6);
      server.followedThreads = {
        'unread': [
          for (final (root, last, fresh) in [
            ('message-1', 3, 2),
            ('message-5', 6, 1),
          ])
            {
              'conversationId': 'lead',
              'rootId': root,
              'root': {'id': root, 'sequence': 1, 'author': _lead, 'text': ''},
              'lastReplySequence': last,
              'lastReplier': _peer,
              'unreadReplies': fresh,
              'follow': null,
            },
        ],
        'read': <Object>[],
        'more': false,
      };
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await tester.binding.setSurfaceSize(const Size(1280, 720));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
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
      await tester.pumpAndSettle();
      final bar = find.byKey(const ValueKey('super-thread-tag-bar'));
      expect(find.text('2 new replies mention you · Open'), findsOneWidget);
      await captureWindow(tester, shots, 'thread-tag-bar-${brightness.name}');

      await tester.tap(bar);
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(c.openedThread?.root, 'message-1');
      await captureWindow(tester, shots, 'thread-tag-open-${brightness.name}');
      await tester.pump(SuperTabAttention.quietGap);
      await tester.pumpAndSettle();
    });
  }
}
