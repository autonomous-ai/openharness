import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/reading.dart';
import 'package:harness/super_tabs/saved_view.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore;

/// A view as a controller hands it over: the state as read, the open
/// conversation and its last page.
Map<String, dynamic> _view({String tab = 'tab', int pad = 0}) {
  final server = ConversationServer()..append('Hello');
  server.state['id'] = tab;
  server.state['starts'] = [
    {
      'id': 'start',
      'request': {'task': 'A task the page never draws.'},
    },
  ];
  if (pad > 0) server.state['name'] = 'x' * pad;
  return {
    'revision': 7,
    'state': server.state,
    'conversationId': 'lead',
    'messages': server.messages,
    'next': null,
  };
}

void main() {
  group('a controller', _controllerTests);
  group('the client', _clientTests);

  test('keeps what the Swarm draws, not what it never shows', () async {
    final store = MemoryStore();
    final views = SuperTabSavedViews(store);
    await views.write('owner', 'tab', _view());
    final read = (await views.read('owner', 'tab'))!;
    expect(read['revision'], 7);
    expect(read['conversationId'], 'lead');
    expect((read['messages'] as List).single['text'], 'Hello');
    final state = read['state'] as Map<String, dynamic>;
    expect(state['name'], 'Pilot');
    expect(state.containsKey('starts'), isFalse);
    expect(store.values.values.join(), isNot(contains('never draws')));
  });

  test('a view over the size cap is not kept, and an older one goes', () async {
    final store = MemoryStore();
    final views = SuperTabSavedViews(store, maxBytes: 4096);
    await views.write('owner', 'tab', _view());
    expect(await views.read('owner', 'tab'), isNotNull);
    await views.write('owner', 'tab', _view(pad: 8000));
    expect(await views.read('owner', 'tab'), isNull);
    expect(
      store.values.values.every((v) => utf8.encode(v).length <= 4096),
      isTrue,
    );
  });

  test('an account keeps its three most recent Swarms', () async {
    final views = SuperTabSavedViews(MemoryStore());
    for (final tab in ['a', 'b', 'c', 'd']) {
      await views.write('owner', tab, _view(tab: tab));
    }
    expect(await views.read('owner', 'a'), isNull);
    for (final tab in ['b', 'c', 'd']) {
      expect(await views.read('owner', tab), isNotNull, reason: tab);
    }
    // Reading one makes it the most recent.
    await views.read('owner', 'b');
    await views.write('owner', 'e', _view(tab: 'e'));
    expect(await views.read('owner', 'c'), isNull);
    expect(await views.read('owner', 'b'), isNotNull);
  });

  test(
    'views are per account, and forgetting an account clears its own',
    () async {
      final store = MemoryStore();
      final views = SuperTabSavedViews(store);
      await views.write('owner', 'tab', _view());
      await views.write('other', 'tab', _view());
      expect(await views.read('stranger', 'tab'), isNull);
      await views.forgetAccount('owner');
      expect(await views.read('owner', 'tab'), isNull);
      expect(await views.read('other', 'tab'), isNotNull);
      expect(store.values.keys.where((k) => k.contains('owner')), isEmpty);
    },
  );

  test('a lost Swarm is forgotten; a view it cannot read is none', () async {
    final store = MemoryStore();
    final views = SuperTabSavedViews(store);
    await views.write('owner', 'tab', _view());
    await views.forget('owner', 'tab');
    expect(await views.read('owner', 'tab'), isNull);
    await store.write('super_tab.view.owner.tab', '{not json');
    expect(await views.read('owner', 'tab'), isNull);
  });
}

const _web = SuperTabReading(
  quietPoll: Duration(seconds: 15),
  pausesAway: true,
  readsOnConnect: true,
  connectGrace: Duration(seconds: 10),
  messagesWithState: true,
  drawsSaved: true,
);

/// Every GET the controller made, answered by [server] unless [missing].
class _Reads {
  _Reads(this.server);
  final ConversationServer server;
  final paths = <String>[];
  bool missing = false;
  Future<Map<String, dynamic>> call(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) {
    if (method == 'GET') paths.add(path);
    if (missing) {
      return Future.error(
        const SuperTabFailure(
          'MACHINE_UNAVAILABLE',
          'Connect one of your machines to open Swarm.',
        ),
      );
    }
    return server.request(method, path, body: body);
  }
}

SuperTabController _controller(
  _Reads reads, {
  SuperTabReading reading = _web,
  String selected = 'lead',
}) => SuperTabController(
  tabId: 'tab',
  accountId: 'owner',
  request: reads.call,
  save: reads.server.save,
  initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': selected},
  reading: reading,
);

