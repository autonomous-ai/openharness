import 'dart:async';
import 'dart:convert';

import 'package:harness/measurement/product_measurement.dart';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/shared_tabs.dart';
import 'package:harness/agent_messages/shared_tabs_model.dart';
import 'package:harness/ws/ws_conn.dart';

const id1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';

WsRequestFailure fail(String code, [String? detail]) =>
    WsRequestFailure(responseType: 'agent_messages_result', code: code, detail: detail);

Map<String, dynamic> shares({
  int api = 2,
  List<Map<String, dynamic>> rosters = const [],
  List<Map<String, dynamic>> notices = const [],
  List<Map<String, dynamic>> activity = const [],
}) => {
  if (api >= 2) 'api': api,
  'me': {'accountId': 'bob', 'email': 'bob@example.com', 'machineId': 'mb'},
  'rosters': rosters,
  'invites': [],
  'alerts': [],
  'pending': [],
  'notices': notices,
  'untrusted': [],
  'activity': activity,
};

Map<String, dynamic> roster({String id = id1, String? tabId, String owner = 'alice'}) => {
  'sharedTabId': id,
  'tabId': tabId,
  'version': 3,
  'name': 'app',
  'owner': {'accountId': owner, 'email': '$owner@example.com', 'machineId': 'ma', 'machinePublicKey': 'k'},
  'leader': null,
  'members': [],
  'invites': [],
  'harnesses': [
    {'accountId': 'alice', 'machineId': 'ma', 'machinePublicKey': 'k', 'agentId': 'a1', 'name': 'api', 'engine': 'claude'},
  ],
};

SharedTabsController make(SharedTabsRequest r, {void Function(SharedActivity)? onActivity, ValueNotifier<bool>? front}) =>
    SharedTabsController(request: r, foreground: front ?? ValueNotifier(true), onActivity: onActivity);

