import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/message_link.dart';

void main() {
  const link = SwarmMessageLink(
    tabId: 'tab1',
    conversationId: 'lead',
    messageId: 'message-7',
  );

  test('a link is the Harness app link: Swarm, conversation, message', () {
    expect(link.url, 'harness://swarm/tab1/lead/message-7');
  });

  test('a link reads back as the one that made it', () {
    final parsed = SwarmMessageLink.parse(link.url);
    expect(parsed?.tabId, 'tab1');
    expect(parsed?.conversationId, 'lead');
    expect(parsed?.messageId, 'message-7');
  });

  test('a link carries the message id alone, never a thread', () {
    // A message in a thread is found by its own id in its conversation.
    expect(SwarmMessageLink.parse('${link.url}/thread-1'), isNull);
    expect(SwarmMessageLink.parse('${link.url}?thread=thread-1'), isNull);
  });

  test('only the Swarm message form is a message link', () {
    for (final other in [
      'harness://swarm/join/tab1', // a join link
      'harness://swarm/tab1/lead', // no message
      'harness://notification/machine/agent',
      'https://swarm/tab1/lead/message-7',
      'harness://other/tab1/lead/message-7',
      'harness://user@swarm/tab1/lead/message-7',
      'harness://swarm:99/tab1/lead/message-7',
      'harness://swarm/tab1/lead/message-7#frag',
      'harness://swarm/tab1/le ad/message-7',
      'harness://swarm//lead/message-7',
      'harness://swarm/tab1/lead/',
      '',
      'not a link',
    ]) {
      expect(SwarmMessageLink.parse(other), isNull, reason: other);
    }
  });

  test('an id with a path or odd characters is refused', () {
    for (final id in ['..', 'a/b', 'a%2Fb', 'a b', 'é', 'x' * 161]) {
      expect(
        SwarmMessageLink.parse(
          'harness://swarm/${Uri.encodeComponent(id)}/lead/message-7',
        ),
        isNull,
        reason: id,
      );
    }
  });

  test('a link longer than the native URL limit is refused', () {
    final long = 'harness://swarm/tab1/lead/${'m' * 240}';
    expect(SwarmMessageLink.parse(long), isNull);
  });

  test('links are found in a message, in order, once each', () {
    const other = SwarmMessageLink(
      tabId: 'tab1',
      conversationId: 'offline',
      messageId: 'message-2',
    );
    final found = SwarmMessageLink.allIn(
      'See ${link.url}, and (${other.url}). Again ${link.url} and '
      'https://example.com/tab1/lead/message-7 and harness://swarm/join/tab1',
    );
    expect(found.map((l) => l.url), [link.url, other.url]);
  });

  test('a link inside code stays literal text', () {
    expect(SwarmMessageLink.allIn('`${link.url}`'), isEmpty);
    expect(SwarmMessageLink.allIn('```\n${link.url}\n```'), isEmpty);
  });

  test('at most four links are previewed', () {
    final text = [
      for (var i = 1; i <= 6; i++) 'harness://swarm/tab1/lead/message-$i',
    ].join(' ');
    expect(SwarmMessageLink.allIn(text), hasLength(4));
  });

  test(
    'the inbox takes message links only, once each, up to a limit',
    () async {
      final inbox = SwarmMessageLinkInbox();
      var told = 0;
      inbox.addListener(() => told++);
      await inbox.accept('harness://swarm/join/tab1');
      await inbox.accept('garbage');
      expect(inbox.pending, isEmpty);
      expect(told, 0);
      await inbox.accept(link.url);
      await inbox.accept(link.url);
      expect(inbox.pending.map((l) => l.url), [link.url]);
      expect(told, 1);
      for (var i = 0; i < 30; i++) {
        await inbox.accept('harness://swarm/tab1/lead/message-x$i');
      }
      expect(inbox.pending.length, 20);
      inbox.complete(inbox.pending.first);
      expect(inbox.pending.length, 19);
    },
  );
}