/// What a controller that read [server] once would save.
Map<String, dynamic> _saved(ConversationServer server) {
  late Map<String, dynamic> view;
  fakeAsync((async) {
    final c = _controller(_Reads(server))..start();
    async.flushMicrotasks();
    view = c.savedView!;
    c.dispose();
  });
  return jsonDecode(jsonEncode(view)) as Map<String, dynamic>;
}

void _controllerTests() {
  test('a saved view draws at once, then the first read replaces it', () {
    final server = ConversationServer()..append('Please start.');
    server.messages.first['deliveries'] = [
      {'id': 'delivery', 'agentId': 'lead-agent', 'status': 'claimed'},
    ];
    final view = _saved(server);
    fakeAsync((async) {
      server
        ..messages.first['deliveries'] = [
          {'id': 'delivery', 'agentId': 'lead-agent', 'status': 'delivered'},
        ]
        ..append('Done.')
        ..holdReads = Completer<void>();
      final reads = _Reads(server);
      final c = _controller(reads)..drawSaved(view);
      expect(c.snapshot!.name, 'Pilot');
      expect(c.messages('lead').single.text, 'Please start.');
      expect(c.showingSaved, isTrue);
      expect(c.loading, isFalse);
      c.start();
      async.flushMicrotasks();
      expect(c.loading, isFalse);
      // The state and the latest page: receipts and new messages in one read.
      expect(reads.paths, [
        '/api/super-tabs/tab/conversations/lead/messages',
        '/api/super-tabs/tab',
      ]);
      server.holdReads!.complete();
      server.holdReads = null;
      async.flushMicrotasks();
      expect(c.showingSaved, isFalse);
      expect(c.messages('lead').map((m) => m.text), ['Please start.', 'Done.']);
      expect(c.messages('lead').first.deliveries.single['status'], 'delivered');
      c.dispose();
    });
  });

  test('a saved view of another conversation draws the state only', () {
    final server = ConversationServer()..append('Hello');
    final view = _saved(server);
    fakeAsync((async) {
      final c = _controller(_Reads(server), selected: 'offline')
        ..drawSaved(view);
      expect(c.snapshot, isNotNull);
      expect(c.messages('offline'), isEmpty);
      expect(c.messages('lead'), isEmpty);
      c.dispose();
    });
  });

  test('a saved view of another Swarm, or a broken one, draws nothing', () {
    final server = ConversationServer()..append('Hello');
    final view = _saved(server);
    fakeAsync((async) {
      final other = SuperTabController(
        tabId: 'other',
        accountId: 'owner',
        request: _Reads(server).call,
        save: server.save,
        reading: _web,
      )..drawSaved(view);
      expect(other.snapshot, isNull);
      final broken = _controller(_Reads(server))
        ..drawSaved({
          ...view,
          'state': {'id': 'tab'},
        });
      expect(broken.snapshot, isNull);
      expect(broken.showingSaved, isFalse);
      other.dispose();
      broken.dispose();
    });
  });

  test('with no machine yet the saved view stays, without the error', () {
    final server = ConversationServer()..append('Hello');
    final view = _saved(server);
    fakeAsync((async) {
      final reads = _Reads(server)..missing = true;
      final c = _controller(reads)
        ..drawSaved(view)
        ..start();
      async.elapse(const Duration(seconds: 9));
      expect(c.error, isNull);
      expect(c.messages('lead').single.text, 'Hello');
      expect(c.showingSaved, isTrue);
      reads.missing = false;
      unawaited(c.machineAvailable());
      async.flushMicrotasks();
      expect(c.showingSaved, isFalse);
      c.dispose();
    });
  });

  test('Desktop reading keeps no saved view and draws none', () {
    final server = ConversationServer()..append('Hello');
    final view = _saved(server);
    fakeAsync((async) {
      final c = _controller(_Reads(server), reading: const SuperTabReading())
        ..drawSaved(view);
      expect(c.snapshot, isNull);
      c.start();
      async.flushMicrotasks();
      expect(c.savedView, isNull);
      c.dispose();
    });
  });
}

/// One Swarm behind a transport that may hold its answers.
class _Transport {
  _Transport(this.server);
  final ConversationServer server;
  Completer<void>? hold;
  SuperTabFailure? refuse;
  Future<Object?> call(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (hold case final wait?) await wait.future;
    if (refuse case final failure?) throw failure;
    if (Uri.parse(path).path == '/api/super-tabs') {
      return {
        'tabs': [
          {'id': 'tab', 'name': 'Pilot'},
        ],
        'next': null,
      };
    }
    return server.request(method, path, body: body);
  }
}

