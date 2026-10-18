// Where other accounts' harnesses go on this account's desk (1c, R1 and R2):
// the roster places a pane once, after which the desk owns it.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/shared_tab_placement.dart';
import 'package:harness/agent_messages/shared_tabs_model.dart';
import 'package:harness/state/desk_sync.dart' show isDeskId;

/// The key a harness has in `deskPaneKeys` and `seen`: the desk's own
/// (`DeskPaneRef.key`), which `SharedTabHarness.key` matches.
String k(String machineId, String agentId) => '$machineId\u0000$agentId';

/// `s1`'s desk tab on a member's desk (R1): derived from the shared tab id.
final d1 = memberDeskTabId('s1');

/// Shared tab `s1` named `app`, owned by [owner], listing [foreign] (each
/// `machine/agent`) under account `alice` and one harness of `bob`'s own.
SharedTab tab({
  String owner = 'alice',
  String? ownerTabId,
  List<String> foreign = const ['ma/a1'],
  String foreignAccount = 'alice',
}) => SharedTab(
  sharedTabId: 's1',
  ownerTabId: ownerTabId,
  name: 'app',
  version: 1,
  ownerAccountId: owner,
  ownerEmail: '$owner@example.com',
  ownerMachineId: owner == 'alice' ? 'ma' : 'mb',
  leader: null,
  members: const [],
  harnesses: [
    for (final key in foreign)
      SharedTabHarness(
        accountId: foreignAccount,
        machineId: key.split('/').first,
        agentId: key.split('/').last,
        name: key,
        engine: 'claude',
      ),
    // This account's own harness in the tab is never placed by the roster.
    if (owner != 'bob')
      const SharedTabHarness(
        accountId: 'bob',
        machineId: 'mown',
        agentId: 'own1',
        name: 'own',
        engine: 'codex',
      ),
  ],
  invites: const [],
);

