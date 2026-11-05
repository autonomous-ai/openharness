import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';

/// A crew member's sleep and move, read as the desktop's model reads them (desktop_parity_test.dart names the
/// fields; this holds their values): since when it sleeps, and whether it is on its way to another machine (#3412).
void main() {
  Map<String, dynamic> agent([Map<String, dynamic> more = const {}]) => {
    'id': 'a1',
    'projectId': 'lead',
    'name': 'Keeper',
    'machineId': 'mac3',
    'harnessId': 'h-a1',
    'contributorId': 'owner',
    'configuration': {'engine': 'claude'},
    'crew': {'role': 'Engineer', 'at': 1, 'by': 'owner'},
    ...more,
  };

  test('an asleep crew member says since when; a moving one says so', () {
    final since = DateTime.utc(2026, 11, 5, 10).millisecondsSinceEpoch;
    final asleep = SuperTabAgent.fromJson(
      agent({
        'asleep': {'since': since},
      }),
    );
    expect(asleep.crewAsleep, isTrue);
    expect(asleep.crewAsleepSince?.millisecondsSinceEpoch, since);
    expect(asleep.crewMoving, isFalse);
    final moving = SuperTabAgent.fromJson(
      agent({
        'movedTo': {'machineId': 'mini'},
      }),
    );
    expect(moving.crewMoving, isTrue);
    expect(moving.crewAsleepSince, isNull);
  });

  test('an asleep record without a time reads asleep, with no time', () {
    final agentRow = SuperTabAgent.fromJson(
      agent({
        'asleep': {'folderDropped': true},
      }),
    );
    expect(agentRow.crewAsleep, isTrue);
    expect(agentRow.crewAsleepSince, isNull);
  });
}