/// Writes to the saved views, by key.
class _CountingStore extends MemoryStore {
  final writes = <String>[];
  @override
  Future<void> write(String key, String value) {
    writes.add(key);
    return super.write(key, value);
  }
}

SuperTabClient _client(
  _Transport transport,
  MemoryStore store, {
  SuperTabReading reading = _web,
}) => SuperTabClient(
  transport: transport.call,
  storage: store,
  discoveryInterval: Duration.zero,
)..reading = reading;

const _viewKey = 'super_tab.view.owner.tab';

void _clientTests() {
  test('the next open draws the saved view before anything answers', () {
    fakeAsync((async) {
      final server = ConversationServer()..append('Hello');
      final store = MemoryStore();
      final first = _client(_Transport(server), store)
        ..bind('owner')
        ..show('tab');
      first.open('tab');
      async.elapse(const Duration(seconds: 1));
      first.show(null);
      async.flushMicrotasks();
      expect(store.values[_viewKey], isNotNull);
      // A reload: a new client, on the same device, whose reads are slow.
      final transport = _Transport(server)..hold = Completer<void>();
      final second = _client(transport, store)
        ..bind('owner')
        ..show('tab');
      SuperTabController? c;
      second.open('tab').then((opened) => c = opened);
      async.flushMicrotasks();
      expect(c!.messages('lead').single.text, 'Hello');
      expect(c!.showingSaved, isTrue);
      transport.hold!.complete();
      transport.hold = null;
      async.flushMicrotasks();
      expect(c!.showingSaved, isFalse);
      first.dispose();
      second.dispose();
    });
  });

  test('a busy Swarm saves at most every 15 s, and at once on going away', () {
    fakeAsync((async) {
      final server = ConversationServer()..append('Hello');
      final store = _CountingStore();
      final client = _client(_Transport(server), store)
        ..bind('owner')
        ..show('tab');
      client.open('tab');
      async.elapse(const Duration(seconds: 1));
      store.writes.clear();
      for (var i = 0; i < 20; i++) {
        server.append('Update $i');
        async.elapse(const Duration(seconds: 3));
      }
      expect(
        store.writes.where((k) => k == _viewKey).length,
        inInclusiveRange(4, 5),
      );
      store.writes.clear();
      server.append('Last one.');
      async.elapse(const Duration(seconds: 3));
      client.show(null);
      async.flushMicrotasks();
      expect(store.writes, contains(_viewKey));
      expect(store.values[_viewKey], contains('Last one.'));
      client.dispose();
    });
  });

  test('signing out or losing the Swarm leaves no saved view behind', () {
    fakeAsync((async) {
      final server = ConversationServer()..append('Hello');
      final store = MemoryStore();
      final transport = _Transport(server);
      final client = _client(transport, store)
        ..bind('owner')
        ..show('tab');
      client.open('tab');
      async.elapse(const Duration(seconds: 1));
      client.show(null);
      async.flushMicrotasks();
      expect(store.values[_viewKey], isNotNull);
      client.bind('someone-else');
      async.flushMicrotasks();
      expect(
        store.values.keys.where(
          (k) => k.startsWith('super_tab.view') && k.contains('owner'),
        ),
        isEmpty,
      );
      // Lost access forgets that Swarm's view.
      client
        ..bind('owner')
        ..show('tab');
      client.open('tab');
      async.elapse(const Duration(seconds: 1));
      client.show(null);
      async.flushMicrotasks();
      expect(store.values[_viewKey], isNotNull);
      client.show('tab');
      transport.refuse = const SuperTabFailure(
        'FORBIDDEN',
        'You no longer have access to this Swarm.',
        statusCode: 403,
      );
      async.elapse(const Duration(seconds: 4));
      expect(store.values[_viewKey], isNull);
      client.dispose();
    });
  });

  test('Desktop reading keeps nothing on the device', () {
    fakeAsync((async) {
      final server = ConversationServer()..append('Hello');
      final store = MemoryStore();
      final client = _client(
        _Transport(server),
        store,
        reading: const SuperTabReading(),
      )..bind('owner');
      client.open('tab');
      for (var i = 0; i < 5; i++) {
        server.append('Update $i');
        async.elapse(const Duration(seconds: 3));
      }
      client.pageVisible = false;
      async.flushMicrotasks();
      expect(
        store.values.keys.where((k) => k.contains('super_tab.view')),
        isEmpty,
      );
      client.dispose();
    });
  });
}
