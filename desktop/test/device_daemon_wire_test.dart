// The daemon's device payloads, exactly as the CLI writes them (cli/src/lib/e2ee/deviceLogSyncer.ts
// `list()` / `history()` / the `removed` and `conflict` hooks, cli/src/cli.ts `onDevicesList` /
// `onDevicesHistory` and the `device_key_removed` / `device_conflict` frames), read by this app's
// parsers. Each JSON below was dumped from the real CLI code — a listing with a new device and a
// removal it signed, a history, a conflict — so a field renamed on one side fails here. Regenerate
// from the CLI when its wire format changes on purpose.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/account_devices.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/viewer/device_history.dart';

/// `GET /api/devices` (`{...list(), lastSeen}`): this computer, plus a phone added after it joined
/// that is still new; box2 (on the account before) was removed by that phone.
const _listing = r'''
{
  "head": {
    "seq": 4,
    "hash": "KGA6L7o4dLJXflHfMrNvQApIFzGCiv9+vBD/YpG2Ezg="
  },
  "frozen": null,
  "self": "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=",
  "members": [
    {
      "pub": "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=",
      "kind": "machine",
      "machineId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "label": "my-mac",
      "addedAt": 5000,
      "seq": 2,
      "fingerprint": "3475·0F98·BD59·FCFC",
      "self": true,
      "pending": false,
      "suspended": false,
      "firstSeen": 5000
    },
    {
      "pub": "7UkoxijRwsbq6QM4kFmVYSlZJzpcY/k2NsFGFKyHN9E=",
      "kind": "viewer",
      "machineId": "",
      "label": "Phone",
      "addedAt": 1000,
      "seq": 3,
      "fingerprint": "B62E·867F·A2F3·3AFE",
      "self": false,
      "pending": true,
      "suspended": false,
      "firstSeen": 5000
    }
  ],
  "frozenPeers": [],
  "pending": [
    "7UkoxijRwsbq6QM4kFmVYSlZJzpcY/k2NsFGFKyHN9E="
  ],
  "suspended": [],
  "joinedSeq": 1,
  "baselineSeen": false,
  "conflict": null,
  "lastSeen": {
    "7UkoxijRwsbq6QM4kFmVYSlZJzpcY/k2NsFGFKyHN9E=": 4000
  }
}
''';

/// `GET /api/devices` on a computer whose id another key holds.
const _conflictListing = r'''
{
  "head": {
    "seq": 2,
    "hash": "eCj7fh11xqlaccjtoufCZTZjmCxcY6uv61jBNLJ687U="
  },
  "frozen": null,
  "self": "iodf/x6zhFFXes1a/uQFRWVo3XyJ4JCGOgVXvHr0nxc=",
  "members": [
    {
      "pub": "gTl3Dqh9F19Wo1Rmw0x+zMuNipG07jeiXfYPW4/Js5Q=",
      "kind": "machine",
      "machineId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "label": "box2",
      "addedAt": 1000,
      "seq": 1,
      "fingerprint": "6A38·03D5·F059·902A",
      "self": false,
      "pending": false,
      "suspended": false
    },
    {
      "pub": "ypOsFwUYcHHWe4PH/w7+gQjo7EUwV113JoeTM9vavnw=",
      "kind": "machine",
      "machineId": "cccccccccccccccccccccccccccccccc",
      "label": "old-install",
      "addedAt": 1000,
      "seq": 2,
      "fingerprint": "C5B9·40ED·3F65·C391",
      "self": false,
      "pending": true,
      "suspended": false,
      "firstSeen": 5000
    }
  ],
  "frozenPeers": [],
  "pending": [
    "ypOsFwUYcHHWe4PH/w7+gQjo7EUwV113JoeTM9vavnw="
  ],
  "suspended": [],
  "joinedSeq": 1,
  "baselineSeen": false,
  "conflict": {
    "pub": "ypOsFwUYcHHWe4PH/w7+gQjo7EUwV113JoeTM9vavnw=",
    "label": "old-install",
    "machineId": "cccccccccccccccccccccccccccccccc",
    "addedAt": 1000,
    "seq": 2,
    "fingerprint": "C5B9·40ED·3F65·C391",
    "afterJoin": true
  }
}
''';

