import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/state/desk_sync.dart';
import 'package:harness_mobile/state/phone_desk.dart';

/// A backend holding one desk document, which answers ops the way `routes/desk.ts`
/// does: apply them, bump the revision, hand back what that produced.
class _Backend {
  _Backend({this.tabs = const []});

  List<DeskTab> tabs;
  int _revision = 0;
  int reads = 0;

  /// Every op this backend was ever sent, in order — the phone's side of the
  /// conversation.
  final List<Map<String, dynamic>> received = [];

  /// Set to refuse the next write the way a daemon that has lost its session
  /// does: with nothing.
  bool refuseWrites = false;

  /// Set to fail every call, as a phone with no network does.
  bool offline = false;

  Map<String, dynamic> get _doc => {
    'revision': _revision,
    'tabs': [for (final tab in tabs) tab.toJson()],
  };

  Future<Map<String, dynamic>?> read() async {
    if (offline) throw StateError('no network');
    reads++;
    return _doc;
  }

  Future<Map<String, dynamic>?> write(List<Map<String, dynamic>> ops) async {
    if (offline) throw StateError('no network');
    received.addAll(ops);
    if (refuseWrites) return null;
    tabs = applyDeskOps(tabs, ops);
    _revision++;
    return _doc;
  }

  /// Another computer changing the tabs.
  void edit(List<Map<String, dynamic>> ops) {
    tabs = applyDeskOps(tabs, ops);
    _revision++;
  }
}

DeskTab _tab(String id, String name, List<String> agentIds) => DeskTab(
  id: id,
  name: name,
  panes: [
    for (final agentId in agentIds)
      DeskPaneRef(machineId: 'm', agentId: agentId),
  ],
);

List<String> _agentsOf(PhoneDesk desk, String tabId) => [
  for (final pane in desk.tabs.firstWhere((tab) => tab.id == tabId).panes)
    pane.agentId,
];

