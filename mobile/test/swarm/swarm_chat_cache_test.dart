import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_chat_cache.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';

import 'swarm_fixture.dart';

/// The chats last read on the phone, kept in memory so one opened again
/// shows at once: the last ten, each only while its Swarm's read still has
/// it, and none once the reader's access ends.
void main() {
  /// Messages m[first] to m[first + count - 1] of [conversationId].
  List<SuperTabMessage> read(
    String conversationId, {
    int first = 1,
    int count = 1,
  }) => [
    for (var i = first; i < first + count; i++)
      SuperTabMessage.fromJson({
        'id': 'm$i',
        'conversationId': conversationId,
        'text': 'hello',
        'sequence': i,
        'author': {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
        'createdAt': '2026-10-27T01:00:00.000Z',
      }),
  ];

  /// A Swarm whose first load has chats g0 to g[count - 1].
  ({FakeSwarm swarm, SwarmReader reader}) rig({int count = 11}) {
    final swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) =>
        firstLoad(groups: [for (var i = 0; i < count; i++) groupData('g$i')]);
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: swarm.request,
    );
    addTearDown(reader.dispose);
    addTearDown(SwarmChatCache.clear);
    return (swarm: swarm, reader: reader);
  }

  void keep(SwarmReader reader, String id) => SwarmChatCache.keep(
    reader,
    id,
    messages: read(id),
    before: const SuperTabPage(1, 'm1'),
  );

  test('gives back what was kept, with where earlier messages start', () async {
    final r = rig();
    await r.reader.refresh();

    keep(r.reader, 'g1');
    final kept = SwarmChatCache.take(r.reader, 'g1');

    expect(kept?.messages.single.id, 'm1');
    expect(kept?.before?.id, 'm1');
    expect(SwarmChatCache.take(r.reader, 'g2'), isNull);
  });

  test('keeps a chat\'s newest page, the rest read again as earlier '
      'messages', () async {
    final r = rig();
    await r.reader.refresh();

    SwarmChatCache.keep(
      r.reader,
      'g1',
      messages: read('g1', count: 250),
      before: null,
    );
    final kept = SwarmChatCache.take(r.reader, 'g1')!;

    expect(kept.messages, hasLength(100));
    expect(kept.messages.first.id, 'm151');
    expect(kept.messages.last.id, 'm250');
    expect((kept.before?.sequence, kept.before?.id), (151, 'm151'));
  });

  test('keeps the last ten chats', () async {
    final r = rig();
    await r.reader.refresh();

    for (var i = 0; i < 11; i++) {
      keep(r.reader, 'g$i');
    }

    expect(SwarmChatCache.length, 10);
    expect(SwarmChatCache.take(r.reader, 'g0'), isNull);
    expect(SwarmChatCache.take(r.reader, 'g10'), isNotNull);
  });

  test('a chat opened again is the newest kept', () async {
    final r = rig();
    await r.reader.refresh();
    for (var i = 0; i < 10; i++) {
      keep(r.reader, 'g$i');
    }

    keep(r.reader, 'g0');
    keep(r.reader, 'g10');

    expect(SwarmChatCache.take(r.reader, 'g0'), isNotNull);
    expect(SwarmChatCache.take(r.reader, 'g1'), isNull);
  });

  test('keeps nothing of a chat its Swarm\'s read does not have', () async {
    final r = rig();
    await r.reader.refresh();

    keep(r.reader, 'elsewhere');

    expect(SwarmChatCache.length, 0);
  });

  test('another reader of the same Swarm gets nothing', () async {
    final r = rig();
    final other = rig();
    await r.reader.refresh();
    await other.reader.refresh();

    keep(r.reader, 'g1');

    expect(SwarmChatCache.take(other.reader, 'g1'), isNull);
  });

  test('a Swarm read again from nothing forgets its chats', () async {
    final r = rig();
    await r.reader.refresh();
    keep(r.reader, 'g1');

    r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => {'reload': true};
    await r.reader.refresh();

    expect(SwarmChatCache.length, 0);
    expect(SwarmChatCache.take(r.reader, 'g1'), isNull);
  });

  test('a chat its Swarm\'s read no longer has is forgotten', () async {
    final r = rig(count: 2);
    await r.reader.refresh();
    keep(r.reader, 'g0');
    keep(r.reader, 'g1');

    r.swarm.routes['/api/super-tabs/$tab/parts'] = (_) =>
        firstLoad(groups: [groupData('g0')]);
    r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => {'reload': true};
    await r.reader.refresh();

    expect(SwarmChatCache.take(r.reader, 'g1'), isNull);
  });

  test(
    'a reader whose access ended forgets its chats, and keeps no more',
    () async {
      final r = rig();
      await r.reader.refresh();
      keep(r.reader, 'g1');

      r.reader.revoke();

      expect(SwarmChatCache.length, 0);
      keep(r.reader, 'g1');
      expect(SwarmChatCache.length, 0);
    },
  );
}
