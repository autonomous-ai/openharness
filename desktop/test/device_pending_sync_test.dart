// A desktop build keeps no device log of its own: which devices are still new, and whether this
// computer's id is held by another key, are read from the daemon — and "seen" is written back to it.
import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/account_devices.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/viewer/device_history.dart' show DeviceDepartedCopy;
import 'package:harness/viewer/device_log.dart' show DevLogHead;
import 'package:harness/ws/ws_conn.dart';

/// A socket that answers every request with nothing: connecting a machine loads its data, and only
/// what that does to the device notices is under test.
class _QuietConn extends WsConn {
  _QuietConn()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) => Future.value({});
}

/// A socket that is up: the local machine's link is live, so a frame from it heals an "offline" mark.
class _ReadyConn extends _QuietConn {
  @override
  bool get isReady => true;
}

class _DaemonApi extends ApiClient {
  _DaemonApi() : super(config: AppConfig.dev, session: AuthSession());

  Map<String, dynamic>? listing;
  Map<String, dynamic>? history;

  /// Whether marking DEVICES seen succeeds; "Got it" on the baseline panel is a write of its own.
  bool dismissWorks = true;
  bool baselineWorks = true;
  final dismissed = <({String? pub, List<String>? pubs, bool baseline})>[];
  final rebaselines = <({bool confirm, Map<String, Object?>? head})>[];
  Map<String, dynamic>? rebaselineAnswer;

  /// When set, each read waits on the next of these, so reads can be made to answer out of order.
  List<Completer<Map<String, dynamic>?>>? held;

  @override
  Future<Map<String, dynamic>?> daemonDevices() async {
    if (held case final queue?) {
      final gate = Completer<Map<String, dynamic>?>();
      queue.add(gate);
      return gate.future;
    }
    return listing;
  }

  @override
  Future<bool> daemonDismissDevices({
    String? pub,
    List<String>? pubs,
    bool baseline = false,
  }) async {
    dismissed.add((pub: pub, pubs: pubs, baseline: baseline));
    if (dismissWorks && !baseline && listing?['pending'] is List) {
      listing!['pending'] = [
        for (final p in listing!['pending'] as List)
          if (pub != p && !(pubs?.contains(p) ?? false)) p,
      ];
      // The daemon clears a departed key the same way it clears a pending one.
      if (listing!['departed'] is List) {
        listing!['departed'] = [
          for (final d in listing!['departed'] as List)
            if (d is Map &&
                pub != d['pub'] &&
                !(pubs?.contains(d['pub']) ?? false))
              d,
        ];
      }
    }
    return baseline ? baselineWorks : dismissWorks;
  }

  @override
  Future<Map<String, dynamic>?> daemonRebaselineDevices({
    required bool confirm,
    Map<String, Object?>? head,
  }) async {
    rebaselines.add((confirm: confirm, head: head));
    return rebaselineAnswer;
  }

  @override
  Future<Map<String, dynamic>?> daemonDeviceHistory() async => history;
}

Map<String, Object?> _member(
  String pub,
  int seq, {
  String kind = 'viewer',
  bool self = false,
  bool suspended = false,
}) => {
  'pub': pub,
  'label': pub.toUpperCase(),
  'kind': kind,
  'machineId': '',
  'addedAt': 1000 + seq,
  'fingerprint': 'FP$seq',
  'self': self,
  'seq': seq,
  'suspended': suspended,
};

const _machine = Machine(
  machineId: 'm',
  authMode: MachineAuthMode.remote,
  name: 'Mac',
);

