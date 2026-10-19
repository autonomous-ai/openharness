import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/agent_messages.dart';
import 'package:harness/agent_messages/shared_tabs_model.dart' show memberDeskTabId;
import 'package:harness/agent_messages/tab_settings.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/agent_messages_api.dart';
import 'swarm_state_test.dart' show createApp, MemoryStore;

const _shared = 'aaaaaaaaaaaaaaaaaaaaaaaa';

/// The backend's listing and its PATCH, scripted.
class _Api extends AgentMessagesApi {
  List<Object?> tabs = const [];
  final patches = <({String tabId, bool? enabled, AgentMessageLeader? leader, bool clear})>[];
  Object? patchError;
  Completer<void>? gate;

  @override
  Future<Map<String, dynamic>?> readAgentMessageTabs() async {
    reads++;
    return {'revision': 1, 'machines': const [], 'tabs': tabs};
  }

  @override
  Future<Map<String, dynamic>> setAgentMessageTab(
    String tabId, {
    bool? enabled,
    AgentMessageLeader? leader,
    bool clearLeader = false,
  }) async {
    patches.add((tabId: tabId, enabled: enabled, leader: leader, clear: clearLeader));
    if (gate case final g?) await g.future;
    if (patchError case final error?) throw error;
    return {
      'tabId': tabId,
      'enabled': enabled ?? false,
      'leader': leader == null ? null : {'machineId': leader.machineId, 'agentId': leader.agentId},
      'revision': 2,
    };
  }
}

class _Daemon extends WsConn {
  _Daemon(this.shares)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final Map<String, dynamic> shares;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => payload['action'] == 'shares' ? shares : const {};
}

Map<String, dynamic> _shares({required String owner, Map<String, String>? leader}) => {
  'api': 2,
  'me': {'accountId': 'bob', 'email': 'bob@example.com', 'machineId': 'm'},
  'rosters': [
    {
      'sharedTabId': _shared,
      'tabId': owner == 'bob' ? 'desk-1' : null,
      'version': 3,
      'name': 'app',
      'owner': {'accountId': owner, 'email': '$owner@example.com', 'machineId': 'm', 'machinePublicKey': 'k'},
      'leader': leader,
      'members': const [],
      'invites': const [],
      'pendingInvites': const [],
      'harnesses': const [],
    },
  ],
  'invites': const [],
  'alerts': const [],
  'pending': const [],
  'notices': const [],
  'untrusted': const [],
  'activity': const [],
};