/// `GET /api/devices/history` for the first listing.
const _history = r'''
{
  "rows": [
    {
      "seq": 4,
      "pub": "gTl3Dqh9F19Wo1Rmw0x+zMuNipG07jeiXfYPW4/Js5Q=",
      "kind": "machine",
      "machineId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "label": "box2",
      "fingerprint": "6A38·03D5·F059·902A",
      "at": 2000,
      "thisDevice": false,
      "afterJoin": true,
      "pending": false,
      "active": false,
      "whileFrozen": false,
      "op": "removed",
      "by": {
        "pub": "7UkoxijRwsbq6QM4kFmVYSlZJzpcY/k2NsFGFKyHN9E=",
        "label": "Phone",
        "fingerprint": "B62E·867F·A2F3·3AFE"
      }
    },
    {
      "seq": 3,
      "pub": "7UkoxijRwsbq6QM4kFmVYSlZJzpcY/k2NsFGFKyHN9E=",
      "kind": "viewer",
      "machineId": "",
      "label": "Phone",
      "fingerprint": "B62E·867F·A2F3·3AFE",
      "at": 1000,
      "thisDevice": false,
      "afterJoin": true,
      "pending": true,
      "active": true,
      "whileFrozen": false,
      "op": "added"
    },
    {
      "seq": 2,
      "pub": "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=",
      "kind": "machine",
      "machineId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "label": "my-mac",
      "fingerprint": "3475·0F98·BD59·FCFC",
      "at": 5000,
      "thisDevice": true,
      "afterJoin": true,
      "pending": false,
      "active": true,
      "whileFrozen": false,
      "op": "added"
    },
    {
      "seq": 1,
      "pub": "gTl3Dqh9F19Wo1Rmw0x+zMuNipG07jeiXfYPW4/Js5Q=",
      "kind": "machine",
      "machineId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "label": "box2",
      "fingerprint": "6A38·03D5·F059·902A",
      "at": 1000,
      "thisDevice": false,
      "afterJoin": false,
      "pending": false,
      "active": false,
      "whileFrozen": false,
      "op": "added"
    }
  ],
  "complete": true,
  "frozen": null
}
''';

/// The frames the daemon sent the app (`backend.sendLocal`).
const _removedFrame = r'''
{
  "type": "device_key_removed",
  "payload": {
    "pub": "gTl3Dqh9F19Wo1Rmw0x+zMuNipG07jeiXfYPW4/Js5Q=",
    "label": "box2",
    "kind": "machine",
    "fingerprint": "6A38·03D5·F059·902A",
    "signer": "7UkoxijRwsbq6QM4kFmVYSlZJzpcY/k2NsFGFKyHN9E=",
    "signerLabel": "Phone",
    "signerFingerprint": "B62E·867F·A2F3·3AFE",
    "signerPending": true,
    "selfRemoved": false,
    "at": 5000
  }
}
''';
const _conflictFrame = r'''
{
  "type": "device_conflict",
  "payload": {
    "pub": "ypOsFwUYcHHWe4PH/w7+gQjo7EUwV113JoeTM9vavnw=",
    "label": "old-install",
    "fingerprint": "C5B9·40ED·3F65·C391",
    "addedAt": 1000,
    "afterJoin": true
  }
}
''';

Map<String, dynamic> _json(String s) => jsonDecode(s) as Map<String, dynamic>;

const _phone = '7UkoxijRwsbq6QM4kFmVYSlZJzpcY/k2NsFGFKyHN9E=';
const _box2 = 'gTl3Dqh9F19Wo1Rmw0x+zMuNipG07jeiXfYPW4/Js5Q=';
const _holder = 'ypOsFwUYcHHWe4PH/w7+gQjo7EUwV113JoeTM9vavnw=';

class _DaemonApi extends ApiClient {
  _DaemonApi() : super(config: AppConfig.dev, session: AuthSession());

  bool conflicted = false;

  @override
  Future<Map<String, dynamic>?> daemonDevices() async =>
      _json(conflicted ? _conflictListing : _listing);

  @override
  Future<Map<String, dynamic>?> daemonDeviceHistory() async => _json(_history);
}

const _machine = Machine(
  machineId: 'm',
  authMode: MachineAuthMode.remote,
  name: 'Mac',
);