void main() {
  test('a member\'s desk tab id is derived: 32 hex of sha256, the same on every computer, and a desk id (R1)', () {
    // sha256('harness-member-tab' + 'aaaaaaaaaaaaaaaaaaaaaaaa'), its first 32 hex characters.
    expect(
      memberDeskTabId('aaaaaaaaaaaaaaaaaaaaaaaa'),
      'cd442ba11c62db807e48f4021695be72',
    );
    expect(memberDeskTabId('s1'), d1);
    expect(isDeskId(d1), isTrue);
    expect(memberDeskTabId('s2'), isNot(d1));
    expect(tab().deskTabId('bob'), d1);
    expect(tab(owner: 'bob', ownerTabId: 'own-tab').deskTabId('bob'), 'own-tab');
    // An Agent Messages tab id the daemons give a member's tab (24 hex) names
    // that derived desk tab; a desk id names itself.
    expect(
      deskTabIdForMessages('aaaaaaaaaaaaaaaaaaaaaaaa'),
      memberDeskTabId('aaaaaaaaaaaaaaaaaaaaaaaa'),
    );
    expect(deskTabIdForMessages(d1), d1);
    expect(deskTabIdForMessages('swarm-1'), 'swarm-1');
  });

  test('the placement key is the desk pane key', () {
    expect(tab().harnesses.first.key, k('ma', 'a1'));
  });

  test('a member\'s first sight creates its tab and places every other account\'s harness', () {
    final p = planSharedPlacement(
      me: 'bob',
      tabs: [tab()],
      deskTabIds: {},
      deskPaneKeys: {},
      seen: {},
    );
    expect(p.createTabs, [(id: d1, name: 'app')]);
    expect(p.addPanes, [(deskTabId: d1, machineId: 'ma', agentId: 'a1')]);
    expect(p.seen, {
      's1': {k('ma', 'a1')},
    });
  });

  test('a tab the member closed is never created again here (Review Focus 1)', () {
    final p = planSharedPlacement(
      me: 'bob',
      tabs: [
        tab(foreign: ['ma/a1', 'ma/a2']),
      ],
      deskTabIds: {},
      deskPaneKeys: {},
      seen: {
        's1': {k('ma', 'a1')},
      },
    );
    expect(p.createTabs, isEmpty);
    expect(p.addPanes, isEmpty);
    expect(p.seen['s1'], {k('ma', 'a1'), k('ma', 'a2')});
  });

  test('a harness that joins later is placed once', () {
    final p = planSharedPlacement(
      me: 'bob',
      tabs: [
        tab(foreign: ['ma/a1', 'ma/a2']),
      ],
      deskTabIds: {d1},
      deskPaneKeys: {k('ma', 'a1')},
      seen: {
        's1': {k('ma', 'a1')},
      },
    );
    expect(p.createTabs, isEmpty);
    expect(p.addPanes, [(deskTabId: d1, machineId: 'ma', agentId: 'a2')]);
    expect(p.seen['s1'], {k('ma', 'a1'), k('ma', 'a2')});
    // The next roster read, with the pane on the desk, places nothing more.
    final again = planSharedPlacement(
      me: 'bob',
      tabs: [
        tab(foreign: ['ma/a1', 'ma/a2']),
      ],
      deskTabIds: {d1},
      deskPaneKeys: {k('ma', 'a1'), k('ma', 'a2')},
      seen: p.seen,
    );
    expect(again.addPanes, isEmpty);
  });

  test('a pane the person closed is not placed again', () {
    final p = planSharedPlacement(
      me: 'bob',
      tabs: [tab()],
      deskTabIds: {d1},
      deskPaneKeys: {},
      seen: {
        's1': {k('ma', 'a1')},
      },
    );
    expect(p.createTabs, isEmpty);
    expect(p.addPanes, isEmpty);
    expect(p.seen['s1'], {k('ma', 'a1')});
  });

  test('first sight of an existing desk tab places only what the desk holds nowhere', () {
    final p = planSharedPlacement(
      me: 'bob',
      tabs: [
        tab(foreign: ['ma/a1', 'ma/a2']),
      ],
      deskTabIds: {d1},
      deskPaneKeys: {k('ma', 'a1')},
      seen: {},
    );
    expect(p.createTabs, isEmpty);
    expect(p.addPanes, [(deskTabId: d1, machineId: 'ma', agentId: 'a2')]);
    expect(p.seen['s1'], {k('ma', 'a1'), k('ma', 'a2')});
  });

  test('a harness the desk holds in another tab is not placed on first sight', () {
    final p = planSharedPlacement(
      me: 'bob',
      tabs: [tab()],
      deskTabIds: {d1, 'other'},
      deskPaneKeys: {k('ma', 'a1')},
      seen: {},
    );
    expect(p.addPanes, isEmpty);
  });

  test('the owner places a member\'s harness into the tab it shared, never creating one', () {
    final p = planSharedPlacement(
      me: 'alice',
      tabs: [
        tab(
          owner: 'alice',
          ownerTabId: 'swarm-3',
          foreign: ['mb/b1'],
          foreignAccount: 'bob',
        ),
      ],
      deskTabIds: {'swarm-3'},
      deskPaneKeys: {},
      seen: {'s1': {}},
    );
    expect(p.createTabs, isEmpty);
    // bob's own `mown/own1` is foreign to alice as well: both are placed.
    expect(p.addPanes, [
      (deskTabId: 'swarm-3', machineId: 'mb', agentId: 'b1'),
      (deskTabId: 'swarm-3', machineId: 'mown', agentId: 'own1'),
    ]);
    expect(p.seen['s1'], {k('mb', 'b1'), k('mown', 'own1')});
  });

  test('the owner whose shared tab is closed on its desk gets no new tab', () {
    final p = planSharedPlacement(
      me: 'alice',
      tabs: [
        tab(
          owner: 'alice',
          ownerTabId: 'swarm-3',
          foreign: ['mb/b1'],
          foreignAccount: 'bob',
        ),
      ],
      deskTabIds: {},
      deskPaneKeys: {},
      seen: {},
    );
    expect(p.createTabs, isEmpty);
    expect(p.addPanes, isEmpty);
  });

  test('an owned tab whose desk tab is not known yet waits', () {
    final before = {
      's1': {k('mb', 'b0')},
    };
    final p = planSharedPlacement(
      me: 'alice',
      tabs: [
        tab(owner: 'alice', foreign: ['mb/b1'], foreignAccount: 'bob'),
      ],
      deskTabIds: {'swarm-3'},
      deskPaneKeys: {},
      seen: before,
    );
    expect(p.createTabs, isEmpty);
    expect(p.addPanes, isEmpty);
    expect(p.seen, {
      's1': {k('mb', 'b0')},
    });
    // Never seen before either: nothing is recorded, so the first sight of
    // its desk tab places as a first sight does.
    final fresh = planSharedPlacement(
      me: 'alice',
      tabs: [
        tab(owner: 'alice', foreign: ['mb/b1'], foreignAccount: 'bob'),
      ],
      deskTabIds: {'swarm-3'},
      deskPaneKeys: {},
      seen: {},
    );
    expect(fresh.seen, isEmpty);
  });

  test('a tab no longer held is forgotten, so a later invitation places again', () {
    final p = planSharedPlacement(
      me: 'bob',
      tabs: [tab()],
      deskTabIds: {d1},
      deskPaneKeys: {k('ma', 'a1')},
      seen: {
        'old': {k('mx', 'x1')},
        's1': {k('ma', 'a1')},
      },
    );
    expect(p.seen.containsKey('old'), isFalse);
    expect(p.seen['s1'], {k('ma', 'a1')});
  });

  test('this account\'s own harnesses are never placed', () {
    final p = planSharedPlacement(
      me: 'bob',
      tabs: [tab(foreign: const [])],
      deskTabIds: {},
      deskPaneKeys: {},
      seen: {},
    );
    expect(p.createTabs, [(id: d1, name: 'app')]);
    expect(p.addPanes, isEmpty);
    expect(p.seen, {'s1': <String>{}});
  });
}
