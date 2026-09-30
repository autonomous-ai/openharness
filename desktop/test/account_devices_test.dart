import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/account_devices.dart';

/// The Devices list's model (`lib/state/account_devices.dart`): what a daemon answers, and which apps
/// it offers to remove as unused.
void main() {
  final now = DateTime(2026, 10, 1);
  Map<String, Object?> row(String pub, {String kind = 'viewer', bool self = false}) => {
    'pub': pub, 'label': pub, 'kind': kind, 'machineId': kind == 'machine' ? 'a' * 32 : '',
    'addedAt': DateTime(2026, 1, 1).millisecondsSinceEpoch, 'fingerprint': 'FP', 'self': self,
  };

  test('reads a daemon listing with its frozen state and when each key was last seen', () {
    final devices = AccountDevices.fromDaemon({
      'members': [row('old'), row('me', self: true), row('box', kind: 'machine'), {'bad': true}],
      'frozen': {'reason': 'fork'},
      'frozenPeers': ['box2'],
      'lastSeen': {'old': DateTime(2026, 5, 1).millisecondsSinceEpoch, 'junk': 'x'},
    })!;
    expect(devices.devices.map((d) => d.pub), ['old', 'me', 'box']);
    expect(devices.frozenReason, 'fork');
    expect(devices.frozen, isTrue);
    expect(devices.devices.first.lastSeen, DateTime(2026, 5, 1));
    expect(devices.devices[1].lastSeen, isNull);
  });

  test('offers only apps seen long ago — never this one, a computer, or one never recorded', () {
    final long = DateTime(2026, 5, 1).millisecondsSinceEpoch;
    final devices = AccountDevices.fromDaemon({
      'members': [
        row('stale'), row('fresh'), row('never'), row('me', self: true), row('box', kind: 'machine'),
      ],
      'lastSeen': {
        'stale': long, 'me': long, 'box': long,
        'fresh': DateTime(2026, 9, 20).millisecondsSinceEpoch,
      },
    })!;
    expect(devices.unused(now).map((d) => d.pub), ['stale']);
  });
}
