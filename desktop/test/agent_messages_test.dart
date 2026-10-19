import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/agent_messages.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_session.dart';

import 'support/agent_messages_api.dart';

/// Agent Messages as the window keeps it (docs/design/2026-10-10-agent-messages.md):
/// whether the account has them, the traffic `messages_changed` reports, the
/// pane marks it leaves, and a tab's log merged from every daemon that holds
/// part of it. A tab has no flag here: whether agents may message is the
/// account's, in Settings ▸ Experimental (owner, 2026-10-12).
class _Backend {
  /// Each tab's old flag, which a backend still answers and nothing reads.
  Map<String, bool> tabs = {};
  int reads = 0;
  Object? readError;
  bool readNull = false;

  Future<Map<String, dynamic>?> read() async {
    reads++;
    if (readError case final error?) throw error;
    if (readNull) return null;
    return {
      'revision': 3,
      'machines': const [],
      'tabs': [
        for (final MapEntry(:key, :value) in tabs.entries)
          {'id': key, 'name': key, 'enabled': value, 'panes': const []},
      ],
    };
  }
}

Map<String, dynamic> _sent({
  String tabId = 'tab',
  String id = 'm0000001',
  String to = 'api',
  String state = 'queued',
}) => {
  'tabId': tabId,
  'messageId': id,
  'at': 1,
  'from': {'machineId': 'studio', 'agentId': 'lead'},
  'to': [
    {'machineId': 'laptop', 'agentId': to, 'state': state},
  ],
};

Map<String, dynamic> _row(
  String id, {
  required int at,
  List<Map<String, Object?>> statuses = const [],
  String text = 'Review of 3f2a9c1\nthe cleanup leaves workers running',
}) => {
  'id': id,
  'tabId': 'tab',
  'from': {
    'machineId': 'studio',
    'agentId': 'lead',
    'name': 'lead',
    'engine': 'codex',
    'machine': 'studio',
  },
  'to': [
    {'machineId': 'laptop', 'agentId': 'api', 'name': 'api'},
  ],
  'text': text,
  'at': at,
  'statuses': statuses,
};

