// A thread's reply box says only what went wrong with its own replies: a
// refused send in another chat, or in this chat's main stream, is not said
// under it.
import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

const _refused = 'Choose an agent in this conversation.';
final _png = Uint8List.fromList([1, 2, 3]);

/// Two top-level messages in the Lead chat (message-1, message-2), a reply to
/// message-1 (message-3) and one top-level message in the other chat
/// (message-4).
ConversationServer _threaded() {
  final server = ConversationServer()..threads = true;
  server.append('First topic.');
  server.append('Second topic.');
  server.append('A reply.');
  server.messages.last
    ..['thread'] = 'message-1'
    ..['replyTo'] = 'message-1';
  server.append('Offline topic.', conversationId: 'offline');
  return server;
}

void main() {
  group('the thread reply box error is per thread', () {
    late ConversationServer server;
    late SuperTabController c;

    setUp(() async {
      server = _threaded();
      c = server.controller();
      await c.refresh();
    });
    tearDown(() => c.dispose());

    Future<Map<String, dynamic>?> replyIn(String root, String text) {
      c.openThread(root);
      c.setThreadDraft(root, text);
      return c.sendThreadReply();
    }

    test('a refused send in one chat is not said under another chat\'s '
        'thread', () async {
      server.reject = true;
      c.setDraft('lead', 'Hello');
      expect(await c.send(), isNull);
      expect(c.hasPendingAction, isFalse);
      expect(c.composerError('lead'), _refused);

      await c.select('offline');
      c.openThread('message-4');
      expect(c.threadComposerError('offline', 'message-4'), isNull);
      expect(c.composerError('offline'), isNull);
    });

    test('a refused thread reply shows under its own thread only', () async {
      server.reject = true;
      expect(await replyIn('message-1', 'Reply'), isNull);
      expect(c.hasPendingAction, isFalse);

      expect(c.threadComposerError('lead', 'message-1'), _refused);
      expect(c.threadComposerError('lead', 'message-2'), isNull);
      c.openThread('message-2');
      expect(c.threadComposerError('lead', 'message-2'), isNull);
      // The chat's own box still says it, as before threads were scoped.
      expect(c.composerError('lead'), _refused);

      await c.select('offline');
      c.openThread('message-4');
      expect(c.threadComposerError('offline', 'message-4'), isNull);
      expect(c.composerError('offline'), isNull);
    });

    test('a refused send from the chat\'s main box is not said under its '
        'threads', () async {
      server.reject = true;
      c.setDraft('lead', 'Hello');
      expect(await c.send(), isNull);
      c.openThread('message-1');
      expect(c.threadComposerError('lead', 'message-1'), isNull);
      expect(c.composerError('lead'), _refused);
    });

    test('a refused reply to a message inside a thread shows under that '
        'thread, where it was going', () async {
      server.reject = true;
      c.setDraft('lead', 'Hello');
      expect(await c.send(replyTo: 'message-3'), isNull);
      expect(c.threadComposerError('lead', 'message-1'), _refused);
      expect(c.threadComposerError('lead', 'message-2'), isNull);
    });

    test('a thread reply refused after the person moved to another chat '
        'stays with its own thread', () async {
      final hold = server.holdCommands = Completer<void>();
      server.reject = true;
      final sending = replyIn('message-1', 'Reply');
      await Future<void>.delayed(Duration.zero);
      expect(c.saving, isTrue);

      await c.select('offline');
      c.openThread('message-4');
      hold.complete();
      expect(await sending, isNull);

      expect(c.threadComposerError('offline', 'message-4'), isNull);
      expect(c.threadComposerError('lead', 'message-1'), _refused);
    });

    test('a newer failure in another chat replaces the thread\'s, and the '
        'thread no longer says the old one', () async {
      server.reject = true;
      expect(await replyIn('message-1', 'Reply'), isNull);
      expect(c.threadComposerError('lead', 'message-1'), _refused);

      server
        ..reject = false
        ..refuse = {'code': 'FORBIDDEN', 'message': 'You can’t write here.'}
        ..refuseStatus = 403;
      await c.select('offline');
      c.setDraft('offline', 'Hello');
      expect(await c.send(), isNull);
      expect(c.composerError('offline'), 'You can’t write here.');
      expect(c.threadComposerError('lead', 'message-1'), isNull);
      expect(c.threadComposerError('offline', 'message-4'), isNull);
    });

    test(
      'a send still unconfirmed blocks every reply box, so each says why',
      () async {
        server.loseReply = true;
        c.setDraft('lead', 'Hello');
        expect(await c.send(), isNull);
        expect(c.hasPendingAction, isTrue);

        await c.select('offline');
        c.openThread('message-4');
        expect(
          c.threadComposerError('offline', 'message-4'),
          'The action is not confirmed. Retry to check it.',
        );
      },
    );

    test(
      'a refusal outside any chat still shows where the person is',
      () async {
        server.refuse = {'code': 'NOPE', 'message': 'Not allowed.'};
        expect(
          await c.command({'type': 'agent.release', 'agentId': 'a'}),
          isNull,
        );
        c.openThread('message-1');
        expect(c.threadComposerError('lead', 'message-1'), 'Not allowed.');
      },
    );

    test('a refused file in a thread stays with that thread', () async {
      server.failUpload = 'a.png';
      c.openThread('message-1');
      c.threadAttachments('lead', 'message-1').add([
        HarnessAttachment('a.png', _png),
      ]);
      expect(await c.sendThreadReply(), isNull);
      expect(
        c.threadComposerError('lead', 'message-1'),
        'The file is too '
        'large.',
      );

      c.openThread('message-2');
      expect(c.threadComposerError('lead', 'message-2'), isNull);
      await c.select('offline');
      c.openThread('message-4');
      expect(c.threadComposerError('offline', 'message-4'), isNull);
    });

    test('a chat the reader can no longer read takes its thread error with '
        'it from every other thread box', () async {
      server.reject = true;
      expect(await replyIn('message-1', 'Reply'), isNull);
      server.reject = false;
      (server.state['conversations'] as List).removeWhere(
        (g) => (g as Map)['id'] == 'lead',
      );
      server.revision++;
      await c.refresh();
      await c.select('offline');
      c.openThread('message-4');
      expect(c.threadComposerError('offline', 'message-4'), isNull);
    });
  });

  testWidgets('the thread panel of another chat does not show a refused send', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = _threaded();
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    server.reject = true;
    c.setDraft('lead', 'Hello');
    expect(await c.send(), isNull);
    await tester.pumpAndSettle();
    expect(c.composerError('lead'), _refused);

    await c.select('offline');
    c.openThread('message-4');
    await tester.pumpAndSettle();
    final panel = find.byKey(const ValueKey('super-thread-panel'));
    expect(panel, findsOneWidget);
    expect(
      find.descendant(of: panel, matching: find.text(_refused)),
      findsNothing,
    );

    // Its own refused reply, typed and sent from the thread box, does show.
    await tester.enterText(
      find.byKey(const ValueKey('super-thread-composer')),
      'Reply',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('super-thread-send')));
    await tester.pumpAndSettle();
    expect(server.posts.last['command']['replyTo'], 'message-4');
    expect(
      find.descendant(of: panel, matching: find.text(_refused)),
      findsWidgets,
    );
  });
}
