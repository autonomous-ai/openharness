// The desk: the account's tabs, the same on every computer. The pure half
// (diff and replay) and the window's half (a document becomes `swarms`, an
// edit becomes ops, and what a window keeps for itself stays put).
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/desk_sync.dart';

import 'swarm_state_test.dart' show createApp;

DeskTab tab(
  String id, {
  String name = 'Tab',
  bool custom = false,
  List<String> agents = const [],
}) => DeskTab(
  id: id,
  name: name,
  nameIsCustom: custom,
  panes: [for (final a in agents) DeskPaneRef(machineId: 'm', agentId: a)],
);

/// The daemon's desk proxy, scripted: a document to hand out, the ops it was
/// asked to apply (applied with the same rules the backend uses), or a failure.
class _DeskApi extends ApiClient {
  _DeskApi() : super(config: AppConfig.dev, session: AuthSession());
  DeskDoc? doc = const DeskDoc(revision: 0, tabs: []);
  bool available = true;
  Object? failWith;
  final batches = <List<Map<String, dynamic>>>[];

  Map<String, dynamic>? _json(DeskDoc d) => {
    'revision': d.revision,
    'tabs': [for (final t in d.tabs) t.toJson()],
  };

  @override
  Future<Map<String, dynamic>?> desk() async {
    if (failWith != null) throw failWith!;
    if (!available || doc == null) return null;
    return _json(doc!);
  }

  @override
  Future<Map<String, dynamic>?> deskOps(List<Map<String, dynamic>> ops) async {
    if (failWith != null) throw failWith!;
    if (!available || doc == null) return null;
    batches.add(ops);
    final next = applyDeskOps(doc!.tabs, ops);
    doc = DeskDoc(revision: doc!.revision + 1, tabs: next);
    return _json(doc!);
  }
}

