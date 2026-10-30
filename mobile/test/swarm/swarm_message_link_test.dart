import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_message_link.dart';

/// A message link reads as Desktop reads it
/// (desktop/lib/super_tabs/message_link.dart): three plain ids under
/// harness://swarm, nothing else.
void main() {
  test('three ids under harness://swarm name the Swarm, chat and message', () {
    final link = SwarmMessageLink.parse('harness://swarm/tab-1/g_1/m-1')!;
    expect(
      (link.tabId, link.conversationId, link.messageId),
      ('tab-1', 'g_1', 'm-1'),
    );
    expect(link.url, 'harness://swarm/tab-1/g_1/m-1');
  });

  test('anything else is not a message link', () {
    for (final value in [
      'https://swarm/tab-1/g1/m1',
      'harness://other/tab-1/g1/m1',
      'harness://swarm/tab-1/g1',
      'harness://swarm/tab-1/g1/m1/more',
      'harness://swarm/tab-1//m1',
      'harness://swarm/tab-1/g1/m1?x=1',
      'harness://swarm/tab-1/g1/m1#top',
      'harness://swarm:8080/tab-1/g1/m1',
      'harness://me@swarm/tab-1/g1/m1',
      'harness://swarm/tab-1/g.1/m1',
      'harness://swarm/tab-1/g%2F1/m1',
      'harness://swarm/tab-1/g1/${'m' * 240}',
      '',
    ]) {
      expect(SwarmMessageLink.parse(value), isNull, reason: value);
    }
  });
}
