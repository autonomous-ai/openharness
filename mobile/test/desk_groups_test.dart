import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/agent_index.dart';
import 'package:harness_mobile/phone/desk_groups.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_pager_fixture.dart';
import 'desk_fixture.dart';

/// The desk's tabs, as the phone's strip and its swipe see them.
///
/// The fixture's machine runs four agents — a, b, c, d — and every test below
/// is about which of them a given tab offers.
void main() {
  late PagerConn conn;

  setUp(() => conn = PagerConn());

  Future<AppNotifier> appWith(List<String> desktop, List<String> docker) async {
    final built = await deskApp(
      conn,
      tabs: [
        deskTab('t1', 'Desktop', desktop),
        deskTab('t2', 'Docker', docker),
      ],
    );
    addTearDown(built.dispose);
    return built;
  }

  List<String> agentsOf(DeskGroup group) => [
    for (final entry in group.entries) entry.agent.id,
  ];

  List<DeskGroup> groupsOf(AppNotifier built) =>
      deskGroups(built, visibleAgents(agentIndex(built)));

  test('each tab holds its own agents, in the tab\'s order', () async {
    final built = await appWith(['b', 'a'], ['c']);

    final groups = groupsOf(built);

    expect(
      [for (final group in groups) group.name],
      ['Desktop', 'Docker', kUntabbedGroupName],
    );
    expect(agentsOf(groups[0]), ['b', 'a']);
    expect(agentsOf(groups[1]), ['c']);
  });

  test('the agents no tab holds are a group of their own, last', () async {
    final built = await appWith(['a'], ['b']);

    final groups = groupsOf(built);

    expect(groups.last.name, kUntabbedGroupName);
    expect(groups.last.id, isNull);
    expect(agentsOf(groups.last), ['c', 'd']);
  });

  test('nothing left over means no group for it', () async {
    final built = await appWith(['a', 'b'], ['c', 'd']);

    expect(
      [for (final group in groupsOf(built)) group.name],
      ['Desktop', 'Docker'],
    );
  });

  test('an account with no tabs gets one group over every agent', () async {
    final built = await deskApp(conn);
    addTearDown(built.dispose);

    final groups = groupsOf(built);

    expect(groups, hasLength(1));
    expect(groups.single.name, kEveryAgentGroupName);
    expect(agentsOf(groups.single), ['a', 'b', 'c', 'd']);
  });

  test('a tab naming agents this phone cannot reach is drawn empty', () async {
    final built = await appWith(['nobody'], ['c']);

    final groups = groupsOf(built);

    expect(groups[0].isEmpty, isTrue);
    expect(agentsOf(groups[1]), ['c']);
    // And the unreachable agent is nobody's leftover either.
    expect(agentsOf(groups.last), ['a', 'b', 'd']);
  });

  test(
    'the tab the phone is in is the one holding the agent on screen',
    () async {
      final built = await appWith(['a'], ['c']);
      final groups = groupsOf(built);

      final active = activeDeskGroup(built, groups, (
        machineId: 'm',
        agentId: 'c',
      ));

      expect(active.name, 'Docker');
    },
  );

  test('an agent on two tabs stays in the one the phone chose', () async {
    final built = await appWith(['a', 'c'], ['c']);
    final groups = groupsOf(built);
    const showing = (machineId: 'm', agentId: 'c');

    // Nothing chosen yet: the desk's own order settles it.
    expect(activeDeskGroup(built, groups, showing).name, 'Desktop');

    built.selectDeskTab('t2');
    expect(activeDeskGroup(built, groups, showing).name, 'Docker');
  });

  test('with nothing on screen the tab last chosen holds the strip', () async {
    final built = await appWith(['a'], ['c']);
    final groups = groupsOf(built);

    built.selectDeskTab('t2');

    expect(activeDeskGroup(built, groups, null).name, 'Docker');
  });
}
