import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore;

/// Stability roadmap 2.5: the Swarm list tells each Swarm's waiting tags
/// (`/api/super-tabs/list?mentions=1`), so discovery asks a Swarm for its tags
/// only when they changed, not once per Swarm every round.
class _Backend {
  _Backend({this.listsMentions = true});

  /// A backend from before the list carried tags: it refuses the query.
  final bool listsMentions;
  final server = ConversationServer();
  final lists = <String>[];

  /// What the list says of 'tab': set to null for a row with no tag counts.
  String? digest = 'd0';
  bool counted = true;

  Future<Object?> call(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final uri = Uri.parse(path);
    if (uri.path != '/api/super-tabs/list') {
      return server.request(method, path, body: body);
    }
    lists.add(path);
    final asked = uri.queryParameters['mentions'] == '1';
    if (asked && !listsMentions) {
      throw const SuperTabFailure(
        'VALIDATION_ERROR',
        'Unrecognized key: "mentions"',
        statusCode: 400,
      );
    }
    return {
      'tabs': [
        {
          'id': 'tab',
          'name': 'Pilot',
          if (asked && counted) ...{
            'mentionsWaiting': server.mentions.length,
            'mentionsDigest': '${digest}x${server.mentions.length}',
          },
        },
      ],
      'next': null,
    };
  }
}

SuperTabClient _client(
  _Backend backend, {
  List<String>? arrived,
  void Function()? onTagCounts,
}) {
  final client = SuperTabClient(
    storage: MemoryStore(),
    transport: backend.call,
    discoveryInterval: Duration.zero,
    onTabs: (_, _) {},
    onMention: (_, mention) => arrived?.add(mention.text),
    onTagCounts: onTagCounts,
  );
  addTearDown(client.dispose);
  return client..bind('owner');
}

void main() {
  test(
    'a list that tells no tags for a Swarm costs no mentions read',
    () async {
      final backend = _Backend();
      final client = _client(backend);
      await client.refreshTabs();
      expect(backend.lists.single, contains('mentions=1'));
      expect(client.waitingTags('tab'), 0);
      expect(backend.server.mentionReads, 0);
    },
  );

  test(
    'reads a Swarm\'s tags once, then only when the list says they moved',
    () async {
      final backend = _Backend();
      backend.server.tag('message-1', text: 'Old');
      final arrived = <String>[];
      final client = _client(backend, arrived: arrived);
      await client.refreshTabs();
      expect(client.waitingTags('tab'), 1);
      expect(backend.server.mentionReads, 1);
      await client.refreshTabs();
      await client.refreshTabs();
      expect(backend.server.mentionReads, 1);
      expect(arrived, isEmpty);
      backend.server.tag('message-2', text: 'New');
      await client.refreshTabs();
      expect(backend.server.mentionReads, 2);
      expect(client.waitingTags('tab'), 2);
      expect(arrived, ['New']);
    },
  );

  test('a tag answered elsewhere lowers the count without a read, and a later tag is announced', () async {
    final backend = _Backend();
    backend.server.tag('message-1', text: 'Old');
    final arrived = <String>[];
    var changes = 0;
    final client = _client(
      backend,
      arrived: arrived,
      onTagCounts: () => changes++,
    );
    await client.refreshTabs();
    expect(changes, 1);
    backend.server.mentions.clear();
    await client.refreshTabs();
    expect(client.waitingTags('tab'), 0);
    expect(changes, 2);
    expect(backend.server.mentionReads, 1);
    backend.server.tag('message-3', text: 'Fresh');
    // The fixture numbers tags by how many it holds: a new one, not the old.
    backend.server.mentions.last['id'] = 'mention-9';
    await client.refreshTabs();
    expect(client.waitingTags('tab'), 1);
    expect(arrived, ['Fresh']);
  });

  test(
    'a Swarm with no tags at the first look announces the first one that comes',
    () async {
      final backend = _Backend();
      final arrived = <String>[];
      final client = _client(backend, arrived: arrived);
      await client.refreshTabs();
      backend.server.tag('message-1', text: 'First');
      await client.refreshTabs();
      expect(arrived, ['First']);
      expect(client.waitingTags('tab'), 1);
    },
  );

  test(
    'a row without counts is asked for its tags itself, as before',
    () async {
      final backend = _Backend()..counted = false;
      backend.server.tag('message-1');
      final client = _client(backend);
      await client.refreshTabs();
      await client.refreshTabs();
      expect(client.waitingTags('tab'), 1);
      expect(backend.server.mentionReads, 2);
    },
  );

  test(
    'a backend that refuses the query is asked without it, and not again',
    () async {
      final backend = _Backend(listsMentions: false);
      backend.server.tag('message-1');
      final client = _client(backend);
      await client.refreshTabs();
      expect(client.waitingTags('tab'), 1);
      expect(client.discoveryError, isNull);
      expect(backend.lists, hasLength(2));
      expect(backend.lists.last, isNot(contains('mentions')));
      await client.refreshTabs();
      expect(backend.lists, hasLength(3));
      expect(backend.lists.last, isNot(contains('mentions')));
    },
  );
}