void main() {
  late _Backend backend;
  late PhoneDesk desk;
  var changes = 0;

  PhoneDesk deskOver(_Backend backend, {Duration? poll}) => PhoneDesk(
    read: backend.read,
    write: backend.write,
    onChanged: () => changes++,
    // Fifteen seconds is the shipped beat; a test that waited one out would be
    // fifteen seconds long.
    pollInterval: poll ?? const Duration(seconds: 15),
  );

  setUp(() {
    changes = 0;
    backend = _Backend(
      tabs: [
        _tab('t1', 'Desktop', ['a', 'b']),
        _tab('t2', 'Docker', ['c']),
      ],
    );
    desk = deskOver(backend);
    addTearDown(() => desk.dispose());
  });

  Future<void> join() async {
    desk.ensure();
    await pumpEventQueue();
  }

  test('a phone with no desk yet has no tabs, and says so', () {
    expect(desk.enabled, isFalse);
    expect(desk.tabs, isEmpty);
  });

  test('joining reads the desk once and keeps its tabs in order', () async {
    await join();

    expect(desk.enabled, isTrue);
    expect([for (final tab in desk.tabs) tab.name], ['Desktop', 'Docker']);
    expect(_agentsOf(desk, 't1'), ['a', 'b']);
    expect(backend.reads, 1);

    // Joined already: a second call is the no-op every sign-in path relies on.
    desk.ensure();
    await pumpEventQueue();
    expect(backend.reads, 1);
  });

  test(
    'a read that fails leaves the phone without tabs, and it can join later',
    () async {
      backend.offline = true;
      await join();
      expect(desk.enabled, isFalse);

      backend.offline = false;
      await join();
      expect(desk.enabled, isTrue);
      expect(desk.tabs, hasLength(2));
    },
  );

  test(
    'desk_changed only fetches for a revision the phone has not seen',
    () async {
      await join();
      final afterJoin = backend.reads;

      // The same revision, once per machine the phone is connected to.
      desk.noticeRevision(0);
      desk.noticeRevision(0);
      await pumpEventQueue();
      expect(backend.reads, afterJoin);

      backend.edit([
        {'op': 'tab.create', 'id': 't3', 'name': 'Research', 'index': 2},
      ]);
      desk.noticeRevision(1);
      await pumpEventQueue();
      expect(backend.reads, afterJoin + 1);
      expect(
        [for (final tab in desk.tabs) tab.name],
        ['Desktop', 'Docker', 'Research'],
      );
    },
  );

  test('an agent created on the phone joins the tab the phone is in', () async {
    await join();
    desk.note('t2');

    desk.adopt((machineId: 'm', agentId: 'new'));

    // Believed at once, so the strip and the swipe list have it this frame.
    expect(_agentsOf(desk, 't2'), ['c', 'new']);
    await pumpEventQueue();
    expect(backend.received, [
      {'op': 'pane.add', 'tabId': 't2', 'machineId': 'm', 'agentId': 'new'},
    ]);
    expect(_agentsOf(desk, 't2'), ['c', 'new']);
  });

  test('an agent created outside every tab changes nothing', () async {
    await join();
    // The group for the agents no tab holds — see `desk_groups.dart`.
    desk.note(null);

    desk.adopt((machineId: 'm', agentId: 'new'));
    await pumpEventQueue();

    expect(backend.received, isEmpty);
  });

  test('an agent deleted on the phone leaves every tab that held it', () async {
    backend = _Backend(
      tabs: [
        _tab('t1', 'Desktop', ['a', 'b']),
        _tab('t2', 'Docker', ['b']),
      ],
    );
    desk = deskOver(backend);
    await join();

    desk.drop((machineId: 'm', agentId: 'b'));
    await pumpEventQueue();

    expect(_agentsOf(desk, 't1'), ['a']);
    expect(_agentsOf(desk, 't2'), isEmpty);
    expect(backend.received.map((op) => op['tabId']), ['t1', 't2']);
  });

  test(
    'a write held up by the network is kept and replayed, not dropped',
    () async {
      await join();
      desk.note('t2');
      backend.offline = true;

      desk.adopt((machineId: 'm', agentId: 'new'));
      await pumpEventQueue();

      // Shown as done here, and still owed to the backend.
      expect(_agentsOf(desk, 't2'), ['c', 'new']);
      expect(backend.received, isEmpty);

      // A document arriving meanwhile does not undo it: the unsent op is laid
      // back over whatever the desk says.
      backend.offline = false;
      backend.edit([
        {'op': 'pane.add', 'tabId': 't1', 'machineId': 'm', 'agentId': 'd'},
      ]);
      await desk.refresh();

      expect(_agentsOf(desk, 't1'), ['a', 'b', 'd']);
      expect(_agentsOf(desk, 't2'), ['c', 'new']);
    },
  );

  test('a write the backend will not take stops the phone writing', () async {
    await join();
    desk.note('t1');
    backend.refuseWrites = true;

    desk.adopt((machineId: 'm', agentId: 'new'));
    await pumpEventQueue();

    expect(desk.enabled, isFalse);
    expect(backend.received, hasLength(1));

    desk.adopt((machineId: 'm', agentId: 'later'));
    await pumpEventQueue();
    expect(backend.received, hasLength(1));
  });

  test('a foreground phone keeps reading the desk on its own', () async {
    // ⚠️ The regression this is here for: a phone left on one screen never saw
    // a tab made on a computer. `desk_changed` reaches a phone only over a
    // machine's relay socket, so a backend that does not forward it — or a
    // moment with no machine connected — delivered nothing, and the reading of
    // the desk this app made at launch was the last one it ever made.
    desk = deskOver(backend, poll: const Duration(milliseconds: 10));
    await join();
    expect(desk.tabs, hasLength(2));

    backend.edit([
      {'op': 'tab.create', 'id': 't3', 'name': 'test', 'index': 2},
    ]);
    await Future<void>.delayed(const Duration(milliseconds: 40));

    expect([for (final tab in desk.tabs) tab.name], [
      'Desktop',
      'Docker',
      'test',
    ]);

    // And nothing while the app is in somebody's pocket.
    desk.pause();
    backend.edit([
      {'op': 'tab.close', 'id': 't3'},
    ]);
    final reads = backend.reads;
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(backend.reads, reads);
    expect(desk.tabs, hasLength(3));
  });

  test('a tab picked by hand is remembered', () async {
    await join();

    desk.select('t2');
    expect(desk.activeTabId, 't2');
    expect(changes, greaterThan(0));

    // And the screen's own reading of which tab it ended up in overwrites it,
    // without asking for a redraw of what is already drawn.
    final drawn = changes;
    desk.note('t1');
    expect(desk.activeTabId, 't1');
    expect(changes, drawn);
  });

  test(
    'signing out takes the tabs, the tab you were in, and the unsent writes',
    () async {
      await join();
      desk.note('t1');
      backend.offline = true;
      desk.adopt((machineId: 'm', agentId: 'new'));
      await pumpEventQueue();

      desk.reset();

      expect(desk.enabled, isFalse);
      expect(desk.tabs, isEmpty);
      expect(desk.activeTabId, isNull);

      // The write belonged to the account that left: the next one must not send it.
      backend.offline = false;
      await pumpEventQueue();
      expect(backend.received, isEmpty);
    },
  );
}
