import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/reading.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore;

const _key = 'super_tab.owner.tab';

/// A browser's storage: it can list its keys.
class _BrowserStore extends MemoryStore
    implements KeyListingLocalKeyValueStore {
  @override
  Future<List<String>> keys() async => values.keys.toList();
}

/// The client over [server], reading as Desktop does unless [reading] says.
SuperTabClient _client(
  ConversationServer server,
  MemoryStore store, {
  Completer<void>? Function()? holdPost,
  SuperTabReading reading = SuperTabReading.desktop,
}) => SuperTabClient(
  transport: (method, path, {body}) async {
    if (method == 'POST') await holdPost?.call()?.future;
    return server.request(method, path, body: body);
  },
  storage: store,
  discoveryInterval: Duration.zero,
)..reading = reading;

List<(String, SuperTabOutgoingState)> _outgoing(SuperTabController c) => [
  for (final m in c.outgoing('lead')) (m.text, m.state),
];

/// Signs out and lets the controllers' last writes land.
Future<void> _signOut(SuperTabClient client) async {
  client.bind(null);
  await pumpEventQueue();
}

void main() {
  test('a refused send survives signing out and back in as the same account, '
      'and another account sees none of it', () async {
    final server = ConversationServer()..reject = true;
    final store = MemoryStore();
    final client = _client(server, store);
    addTearDown(client.dispose);
    client.bind('owner');
    final first = await client.open('tab');
    await first.refresh();
    first.setDraft('lead', 'Keep this text');
    await first.send();
    expect(_outgoing(first), [
      ('Keep this text', SuperTabOutgoingState.refused),
    ]);

    await _signOut(client);
    expect(first.outgoing('lead'), isEmpty, reason: 'The screen clears.');
    expect(store.values[_key], contains('Keep this text'));

    client.bind('owner');
    final again = await client.open('tab');
    await again.refresh();
    expect(_outgoing(again), [
      ('Keep this text', SuperTabOutgoingState.refused),
    ]);

    client.bind('someone-else');
    final other = await client.open('tab');
    await other.refresh();
    expect(other.outgoing('lead'), isEmpty);
    expect(
      store.values['super_tab.someone-else.tab'] ?? '',
      isNot(contains('Keep this text')),
    );
    expect(store.values[_key], contains('Keep this text'));
  });

  test('an unconfirmed send survives signing out and is checked against the '
      'backend by its receipt id after signing back in', () async {
    final server = ConversationServer()..loseReply = true;
    final store = MemoryStore();
    final client = _client(server, store);
    addTearDown(client.dispose);
    client.bind('owner');
    final first = await client.open('tab');
    await first.refresh();
    first.setDraft('lead', 'Did this arrive?');
    await first.send();
    expect(_outgoing(first), [
      ('Did this arrive?', SuperTabOutgoingState.unconfirmed),
    ]);

    await _signOut(client);
    client.bind('owner');
    final again = await client.open('tab');
    await again.refresh();
    expect(_outgoing(again), [
      ('Did this arrive?', SuperTabOutgoingState.unconfirmed),
    ]);

    await again.retryOutgoing(again.outgoing('lead').single);
    expect(server.posts, hasLength(2));
    expect(
      server.posts[1]['operationId'],
      server.posts[0]['operationId'],
      reason:
          'The same receipt id: the backend answers, nothing is sent twice.',
    );
    expect(server.messages, hasLength(1));
    expect(again.outgoing('lead'), isEmpty);
    expect(again.messages('lead').map((m) => m.text), ['Did this arrive?']);

    client.bind('someone-else');
    final other = await client.open('tab');
    await other.refresh();
    expect(other.outgoing('lead'), isEmpty);
  });

  test('a send that answers after signing out cannot erase the kept ones, '
      'and its own text stays to be checked', () async {
    // Messages named as the backend names them, by the send's receipt id.
    final server = ConversationServer()
      ..reject = true
      ..hashedIds = true;
    final store = MemoryStore();
    Completer<void>? gate;
    final client = _client(server, store, holdPost: () => gate);
    addTearDown(client.dispose);
    client.bind('owner');
    final first = await client.open('tab');
    await first.refresh();
    first.setDraft('lead', 'Refused one');
    await first.send();
    server.reject = false;
    gate = Completer<void>();
    first.setDraft('lead', 'In flight');
    final flying = first.send();
    await pumpEventQueue();

    await _signOut(client);
    gate.complete();
    await flying;
    await pumpEventQueue();
    expect(first.outgoing('lead'), isEmpty);
    expect(store.values[_key], contains('Refused one'));
    expect(store.values[_key], contains('In flight'));

    client.bind('owner');
    final again = await client.open('tab');
    await again.refresh();
    expect(again.outgoing('lead').map((m) => m.text), contains('Refused one'));
    // The answer came after sign-out: the backend's transcript or its receipt
    // says it arrived, and it shows once.
    expect(
      [
        ...again.messages('lead').map((m) => m.text),
        ...again.outgoing('lead').map((m) => m.text),
      ].where((t) => t == 'In flight'),
      hasLength(1),
    );
  });

  test(
    'the web still forgets what a signed-out account left (#2333)',
    () async {
      final server = ConversationServer()..reject = true;
      final store = _BrowserStore();
      final client = _client(
        server,
        store,
        reading: const SuperTabReading(drawsSaved: true),
      );
      addTearDown(client.dispose);
      client.bind('owner');
      final first = await client.open('tab');
      await first.refresh();
      first.setDraft('lead', 'Not on a shared browser');
      await first.send();
      expect(first.outgoing('lead'), hasLength(1));

      await _signOut(client);
      await client.forgotten;
      await pumpEventQueue();
      expect(
        store.values[_key] ?? '',
        isNot(contains('Not on a shared browser')),
      );
      client.bind('owner');
      final again = await client.open('tab');
      await again.refresh();
      expect(again.outgoing('lead'), isEmpty);
    },
  );
}