void main() {
  test('the listing reads every field the daemon sends', () {
    final devices = AccountDevices.fromDaemon(_json(_listing))!;
    expect(
      devices.devices.map(
        (d) => (d.label, d.self, d.seq, d.pending, d.suspended),
      ),
      [('my-mac', true, 2, false, false), ('Phone', false, 3, true, false)],
    );
    final phone = devices.devices[1];
    expect(phone.kind, 'viewer');
    expect(phone.fingerprint, 'B62E·867F·A2F3·3AFE');
    expect(phone.addedAt, DateTime.fromMillisecondsSinceEpoch(1000));
    expect(phone.lastSeen, DateTime.fromMillisecondsSinceEpoch(4000));
    expect(devices.devices[0].machineId, 'a' * 32);
    expect(devices.pending, [_phone]);
    expect(devices.joinedSeq, 1);
    expect(devices.baselineSeen, isFalse);
    expect(devices.historyAvailable, isTrue);
    expect(devices.frozen, isFalse);
    expect(devices.conflict, isNull);
  });

  test('a conflict in the listing and in the frame reads the same', () {
    final listed = AccountDevices.fromDaemon(_json(_conflictListing))!
        .conflict!;
    final framed = DeviceConflict.fromJson(_json(_conflictFrame)['payload'])!;
    for (final c in [listed, framed]) {
      expect(
        (c.pub, c.label, c.fingerprint, c.afterJoin),
        (_holder, 'old-install', 'C5B9·40ED·3F65·C391', true),
      );
      expect(c.addedAt, DateTime.fromMillisecondsSinceEpoch(1000));
    }
  });

  test('every history row parses, with who did it and the flags', () {
    final raw = _json(_history);
    final history = DeviceLogHistory.fromJson(raw)!;
    expect(history.rows, hasLength((raw['rows'] as List).length));
    expect(history.complete, isTrue);
    expect(history.rows.map((r) => (r.seq, r.op, r.label)), [
      (4, 'removed', 'box2'),
      (3, 'added', 'Phone'),
      (2, 'added', 'my-mac'),
      (1, 'added', 'box2'),
    ]);
    final removal = history.rows.first;
    expect(
      (
        removal.pub,
        removal.by?.pub,
        removal.by?.label,
        removal.by?.fingerprint,
      ),
      (_box2, _phone, 'Phone', 'B62E·867F·A2F3·3AFE'),
    );
    expect((removal.afterJoin, removal.active), (true, false));
    expect(history.rows[1].pending, isTrue);
    expect(history.rows[2].thisDevice, isTrue);
    expect(history.rows[3].afterJoin, isFalse);
    expect(
      history.rows.every((r) => r.machineId.isNotEmpty || r.kind == 'viewer'),
      isTrue,
    );
  });

  test('the removal frame parses whole: signer, its name and code, and that it is still new', () {
    final n = DeviceRemovalNotice.fromJson(_json(_removedFrame)['payload'])!;
    expect(
      (n.pub, n.label, n.kind, n.fingerprint),
      (_box2, 'box2', 'machine', '6A38·03D5·F059·902A'),
    );
    expect(
      (n.signer, n.signerLabel, n.signerFingerprint),
      (_phone, 'Phone', 'B62E·867F·A2F3·3AFE'),
    );
    expect((n.signerPending, n.selfRemoved, n.at), (true, false, 5000));
    // The Dart side writes back the same object.
    expect(n.toJson(), _json(_removedFrame)['payload']);
  });

  test('a desktop build turns the daemon’s payloads into its banner, bands and history', () async {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    addTearDown(app.dispose);
    final api = _DaemonApi();
    app.api = api;
    app.machines = [_machine];
    app.machineStates['m'] = MachineState(_machine);
    app.ownDaemonMachineIdForTest('m');
    await app.handleEventForTest('m', {
      'type': 'device_keys_changed',
      'payload': <String, dynamic>{},
    });
    await Future<void>.delayed(Duration.zero);
    expect(app.newDevices.map((d) => (d.pub, d.label, d.fingerprint)), [
      (_phone, 'Phone', 'B62E·867F·A2F3·3AFE'),
    ]);

    await app.handleEventForTest('m', _json(_removedFrame));
    expect(app.deviceRemovals.single.red, isTrue);
    expect(
      app.deviceRemovals.single.sentence,
      startsWith(
        'box2 was removed from your account by a new device you haven’t looked at (Phone · ',
      ),
    );

    // The frame is a hint; the daemon's listing is what says who holds the id.
    api.conflicted = true;
    await app.handleEventForTest('m', _json(_conflictFrame));
    await Future<void>.delayed(Duration.zero);
    expect(app.deviceConflict?.pub, _holder);

    final history = (await app.loadDeviceHistory())!;
    expect(history.rows.first.op, 'removed');
  });
}