void main() {
  test('invite measurement counts acknowledgements without addresses or ids and separates pending acceptance', () async {
    final reports = <Map<String, dynamic>>[];
    final usage = ProductMeasurement(
      surface: 'desktop',
      automatic: false,
      context: ProductUsageContext(
        release: '1.2.3',
        platform: 'macos',
        production: true,
      ),
      sendSetup: (_) async => {'accepted': true},
    );
    usage.account(
      'PRIVATE_ACCOUNT',
      choice: () async => {'enabled': true, 'revision': 0},
      send: (report) async {
        reports.add(jsonDecode(jsonEncode(report)));
        return {'accepted': true};
      },
    );
    await usage.flush();
    usage.proxyVocabulary = 5;
    var pending = true;
    final c = SharedTabsController(
      foreground: ValueNotifier(true),
      measurement: usage,
      request: (p) async => switch (p['action']) {
        'share_invite' => {
          'invited': ['PRIVATE_1', 'PRIVATE_2'],
          'refused': ['PRIVATE_3'],
        },
        'share_accept' => {'sharedTabId': 'PRIVATE_TAB', 'pending': pending},
        _ => shares(),
      },
    );
    await c.act('share_invite', {
      'emails': ['PRIVATE_1', 'PRIVATE_2', 'PRIVATE_3'],
    });
    await c.act('share_accept', {'inviteId': 'PRIVATE_INVITE'});
    pending = false;
    await c.act('share_accept', {'inviteId': 'PRIVATE_INVITE'});
    await usage.flush();
    final totals = <String, int>{};
    for (final r in reports) {
      for (final e in (r['counters'] as Map).entries) {
        totals[e.key as String] = (totals[e.key] ?? 0) + (e.value as int);
      }
    }
    expect(totals['health_desktop_shared_invites_sent'], 2);
    expect(totals['health_desktop_shared_invites_refused'], 1);
    expect(totals['ui_desktop_share_accept_unknown'], 1);
    expect(totals['ui_desktop_share_accept_ok'], 1);
    expect(jsonEncode(reports), isNot(contains('PRIVATE')));
    c.dispose();
    usage.dispose();
  });

  test("reads shares, and a member's desk tab is derived from its shared tab id (R1)", () async {
    final c = make((p) async => shares(rosters: [roster()]));
    await c.refresh();
    expect(c.state, SharedTabsState.ready);
    expect(c.isShared(memberDeskTabId(id1)), isTrue);
    expect(c.isShared(id1), isFalse);
    expect(c.tabForDesk(memberDeskTabId(id1))!.harnesses.single.name, 'api');
    // Its Agent Messages are filed under both: the shared tab id for what
    // crosses accounts, the desk id for the member's own harnesses.
    expect(c.agentMessagesTabIds(memberDeskTabId(id1)), [memberDeskTabId(id1), id1]);
    expect(c.agentMessagesTabIds('other'), ['other']);
  });

  // tabForDesk asks every shared tab for its desk id, for each desk tab, on
  // every native menu flush; each answer was a fresh SHA-256.
  test("a member tab's desk id is worked out once, not on every ask", () async {
    final c = make((p) async => shares(rosters: [roster()]));
    await c.refresh();
    final tab = c.snapshot.tabs.single;
    final desk = tab.deskTabId('bob');
    expect(desk, memberDeskTabId(id1));
    expect(identical(tab.deskTabId('bob'), desk), isTrue);
    expect(identical(c.tabForDesk(desk!), tab), isTrue);
    expect(tab.deskTabId('alice'), isNull, reason: "the owner's: its own tab id");
  });

  test("the owner's tab's Agent Messages are its desk tab's alone", () async {
    final c = make((p) async => shares(rosters: [roster(owner: 'bob', tabId: 'swarm-3')]));
    await c.refresh();
    expect(c.agentMessagesTabIds('swarm-3'), ['swarm-3']);
  });

  test('a burst of refreshes is one read in flight and one after it, never parallel (final review of 1c, I4)', () async {
    final gates = <Completer<Map<String, dynamic>>>[];
    var inFlight = 0, most = 0;
    final c = make((p) {
      final gate = Completer<Map<String, dynamic>>();
      gates.add(gate);
      most = ++inFlight > most ? inFlight : most;
      return gate.future.whenComplete(() => inFlight--);
    });
    final first = c.refresh();
    final joined = [for (var i = 0; i < 10; i++) c.refresh()];
    for (var i = 0; i < 10; i++) {
      c.changed();
    }
    expect(gates, hasLength(1));
    gates.single.complete(shares());
    await Future<void>.delayed(Duration.zero);
    // The trailing read, for everything asked while the first was in flight.
    expect(gates, hasLength(2));
    gates.last.complete(shares(rosters: [roster()]));
    await first;
    await Future.wait(joined);
    expect(gates, hasLength(2));
    expect(most, 1);
    // Everyone who waited saw the trailing read's answer.
    expect(c.snapshot.tabs, hasLength(1));
    // Quiet again: the next refresh is a read of its own.
    final next = c.refresh();
    expect(gates, hasLength(3));
    gates.last.complete(shares());
    await next;
  });

  test('a refresh after a reset does not wait on the read from before it', () async {
    final gates = <Completer<Map<String, dynamic>>>[];
    final c = make((p) {
      final gate = Completer<Map<String, dynamic>>();
      gates.add(gate);
      return gate.future;
    });
    final old = c.refresh();
    c.reset();
    final fresh = c.refresh();
    expect(gates, hasLength(2));
    gates.last.complete(shares(rosters: [roster()]));
    await fresh;
    expect(c.snapshot.tabs, hasLength(1));
    // The old read lands late, is dropped, and asks for nothing more.
    c.refresh();
    gates.first.complete(shares());
    await old;
    await Future<void>.delayed(Duration.zero);
    expect(c.snapshot.tabs, hasLength(1));
  });

  test('an owned tab is found under the desk tab it was shared from', () async {
    final c = make((p) async => shares(rosters: [roster(owner: 'bob', tabId: 'swarm-3')]));
    await c.refresh();
    expect(c.isShared('swarm-3'), isTrue);
    expect(c.isShared(id1), isFalse);
  });

  test('an owned tab without a desk tab id is in no desk tab', () async {
    final c = make((p) async => shares(rosters: [roster(owner: 'bob')]));
    await c.refresh();
    expect(c.snapshot.tabs, hasLength(1));
    expect(c.isShared(id1), isFalse);
  });

  for (final (code, state) in [
    ('UNKNOWN_ACTION', SharedTabsState.tooOld),
    ('DAEMON_TOO_OLD', SharedTabsState.tooOld),
    ('UNSUPPORTED', SharedTabsState.tooOld),
    ('MESSAGES_OFF', SharedTabsState.off),
    ('SHARED_TABS_UNSUPPORTED', SharedTabsState.unsupported),
  ]) {
    test('$code -> $state', () async {
      final c = make((p) async => throw fail(code));
      await c.refresh();
      expect(c.state, state);
    });
  }

  test('a failed read keeps what was known', () async {
    var failing = false;
    final c = make((p) async => failing ? throw fail('ACCOUNT_UNAVAILABLE') : shares(rosters: [roster()]));
    await c.refresh();
    failing = true;
    await c.refresh();
    expect(c.state, SharedTabsState.ready);
    expect(c.snapshot.tabs, hasLength(1));
  });

  test('an answer to a read the account has moved past is dropped (Review Focus 4)', () async {
    final first = Completer<Map<String, dynamic>>();
    var calls = 0;
    final c = make((p) => ++calls == 1 ? first.future : Future.value(shares()));
    final late = c.refresh();
    c.reset(); // sign-out
    first.complete(shares(rosters: [roster()]));
    await late;
    expect(c.snapshot.tabs, isEmpty);
    expect(c.state, SharedTabsState.unknown);
  });

  test('reads again on shared_tabs_changed, and every 60 s only while in front', () {
    fakeAsync((async) {
      var reads = 0;
      final front = ValueNotifier(true);
      final c = make((p) async {
        reads++;
        return shares();
      }, front: front);
      final watch = SharedTabsWatch(controller: c, foreground: front)..start();
      async.flushMicrotasks();
      expect(reads, 1);
      c.changed();
      async.flushMicrotasks();
      expect(reads, 2);
      async.elapse(const Duration(seconds: 60));
      expect(reads, 3);
      front.value = false;
      async.elapse(const Duration(minutes: 5));
      expect(reads, 3);
      watch.dispose();
    });
  });

  // With the account's Agent Messages switch off (the default) every daemon
  // refuses `shares` with MESSAGES_OFF; asking anyway was a request and an
  // fsync'd WARN every 60 s and on each reconnect, for everyone.
  group("the account's Agent Messages switch", () {
    test('off: nothing is asked, by the poll or anything else, and the state is off', () {
      fakeAsync((async) {
        var reads = 0;
        final front = ValueNotifier(true);
        final on = ValueNotifier<bool?>(false);
        final c = SharedTabsController(
          request: (p) async {
            reads++;
            return shares(rosters: [roster()]);
          },
          foreground: front,
          messagesSwitch: on,
        );
        final watch = SharedTabsWatch(controller: c, foreground: front)..start();
        async.flushMicrotasks();
        expect(c.state, SharedTabsState.off);
        async.elapse(const Duration(minutes: 5));
        c.changed(); // a reconnect, or shared_tabs_changed
        front.value = false;
        front.value = true;
        async.elapse(const Duration(minutes: 5));
        expect(reads, 0);
        expect(c.state, SharedTabsState.off);
        watch.dispose();
      });
    });

    test('turned on: read at once, then every 60 s; off again: stops, and the shares are gone', () {
      fakeAsync((async) {
        var reads = 0;
        final front = ValueNotifier(true);
        final on = ValueNotifier<bool?>(false);
        final c = SharedTabsController(
          request: (p) async {
            reads++;
            return shares(rosters: [roster()]);
          },
          foreground: front,
          messagesSwitch: on,
        );
        final watch = SharedTabsWatch(controller: c, foreground: front)..start();
        on.value = true;
        async.flushMicrotasks();
        expect(reads, 1);
        expect(c.state, SharedTabsState.ready);
        expect(c.snapshot.tabs, hasLength(1));
        async.elapse(const Duration(seconds: 60));
        expect(reads, 2);
        on.value = false;
        expect(c.state, SharedTabsState.off);
        expect(c.snapshot.tabs, isEmpty);
        async.elapse(const Duration(minutes: 5));
        expect(reads, 2);
        watch.dispose();
      });
    });

    test('the settings store notifying with nothing changed starts no read', () {
      fakeAsync((async) {
        var reads = 0;
        final front = ValueNotifier(true);
        final on = _Switch(true);
        final c = SharedTabsController(
          request: (p) async {
            reads++;
            return shares();
          },
          foreground: front,
          messagesSwitch: on,
        );
        final watch = SharedTabsWatch(controller: c, foreground: front)..start();
        async.flushMicrotasks();
        expect(reads, 1);
        for (var i = 0; i < 10; i++) {
          async.elapse(const Duration(seconds: 5));
          on.ping(); // the store's 30 s read, the same answer
        }
        expect(reads, 1);
        async.elapse(const Duration(seconds: 10));
        expect(reads, 2, reason: 'the 60 s poll keeps its own pace');
        watch.dispose();
      });
    });

    test('not read yet, it asks as before; bound again (null), it remembers it was off', () async {
      var reads = 0;
      final on = ValueNotifier<bool?>(null);
      final c = SharedTabsController(
        request: (p) async {
          reads++;
          return shares();
        },
        foreground: ValueNotifier(true),
        messagesSwitch: on,
      );
      await c.refresh();
      expect(reads, 1);
      expect(c.state, SharedTabsState.ready);
      on.value = false;
      on.value = null;
      on.value = true;
      await pumpEventQueue();
      expect(reads, 2, reason: 'off to on through an unread store is a turn-on');
    });

    test('an answer in flight when it is turned off is dropped', () async {
      final gate = Completer<Map<String, dynamic>>();
      final on = ValueNotifier<bool?>(true);
      final c = SharedTabsController(
        request: (p) => gate.future,
        foreground: ValueNotifier(true),
        messagesSwitch: on,
      );
      final read = c.refresh();
      on.value = false;
      gate.complete(shares(rosters: [roster()]));
      await read;
      expect(c.state, SharedTabsState.off);
      expect(c.snapshot.tabs, isEmpty);
    });
  });

  test('dismiss asks the daemon', () async {
    final asked = <Map<String, dynamic>>[];
    final notice = {'id': 'n1', 'sharedTabId': id1, 'kind': 'removed', 'at': '2026-10-16T10:00:00Z'};
    final c = make((p) async {
      asked.add(p);
      return p['action'] == 'shares' ? shares(notices: [notice]) : {'ok': true};
    });
    await c.refresh();
    await c.dismiss('n1');
    expect(asked.map((p) => p['action']), contains('share_notice_dismiss'));
  });

  test('dismiss of a notice already gone is quiet; another failure hides it here', () async {
    var code = 'NOT_FOUND';
    final notice = {'id': 'n1', 'sharedTabId': id1, 'kind': 'removed', 'at': 'x'};
    final c = make((p) async {
      if (p['action'] == 'share_notice_dismiss') throw fail(code);
      return shares(notices: [notice]);
    });
    await c.refresh();
    await c.dismiss('n1');
    expect(c.snapshot.notices, hasLength(1)); // the next read says whether it is gone
    code = 'TIMEOUT';
    await c.dismiss('n1');
    expect(c.snapshot.notices, isEmpty);
  });

  test('act sends the action with its payload, reads again, and names the failure', () async {
    final asked = <Map<String, dynamic>>[];
    final c = make((p) async {
      asked.add(p);
      if (p['action'] == 'share_invite') throw fail('RATE_LIMITED', 'Too many.');
      return p['action'] == 'shares' ? shares() : {'sharedTabId': id1};
    });
    final answer = await c.act('share_accept', {'inviteId': 'i1'});
    expect(answer['sharedTabId'], id1);
    expect(asked.first, {'action': 'share_accept', 'inviteId': 'i1'});
    await pumpEventQueue();
    expect(asked.map((p) => p['action']), ['share_accept', 'shares']);
    await expectLater(
      c.act('share_invite', {'sharedTabId': id1, 'emails': [], 'days': 7}),
      throwsA(isA<SharedTabsFailure>().having((e) => e.code, 'code', 'RATE_LIMITED').having((e) => e.message, 'message', 'Too many.')),
    );
  });

  test('a hostile name stays plain text, and a malformed entry is dropped, not thrown', () async {
    final hostile = '\u202Eevil<b>x</b>${'y' * 200}';
    final good = roster();
    good['harnesses'] = <dynamic>[...(good['harnesses'] as List)];
    (good['harnesses'] as List).add({'accountId': 'alice', 'machineId': 'ma', 'agentId': 'a2', 'name': hostile, 'engine': 'codex'});
    (good['harnesses'] as List).add({'accountId': 'alice', 'machineId': 'ma'}); // no agentId
    (good['harnesses'] as List).add('junk');
    final noId = roster()..remove('sharedTabId');
    final badHarnesses = roster(id: 'bbbbbbbbbbbbbbbbbbbbbbbb')..['harnesses'] = 'nope';
    final c = make((p) async => shares(rosters: [good, noId, badHarnesses, ...<Map<String, dynamic>>[]])..['invites'] = [
          {'id': 'i1', 'sharedTabId': id1, 'ownerEmail': '<i>a@b</i>', 'ownerMachineId': 'ma', 'tabName': '\u0007tab', 'expiresAt': 'x'},
          {'id': 'i2'},
          42,
        ]);
    await c.refresh();
    expect(c.state, SharedTabsState.ready);
    expect(c.snapshot.tabs.map((t) => t.sharedTabId), [id1]);
    final names = c.snapshot.tabs.single.harnesses.map((h) => h.name).toList();
    expect(names, ['api', hostile]);
    expect(names.last.length, 'evil<b>x</b>'.length + 1 + 200);
    expect(c.snapshot.invites.single.ownerEmail, '<i>a@b</i>');
    expect(c.snapshot.invites.single.tabName, '\u0007tab');
  });

  test('pending invitations carry their ids; malformed ones and a missing list read as none', () async {
    final owned = roster(owner: 'bob', tabId: 'swarm-3')
      ..['pendingInvites'] = [
        {'id': 'inv1', 'email': 'carol@example.com', 'expiresAt': '2026-11-01T00:00:00.000Z'},
        {'id': 'inv2', 'email': 'dave@example.com'},
        {'email': 'noid@example.com'},
        {'id': 'inv3'},
        'junk',
      ];
    final old = roster(id: 'bbbbbbbbbbbbbbbbbbbbbbbb', owner: 'bob', tabId: 'swarm-4');
    final bad = roster(id: 'cccccccccccccccccccccccc', owner: 'bob', tabId: 'swarm-5')..['pendingInvites'] = 7;
    final c = make((p) async => shares(rosters: [owned, old, bad]));
    await c.refresh();
    final tabs = c.snapshot.tabs;
    expect(tabs[0].pendingInvites, [
      (id: 'inv1', email: 'carol@example.com', expiresAt: '2026-11-01T00:00:00.000Z'),
      (id: 'inv2', email: 'dave@example.com', expiresAt: ''),
    ]);
    expect(tabs[1].pendingInvites, isEmpty);
    expect(tabs[2].pendingInvites, isEmpty);
  });

  test('a garbage answer changes nothing', () async {
    var n = 0;
    final c = make((p) async => ++n == 1 ? shares(rosters: [roster()]) : <String, dynamic>{'rosters': 7, 'me': 'x'});
    await c.refresh();
    await c.refresh();
    expect(c.state, SharedTabsState.ready);
    expect(c.snapshot.tabs, hasLength(1)); // not a shares answer: what was known stays
  });

  test('a garbage first answer leaves the state unavailable, not unknown', () async {
    final c = make((p) async => <String, dynamic>{'rosters': 7});
    await c.refresh();
    expect(c.state, SharedTabsState.unavailable);
  });

  test('a transient failure with nothing known is unavailable; after a good read it keeps ready', () async {
    var failing = true;
    final c = make((p) async => failing ? throw StateError('WS is not connected') : shares(rosters: [roster()]));
    await c.refresh();
    expect(c.state, SharedTabsState.unavailable);
    failing = false;
    await c.refresh();
    expect(c.state, SharedTabsState.ready);
    failing = true;
    await c.refresh();
    expect(c.state, SharedTabsState.ready);
    expect(c.snapshot.tabs, hasLength(1));
  });

  test('a down socket or a timeout is a SharedTabsFailure UNAVAILABLE, and dismiss hides locally', () async {
    final notice = {'id': 'n1', 'sharedTabId': id1, 'kind': 'removed', 'at': 'x'};
    Object? error = StateError('WS is not connected');
    final c = make((p) async {
      if (p['action'] == 'shares') return shares(notices: [notice]);
      throw error!;
    });
    await c.refresh();
    await expectLater(c.act('share_leave', {}), throwsA(isA<SharedTabsFailure>().having((e) => e.code, 'code', 'UNAVAILABLE')));
    await expectLater(
      c.act('share_leave', {}),
      throwsA(isA<SharedTabsFailure>().having(
        (e) => e.message,
        'message',
        'Harness could not reach this computer. Check that it is online, then try again.',
      )),
    );
    error = TimeoutException('slow');
    await expectLater(c.act('share_leave', {}), throwsA(isA<SharedTabsFailure>().having((e) => e.code, 'code', 'UNAVAILABLE')));
    expect(c.snapshot.notices, hasLength(1));
    await c.dismiss('n1');
    expect(c.snapshot.notices, isEmpty);
  });

  group('Tasks', () {
    Map<String, dynamic> tasks() => {
      'rows': [
        {
          'repo': 'o/r', 'issue': 7, 'title': 'Fix', 'url': 'https://github.com/o/r/issues/7', 'state': 'open',
          'assignee': {'account': 'alice', 'harness': 'api'},
          'pr': {'number': 9, 'url': 'https://github.com/o/r/pull/9', 'state': 'Open', 'ci': 'passing'},
          'updatedAt': 't',
        },
        {'repo': 'o/r', 'issue': 8, 'title': 'No pr', 'url': 'https://github.com/o/r/issues/8', 'state': 'closed', 'assignee': null, 'pr': null},
        {'issue': 'bad'},
        5,
      ],
      'truncated': false,
      'checkedAt': 'now',
    };

    test('loading, then rows parsed; a bad row is dropped', () async {
      final gate = Completer<Map<String, dynamic>>();
      final c = make((p) => p['action'] == 'share_tasks' ? gate.future : Future.value(shares()));
      expect(c.tasksFor(id1).loading, isFalse);
      expect(c.tasksFor(id1).loaded, isFalse);
      final read = c.loadTasks(id1);
      expect(c.tasksFor(id1).loading, isTrue);
      gate.complete(tasks());
      await read;
      final t = c.tasksFor(id1);
      expect(t.loading, isFalse);
      expect(t.loaded, isTrue);
      expect(t.error, isNull);
      expect(t.rows.map((r) => r.issue), [7, 8]);
      expect(t.rows.first.pr!.ci, 'passing');
      expect(t.rows.first.assignee!.harness, 'api');
      expect(t.rows.last.pr, isNull);
    });

    test('one read at a time per tab', () async {
      var asked = 0;
      final gate = Completer<Map<String, dynamic>>();
      final c = make((p) {
        if (p['action'] != 'share_tasks') return Future.value(shares());
        asked++;
        return gate.future;
      });
      final a = c.loadTasks(id1), b = c.loadTasks(id1);
      gate.complete(tasks());
      await Future.wait([a, b]);
      expect(asked, 1);
      await c.loadTasks('bbbbbbbbbbbbbbbbbbbbbbbb'); // another tab reads on its own
      expect(asked, 2); // the gate is already complete, so it answered at once
    });

    test('a flight from before a reset does not free the slot of the one after it', () async {
      final gates = <Completer<Map<String, dynamic>>>[];
      final c = make((p) {
        if (p['action'] != 'share_tasks') return Future.value(shares());
        gates.add(Completer());
        return gates.last.future;
      });
      final old = c.loadTasks(id1);
      c.reset();
      final fresh = c.loadTasks(id1);
      expect(gates, hasLength(2));
      gates[0].complete(tasks());
      await old;
      final joined = c.loadTasks(id1); // the fresh flight still holds the slot
      expect(gates, hasLength(2));
      gates[1].complete(tasks());
      await Future.wait([fresh, joined]);
      expect(c.tasksFor(id1).rows, hasLength(2));
    });

    test('an error is kept with its tab and its code', () async {
      final c = make((p) async => p['action'] == 'share_tasks' ? throw fail('GH_SIGNED_OUT') : shares());
      await c.loadTasks(id1);
      expect(c.tasksFor(id1).error, 'GH_SIGNED_OUT');
      expect(c.tasksFor(id1).loading, isFalse);
      expect(c.tasksFor('bbbbbbbbbbbbbbbbbbbbbbbb').error, isNull);
    });

    test('a late answer after reset is dropped', () async {
      final gate = Completer<Map<String, dynamic>>();
      final c = make((p) => p['action'] == 'share_tasks' ? gate.future : Future.value(shares()));
      final read = c.loadTasks(id1);
      c.reset();
      gate.complete(tasks());
      await read;
      expect(c.tasksFor(id1).rows, isEmpty);
      expect(c.tasksFor(id1).loaded, isFalse);
      expect(c.tasksFor(id1).loading, isFalse);
    });
  });

  group('who', () {
    test('an answer after the account moved on is dropped', () async {
      final gate = Completer<Map<String, dynamic>>();
      final c = make((p) => gate.future);
      final asking = c.who(id1);
      c.reset();
      gate.complete({'harnesses': [{'machineId': 'ma', 'agentId': 'a1', 'project': 'r'}]});
      expect(await asking, isEmpty);
    });

    test('maps machine and agent to project and branch; a failure is empty', () async {
      var ok = true;
      final c = make((p) async {
        if (!ok) throw fail('NOT_SHARED');
        return {
          'harnesses': [
            {'machineId': 'ma', 'agentId': 'a1', 'project': 'repo', 'branch': 'main'},
            {'machineId': 'ma', 'agentId': 'a2'},
            {'agentId': 'x'},
          ],
        };
      });
      final who = await c.who(id1);
      expect(who.keys, hasLength(2));
      expect(who['ma\u0000a1'], (project: 'repo', branch: 'main'));
      expect(who['ma\u0000a2'], (project: null, branch: null));
      ok = false;
      expect(await c.who(id1), isEmpty);
    });
  });

  group('activity', () {
    test('frames are parsed and handed on with a growing revision; a bad payload is ignored', () {
      final seen = <SharedActivity>[];
      final c = make((p) async => shares(), onActivity: seen.add);
      c.handleActivity({'sharedTabId': id1, 'machineId': 'ma', 'agentId': 'a1', 'state': 'working', 'validForMs': 25000});
      c.handleActivity({'sharedTabId': id1, 'machineId': 'ma', 'agentId': 'a1', 'state': 'idle', 'validForMs': 25000});
      c.handleActivity({'sharedTabId': id1, 'agentId': 'a1', 'state': 'idle', 'validForMs': 1});
      expect(seen.map((a) => a.revision), [1, 2]);
      expect(seen.map((a) => a.state), ['working', 'idle']);
      expect(seen.first.validForMs, 25000);
    });

    test('activity in a read is handed on too', () async {
      final seen = <SharedActivity>[];
      final c = make(
        (p) async => shares(activity: [
          {'sharedTabId': id1, 'machineId': 'ma', 'agentId': 'a1', 'state': 'working', 'validForMs': 5000},
        ]),
        onActivity: seen.add,
      );
      await c.refresh();
      expect(seen.single.state, 'working');
      expect(c.snapshot.activity, hasLength(1));
    });
  });

  test('reset clears everything and notifies', () async {
    final c = make((p) async => shares(rosters: [roster()]));
    await c.refresh();
    var notified = 0;
    c.addListener(() => notified++);
    c.reset();
    expect(notified, 1);
    expect(c.snapshot.tabs, isEmpty);
    expect(c.state, SharedTabsState.unknown);
  });
}

/// A switch that notifies without changing, as the settings store does on
/// every 30 s read.
class _Switch extends ChangeNotifier implements ValueListenable<bool?> {
  _Switch(this.value);

  @override
  bool? value;

  void ping() => notifyListeners();
}