void main() {
  late _Backend backend;
  final names = {'lead': 'Lead', 'api': 'API worker'};

  AgentMessagesController controller({
    AgentMessagesRequest? request,
    AgentNameOf? nameOf,
  }) => AgentMessagesController(
    read: backend.read,
    request: request ?? (_, _) async => throw StateError('offline'),
    nameOf: nameOf ?? (_, agentId) => names[agentId],
  );

  setUp(() {
    backend = _Backend();
  });

  group('whether the account has Agent Messages', () {
    test('an answer says so, whatever a tab\'s old flag says', () async {
      backend.tabs = {'on': true, 'off': false};
      final messages = controller();
      addTearDown(messages.dispose);
      expect(messages.loaded, isFalse, reason: 'unknown until read');
      var notified = 0;
      messages.addListener(() => notified++);
      await messages.refresh();
      expect(messages.loaded, isTrue);
      expect(notified, 1);
      await messages.refresh();
      expect(notified, 1, reason: 'the same answer again changes nothing');
    });

    test('an older daemon or backend (404) offers nothing, for good', () async {
      final messages = controller();
      addTearDown(messages.dispose);
      backend.readNull = true;
      await messages.refresh();
      expect(messages.loaded, isFalse);
      backend.readNull = false;
      await messages.refresh();
      expect(messages.loaded, isTrue);
      // The daemon was replaced by one without Agent Messages.
      backend.readNull = true;
      var notified = 0;
      messages.addListener(() => notified++);
      await messages.refresh();
      expect(messages.loaded, isFalse);
      expect(notified, 1);
    });

    test('a failure before any answer stays unanswered', () async {
      final messages = controller();
      addTearDown(messages.dispose);
      backend.readError = StateError('daemon down');
      await messages.refresh();
      expect(messages.loaded, isFalse);
    });

    test('a failed read keeps what was known', () async {
      final messages = controller();
      addTearDown(messages.dispose);
      await messages.refresh();
      backend.readError = StateError('one dropped request');
      await messages.refresh();
      expect(messages.loaded, isTrue);
    });

    test('signing out forgets the account', () async {
      final messages = controller();
      addTearDown(messages.dispose);
      await messages.refresh();
      messages.handleEvent(_sent());
      messages.reset();
      expect(messages.trafficFor('tab'), 0);
      expect(messages.markFor('studio', 'lead'), isNull);
      expect(messages.loaded, isFalse);
    });
  });

  group('traffic', () {
    test('a message counts as traffic, so an open log reads again', () {
      fakeAsync((async) {
        final messages = controller();
        unawaited(messages.refresh());
        async.flushMicrotasks();
        var notified = 0;
        messages.addListener(() => notified++);
        messages.handleEvent(_sent());
        expect(messages.trafficFor('tab'), 1);
        expect(notified, 1, reason: 'an open log reads again');
        messages.handleEvent(_sent(state: 'delivered'));
        expect(messages.trafficFor('tab'), 2);
        messages.dispose();
        expect(async.pendingTimers, isEmpty);
      });
    });

    test('marks the sender and each recipient once per message', () {
      fakeAsync((async) {
        final messages = controller();
        messages.handleEvent(_sent());
        expect(messages.markFor('studio', 'lead')?.label, '→ API worker');
        expect(messages.markFor('laptop', 'api')?.label, '← Lead');
        expect(messages.markFor('studio', 'lead')?.warning, isFalse);
        // The next status of the same message is not a new message.
        messages.seen('laptop', 'api');
        messages.handleEvent(_sent(state: 'delivered'));
        expect(messages.markFor('laptop', 'api'), isNull);
        async.elapse(const Duration(seconds: 5));
        expect(messages.markFor('studio', 'lead'), isNull);
        messages.handleEvent(_sent(id: 'm0000002', to: 'web'));
        expect(
          messages.markFor('studio', 'lead')?.label,
          '→ web',
          reason: 'an unknown name falls back to the start of its id',
        );
        messages.dispose();
        expect(async.pendingTimers, isEmpty);
      });
    });

    test('focusing a pane clears its mark', () {
      fakeAsync((async) {
        final messages = controller();
        messages.handleEvent(_sent());
        var notified = 0;
        messages.addListener(() => notified++);
        messages.seen('studio', 'lead');
        expect(messages.markFor('studio', 'lead'), isNull);
        expect(messages.markFor('laptop', 'api'), isNotNull);
        expect(notified, 1);
        messages.seen('studio', 'lead');
        expect(notified, 1);
        messages.dispose();
      });
    });

    test('a sender stopped by the rate limit is the one alert', () {
      fakeAsync((async) {
        final messages = controller();
        messages.handleEvent({
          'limited': {'machineId': 'studio', 'agentId': 'lead'},
        });
        final mark = messages.markFor('studio', 'lead')!;
        expect(mark.warning, isTrue);
        expect(mark.label, '→ rate limited');
        expect(messages.trafficFor('tab'), 0);
        messages.dispose();
      });
    });

    test('frames without a tab or parties change nothing', () {
      final messages = controller();
      addTearDown(messages.dispose);
      messages.handleEvent({'messageId': 'm0000001'});
      messages.handleEvent({'tabId': '', 'messageId': 'm0000001'});
      messages.handleEvent({'limited': 'nobody'});
      expect(messages.trafficFor(''), 0);
      messages.handleEvent({'tabId': 'tab', 'messageId': 'm0000003'});
      expect(messages.trafficFor('tab'), 1);
      expect(messages.markFor('studio', 'lead'), isNull);
    });
  });

  group('the log', () {
    test('merges every daemon by message id, oldest first', () async {
      final asked = <(String, Map<String, dynamic>)>[];
      final messages = controller(
        request: (machineId, payload) async {
          asked.add((machineId, payload));
          return switch (machineId) {
            // The sender's daemon still says queued for the remote recipient.
            'studio' => {
              'messages': [
                _row(
                  'm0000002',
                  at: 2000,
                  statuses: [
                    {
                      'machineId': 'laptop',
                      'agentId': 'api',
                      'state': 'queued',
                      'at': 2000,
                    },
                  ],
                ),
                _row('m0000001', at: 1000),
              ],
            },
            // The recipient's daemon delivered it.
            'laptop' => {
              'messages': [
                _row(
                  'm0000002',
                  at: 2000,
                  statuses: [
                    {
                      'machineId': 'laptop',
                      'agentId': 'api',
                      'state': 'delivered',
                      'via': 'hook',
                      'at': 2500,
                    },
                  ],
                ),
                {..._row('m0000009', at: 9), 'tabId': 'another'},
                'not a message',
              ],
            },
            _ => throw StateError('offline'),
          };
        },
      );
      addTearDown(messages.dispose);
      final log = await messages.history('tab', [
        'studio',
        'laptop',
        'laptop',
        'gone',
      ]);
      expect(log.reached, isTrue);
      expect(asked, hasLength(3));
      expect(asked.first.$2, {'action': 'history', 'tabId': 'tab'});
      expect(log.messages.map((m) => m.id), ['m0000001', 'm0000002']);
      final merged = log.messages.last;
      expect(merged.stateOf(merged.to.single), AgentMessageState.delivered);
      expect(merged.statusOf(merged.to.single)?.via, 'hook');
      expect(merged.firstLine, 'Review of 3f2a9c1');
      expect(
        log.messages.first.stateOf(log.messages.first.to.single),
        AgentMessageState.queued,
      );
    });

    test('no daemon answering is not an empty log', () async {
      final messages = controller(
        request: (_, _) async => {'error': 'UNKNOWN_ACTION'},
      );
      addTearDown(messages.dispose);
      final unreachable = await messages.history('tab', ['studio']);
      expect(unreachable.reached, isFalse);
      expect(unreachable.messages, isEmpty);
      final empty = await controller(request: (_, _) async => {'messages': []})
          .history('tab', ['studio']);
      expect(empty.reached, isTrue);
      expect(empty.complete, isTrue);
    });

    test(
      'a member machine that did not answer leaves the log incomplete',
      () async {
        final messages = controller(
          request: (machineId, _) async => machineId == 'studio'
              ? {
                  'messages': [_row('m0000001', at: 1)],
                }
              : throw StateError('offline'),
        );
        addTearDown(messages.dispose);
        final partial = await messages.history(
          'tab',
          ['studio', 'laptop'],
          expected: {'studio', 'laptop'},
        );
        expect(partial.reached, isTrue);
        expect(partial.complete, isFalse);
        final unasked = await messages.history(
          'tab',
          ['studio'],
          expected: {'studio', 'gone-offline'},
        );
        expect(unasked.complete, isFalse, reason: 'offline, so never asked');
        final whole = await messages.history(
          'tab',
          ['studio'],
          expected: {'studio'},
        );
        expect(whole.complete, isTrue);
      },
    );

    test('a later final state wins, and failed says why', () {
      AgentMessage message(String state, int at, {String? reason}) =>
          AgentMessage.fromJson(
            _row(
              'm0000001',
              at: 1,
              statuses: [
                {
                  'machineId': 'laptop',
                  'agentId': 'api',
                  'state': state,
                  'at': at,
                  'reason': ?reason,
                },
              ],
            ),
          )!;
      final failed = message('failed', 5, reason: 'left the tab');
      final queued = message('queued', 9);
      final merged = queued.merge(failed);
      expect(merged.stateOf(merged.to.single), AgentMessageState.failed);
      expect(merged.statusOf(merged.to.single)?.reason, 'left the tab');
      expect(
        failed.merge(message('delivered', 7)).stateOf(failed.to.single),
        AgentMessageState.delivered,
      );
    });
  });

  group('other machines', () {
    // A daemon tells `messages_changed` only to its own computer's windows:
    // traffic between harnesses elsewhere is read from their logs.
    final now = DateTime(2026, 10, 10, 12);
    Map<String, dynamic> recent(String id, {required Duration ago}) =>
        _row(id, at: now.subtract(ago).millisecondsSinceEpoch);

    test('a message that just moved is traffic and marks its panes', () async {
      final asked = <(String, Map<String, dynamic>)>[];
      final messages = AgentMessagesController(
        read: backend.read,
        request: (machineId, payload) async {
          asked.add((machineId, payload));
          return {
            'messages': [
              recent('m0000001', ago: const Duration(minutes: 5)),
              // Within a round of the remote watch's: still news when a
              // round first sees it.
              recent('m0000002', ago: const Duration(seconds: 30)),
            ],
          };
        },
        nameOf: (_, agentId) => names[agentId],
        now: () => now,
      );
      addTearDown(messages.dispose);
      await messages.pollRemote([
        (tabId: 'tab', machineIds: ['laptop']),
      ]);
      expect(asked.single.$1, 'laptop');
      expect(asked.single.$2, {
        'action': 'history',
        'tabId': 'tab',
        'limit': 20,
      });
      expect(messages.trafficFor('tab'), 1);
      expect(messages.markFor('studio', 'lead')?.label, '→ API worker');
      expect(messages.markFor('laptop', 'api')?.label, '← Lead');
      // Already seen: the next round changes nothing, and neither does the
      // same message's own frame.
      messages.seen('studio', 'lead');
      await messages.pollRemote([
        (tabId: 'tab', machineIds: ['laptop']),
      ]);
      expect(messages.trafficFor('tab'), 1);
      expect(messages.markFor('studio', 'lead'), isNull);
      messages.handleEvent(_sent(id: 'm0000002', state: 'delivered'));
      expect(messages.markFor('studio', 'lead'), isNull);
    });

    test('older messages are remembered, not announced', () async {
      final messages = AgentMessagesController(
        read: backend.read,
        request: (_, _) async => {
          'messages': [recent('m0000003', ago: const Duration(minutes: 2))],
        },
        nameOf: (_, _) => null,
        now: () => now,
      );
      addTearDown(messages.dispose);
      await messages.pollRemote([
        (tabId: 'tab', machineIds: ['laptop']),
      ]);
      expect(messages.trafficFor('tab'), 0);
      expect(messages.markFor('studio', 'lead'), isNull);
      messages.handleEvent(_sent(id: 'm0000003', state: 'delivered'));
      expect(
        messages.markFor('studio', 'lead'),
        isNull,
        reason: 'its marks were due when it moved, not now',
      );
    });

    test('one request at a time per machine', () async {
      final answer = Completer<Map<String, dynamic>>();
      final asked = <String>[];
      final messages = AgentMessagesController(
        read: backend.read,
        request: (machineId, payload) {
          asked.add('$machineId/${payload['tabId']}');
          return machineId == 'laptop'
              ? answer.future
              : Future.value({'messages': const []});
        },
        nameOf: (_, _) => null,
        now: () => now,
      );
      addTearDown(messages.dispose);
      final tabs = <AgentMessagesRemoteTab>[
        (tabId: 'one', machineIds: ['laptop', 'mini']),
        (tabId: 'two', machineIds: ['laptop']),
      ];
      final first = messages.pollRemote(tabs);
      await pumpEventQueue();
      final second = messages.pollRemote(tabs);
      await pumpEventQueue();
      expect(asked, ['laptop/one', 'mini/one', 'mini/one']);
      answer.complete({'messages': const []});
      await Future.wait([first, second]);
      expect(asked, ['laptop/one', 'mini/one', 'mini/one', 'laptop/two']);
    });

    test('a watch asks while the window is in front, every 15 seconds', () {
      fakeAsync((async) {
        final foreground = ValueNotifier(false);
        var rounds = 0;
        final messages = AgentMessagesController(
          read: backend.read,
          request: (_, _) async {
            rounds++;
            return {'messages': const []};
          },
          nameOf: (_, _) => null,
          now: () => now,
        );
        var tabs = <AgentMessagesRemoteTab>[
          (tabId: 'tab', machineIds: ['laptop']),
        ];
        final watch = AgentMessagesRemoteWatch(
          controller: messages,
          foreground: foreground,
          tabs: () => tabs,
        )..start();
        async.flushMicrotasks();
        expect(rounds, 0, reason: 'a background window asks nothing');
        foreground.value = true;
        async.flushMicrotasks();
        expect(rounds, 1, reason: 'once on coming to the front');
        async.elapse(const Duration(seconds: 15));
        expect(rounds, 2);
        async.elapse(const Duration(seconds: 15));
        expect(rounds, 3);
        tabs = [];
        async.elapse(const Duration(seconds: 15));
        expect(rounds, 3, reason: 'no tab has remote harnesses to message');
        tabs = [
          (tabId: 'tab', machineIds: ['laptop']),
        ];
        foreground.value = false;
        async.elapse(const Duration(minutes: 1));
        expect(rounds, 3);
        expect(async.pendingTimers, isEmpty);
        watch.dispose();
        messages.dispose();
        foreground.dispose();
      });
    });
  });

  group('the app', () {
    late AppNotifier app;

    setUp(() {
      app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
      const machine = Machine(
        machineId: 'studio',
        authMode: MachineAuthMode.remote,
        name: 'Studio',
      );
      app.machines = [machine];
      app.machineStates['studio'] = MachineState(machine)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..agents = [
          const Agent(id: 'lead', name: 'Lead', terminalAvailable: true),
          const Agent(id: 'api', name: 'API worker', terminalAvailable: true),
        ];
    });
    tearDown(() => app.dispose());

    test(
      'messages_changed reaches Agent Messages, never turn activity',
      () async {
        await app.handleEventForTest('studio', {
          'type': 'messages_changed',
          'payload': {
            'tabId': app.activeSwarmId,
            'messageId': 'm0000001',
            'at': 1,
            'from': {'machineId': 'studio', 'agentId': 'lead'},
            'to': [
              {'machineId': 'studio', 'agentId': 'api', 'state': 'queued'},
            ],
          },
        });
        expect(app.agentMessages.trafficFor(app.activeSwarmId), 1);
        expect(
          app.agentMessages.markFor('studio', 'lead')?.label,
          '→ API worker',
        );
        expect(app.agentMessages.markFor('studio', 'api')?.label, '← Lead');
        final state = app.machineStates['studio']!;
        expect(state.unknownActivityAgentIds, isEmpty);
        expect(state.processingAgentIds, isEmpty);
        app.agentMessages.reset();
      },
    );

    test('Agent Messages is asked about once the desk is joined, and '
        'forgotten on sign-out', () async {
      final api = await joinAgentMessagesDesk(app);
      expect(api.reads, 1);
      expect(app.agentMessages.loaded, isTrue);
      // desk_changed may have moved a tab's leader: the settings are read again.
      await app.handleEventForTest('studio', {
        'type': 'desk_changed',
        'payload': {'revision': 0},
      });
      await pumpEventQueue();
      expect(api.reads, 2);
      app.expireSessionForTest('Signed out');
      expect(app.agentMessages.loaded, isFalse);
    });

    test('only desk tabs, once answered, have Agent Messages', () async {
      final desk = app.activeSwarmId;
      expect(
        app.agentMessagesOffered(desk),
        isFalse,
        reason: 'before the desk',
      );
      final api = await joinAgentMessagesDesk(app);
      final joined = app.activeSwarmId;
      expect(app.agentMessagesOffered(joined), isTrue);
      app.openStore();
      expect(app.activeSwarm.isStore, isTrue);
      expect(app.agentMessagesOffered(app.activeSwarmId), isFalse);
      app.newSwarm(draft: true, newTabPage: true);
      expect(app.isDraftSwarm(app.activeSwarmId), isTrue);
      expect(app.agentMessagesOffered(app.activeSwarmId), isFalse);
      api.unsupported = true;
      await app.agentMessages.refresh();
      expect(
        app.agentMessagesOffered(joined),
        isFalse,
        reason: 'an older CLI or backend',
      );
    });

    test('a desk tab with two harnesses polls those on other machines, '
        'with no flag to turn on', () async {
      const laptop = Machine(
        machineId: 'laptop',
        authMode: MachineAuthMode.remote,
        name: 'Laptop',
      );
      app.machineStates['laptop'] = MachineState(laptop)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..agents = [
          const Agent(id: 'web', name: 'Web', terminalAvailable: true),
        ];
      await joinAgentMessagesDesk(app);
      void adopt(String machineId, String agentId) => app.adoptSessionForTest(
        TerminalSession(
          machineId: machineId,
          agentId: agentId,
          agentName: agentId,
          engineId: 'codex',
          send: (_, _) async => true,
          sendBinary: (_) async => true,
        ),
      );
      final tab = app.activeSwarmId;
      adopt('studio', 'lead');
      expect(
        app.agentMessagesRemoteTabs(),
        isEmpty,
        reason: 'one harness has nobody to message',
      );
      adopt('laptop', 'web');
      final remote = app.agentMessagesRemoteTabs().single;
      expect(remote.tabId, tab);
      // No daemon of this computer in this fixture: every machine is remote.
      expect(remote.machineIds, ['studio', 'laptop']);
      app.machineStates['laptop']!.connectionStatus =
          ConnectionStatus.disconnected;
      expect(app.agentMessagesRemoteTabs().single.machineIds, ['studio']);
    });

    test('a tab asks this computer and its connected machines', () {
      expect(
        app.agentMessageMachines(app.activeSwarmId),
        isEmpty,
        reason: 'no local daemon and no panes',
      );
      app.adoptSessionForTest(
        TerminalSession(
          machineId: 'studio',
          agentId: 'lead',
          agentName: 'Lead',
          engineId: 'codex',
          send: (_, _) async => true,
          sendBinary: (_) async => true,
        ),
      );
      expect(app.agentMessageMachines(app.activeSwarmId), ['studio']);
      app.machineStates['studio']!.connectionStatus =
          ConnectionStatus.disconnected;
      expect(app.agentMessageMachines(app.activeSwarmId), isEmpty);
    });
  });
}
