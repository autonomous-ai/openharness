import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/parts.dart';
import 'package:harness/super_tabs/reading.dart';
import 'package:harness/super_tabs/saved_view.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore;

/// A view as a controller hands it over: the Swarm's parts as read, the open
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
  final load = server.parts.read('/api/super-tabs/$tab/parts', server.state)!;
  return {
    'format': 2,
    'savedAt': DateTime.now().millisecondsSinceEpoch,
    'lastChangedAt': 7,
    'parts': SuperTabParts.firstLoad(load).toJson(),
    'conversationId': 'lead',
    'messages': server.messages,
    'next': null,
  };
}

void main() {
  group('a controller', _controllerTests);
  group('the client', _clientTests);
  group('review of #1723', _reviewTests);
  group('re-review of #1727', _reReviewTests);

  test('keeps what the Swarm draws, not what it never shows', () async {
    final store = MemoryStore();
    final views = SuperTabSavedViews(store);
    await views.claim('owner');
    await views.write('owner', 'tab', _view());
    final read = (await views.read('owner', 'tab'))!;
    expect(read['lastChangedAt'], 7);
    expect(read['conversationId'], 'lead');
    expect((read['messages'] as List).single['text'], 'Hello');
    final state = SuperTabParts.fromJson(superTabMap(read['parts'])).state;
    expect(state['name'], 'Pilot');
    expect(state['starts'], isEmpty);
    expect(store.values.values.join(), isNot(contains('never draws')));
  });

  test('a view an older build saved is not drawn', () async {
    final store = MemoryStore();
    final views = SuperTabSavedViews(store);
    await views.claim('owner');
    await store.write(
      'super_tab.view.owner.tab',
      jsonEncode({
        'revision': 7,
        'state': ConversationServer().state,
        'conversationId': 'lead',
        'messages': <dynamic>[],
        'next': null,
      }),
    );
    expect(await views.read('owner', 'tab'), isNull);
  });

  test('a view over the size cap is not kept, and an older one goes', () async {
    final store = MemoryStore();
    final views = SuperTabSavedViews(store, maxBytes: 4096);
    await views.claim('owner');
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
    await views.claim('owner');
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
      await views.claim('owner');
      await views.write('owner', 'tab', _view());
      expect(await views.read('stranger', 'tab'), isNull);
      expect(await views.read('owner', 'tab'), isNotNull);
      await views.forgetAccount('owner');
      expect(await views.read('owner', 'tab'), isNull);
      expect(
        store.values.keys.where((k) => k.startsWith('super_tab.view')),
        isEmpty,
      );
    },
  );

  test('a lost Swarm is forgotten; a view it cannot read is none', () async {
    final store = MemoryStore();
    final views = SuperTabSavedViews(store);
    await views.claim('owner');
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
      // What changed since the view was saved, and the latest page:
      // receipts and new messages in one read.
      expect(reads.paths, [
        '/api/super-tabs/tab/conversations/lead/messages',
        startsWith('/api/super-tabs/tab/changes?cursor='),
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
          'parts': {
            'load': {'format': 2},
          },
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

  test(
    'a saved view from another epoch draws, then the first read loads in full',
    () {
      final server = ConversationServer()..append('Hello');
      final view = _saved(server);
      fakeAsync((async) {
        server.parts.epoch++;
        final reads = _Reads(server);
        final c = _controller(reads)..drawSaved(view);
        expect(c.showingSaved, isTrue);
        c.start();
        async.flushMicrotasks();
        expect(reads.paths.where((p) => !p.contains('/messages')), [
          startsWith('/api/super-tabs/tab/changes?cursor='),
          '/api/super-tabs/tab/parts',
        ]);
        expect(c.showingSaved, isFalse);
        expect(c.snapshot!.name, 'Pilot');
        c.dispose();
      });
    },
  );

  test('a saved view older than seven days is not drawn', () {
    final server = ConversationServer()..append('Hello');
    final view = _saved(server);
    fakeAsync((async) {
      final reads = _Reads(server);
      final c = _controller(reads)
        ..drawSaved({
          ...view,
          'savedAt': DateTime.now()
              .subtract(const Duration(days: 7))
              .millisecondsSinceEpoch,
        });
      expect(c.snapshot, isNull);
      c.start();
      async.flushMicrotasks();
      expect(reads.paths.where((p) => !p.contains('/messages')), [
        '/api/super-tabs/tab/parts',
      ]);
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

/// When the saved view is read, among the requests a test records.
class _OrderStore extends MemoryStore {
  final order = <String>[];

  /// How long reading the saved view takes, as a slow device's storage.
  Duration viewDelay = Duration.zero;
  @override
  Future<String?> read(String key) async {
    if (key == _viewKey) {
      order.add('view');
      if (viewDelay > Duration.zero) await Future<void>.delayed(viewDelay);
    }
    return super.read(key);
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

  test('the first read is asked for before the saved view is read', () {
    fakeAsync((async) {
      final server = ConversationServer()..append('Hello');
      final store = _OrderStore();
      final first = _client(_Transport(server), store)
        ..bind('owner')
        ..show('tab');
      first.open('tab');
      async.elapse(const Duration(seconds: 1));
      first.show(null);
      async.flushMicrotasks();
      store.order.clear();
      final transport = _Transport(server)..hold = Completer<void>();
      final second =
          SuperTabClient(
              transport: (method, path, {body}) {
                store.order.add('request');
                return transport.call(method, path, body: body);
              },
              storage: store,
              discoveryInterval: Duration.zero,
            )
            ..reading = _web
            ..bind('owner')
            ..show('tab');
      SuperTabController? c;
      second.open('tab').then((opened) => c = opened);
      async.flushMicrotasks();
      expect(store.order.first, 'request');
      expect(store.order, contains('view'));
      expect(c!.showingSaved, isTrue);
      expect(c!.messages('lead').single.text, 'Hello');
      transport.hold!.complete();
      transport.hold = null;
      async.flushMicrotasks();
      expect(c!.showingSaved, isFalse);
      first.dispose();
      second.dispose();
    });
  });

  test('a first read that lands before the saved view is not drawn over', () {
    fakeAsync((async) {
      final server = ConversationServer()..append('Hello');
      final store = _OrderStore();
      final first = _client(_Transport(server), store)
        ..bind('owner')
        ..show('tab');
      first.open('tab');
      async.elapse(const Duration(seconds: 1));
      first.show(null);
      async.flushMicrotasks();
      server.append('Newer.');
      store.viewDelay = const Duration(milliseconds: 500);
      final second = _client(_Transport(server), store)
        ..bind('owner')
        ..show('tab');
      SuperTabController? c;
      second.open('tab').then((opened) => c = opened);
      async.elapse(const Duration(seconds: 1));
      expect(c!.showingSaved, isFalse);
      expect(c!.messages('lead').map((m) => m.text), ['Hello', 'Newer.']);
      first.dispose();
      second.dispose();
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

/// A store that refuses, as a full (writes) or private-mode (reads too)
/// browser storage does.
class _FailingStore extends MemoryStore {
  bool refuseReads = false, refuseWrites = false;
  @override
  Future<String?> read(String key) async {
    if (refuseReads && key.startsWith('super_tab.view')) {
      throw StateError('SecurityError');
    }
    return super.read(key);
  }

  @override
  Future<void> write(String key, String value) async {
    if (refuseWrites && key.startsWith('super_tab.view')) {
      throw StateError('QuotaExceededError');
    }
    return super.write(key, value);
  }
}

/// Every key the client touched, reads and deletes included.
class _TouchStore extends MemoryStore {
  final touched = <String>[];
  @override
  Future<String?> read(String key) {
    touched.add(key);
    return super.read(key);
  }

  @override
  Future<void> delete(String key) {
    touched.add(key);
    return super.delete(key);
  }
}

/// Saves [server]'s Swarm as `owner` through a client on [store], then
/// leaves it, as a person does before closing the page.
void _visit(FakeAsync async, ConversationServer server, MemoryStore store) {
  final client = _client(_Transport(server), store)
    ..bind('owner')
    ..show('tab');
  client.open('tab');
  async.elapse(const Duration(seconds: 1));
  client.show(null);
  async.flushMicrotasks();
  // Not disposed: closing a page signs nobody out (dispose is a sign-out).
}

/// A browser store whose cross-tab lock another tab holds: an iPhone
/// suspending a background tab that held it.
class _StuckLockStore extends MemoryStore
    implements SynchronizedLocalKeyValueStore {
  final release = Completer<void>();
  @override
  Future<T> synchronized<T>(String scope, Future<T> Function() action) =>
      release.future.then((_) => action());
}

void _reReviewTests() {
  // Minor a.
  test('a lock another tab holds delays the open no more than 250 ms', () {
    fakeAsync((async) {
      final server = ConversationServer()..append('Hello');
      final store = _StuckLockStore();
      final client = _client(_Transport(server), store)
        ..bind('owner')
        ..show('tab');
      SuperTabController? c;
      client.open('tab').then((opened) => c = opened);
      async.elapse(const Duration(milliseconds: 249));
      expect(c, isNull);
      async.elapse(const Duration(milliseconds: 2));
      expect(c, isNotNull);
      expect(c!.showingSaved, isFalse);
      expect(c!.messages('lead').single.text, 'Hello');
      store.release.complete();
      async.flushMicrotasks();
      client.dispose();
    });
  });

  // Minor b.
  test('after a sign-out elsewhere, a late write keeps nothing', () async {
    final store = MemoryStore();
    final views = SuperTabSavedViews(store);
    await views.claim('owner');
    await views.write('owner', 'tab', _view());
    expect(store.values[_viewKey], isNotNull);
    // Another browser tab signs out: the device keeps nobody's views now.
    await SuperTabSavedViews(store).claim(null);
    expect(store.values[_viewKey], isNull);
    await views.write('owner', 'tab', _view());
    expect(store.values[_viewKey], isNull);
    // Nor one written for another account than the one using the device.
    await views.claim('someone-else');
    await views.write('owner', 'tab', _view());
    expect(store.values[_viewKey], isNull);
  });
}

void _reviewTests() {
  // Finding 1.
  test('more than a page since the save leaves no gap in the transcript', () {
    final server = ConversationServer();
    for (var i = 1; i <= 120; i++) {
      server.append('m$i');
    }
    final view = _saved(server);
    fakeAsync((async) {
      for (var i = 121; i <= 270; i++) {
        server.append('m$i');
      }
      final c = _controller(_Reads(server))
        ..drawSaved(view)
        ..start();
      async.flushMicrotasks();
      final shown = c.messages('lead').map((m) => m.text).toList();
      expect(shown.length, 100);
      expect(shown.first, 'm171');
      expect(shown.last, 'm270');
      unawaited(c.loadMessages('lead', older: true));
      async.flushMicrotasks();
      final sequences = c.messages('lead').map((m) => m.sequence).toList();
      expect(sequences.first, 71);
      for (var i = 1; i < sequences.length; i++) {
        expect(sequences[i], sequences[i - 1] + 1, reason: 'at $i');
      }
      c.dispose();
    });
  });

  // Finding 2.
  test('nothing is written back while the saved view is on screen', () {
    fakeAsync((async) {
      final server = ConversationServer()..append('Hello');
      final store = _CountingStore();
      _visit(async, server, store);
      server.append('Newer.');
      store.writes.clear();
      final transport = _Transport(server)..hold = Completer<void>();
      final client = _client(transport, store)
        ..bind('owner')
        ..show('tab');
      client.open('tab');
      async.elapse(const Duration(seconds: 2));
      expect(store.writes.where((k) => k == _viewKey), isEmpty);
      transport.hold!.complete();
      transport.hold = null;
      async.elapse(const Duration(seconds: 1));
      // The fresh view is kept at once, not 15 s later.
      expect(store.writes.where((k) => k == _viewKey), hasLength(1));
      expect(store.values[_viewKey], contains('Newer.'));
      client.dispose();
    });
  });

  // Finding 3.
  for (final (name, full, private) in [
    ('full', true, false),
    ('private mode', true, true),
  ]) {
    test('a $name storage opens the Swarm as today, with one poll', () {
      fakeAsync((async) {
        final server = ConversationServer()..append('Hello');
        final store = _FailingStore();
        _visit(async, server, store);
        store
          ..refuseWrites = full
          ..refuseReads = private;
        final reads = <String>[];
        final transport = _Transport(server)..hold = Completer<void>();
        final client =
            SuperTabClient(
                transport: (method, path, {body}) {
                  if (path == '/api/super-tabs/tab/parts' ||
                      path.startsWith('/api/super-tabs/tab/changes?')) {
                    reads.add(path);
                  }
                  return transport.call(method, path, body: body);
                },
                storage: store,
                discoveryInterval: Duration.zero,
              )
              ..reading = _web
              ..bind('owner')
              ..show('tab');
        SuperTabController? c;
        Object? failed;
        client
            .open('tab')
            .then<void>(
              (opened) => c = opened,
              onError: (Object e) => failed = e,
            );
        async.flushMicrotasks();
        // A full storage still reads: the saved view draws. Private mode
        // reads nothing: the Swarm opens as today.
        expect(failed, isNull);
        expect(c!.showingSaved, !private);
        transport.hold!.complete();
        transport.hold = null;
        async.elapse(const Duration(milliseconds: 7100));
        expect(c!.error, isNull);
        expect(c!.messages('lead').single.text, 'Hello');
        expect(reads, hasLength(3));
        // Leaving and signing out: no error escapes either.
        client.show(null);
        client.bind('someone-else');
        async.flushMicrotasks();
        client.dispose();
      });
    });
  }

  // Finding 4.
  test('views saved at the same moment all stay listed, and all go', () async {
    final store = MemoryStore();
    final views = SuperTabSavedViews(store);
    await views.claim('owner');
    await Future.wait([
      views.write('owner', 'a', _view(tab: 'a')),
      views.write('owner', 'b', _view(tab: 'b')),
      views.write('owner', 'c', _view(tab: 'c')),
    ]);
    for (final tab in ['a', 'b', 'c']) {
      expect(store.values['super_tab.view.owner.$tab'], isNotNull, reason: tab);
    }
    // Signing out then finds every one of them.
    await views.forgetAccount('owner');
    expect(
      store.values.keys.where((k) => k.startsWith('super_tab.view')),
      isEmpty,
    );
  });

  // Finding 5.
  test('another account after a reload clears the one before', () {
    fakeAsync((async) {
      final server = ConversationServer()..append('Hello');
      final store = MemoryStore();
      _visit(async, server, store);
      expect(store.values[_viewKey], isNotNull);
      // The same account after a reload keeps its view.
      _client(_Transport(server), store).bind('owner');
      async.flushMicrotasks();
      expect(store.values[_viewKey], isNotNull);
      // Another account on the next page load: nothing of the first stays.
      final other = _client(_Transport(server), store)..bind('someone-else');
      async.flushMicrotasks();
      expect(
        store.values.keys.where(
          (k) => k.startsWith('super_tab.view') && k.contains('owner'),
        ),
        isEmpty,
      );
      other.dispose();
    });
  });

  test('at boot the account binds before the web says views are kept', () {
    fakeAsync((async) {
      final server = ConversationServer()..append('Hello');
      final store = MemoryStore();
      _visit(async, server, store);
      // As AppNotifier does: the account first, the workspace's reading after.
      SuperTabClient(
          transport: _Transport(server).call,
          storage: store,
          discoveryInterval: Duration.zero,
        )
        ..bind('someone-else')
        ..reading = _web;
      async.flushMicrotasks();
      expect(store.values[_viewKey], isNull);
    });
  });

  // Finding 6.
  test('the first read wins over a saved view, whatever its revision', () {
    final server = ConversationServer()..append('Hello');
    final view = _saved(server)..['lastChangedAt'] = 1 << 50;
    fakeAsync((async) {
      server.state['name'] = 'Pilot, renamed';
      final c = _controller(_Reads(server))
        ..drawSaved(view)
        ..start();
      async.flushMicrotasks();
      expect(c.showingSaved, isFalse);
      expect(c.snapshot!.name, 'Pilot, renamed');
      c.dispose();
    });
  });

  // Finding 8.
  test('a change of the page only, not of what was read, writes nothing', () {
    fakeAsync((async) {
      final server = ConversationServer()..append('Hello');
      final store = _CountingStore();
      final client = _client(_Transport(server), store)
        ..bind('owner')
        ..show('tab');
      SuperTabController? c;
      client.open('tab').then((opened) => c = opened);
      async.elapse(const Duration(seconds: 20));
      store.writes.clear();
      c!.markRead('lead');
      c!.toggleProject('lead');
      async.elapse(const Duration(seconds: 20));
      expect(store.writes.where((k) => k == _viewKey), isEmpty);
      client.dispose();
    });
  });

  // Finding 9.
  test('Desktop: an account change reads and deletes no saved view', () {
    fakeAsync((async) {
      final store = _TouchStore();
      final client =
          _client(
              _Transport(ConversationServer()),
              store,
              reading: const SuperTabReading(),
            )
            ..bind('owner')
            ..bind('someone-else')
            ..bind(null);
      async.flushMicrotasks();
      expect(store.touched.where((k) => k.contains('super_tab.view')), isEmpty);
      client.dispose();
    });
  });
}
