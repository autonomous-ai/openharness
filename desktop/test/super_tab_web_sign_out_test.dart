import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/super_tabs/account_keys.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/reading.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore;

// Signing out on the web clears what the browser keeps of that account's
// Swarms beside its saved views (Huy, 10-30, the follow-up of #2306): its
// drafts, launches, hidden Swarms and switcher pick. Another account's stay,
// and a save that lands after the sign-out writes nothing.

/// The browser's storage: it can list its keys.
class _BrowserStore extends MemoryStore
    implements KeyListingLocalKeyValueStore {
  @override
  Future<List<String>> keys() async => values.keys.toList();
}

const _web = SuperTabReading(
  quietPoll: Duration(seconds: 15),
  pausesAway: true,
  readsOnConnect: true,
  connectGrace: Duration(seconds: 10),
  messagesWithState: true,
  drawsSaved: true,
);

/// What an account keeps here beside its saved views.
Map<String, String> _kept(String account) => {
  'super_tab.$account.tab': '{"drafts":{"lead":"half a sentence"}}',
  'super_tab.launch.$account.desk.lead': '{"phase":"draft"}',
  'super_tab.hidden.$account': '["other"]',
  'super_tab.personal.$account': 'tab',
};

Future<Object?> _transport(
  ConversationServer server,
  String method,
  String path, {
  Map<String, dynamic>? body,
}) async {
  if (Uri.parse(path).path == '/api/super-tabs/list') {
    return {
      'tabs': [
        {'id': 'tab', 'name': 'Pilot'},
      ],
      'next': null,
    };
  }
  return server.request(method, path, body: body);
}

SuperTabClient _client(
  LocalKeyValueStore store, {
  SuperTabReading reading = _web,
  ConversationServer? server,
}) {
  final backend = server ?? ConversationServer();
  return SuperTabClient(
    transport: (method, path, {body}) =>
        _transport(backend, method, path, body: body),
    storage: store,
    discoveryInterval: Duration.zero,
  )..reading = reading;
}

Iterable<String> _swarmKeys(MemoryStore store, String account) =>
    store.values.keys.where((key) => swarmKeyAccount(key) == account);

void main() {
  test('names whose each Swarm key is, and no one for the saved views', () {
    expect(swarmKeyAccount('super_tab.owner.tab'), 'owner');
    expect(swarmKeyAccount('super_tab.launch.owner.desk.lead'), 'owner');
    expect(swarmKeyAccount('super_tab.hidden.owner'), 'owner');
    expect(swarmKeyAccount('super_tab.personal.owner'), 'owner');
    for (final key in [
      'super_tab.view.owner.tab',
      'super_tab.views.owner',
      'super_tab.saved_by',
      signedOutAccountsKey,
      'super_tab.owner',
      'harness.other',
      'theme',
    ]) {
      expect(swarmKeyAccount(key), isNull, reason: key);
    }
  });

  test('signing out clears that account\'s drafts, launches, hidden Swarms '
      'and pick, and keeps another account\'s', () async {
    final store = _BrowserStore()
      ..values.addAll(_kept('owner'))
      ..values.addAll(_kept('other'))
      ..values['theme'] = 'dark';
    final client = _client(store);
    addTearDown(client.dispose);
    client.bind('owner');
    await client.forgotten;
    expect(_swarmKeys(store, 'owner'), hasLength(4));

    client.bind(null);
    await client.forgotten;
    expect(_swarmKeys(store, 'owner'), isEmpty);
    expect(
      Map.fromEntries(
        _swarmKeys(store, 'other').map((k) => MapEntry(k, store.values[k])),
      ),
      _kept('other'),
    );
    expect(store.values['theme'], 'dark');
  });

  test(
    'switching accounts clears the one leaving and keeps the one coming',
    () async {
      final store = _BrowserStore()
        ..values.addAll(_kept('owner'))
        ..values.addAll(_kept('other'));
      final client = _client(store);
      addTearDown(client.dispose);
      client.bind('owner');
      client.bind('other');
      await client.forgotten;
      expect(_swarmKeys(store, 'owner'), isEmpty);
      expect(_swarmKeys(store, 'other'), hasLength(4));
    },
  );

  test('a draft saved after the sign-out writes nothing: its timer, the '
      'close\'s flush, a hidden Swarm and a launch or pick saved late', () {
    fakeAsync((async) {
      final store = _BrowserStore();
      final client = _client(store, server: ConversationServer()..append('Hi'));
      addTearDown(client.dispose);
      client
        ..bind('owner')
        ..show('tab');
      SuperTabController? c;
      client.open('tab').then((opened) => c = opened);
      async.elapse(const Duration(seconds: 1));
      expect(c, isNotNull);
      // Typed just before signing out: the 200 ms save is still waiting.
      c!.setDraft('lead', 'half a sentence');
      final hiding = client.setTabVisible('tab', false);
      client.bind(null);
      async.elapse(const Duration(seconds: 1));
      unawaited(hiding);
      // A launch form and the switcher answer after the sign-out.
      unawaited(client.storage.write('super_tab.launch.owner.desk.lead', '{}'));
      unawaited(client.storage.write('super_tab.personal.owner', 'tab'));
      async.elapse(const Duration(seconds: 1));
      expect(_swarmKeys(store, 'owner'), isEmpty);
    });
  });

  test('a key another page wrote after the sign-out goes at the next sign-in '
      'or reload, and comes back once that account signs in again', () async {
    final store = _BrowserStore();
    final client = _client(store);
    addTearDown(client.dispose);
    client.bind('owner');
    client.bind(null);
    await client.forgotten;
    // Another page of this browser had not reloaded yet.
    store.values.addAll(_kept('owner'));
    final reload = _client(store);
    addTearDown(reload.dispose);
    reload.bind('other');
    await reload.forgotten;
    expect(_swarmKeys(store, 'owner'), isEmpty);

    // Signed in again: theirs to keep from now on.
    reload.bind('owner');
    await reload.forgotten;
    await reload.storage.write('super_tab.personal.owner', 'tab');
    expect(store.values['super_tab.personal.owner'], 'tab');
    reload.bind('owner2');
    await reload.forgotten;
    final again = _client(store);
    addTearDown(again.dispose);
    again.bind('owner');
    await again.forgotten;
    await again.storage.write('super_tab.hidden.owner', '[]');
    expect(store.values['super_tab.hidden.owner'], '[]');
  });

  test('remembers a bounded number of accounts signed out here', () async {
    final store = _BrowserStore();
    for (var i = 0; i < maxSignedOutAccounts + 4; i++) {
      await forgetSwarmAccounts(store, bound: null, leaving: 'a$i');
    }
    final kept = store.values[signedOutAccountsKey]!;
    expect(kept, isNot(contains('"a0"')));
    expect(kept, contains('"a${maxSignedOutAccounts + 3}"'));
  });

  test(
    'Desktop keeps each account\'s drafts when it signs out, as before',
    () async {
      final store = _BrowserStore()..values.addAll(_kept('owner'));
      final client = _client(store, reading: SuperTabReading.desktop);
      addTearDown(client.dispose);
      client.bind('owner');
      client.bind(null);
      await client.forgotten;
      await client.storage.write('super_tab.personal.owner', 'other');
      expect(_swarmKeys(store, 'owner'), hasLength(4));
      expect(store.values['super_tab.personal.owner'], 'other');
    },
  );
}