void main() {
  late AppNotifier app;
  late _DaemonApi api;

  setUp(() {
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      connectionForTest: (_) => _QuietConn(),
    );
    api = _DaemonApi();
    app.api = api;
    app.machines = [_machine];
    app.machineStates['m'] = MachineState(_machine);
    app.ownDaemonMachineIdForTest('m');
  });
  tearDown(() => app.dispose());

  Future<void> frame(String type) => app.handleEventForTest('m', {
    'type': type,
    'payload': <String, dynamic>{},
  });

  test('what the daemon kept as pending becomes the new devices, oldest first, with their key codes', () async {
    api.listing = {
      'members': [
        _member('me', 1, self: true),
        _member('b', 4),
        _member('a', 3),
        _member('old', 2),
      ],
      'pending': ['a', 'b', 'gone'],
      'conflict': {
        'pub': 'holder',
        'label': 'H',
        'fingerprint': 'HH',
        'addedAt': 9,
        'afterJoin': false,
      },
    };
    await frame('device_keys_changed');
    await Future<void>.delayed(Duration.zero);
    expect(app.newDevices.map((d) => d.pub), ['a', 'b']);
    expect(app.newDevices.first.fingerprint, 'FP3');
    expect(app.deviceConflict?.pub, 'holder');
    // Once the daemon stops reporting the holder, the band goes.
    api.listing = {
      'members': [_member('me', 1, self: true)],
      'pending': <String>[],
    };
    await frame('device_keys_changed');
    await Future<void>.delayed(Duration.zero);
    expect(app.newDevices, isEmpty);
    expect(app.deviceConflict, isNull);
  });

  test('a daemon without pending leaves the in-memory notices exactly as they were', () async {
    api.listing = {
      'members': [_member('me', 1, self: true)],
    };
    await app.handleEventForTest('m', {
      'type': 'device_key_added',
      'payload': {'pub': 'p', 'label': 'iPad', 'kind': 'viewer'},
    });
    await frame('device_keys_changed');
    await Future<void>.delayed(Duration.zero);
    expect(app.newDevices.map((d) => d.pub), ['p']);
  });

  Map<String, Object?> departed(
    String pub, {
    String by = 'box',
    bool self = false,
    int removedAt = 50,
  }) => {
    'pub': pub,
    'label': 'Phone',
    'kind': 'viewer',
    'machineId': '',
    'fingerprint': 'FP·$pub',
    'addedAt': 10,
    'removedAt': removedAt,
    'removedBy': self ? pub : by,
    'removedByLabel': self ? 'Phone' : 'Box',
    'selfRemoved': self,
  };

  test('the link to this computer\'s own daemon coming back reads the listing again: what arose while it was down shows', () async {
    api.listing = {
      'members': [_member('me', 1, self: true)],
      'pending': <String>[],
    };
    await frame('device_keys_changed');
    await Future<void>.delayed(Duration.zero);
    expect(app.newDevices, isEmpty);
    expect(app.departedDevices, isEmpty);
    expect(app.deviceConflict, isNull);

    // While the link was down the daemon found a held computer id, a new key and a departed one; the
    // frames that said so reached nobody.
    api.listing = {
      'members': [_member('me', 1, self: true), _member('p', 2)],
      'pending': ['p'],
      'departed': [departed('gone')],
      'conflict': {
        'pub': 'holder',
        'label': 'H',
        'fingerprint': 'HH',
        'addedAt': 9,
        'afterJoin': false,
      },
    };
    app.onMachineConnectedForTest('m');
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
    expect(app.newDevices.map((d) => d.pub), ['p']);
    expect(app.departedDevices.map((d) => d.pub), ['gone']);
    expect(app.deviceConflict?.pub, 'holder');
  });

  test('this computer\'s machine healed from "offline" by a live local socket reads the listing again too', () async {
    // The other way the daemon's link comes back: no reconnect, the socket was live all along and a
    // frame from it restores the machine (_healLocalMachine).
    app.dispose();
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      connectionForTest: (_) => _ReadyConn(),
    );
    app.api = api;
    app.machines = [_machine];
    app.machineStates['m'] = MachineState(_machine)
      ..localOnly = true
      ..nodeOnline = false
      ..localEndpoint = null;
    app.ownDaemonMachineIdForTest('m');
    api.listing = {
      'members': [_member('me', 1, self: true), _member('p', 2)],
      'pending': ['p'],
      'conflict': {
        'pub': 'holder',
        'label': 'H',
        'fingerprint': 'HH',
        'addedAt': 9,
        'afterJoin': false,
      },
    };
    await frame('test_unrelated_frame');
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
    expect(app.machineStates['m']!.nodeOnline, isTrue);
    expect(app.newDevices.map((d) => d.pub), ['p']);
    expect(app.deviceConflict?.pub, 'holder');
  });

  test('another machine connecting is not the daemon: it reads nothing (its frames are anyone\'s)', () async {
    const other = Machine(
      machineId: 'other',
      authMode: MachineAuthMode.remote,
      name: 'Box',
    );
    app.machines = [_machine, other];
    app.machineStates['other'] = MachineState(other);
    api.listing = {
      'members': [_member('me', 1, self: true), _member('p', 2)],
      'pending': ['p'],
    };
    app.onMachineConnectedForTest('other');
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
    expect(app.newDevices, isEmpty);
  });

  test('a key that joined and left before anyone looked is read from the daemon, and outlasts a restart', () async {
    api.listing = {
      'members': [_member('me', 1, self: true)],
      'pending': <String>[],
      'departed': [
        departed('gone'),
        {'garbage': true},
      ],
    };
    await frame('device_keys_changed');
    await Future<void>.delayed(Duration.zero);
    expect(app.departedDevices.map((d) => d.pub), ['gone']);
    expect(
      app.departedDevices.single.sentence(red: false),
      'Phone joined your account and left before you looked. Removed by Box.',
    );
    expect(app.departedIsRed(app.departedDevices.single), isFalse);

    // Another read says the same: nothing changes (no rebuild churn), and the flag stays.
    await frame('device_keys_changed');
    await Future<void>.delayed(Duration.zero);
    expect(app.departedDevices.map((d) => d.pub), ['gone']);
  });

  test('a daemon that predates the field has no departed keys', () async {
    api.listing = {
      'members': [_member('me', 1, self: true)],
      'pending': <String>[],
    };
    await frame('device_keys_changed');
    await Future<void>.delayed(Duration.zero);
    expect(app.departedDevices, isEmpty);
  });

  test('red when the key that took it out is itself new, or itself left unseen; never for its own sign-out', () async {
    api.listing = {
      'members': [_member('me', 1, self: true), _member('new', 5)],
      'pending': ['new'],
      'departed': [
        departed('a', by: 'new'),
        departed('b', by: 'a'),
        departed('c', by: 'known'),
        departed('d', self: true),
      ],
    };
    await frame('device_keys_changed');
    await Future<void>.delayed(Duration.zero);
    final red = {
      for (final d in app.departedDevices) d.pub: app.departedIsRed(d),
    };
    expect(red, {'a': true, 'b': true, 'c': false, 'd': false});
    expect(
      app.departedDevices[0].sentence(red: true),
      'Phone joined your account and left before you looked. Removed by Box, a new device you haven’t looked at.',
    );
    expect(
      app.departedDevices[3].sentence(red: false),
      'Phone joined your account and left before you looked.',
    );
  });

  test('Got it on a departed key is written to the daemon as seen, and a read from before cannot bring it back', () async {
    api.listing = {
      'members': [_member('me', 1, self: true)],
      'pending': <String>[],
      'departed': [departed('gone')],
    };
    await frame('device_keys_changed');
    await Future<void>.delayed(Duration.zero);
    app.dismissDeparted('gone');
    await Future<void>.delayed(Duration.zero);
    expect(app.departedDevices, isEmpty);
    expect(api.dismissed.single.pubs, ['gone']);
    await frame('device_keys_changed');
    await Future<void>.delayed(Duration.zero);
    expect(app.departedDevices, isEmpty);
    expect(
      (api.listing!['departed'] as List),
      isEmpty,
      reason: 'the daemon cleared it',
    );
  });

  test(
    'Got it on a band of several clears them all in one write to the daemon',
    () async {
      api.listing = {
        'members': [_member('me', 1, self: true)],
        'pending': <String>[],
        'departed': [departed('gone'), departed('gone2')],
      };
      await frame('device_keys_changed');
      await Future<void>.delayed(Duration.zero);
      app.dismissDepartedAll(['gone', 'gone2']);
      await Future<void>.delayed(Duration.zero);
      expect(app.departedDevices, isEmpty);
      expect(api.dismissed.single.pubs, unorderedEquals(['gone', 'gone2']));
      await frame('device_keys_changed');
      await Future<void>.delayed(Duration.zero);
      expect(app.departedDevices, isEmpty);
    },
  );

  test(
    'a dismissal the daemon could not write stays dismissed in memory',
    () async {
      api.listing = {
        'members': [_member('me', 1, self: true)],
        'pending': <String>[],
        'departed': [departed('gone')],
      };
      api.dismissWorks = false;
      await frame('device_keys_changed');
      await Future<void>.delayed(Duration.zero);
      app.dismissDeparted('gone');
      await Future<void>.delayed(Duration.zero);
      await frame('device_keys_changed');
      await Future<void>.delayed(Duration.zero);
      expect(app.departedDevices, isEmpty);
    },
  );

  test('signing out forgets the departed keys of the old account', () async {
    api.listing = {
      'members': [_member('me', 1, self: true)],
      'pending': <String>[],
      'departed': [departed('gone')],
    };
    await frame('device_keys_changed');
    await Future<void>.delayed(Duration.zero);
    app.clearDeviceNoticeStateForTest();
    expect(app.departedDevices, isEmpty);
  });

  test('a daemon without pending counts as read: the recovery tick does not ask again', () async {
    api.listing = {
      'members': [_member('me', 1, self: true)],
    };
    expect(app.pendingBootReadDoneForTest, isFalse);
    await frame('device_keys_changed');
    await Future<void>.delayed(Duration.zero);
    expect(app.pendingBootReadDoneForTest, isTrue);
  });

  test(
    'a daemon that cannot answer leaves the boot read to be tried again',
    () async {
      api.listing = null;
      await frame('device_keys_changed');
      await Future<void>.delayed(Duration.zero);
      expect(app.pendingBootReadDoneForTest, isFalse);
    },
  );

  test('seen is written to the daemon, one device or all; a daemon that cannot keeps it in memory', () async {
    api.listing = {
      'members': [
        _member('me', 1, self: true),
        _member('a', 3),
        _member('b', 4),
      ],
      'pending': ['a', 'b'],
    };
    await frame('device_keys_changed');
    await Future<void>.delayed(Duration.zero);
    app.dismissNewDevice('a');
    await Future<void>.delayed(Duration.zero);
    // The banner's "It's mine" goes through `pubs`: a fork's suspension on the key is kept.
    expect(api.dismissed.single.pub, isNull);
    expect(api.dismissed.single.pubs, ['a']);
    expect(app.newDevices.map((d) => d.pub), ['b']);

    // The daemon predates dismiss: it still lists both as pending, but what was seen stays seen.
    api.dismissWorks = false;
    app.seenNewDevices();
    await Future<void>.delayed(Duration.zero);
    expect(api.dismissed.last.pubs, ['b']);
    await frame('device_keys_changed');
    await Future<void>.delayed(Duration.zero);
    expect(app.newDevices, isEmpty);
  });

  test('a fork-suspended entry is marked so on the banner, and follows the listing', () async {
    api.listing = {
      'members': [
        _member('me', 1, self: true),
        _member('a', 3, suspended: true),
        _member('b', 4),
      ],
      'pending': ['a', 'b'],
    };
    await frame('device_keys_changed');
    await Future<void>.delayed(Duration.zero);
    expect(app.newDevices.map((d) => (d.pub, d.suspended)), [
      ('a', true),
      ('b', false),
    ]);
    // Reviewed and lifted elsewhere: the same pending pubs, but no longer suspended.
    api.listing = {
      'members': [
        _member('me', 1, self: true),
        _member('a', 3),
        _member('b', 4),
      ],
      'pending': ['a', 'b'],
    };
    await frame('device_keys_changed');
    await Future<void>.delayed(Duration.zero);
    expect(app.newDevices.map((d) => (d.pub, d.suspended)), [
      ('a', false),
      ('b', false),
    ]);
  });

  test(
    'the device page lifts a suspension (single pub); the banner does not',
    () async {
      api.listing = {
        'members': [_member('me', 1, self: true), _member('a', 3)],
        'pending': ['a'],
      };
      await frame('device_keys_changed');
      await Future<void>.delayed(Duration.zero);
      app.dismissNewDevice('a', liftSuspension: true);
      await Future<void>.delayed(Duration.zero);
      expect(api.dismissed.single.pub, 'a');
      expect(api.dismissed.single.pubs, isNull);
    },
  );

  test(
    'the boot read is kept when the profile arrives while it is in flight',
    () async {
      api.held = [];
      await frame('device_keys_changed');
      expect(app.currentUser, isNull);
      // /api/auth/me answers before the daemon's listing does.
      app.currentUser = const CurrentUserProfile(id: 'u1', email: 'a@b.c');
      api.held![0].complete({
        'members': [_member('me', 1, self: true), _member('a', 3)],
        'pending': ['a'],
        'conflict': {
          'pub': 'holder',
          'label': 'H',
          'fingerprint': 'HH',
          'addedAt': 9,
          'afterJoin': false,
        },
      });
      await Future<void>.delayed(Duration.zero);
      expect(app.newDevices.map((d) => d.pub), ['a']);
      expect(app.deviceConflict?.pub, 'holder');
    },
  );

  test('a read in flight when the account signs out does not write the old listing', () async {
    api.held = [];
    await frame('device_keys_changed');
    app.clearDeviceNoticeStateForTest();
    api.held![0].complete({
      'members': [_member('me', 1, self: true), _member('a', 3)],
      'pending': ['a'],
    });
    await Future<void>.delayed(Duration.zero);
    expect(app.newDevices, isEmpty);
  });

  test('an older read answering last cannot take back a device the newer read reported', () async {
    api.held = [];
    // The log grew (a read starts), then the daemon announced what it read (a second read starts).
    await frame('device_keys_changed');
    await app.handleEventForTest('m', {
      'type': 'device_key_added',
      'payload': {'pub': 'a', 'label': 'A', 'kind': 'viewer'},
    });
    expect(api.held!.length, 2);
    final members = [_member('me', 1, self: true), _member('a', 3)];
    api.held![1].complete({
      'members': members,
      'pending': ['a'],
    });
    await Future<void>.delayed(Duration.zero);
    // The first read, from before the daemon accepted it, answers last.
    api.held![0].complete({
      'members': [members.first],
      'pending': <String>[],
    });
    await Future<void>.delayed(Duration.zero);
    expect(app.newDevices.map((d) => d.pub), ['a']);
  });

  test('opening the list writes back what it read as pending even with no banner up', () async {
    api.listing = {
      'members': [_member('me', 1, self: true), _member('a', 3)],
      'pending': ['a'],
    };
    app.seenNewDevices(pending: ['a']);
    await Future<void>.delayed(Duration.zero);
    // Exactly what was shown — never "everything".
    expect(api.dismissed.single.pubs, ['a']);
    expect(api.dismissed.single.pub, isNull);
    // And nothing to write back is no write at all.
    final fresh = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    addTearDown(fresh.dispose);
    final other = _DaemonApi();
    fresh.api = other;
    fresh.seenNewDevices();
    await Future<void>.delayed(Duration.zero);
    expect(other.dismissed, isEmpty);
  });

  test('"Got it" on the baseline panel is written to the daemon', () async {
    await app.seeDeviceBaseline();
    expect(api.dismissed.single, (pub: null, pubs: null, baseline: true));
    expect(app.baselineSeenLocally, isTrue);
  });

  test(
    'a device that joined after the list was read is not marked seen with it',
    () async {
      api.listing = {
        'members': [
          _member('me', 1, self: true),
          _member('a', 3),
          _member('late', 4),
        ],
        'pending': ['a'],
      };
      await frame('device_keys_changed');
      await Future<void>.delayed(Duration.zero);
      app.seenNewDevices(pending: ['a']);
      await Future<void>.delayed(Duration.zero);
      expect(api.dismissed.single.pubs, ['a']);
      expect(api.dismissed.single.pubs, isNot(contains('late')));
    },
  );

  test(
    '"Got it" on the baseline panel keeps an unsaved "It’s mine" dismissal',
    () async {
      api.dismissWorks = false;
      api.listing = {
        'members': [_member('me', 1, self: true), _member('a', 3)],
        'pending': ['a'],
      };
      await frame('device_keys_changed');
      await Future<void>.delayed(Duration.zero);
      app.dismissNewDevice('a');
      await Future<void>.delayed(Duration.zero);
      await app.seeDeviceBaseline();
      await frame('device_keys_changed');
      await Future<void>.delayed(Duration.zero);
      expect(app.newDevices, isEmpty);
    },
  );

  test(
    'a read that started before "It’s mine" cannot bring the device back',
    () async {
      api.held = [];
      final members = [_member('me', 1, self: true), _member('a', 3)];
      await app.handleEventForTest('m', {
        'type': 'device_key_added',
        'payload': {'pub': 'a', 'label': 'A', 'kind': 'viewer'},
      });
      expect(app.newDevices.map((d) => d.pub), ['a']);
      app.dismissNewDevice('a');
      api.dismissWorks = false;
      // The read from before the dismissal answers still listing it as pending.
      api.held![0].complete({
        'members': members,
        'pending': ['a'],
      });
      await Future<void>.delayed(Duration.zero);
      expect(app.newDevices, isEmpty);
    },
  );

  test('a read that started before the list was opened cannot bring a seen device back', () async {
    api.held = [];
    final members = [_member('me', 1, self: true), _member('a', 3)];
    await app.handleEventForTest('m', {
      'type': 'device_key_added',
      'payload': {'pub': 'a', 'label': 'A', 'kind': 'viewer'},
    });
    expect(app.newDevices.map((d) => d.pub), ['a']);
    app.seenNewDevices(pending: ['a']);
    // The seen is written (so nothing is held back in memory any more)…
    await Future<void>.delayed(Duration.zero);
    expect(api.dismissed.single.pubs, ['a']);
    // …and only then does the read from before it answer, still listing it as pending.
    api.held![0].complete({
      'members': members,
      'pending': ['a'],
    });
    await Future<void>.delayed(Duration.zero);
    expect(app.newDevices, isEmpty);
  });

  test('a read answering after the account was left is dropped', () async {
    api.held = [];
    await frame('device_keys_changed');
    expect(api.held!.length, 1);
    app.ownDaemonMachineIdForTest('m');
    app.clearDeviceNoticeStateForTest();
    api.held![0].complete({
      'members': [_member('me', 1, self: true), _member('a', 3)],
      'pending': ['a'],
      'conflict': {
        'pub': 'h',
        'label': 'H',
        'fingerprint': 'HH',
        'addedAt': 9,
        'afterJoin': false,
      },
    });
    await Future<void>.delayed(Duration.zero);
    expect(app.newDevices, isEmpty);
    expect(app.deviceConflict, isNull);
  });

  test('the baseline panel lists what the daemon says, not what seq <= joinedSeq would', () async {
    final raw = {
      'members': [
        _member('me', 1, self: true),
        _member('a', 2),
        _member('b', 5),
      ],
      'pending': <String>[],
      'joinedSeq': 3,
      'baseline': ['b'],
    };
    expect(AccountDevices.fromDaemon(raw)!.baseline.map((d) => d.pub), ['b']);
    raw.remove('baseline');
    expect(AccountDevices.fromDaemon(raw)!.baseline.map((d) => d.pub), ['a']);
  });

  test('Trust again hands the previewed head to the confirm; a changed list is reported, not applied', () async {
    api.rebaselineAnswer = {
      'head': {'seq': 7, 'hash': 'h7'},
      'added': <Object?>[],
      'removed': <Object?>[],
    };
    final preview = (await app.rebaselineDevices(confirm: false))!;
    expect(preview.head?.seq, 7);
    api.rebaselineAnswer = {'error': 'LOG_CHANGED'};
    final before = app.devicesRevision;
    final done = await app.rebaselineDevices(confirm: true, head: preview.head);
    expect(api.rebaselines.last.head, {'seq': 7, 'hash': 'h7'});
    expect(done?.logChanged, isTrue);
    expect(app.devicesRevision, before);
  });

  test('the daemon\'s 409 says which refusal it is: OTHER_ACCOUNT, else LOG_CHANGED', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    var answer = '{"error":"OTHER_ACCOUNT"}';
    server.listen((req) async {
      await req.drain<void>();
      req.response
        ..statusCode = 409
        ..headers.contentType = ContentType.json
        ..write(answer);
      await req.response.close();
    });
    final client = ApiClient(
      config: AppConfig(
        apiBaseUrl: 'http://127.0.0.1:1',
        localCliBaseUrl: 'http://127.0.0.1:${server.port}',
      ),
      session: AuthSession(),
    );
    expect(await client.daemonRebaselineDevices(confirm: false), {
      'error': 'OTHER_ACCOUNT',
    });
    answer = '{"error":"LOG_CHANGED"}';
    expect(
      await client.daemonRebaselineDevices(
        confirm: true,
        head: {'seq': 1, 'hash': 'h'},
      ),
      {'error': 'LOG_CHANGED'},
    );
    answer = '{}';
    expect(await client.daemonRebaselineDevices(confirm: true), {
      'error': 'LOG_CHANGED',
    });
  });

  test('Trust again on another account\'s list (OTHER_ACCOUNT) is reported, not applied', () async {
    api.rebaselineAnswer = {'error': 'OTHER_ACCOUNT'};
    final before = app.devicesRevision;
    final preview = (await app.rebaselineDevices(confirm: false))!;
    expect([preview.otherAccount, preview.logChanged], [true, false]);
    final done = (await app.rebaselineDevices(
      confirm: true,
      head: const DevLogHead(7, 'h7'),
    ))!;
    expect([done.otherAccount, done.logChanged], [true, false]);
    expect(app.devicesRevision, before);
  });

  test(
    'the history is the daemon’s; a daemon that predates it answers null',
    () async {
      expect(await app.loadDeviceHistory(), isNull);
      api.history = {
        'complete': true,
        'rows': [
          {
            'seq': 2,
            'op': 'added',
            'pub': 'p',
            'kind': 'viewer',
            'machineId': '',
            'label': 'iPad',
            'fingerprint': 'FP',
            'at': 5,
            'thisDevice': false,
            'afterJoin': true,
            'pending': true,
            'active': true,
            'whileFrozen': false,
          },
        ],
      };
      final history = (await app.loadDeviceHistory())!;
      expect(history.complete, isTrue);
      expect(history.rows.single.label, 'iPad');
    },
  );
}