Map<String, Object?> _tab(String id, {Object? leader = #missing, bool enabled = true}) => {
  'id': id,
  'name': 'T',
  'named': true,
  'enabled': enabled,
  'panes': const [],
  if (leader != #missing) 'leader': leader,
};

void main() {
  group('parseTabSettings', () {
    test('keeps each tab\'s leader; null, missing and malformed leaders are none', () {
      final settings = parseTabSettings({
        'tabs': [
          _tab('a', leader: {'machineId': 'm1', 'agentId': 'x'}),
          _tab('b', leader: null),
          _tab('c'),
          _tab('d', leader: {'machineId': 'm1'}),
          _tab('e', leader: 'x'),
          _tab('f', leader: {'machineId': '', 'agentId': 'x'}),
          {'name': 'no id'},
          'junk',
          _tab('g', enabled: false),
        ],
      });
      expect(settings.keys, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
      expect(settings['a']!.leader, const AgentMessageLeader('m1', 'x'));
      for (final id in ['b', 'c', 'd', 'e', 'f']) {
        expect(settings[id]!.leader, isNull, reason: id);
      }
      expect(settings['g']!.enabled, isFalse);
    });

    test('an answer without tabs is no settings', () {
      expect(parseTabSettings(null), isEmpty);
      expect(parseTabSettings({'tabs': 'x'}), isEmpty);
    });

    test('leaders compare by value', () {
      expect(const AgentMessageLeader('m', 'a'), const AgentMessageLeader('m', 'a'));
      expect(const AgentMessageLeader('m', 'a').hashCode, const AgentMessageLeader('m', 'a').hashCode);
      expect(const AgentMessageLeader('m', 'a') == const AgentMessageLeader('m', 'b'), isFalse);
    });
  });

  group('the controller', () {
    test('refresh keeps the tab settings, and tells listeners when they change', () async {
      var answer = <Object?>[
        _tab('t1', leader: {'machineId': 'm', 'agentId': 'a0'}),
      ];
      final controller = AgentMessagesController(
        read: () async => {'tabs': answer},
        request: (_, _) async => const {},
        nameOf: (_, _) => null,
      );
      var notified = 0;
      controller.addListener(() => notified++);
      expect(controller.leaderOf('t1'), isNull);
      await controller.refresh();
      expect(controller.leaderOf('t1'), const AgentMessageLeader('m', 'a0'));
      expect(controller.leaderOf('t2'), isNull);
      expect(notified, 1);
      await controller.refresh();
      expect(notified, 1, reason: 'the same answer is not news');
      answer = [_tab('t1', leader: null)];
      await controller.refresh();
      expect(controller.leaderOf('t1'), isNull);
      expect(notified, 2);
      controller.dispose();
    });

    test('a failed read keeps what was known; an unsupported daemon clears it', () async {
      Object? fail;
      var tabs = <Object?>[_tab('t1', leader: {'machineId': 'm', 'agentId': 'a0'})];
      var unsupported = false;
      final controller = AgentMessagesController(
        read: () async {
          if (fail != null) throw fail;
          return unsupported ? null : {'tabs': tabs};
        },
        request: (_, _) async => const {},
        nameOf: (_, _) => null,
      );
      await controller.refresh();
      fail = StateError('away');
      await controller.refresh();
      expect(controller.leaderOf('t1'), isNotNull);
      fail = null;
      unsupported = true;
      await controller.refresh();
      expect(controller.loaded, isFalse);
      expect(controller.leaderOf('t1'), isNull);
      controller.dispose();
    });

    test('reset forgets the settings, and a failing read does not bring them back', () async {
      Object? fail;
      final controller = AgentMessagesController(
        read: () async {
          if (fail != null) throw fail;
          return {
            'tabs': [_tab('t1', leader: {'machineId': 'm', 'agentId': 'a0'})],
          };
        },
        request: (_, _) async => const {},
        nameOf: (_, _) => null,
      );
      await controller.refresh();
      expect(controller.leaderOf('t1'), isNotNull);
      controller.reset();
      expect(controller.leaderOf('t1'), isNull);
      fail = StateError('away');
      await controller.refresh();
      expect(controller.leaderOf('t1'), isNull);
      controller.dispose();
    });

    test('a read that was in flight cannot put back a leader that was just changed', () async {
      final gate = Completer<Map<String, dynamic>?>();
      var first = true;
      final controller = AgentMessagesController(
        read: () => first ? (() { first = false; return gate.future; })() : Future.value(null),
        request: (_, _) async => const {},
        nameOf: (_, _) => null,
      );
      final reading = controller.refresh();
      controller.applyTabSetting('t1', const AgentMessageLeader('m', 'new'));
      gate.complete({
        'tabs': [_tab('t1', leader: {'machineId': 'm', 'agentId': 'old'})],
      });
      await reading;
      expect(controller.leaderOf('t1'), const AgentMessageLeader('m', 'new'));
      controller.dispose();
    });

    test('applyTabSetting sets one tab\'s setting', () {
      final controller = AgentMessagesController(
        read: () async => null,
        request: (_, _) async => const {},
        nameOf: (_, _) => null,
      );
      var notified = 0;
      controller.addListener(() => notified++);
      controller.applyTabSetting('t', const AgentMessageLeader('m', 'a'));
      expect(controller.leaderOf('t'), const AgentMessageLeader('m', 'a'));
      controller.applyTabSetting('t', null);
      expect(controller.leaderOf('t'), isNull);
      expect(notified, 2);
      controller.dispose();
    });
  });

  group('the app', () {
    test('a desk_changed push reads the tab settings again', () async {
      final app = createApp();
      addTearDown(app.dispose);
      final api = _Api()
        ..tabs = [_tab('d1', leader: {'machineId': 'm', 'agentId': 'a0'})];
      await joinAgentMessagesDesk(app, api);
      expect(app.agentMessages.leaderOf('d1'), const AgentMessageLeader('m', 'a0'));
      final before = api.reads;
      api.tabs = [_tab('d1', leader: {'machineId': 'm', 'agentId': 'a1'})];
      await app.handleEventForTest('m', {
        'type': 'desk_changed',
        'payload': {'revision': 1},
      });
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(api.reads, greaterThan(before));
      expect(app.agentMessages.leaderOf('d1'), const AgentMessageLeader('m', 'a1'));
    });

    test('setTabLeader PATCHes the leader and the tab shows it; clearTabLeader clears it', () async {
      final app = createApp();
      addTearDown(app.dispose);
      final api = _Api()..tabs = [_tab('d1')];
      await joinAgentMessagesDesk(app, api);
      expect(app.tabLeader('d1'), isNull);

      await app.setTabLeader('d1', 'm', 'a2');
      expect(api.patches.single.tabId, 'd1');
      expect(api.patches.single.leader, const AgentMessageLeader('m', 'a2'));
      expect(api.patches.single.clear, isFalse);
      expect(app.tabLeader('d1'), const AgentMessageLeader('m', 'a2'));

      await app.clearTabLeader('d1');
      expect(api.patches.last.clear, isTrue);
      expect(api.patches.last.leader, isNull);
      expect(app.tabLeader('d1'), isNull);
      expect(app.lastError, isNull);
    });

    test('a PATCH answered after sign-out is dropped, success or failure', () async {
      final app = createApp();
      addTearDown(app.dispose);
      final api = _Api()..tabs = [_tab('d1')];
      await joinAgentMessagesDesk(app, api);
      final gate = Completer<void>();
      api.gate = gate;
      final done = app.setTabLeader('d1', 'm', 'a2');
      app.expireSessionForTest('Signed out');
      final errorBefore = app.lastError;
      gate.complete();
      await done;
      expect(app.agentMessages.leaderOf('d1'), isNull);
      expect(app.lastError, errorBefore);

      final other = createApp();
      addTearDown(other.dispose);
      final failingApi = _Api()..tabs = [_tab('d1')];
      await joinAgentMessagesDesk(other, failingApi);
      final failing = Completer<void>();
      failingApi
        ..gate = failing
        ..patchError = ApiException('Choose a harness in this tab.', status: 400);
      final late = other.setTabLeader('d1', 'm', 'a3');
      other.expireSessionForTest('Signed out');
      final before = other.lastError;
      failing.complete();
      await late;
      expect(other.lastError, before);
      expect(other.lastError, isNot('Choose a harness in this tab.'));
    });

    test('a refused PATCH keeps the old leader and surfaces the error', () async {
      final app = createApp();
      addTearDown(app.dispose);
      final api = _Api()
        ..tabs = [_tab('d1', leader: {'machineId': 'm', 'agentId': 'a0'})];
      await joinAgentMessagesDesk(app, api);
      api.patchError = ApiException('Choose a harness in this tab.', status: 400);
      await app.setTabLeader('d1', 'm', 'a9');
      expect(app.tabLeader('d1'), const AgentMessageLeader('m', 'a0'));
      expect(app.lastError, 'Choose a harness in this tab.');

      api.patchError = StateError('offline');
      await app.clearTabLeader('d1');
      expect(app.tabLeader('d1'), const AgentMessageLeader('m', 'a0'));
      expect(app.lastError, contains('Could not'));
    });

    test('tabLeader in a tab shared with this account is the roster\'s, never the setting\'s', () async {
      final desk = memberDeskTabId(_shared);
      for (final (roster, expected) in [
        ({'machineId': 'ma', 'agentId': 'a1'}, const AgentMessageLeader('ma', 'a1')),
        (null, null),
      ]) {
        final app = createApp(
          store: MemoryStore(),
          connectionForTest: (_) => _Daemon(_shares(owner: 'alice', leader: roster)),
          connected: true,
        );
        app.machineStates['m']!.localOnly = true;
        addTearDown(app.dispose);
        final api = _Api()
          ..tabs = [_tab(desk, leader: {'machineId': 'm', 'agentId': 'a0'})];
        await joinAgentMessagesDesk(app, api);
        await app.sharedTabs.refresh();
        expect(app.agentMessages.leaderOf(desk), const AgentMessageLeader('m', 'a0'));
        expect(app.tabLeader(desk), expected);
      }
    });

    test('in the owner\'s own shared tab the setting is the source', () async {
      final app = createApp(
        store: MemoryStore(),
        connectionForTest: (_) => _Daemon(_shares(owner: 'bob', leader: {'machineId': 'm', 'agentId': 'stale'})),
        connected: true,
      );
      app.machineStates['m']!.localOnly = true;
      addTearDown(app.dispose);
      final api = _Api()..tabs = [_tab('desk-1', leader: {'machineId': 'm', 'agentId': 'a0'})];
      await joinAgentMessagesDesk(app, api);
      await app.sharedTabs.refresh();
      expect(app.sharedTabs.tabForDesk('desk-1'), isNotNull);
      expect(app.tabLeader('desk-1'), const AgentMessageLeader('m', 'a0'));
    });
  });
}