void main() {
  group('deskDiff', () {
    test('creates a tab with its panes, closes, renames only what the person named, and reorders', () {
      final before = [
        tab('a', agents: ['x']),
        tab('b', name: 'derived'),
      ];
      final after = [
        tab('b', name: 'Home', custom: true),
        tab('c', name: 'New', agents: ['y', 'z']),
      ];
      final ops = deskDiff(before, after);
      expect(ops.map((o) => o['op']), [
        'tab.close',
        'tab.create',
        'pane.add',
        'pane.add',
        'tab.rename',
      ]);
      expect(ops[1], {
        'op': 'tab.create',
        'id': 'c',
        'name': 'New',
        'index': 1,
      });
      expect(ops[2], {
        'op': 'pane.add',
        'tabId': 'c',
        'machineId': 'm',
        'agentId': 'y',
        'index': 0,
      });
      expect(ops[4], {
        'op': 'tab.rename',
        'id': 'b',
        'name': 'Home',
        'nameIsCustom': true,
      });
      // A derived name that differs is each window's own to derive — no op.
      expect(
        deskDiff([tab('b', name: 'one')], [tab('b', name: 'two')]),
        isEmpty,
      );
      // Order of tabs both sides have.
      expect(
        deskDiff(
          [tab('a'), tab('b')],
          [tab('b'), tab('a')],
        ).map((o) => o['op']),
        ['tab.move', 'tab.move'],
      );
    });

    test('adds, removes and moves panes within a tab', () {
      final ops = deskDiff(
        [
          tab('a', agents: ['x', 'y']),
        ],
        [
          tab('a', agents: ['y', 'z']),
        ],
      );
      expect(ops, [
        {'op': 'pane.remove', 'tabId': 'a', 'machineId': 'm', 'agentId': 'x'},
        {
          'op': 'pane.add',
          'tabId': 'a',
          'machineId': 'm',
          'agentId': 'z',
          'index': 1,
        },
      ]);
      final moved = deskDiff(
        [
          tab('a', agents: ['x', 'y']),
        ],
        [
          tab('a', agents: ['y', 'x']),
        ],
      );
      expect(moved.map((o) => o['op']), ['pane.move', 'pane.move']);
      expect(
        deskDiff(
          [
            tab('a', agents: ['x']),
          ],
          [
            tab('a', agents: ['x']),
          ],
        ),
        isEmpty,
      );
    });

    test(
      'replays like the backend: idempotent, and nothing on a tab that is gone',
      () {
        final tabs = applyDeskOps(
          [tab('a')],
          [
            {'op': 'pane.add', 'tabId': 'a', 'machineId': 'm', 'agentId': 'x'},
            {'op': 'pane.add', 'tabId': 'a', 'machineId': 'm', 'agentId': 'x'},
            {'op': 'tab.close', 'id': 'a'},
            {'op': 'pane.add', 'tabId': 'a', 'machineId': 'm', 'agentId': 'y'},
            {'op': 'tab.create', 'id': 'b', 'name': 'B', 'index': 0},
            {'op': 'tab.create', 'id': 'b', 'name': 'B'},
          ],
        );
        expect(tabs.map((t) => t.id), ['b']);
        // A diff, replayed, is the "after" it was taken from.
        final before = [
          tab('a', agents: ['x', 'y']),
          tab('b'),
        ];
        final after = [
          tab('b', name: 'Home', custom: true),
          tab('a', agents: ['y']),
          tab('c', agents: ['z']),
        ];
        final replayed = applyDeskOps(before, deskDiff(before, after));
        expect(
          [for (final t in replayed) t.toJson()],
          [for (final t in after) t.toJson()],
        );
      },
    );

    test(
      'desk ids are 32 hex characters; a window\'s own numbering is not one',
      () {
        expect(isDeskId(newDeskId()), isTrue);
        expect(newDeskId(), isNot(newDeskId()));
        expect(isDeskId('swarm-3'), isFalse);
      },
    );
  });

  group('the window and the desk', () {
    test('joins the desk: its own tabs get desk ids and are seeded, the desk\'s tabs appear as intent', () async {
      final api = _DeskApi()
        ..doc = DeskDoc(
          revision: 4,
          tabs: [
            tab(
              'd1',
              name: 'From the other Mac',
              custom: true,
              agents: ['a5', 'a6'],
            ),
          ],
        );
      final app = createApp()..api = api;
      addTearDown(app.dispose);
      await app.addAgentToSwarm(
        'm',
        'a0',
      ); // this window's own tab, numbered swarm-N
      final own = app.activeSwarm;
      expect(isDeskId(own.id), isFalse);

      await app.deskStartForTest();

      expect(
        isDeskId(own.id),
        isTrue,
        reason: 'the local tab was given a desk id',
      );
      expect(api.batches.single.single['op'], 'seed');
      // The desk's own tabs first, this computer's after them — that is where the seed puts them.
      expect(app.swarms.map((s) => s.id), ['d1', own.id]);
      final remote = app.swarms.first;
      expect(remote.name, 'From the other Mac');
      expect(remote.panes.map((p) => p.agentId), ['a5', 'a6']);
      expect(
        remote.panes.every((p) => p.session == null),
        isTrue,
        reason: 'intent only until the machine answers',
      );
      expect(
        app.activeSwarmId,
        own.id,
        reason: 'the active tab is this window\'s',
      );
      expect(app.deskSyncForTest.revision, 5);
      expect(app.deskSyncForTest.pending, isEmpty);
    });

    test(
      'says every edit as ops: new tab, a pane, a rename, an order, a close',
      () async {
        final api = _DeskApi();
        final app = createApp()..api = api;
        addTearDown(app.dispose);
        await app.deskStartForTest();
        api.batches.clear();

        app.newSwarm(name: 'Work');
        final work = app.activeSwarm;
        expect(isDeskId(work.id), isTrue);
        await app.addAgentToSwarm('m', 'a1');
        app.renameSwarm(work.id, 'Real work');
        app.newSwarm(name: 'Second');
        final second = app.activeSwarm;
        app.reorderSwarm(second.id, 0);
        await app.closeSwarm(work.id);
        await Future<void>.delayed(Duration.zero);

        final sent = api.batches.expand((b) => b).map((o) => o['op']).toList();
        expect(
          sent,
          containsAllInOrder([
            'tab.create',
            'pane.add',
            'tab.rename',
            'tab.create',
            'tab.move',
            'tab.close',
          ]),
        );
        // The starter tab this window opened with is on the desk too (empty, unnamed) — a tab is a tab.
        final ids = api.doc!.tabs.map((t) => t.id).toList();
        expect(ids, contains(second.id));
        expect(ids, isNot(contains(work.id)));
        expect(
          ids,
          app.swarms.map((s) => s.id).toList(),
          reason: 'the desk and the window agree on order',
        );
        expect(app.deskSyncForTest.pending, isEmpty);
      },
    );

    test('a desk_changed push closes a tab closed elsewhere and opens one opened elsewhere, keeping this window\'s focus', () async {
      final api = _DeskApi()
        ..doc = DeskDoc(
          revision: 1,
          tabs: [
            tab('d1', name: 'One', custom: true, agents: ['a1', 'a2']),
            tab('d2', name: 'Two', custom: true, agents: ['a3']),
          ],
        );
      final app = createApp()..api = api;
      addTearDown(app.dispose);
      await app.deskStartForTest();
      api.batches.clear();
      app.selectSwarm('d1');
      final d1 = app.activeSwarm;
      final second = d1.panes[1];
      app.focusPane(second.id);
      expect(d1.focusedPaneId, second.id);

      // The other Mac: closed Two, renamed One, added a pane to One, opened Three.
      api.doc = DeskDoc(
        revision: 9,
        tabs: [
          tab('d3', name: 'Three', custom: true, agents: ['a9']),
          tab(
            'd1',
            name: 'One, really',
            custom: true,
            agents: ['a1', 'a2', 'a4'],
          ),
        ],
      );
      await app.handleEventForTest('m', {
        'type': 'desk_changed',
        'payload': {'revision': 9},
      });
      await Future<void>.delayed(Duration.zero);

      // This window's starter tab went too: the other Mac's document did not have it.
      expect(app.swarms.map((s) => s.id), ['d3', 'd1']);
      expect(app.activeSwarmId, 'd1');
      expect(d1.name, 'One, really');
      expect(d1.panes.map((p) => p.agentId), ['a1', 'a2', 'a4']);
      expect(d1.focusedPaneId, second.id, reason: 'focus is this window\'s');
      expect(
        api.batches,
        isEmpty,
        reason: 'applying the desk sends nothing back',
      );
    });

    test('keeps its ops while the backend is unreachable and sends them once it is back', () async {
      final api = _DeskApi();
      final app = createApp()..api = api;
      addTearDown(app.dispose);
      await app.deskStartForTest();
      api.failWith = StateError('offline');
      app.newSwarm(name: 'Offline work');
      final offline = app.activeSwarm;
      await Future<void>.delayed(Duration.zero);
      expect(app.deskSyncForTest.pending, isNotEmpty);
      expect(api.doc!.tabs.map((t) => t.id), isNot(contains(offline.id)));

      api.failWith = null;
      await app.deskFlushForTest();
      expect(api.doc!.tabs.map((t) => t.id), contains(offline.id));
      expect(app.deskSyncForTest.pending, isEmpty);
    });

    test(
      'a daemon without a desk leaves the window as it was: local ids, no ops',
      () async {
        final api = _DeskApi()..available = false;
        final app = createApp()..api = api;
        addTearDown(app.dispose);
        await app.addAgentToSwarm('m', 'a0');
        await app.deskStartForTest();
        expect(app.deskSyncForTest.enabled, isFalse);
        app.newSwarm(name: 'Local');
        expect(isDeskId(app.activeSwarm.id), isFalse);
        expect(api.batches, isEmpty);
      },
    );
  });
}
