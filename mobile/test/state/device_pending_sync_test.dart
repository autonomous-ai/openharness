import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/e2ee/bytes.dart';
import 'package:harness_mobile/e2ee/keys.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/pane_layout_store.dart';
import 'package:harness_mobile/viewer/device_log.dart';
import 'package:harness_mobile/viewer/device_log_sync.dart';
import 'package:harness_mobile/viewer/direct_auth_api.dart';
import 'package:harness_mobile/viewer/viewer_key_store.dart';

import '../viewer_app_fixture.dart';
import '../voice_fakes.dart' show MemoryKeyValueStore;

/// The phone's new-device banner is the log's persisted `pending`, not a list in memory: it comes back
/// after a restart, a dismissal holds across one, and a read that started before a dismissal never
/// brings the dismissed device back. Against a real [ViewerDeviceLog] and an honest backend.

const _acct = 'acct-1';
final _mid2 = 'b' * 32, _mid3 = 'c' * 32;

class _Backend {
  _Backend([this.acct = _acct]) : state = DevLogState.empty(acct);

  final entries = <DevLogEntry>[];
  DevLogState state;

  /// The account id the backend claims.
  String acct;

  Future<void> add(
    E2eeIdentity who,
    String kind,
    String machineId,
    String label,
  ) async {
    final pub = b64e(who.pub);
    await _push(
      await signDevLogEntry(
        nextDevLogEntry(
          state,
          op: 'add',
          pub: pub,
          kind: kind,
          machineId: machineId,
          label: label,
          signer: pub,
          at: 1000,
        ),
        who,
      ),
    );
  }

  Future<void> removeBy(String target, E2eeIdentity by) async {
    final t = state.active[target]!;
    await _push(
      await signDevLogEntry(
        nextDevLogEntry(
          state,
          op: 'remove',
          pub: t.pub,
          kind: t.kind,
          machineId: t.machineId,
          label: t.label,
          signer: b64e(by.pub),
          at: 2000,
        ),
        by,
      ),
    );
  }

  Future<void> _push(DevLogEntry e) async {
    state = (await applyDevLogEntries(state, [e.toJson()])).state;
    entries.add(e);
  }

  /// Held: a read of the log waits on it (answering with what the backend held when it was asked).
  Completer<void>? fetchGate;

  Future<DeviceLogFetched?> fetch(int since) async {
    final gate = fetchGate;
    final snapshot = _snapshot(since);
    if (gate != null) await gate.future;
    return snapshot;
  }

  DeviceLogFetched _snapshot(int since) => (
    acct: acct,
    head: state.head,
    entries: [
      for (final e in entries)
        if (e.seq > since) e.toJson(),
    ],
  );

  /// Every append is refused while set: this phone never gets into the log.
  bool refuseAppends = false;
  String refuseWith = 'FORBIDDEN';

  Future<DeviceLogAppendAnswer?> append(DevLogEntry entry) async {
    if (refuseAppends) return (head: null, error: refuseWith);
    if (entry.seq != state.head.seq + 1 || entry.prev != state.head.hash) {
      return (head: state.head, error: 'STALE_HEAD');
    }
    await _push(entry);
    return (head: state.head, error: null);
  }
}

class _Api extends FakeApi {
  _Api(this.backend);

  final _Backend backend;

  /// The `self` every read of the log named.
  final selves = <String?>[];

  @override
  Future<DeviceLogFetched?> deviceKeys(int since, {String? self}) {
    selves.add(self);
    return backend.fetch(since);
  }

  @override
  Future<DeviceLogAppendAnswer?> appendDeviceKey(DevLogEntry entry) =>
      backend.append(entry);
}

/// The phone's own storage, kept across "restarts". [holdDevLogRead] parks one read of the device log
/// file (after [skip] others) until the test lets it go — answering with what the file held when it
/// was asked, as a slow disk would.
class _Disk implements LocalKeyValueStore {
  final values = <String, String>{};
  Completer<void>? _hold;
  Completer<void>? held;
  var _skip = 0;

  /// Writes of the device log file fail while set.
  bool failDevLogWrites = false;

  void holdDevLogRead({int skip = 0}) {
    _skip = skip;
    _hold = Completer<void>();
    held = Completer<void>();
  }

  void release() => _hold?.complete();

  @override
  Future<String?> read(String key) async {
    final value = values[key];
    if (key == 'viewer_e2ee_devlog' && _hold != null && !held!.isCompleted) {
      if (_skip > 0) {
        _skip--;
        return value;
      }
      final hold = _hold!;
      held!.complete();
      await hold.future;
      _hold = null;
    }
    return value;
  }

  @override
  Future<void> write(String key, String value) async {
    if (failDevLogWrites && key == 'viewer_e2ee_devlog') {
      throw StateError('disk full');
    }
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async => values.remove(key);
}

/// A viewer whose key store — the phone's disk — outlives one launch.
class _Viewer extends FakeViewer {
  _Viewer(super.session, this._keys);

  final ViewerKeyStore _keys;

  @override
  ViewerKeyStore get keys => _keys;
}

/// The pane layout's disk read, parked: the boot waits on it while the app is still `bootstrapping`.
class _GatedLayout extends PaneLayoutStore {
  _GatedLayout(this._gate) : super(storage: MemoryKeyValueStore());

  final Completer<void> _gate;

  @override
  Future<Map<String, dynamic>?> loadSwarms() async {
    await _gate.future;
    return null;
  }
}

class _Notices extends SilentSystemNotices {
  final keys = <String>[];

  @override
  Future<void> showAccountNotice({
    required String key,
    required String title,
    required String body,
  }) async => keys.add(key);
}

void main() {
  late _Backend backend;
  late _Disk disk;
  late E2eeIdentity box2, box3;
  final apps = <AppNotifier>[];
  late Future<void> lastBoot;

  /// The phone opening, signed in, on [disk]: it registers with the log on its own.
  ///
  /// [profileId] is what the backend's `/me` says; [fresh] makes it a sign-in by hand just done (not
  /// a stored session). With a gate held, the boot is left running: the future is [lastBoot].
  Future<(AppNotifier, _Notices)> launch({
    Completer<void>? profileGate,
    Completer<void>? machinesGate,
    Completer<void>? layoutGate,
    String? profileId,
    bool fresh = false,
  }) async {
    final session = AuthSession(storage: MemoryKeyValueStore());
    final notices = _Notices();
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: session,
      configStore: null,
      cliLogin: FakeSignIn(),
      peerLinks: FakeLinks(),
      viewer: _Viewer(session, ViewerKeyStore(storage: disk)),
      systemNotices: notices,
      connectionForTest: (_) => ScriptedConn(),
      paneLayoutStore: layoutGate == null ? null : _GatedLayout(layoutGate),
    );
    final api = _Api(backend);
    app.api = api;
    if (profileId != null) {
      api.profile = {
        'user': {'id': profileId, 'email': 'pat@example.com', 'name': 'Pat'},
      };
    }
    if (profileGate != null) {
      api.onProfile = () async {
        await profileGate.future;
        return api.profile;
      };
    }
    if (machinesGate != null) {
      api.onMachines = () async {
        await machinesGate.future;
        return const [];
      };
    }
    if (fresh) await app.viewer.auth.signIn(const IssuedTokens(token: 'tok'));
    apps.add(app);
    lastBoot = app.bootstrap();
    final held =
        profileGate != null || machinesGate != null || layoutGate != null;
    if (!held) await lastBoot;
    await settle();
    if (!held) expect(app.status, AppStatus.authenticated);
    return (app, notices);
  }

  List<String> pubs(List<DevLogMember> ms) => [for (final m in ms) m.pub];

  setUp(() async {
    backend = _Backend();
    disk = _Disk();
    box2 = await E2eeIdentity.fromSeed(List.filled(32, 2));
    box3 = await E2eeIdentity.fromSeed(List.filled(32, 3));
  });

  tearDown(() {
    for (final app in apps) {
      app.dispose();
    }
    apps.clear();
  });

  test('a device that joins later is on the banner, and still is after a restart — announced once', () async {
    await backend.add(box2, 'machine', _mid2, 'box2');
    final (first, firstNotices) = await launch();
    // What was there when this phone joined is not news.
    expect(first.newDevices, isEmpty);

    await backend.add(box3, 'machine', _mid3, 'box3');
    await first.deviceLog!.refresh();
    await settle();
    expect(pubs(first.newDevices), [b64e(box3.pub)]);
    expect(firstNotices.keys, [b64e(box3.pub)]);

    first.dispose();
    apps.remove(first);
    final (second, secondNotices) = await launch();
    expect(pubs(second.newDevices), [b64e(box3.pub)]);
    // The OS was told once already.
    expect(secondNotices.keys, isEmpty);
  });

  test('every read of the log names this phone\'s key; too many devices is said until a register lands', () async {
    await backend.add(box2, 'machine', _mid2, 'box2');
    backend
      ..refuseAppends = true
      ..refuseWith = 'TOO_MANY';
    final (app, _) = await launch();
    final me = b64e((await app.viewer.keys.identity()).pub);
    final api = app.api as _Api;
    expect(api.selves, isNotEmpty);
    expect(api.selves.toSet(), {me});
    expect(app.deviceListTooMany, isTrue);

    backend.refuseAppends = false;
    await app.deviceLog!.register();
    await settle();
    expect(backend.state.active[me], isNotNull);
    expect(app.deviceListTooMany, isFalse);
  });

  test('"It’s mine" on one device holds across a restart', () async {
    final (first, _) = await launch();
    await backend.add(box2, 'machine', _mid2, 'box2');
    await backend.add(box3, 'machine', _mid3, 'box3');
    await first.deviceLog!.refresh();
    await settle();
    expect(pubs(first.newDevices), [b64e(box2.pub), b64e(box3.pub)]);

    first.dismissNewDevice(b64e(box2.pub));
    await settle();
    expect(pubs(first.newDevices), [b64e(box3.pub)]);

    first.dispose();
    apps.remove(first);
    final (second, _) = await launch();
    expect(pubs(second.newDevices), [b64e(box3.pub)]);
  });

  test('opening the list (seenNewDevices) holds across a restart', () async {
    final (first, _) = await launch();
    await backend.add(box3, 'machine', _mid3, 'box3');
    await first.deviceLog!.refresh();
    await settle();
    first.seenNewDevices();
    await settle();
    expect(first.newDevices, isEmpty);
    expect((await first.deviceLog!.list()).pending, isEmpty);

    first.dispose();
    apps.remove(first);
    final (second, _) = await launch();
    expect(second.newDevices, isEmpty);
  });

  test('opening the list before the banner is rebuilt still marks what the list read as seen', () async {
    final (first, _) = await launch();
    await backend.add(box3, 'machine', _mid3, 'box3');
    await first.deviceLog!.refresh();
    await settle();
    // As after a restart, before the log has been read again: the banner list is empty.
    first.newDevices.clear();
    final listing = await first.deviceLog!.list();
    expect(listing.pending, [b64e(box3.pub)]);
    first.seenNewDevices(pending: listing.pending);
    await settle();
    expect((await first.deviceLog!.list()).pending, isEmpty);
    expect(first.newDevices, isEmpty);
  });

  test('a read of the log that started before a dismissal does not bring the device back', () async {
    final (app, _) = await launch();
    await backend.add(box3, 'machine', _mid3, 'box3');
    await app.deviceLog!.refresh();
    await settle();
    expect(pubs(app.newDevices), [b64e(box3.pub)]);

    // Something else changes the log (here: an unrelated dismissal) and the app re-reads `pending`;
    // that read is slow.
    disk.holdDevLogRead(skip: 1);
    unawaited(app.deviceLog!.dismiss(pub: 'nobody'));
    // The dismissal's own read goes through; the re-read of `pending` it sets off is the one held.
    await disk.held!.future;
    // Meanwhile the person opens the list: everything is seen.
    app.seenNewDevices();
    await settle();
    expect(app.newDevices, isEmpty);

    // The slow read lands last, with what `pending` held before.
    disk.release();
    await settle();
    expect(app.newDevices, isEmpty);
    expect((await app.deviceLog!.list()).pending, isEmpty);
  });

  test('a removal by a device nobody has looked at is red and keyed by the signer; a sign-out is not', () async {
    final (app, notices) = await launch();
    await backend.add(box2, 'machine', _mid2, 'box2');
    await backend.add(box3, 'machine', _mid3, 'box3');
    await app.deviceLog!.refresh();
    await settle();
    notices.keys.clear();

    // box3 is still pending here when it takes box2 out.
    await backend.removeBy(b64e(box2.pub), box3);
    await app.deviceLog!.refresh();
    await settle();
    final red = app.deviceRemovals.single;
    expect(red.pub, b64e(box2.pub));
    expect(red.red, isTrue);
    expect(red.title, 'Removed by a new device');
    expect(
      red.sentence,
      'box2 was removed from your account by a new device you haven’t looked at '
      '(box3 · ${fingerprint(box3.pub).split('·').take(2).join('·')}…).',
    );
    expect(notices.keys, ['removedBy:${b64e(box3.pub)}:${b64e(box2.pub)}']);

    // box3 then signs itself out: neutral, and its notice is keyed by the removal.
    await backend.removeBy(b64e(box3.pub), box3);
    await app.deviceLog!.refresh();
    await settle();
    final out = app.deviceRemovals.last;
    expect(out.selfRemoved, isTrue);
    expect(out.red, isFalse);
    expect(out.title, 'Device signed out');
    expect(notices.keys.last, 'removed:${b64e(box3.pub)}');
  });

  test('signing out drops the account’s device notices with it', () async {
    final (app, _) = await launch();
    await backend.add(box2, 'machine', _mid2, 'box2');
    await backend.add(box3, 'machine', _mid3, 'box3');
    await app.deviceLog!.refresh();
    await settle();
    await backend.removeBy(b64e(box2.pub), box3);
    await app.deviceLog!.refresh();
    await settle();
    expect(app.newDevices, isNotEmpty);
    expect(app.deviceRemovals, isNotEmpty);

    await app.logout();
    await settle();
    expect(app.newDevices, isEmpty);
    expect(app.deviceRemovals, isEmpty);
  });

  test(
    'opening the list dismisses what was shown, not a device added since',
    () async {
      final (app, _) = await launch();
      await backend.add(box2, 'machine', _mid2, 'box2');
      await backend.add(box3, 'machine', _mid3, 'box3');
      await app.deviceLog!.refresh();
      await settle();
      expect((await app.deviceLog!.list()).pending, hasLength(2));
      // The page showed box2 only (box3 landed in the log after it was read).
      app.newDevices.removeWhere((d) => d.pub == b64e(box3.pub));
      app.seenNewDevices(pending: [b64e(box2.pub)]);
      await settle();
      expect((await app.deviceLog!.list()).pending, [b64e(box3.pub)]);
    },
  );

  test(
    'a session lost at runtime drops the notices and a read in flight',
    () async {
      final (app, _) = await launch();
      await backend.add(box2, 'machine', _mid2, 'box2');
      await app.deviceLog!.refresh();
      await settle();
      expect(app.newDevices, isNotEmpty);

      disk.holdDevLogRead();
      unawaited(app.deviceLog!.dismiss(pub: 'nobody'));
      await disk.held!.future;
      app.authFailureForTest('gone');
      expect(app.newDevices, isEmpty);
      disk.release();
      await settle();
      expect(app.newDevices, isEmpty);
    },
  );

  test('a dismissal that could not be saved does not throw, and the banner does not bring the device back', () async {
    final (app, _) = await launch();
    await backend.add(box2, 'machine', _mid2, 'box2');
    await app.deviceLog!.refresh();
    await settle();
    expect(pubs(app.newDevices), [b64e(box2.pub)]);

    disk.failDevLogWrites = true;
    app.dismissNewDevice(b64e(box2.pub));
    await settle();
    disk.failDevLogWrites = false;
    expect(app.newDevices, isEmpty);

    // The log still lists box2 as pending (the write failed); the next read of it must not raise it again.
    await backend.add(box3, 'machine', _mid3, 'box3');
    await app.deviceLog!.refresh();
    await settle();
    expect((await app.deviceLog!.list()).pending, contains(b64e(box2.pub)));
    expect(pubs(app.newDevices), [b64e(box3.pub)]);
  });

  group('a fork suspended a new key', () {
    Future<AppNotifier> forked() async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      final (app, _) = await launch();
      await backend.add(box3, 'machine', _mid3, 'box3');
      await app.deviceLog!.refresh();
      await settle();
      final other = _Backend();
      await other.add(box2, 'machine', _mid2, 'box2');
      await other.add(
        await E2eeIdentity.fromSeed(List.filled(32, 9)),
        'viewer',
        '',
        'evil',
      );
      await other.add(box3, 'machine', _mid3, 'box3');
      await app.deviceLog!.heard(b64e(box2.pub), {
        'head': other.state.head.toJson(),
        'hashes': [
          for (var i = 0; i < other.state.hashes.length; i++)
            {'seq': i + 1, 'hash': other.state.hashes[i]},
        ],
      });
      await settle();
      expect(await app.deviceLog!.suspendedPubs(), {b64e(box3.pub)});
      return app;
    }

    test('the banner knows which of its devices the fork suspended', () async {
      final app = await forked();
      expect(app.newDeviceSuspended(b64e(box3.pub)), isTrue);
      expect(app.newDeviceSuspended(b64e(box2.pub)), isFalse);
    });

    test('the banner\'s "Mine" does not lift the suspension', () async {
      final app = await forked();
      app.dismissNewDevice(b64e(box3.pub));
      await settle();
      expect(await app.deviceLog!.suspendedPubs(), {b64e(box3.pub)});
    });

    test('the detail page\'s "Mine" does', () async {
      final app = await forked();
      app.dismissNewDevice(b64e(box3.pub), liftSuspension: true);
      await settle();
      expect(await app.deviceLog!.suspendedPubs(), isEmpty);
    });
  });

  test('opening the list dismisses the banner as it was when the list was read, not a device announced meanwhile', () async {
    final (app, _) = await launch();
    await backend.add(box2, 'machine', _mid2, 'box2');
    await app.deviceLog!.refresh();
    await settle();
    final shown = pubs(app.newDevices);
    expect(shown, [b64e(box2.pub)]);
    // box3 is announced while the page waits on the backend for the last-seen times.
    await backend.add(box3, 'machine', _mid3, 'box3');
    await app.deviceLog!.refresh();
    await settle();
    expect(pubs(app.newDevices), [b64e(box2.pub), b64e(box3.pub)]);

    app.seenNewDevices(shown: shown);
    await settle();
    expect(pubs(app.newDevices), [b64e(box3.pub)]);
    expect((await app.deviceLog!.list()).pending, [b64e(box3.pub)]);
  });

  test(
    'a read of the account that signed out raises no banner and no notice',
    () async {
      final (app, notices) = await launch();
      await app.logout();
      await settle();
      notices.keys.clear();
      await backend.add(box3, 'machine', _mid3, 'box3');
      await app.deviceLog!.refresh();
      await settle();
      expect(app.newDevices, isEmpty);
      expect(notices.keys, isEmpty);
    },
  );

  test(
    'a read in flight when the session is lost raises no banner and no notice',
    () async {
      final (app, notices) = await launch();
      await backend.add(box3, 'machine', _mid3, 'box3');
      backend.fetchGate = Completer<void>();
      unawaited(app.deviceLog!.refresh());
      await settle();
      app.authFailureForTest('gone');
      backend.fetchGate!.complete();
      await settle();
      expect(app.newDevices, isEmpty);
      expect(notices.keys, isEmpty);
    },
  );

  test(
    'a removal read in flight when the session is lost raises no notice',
    () async {
      final (app, notices) = await launch();
      await backend.add(box2, 'machine', _mid2, 'box2');
      await backend.add(box3, 'machine', _mid3, 'box3');
      await app.deviceLog!.refresh();
      await settle();
      notices.keys.clear();
      await backend.removeBy(b64e(box2.pub), box3);
      backend.fetchGate = Completer<void>();
      unawaited(app.deviceLog!.refresh());
      await settle();
      app.authFailureForTest('gone');
      backend.fetchGate!.complete();
      await settle();
      expect(app.deviceRemovals, isEmpty);
      expect(notices.keys, isEmpty);
    },
  );

  group('while the app is still starting up', () {
    test('a new device read before `authenticated` is announced once it is — the OS notice is not lost', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      final layout = Completer<void>();
      final (app, notices) = await launch(layoutGate: layout);
      expect(app.status, AppStatus.bootstrapping);
      // The first read (a connection coming up) joins the log; the next one finds a new key.
      await app.deviceLog!.refresh();
      await backend.add(box3, 'machine', _mid3, 'box3');
      await app.deviceLog!.refresh();
      await settle();
      expect(app.newDevices, isEmpty);
      expect(notices.keys, isEmpty);

      layout.complete();
      await lastBoot;
      await settle();
      expect(app.status, AppStatus.authenticated);
      expect(notices.keys, [b64e(box3.pub)]);
      expect(pubs(app.newDevices), [b64e(box3.pub)]);
    });

    test('what was parked is checked against the log once replayed: a key dismissed meanwhile leaves the banner without waiting for the next read', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      final layout = Completer<void>();
      final (app, notices) = await launch(layoutGate: layout);
      await app.deviceLog!.refresh();
      await backend.add(box3, 'machine', _mid3, 'box3');
      await app.deviceLog!.refresh();
      await settle();
      expect(notices.keys, isEmpty);
      // Seen elsewhere (the log is shared) before the app is up: still parked here.
      // (By another instance over the same file, so this app is not told: only the replay can notice.)
      await ViewerDeviceLog(
        keys: app.viewer.keys,
        fetch: (since) => backend.fetch(since),
        append: (e) => backend.append(e),
        label: () => 'other tab',
      ).dismiss(pubs: [b64e(box3.pub)]);
      // The log's own read after register is stuck behind the backend: only the replay can fix the banner.
      backend.fetchGate = Completer<void>();
      layout.complete();
      await lastBoot;
      await settle();
      expect(app.status, AppStatus.authenticated);
      expect(app.newDevices, isEmpty);
      backend.fetchGate!.complete();
    });

    test(
      'a removal read before `authenticated` is announced once it is',
      () async {
        await backend.add(box2, 'machine', _mid2, 'box2');
        await backend.add(box3, 'machine', _mid3, 'box3');
        final layout = Completer<void>();
        final (app, notices) = await launch(layoutGate: layout);
        await app.deviceLog!.refresh();
        await backend.removeBy(b64e(box2.pub), box3);
        await app.deviceLog!.refresh();
        await settle();
        expect(app.deviceRemovals, isEmpty);

        layout.complete();
        await lastBoot;
        await settle();
        expect(notices.keys, contains('removed:${b64e(box2.pub)}'));
        expect(app.deviceRemovals.map((r) => r.pub), [b64e(box2.pub)]);
      },
    );

    test(
      'signed out meanwhile: what was parked is dropped, not posted',
      () async {
        await backend.add(box2, 'machine', _mid2, 'box2');
        final layout = Completer<void>();
        final (app, notices) = await launch(layoutGate: layout);
        await app.deviceLog!.refresh();
        await backend.add(box3, 'machine', _mid3, 'box3');
        await app.deviceLog!.refresh();
        await settle();
        app.authFailureForTest('gone');
        layout.complete();
        await lastBoot;
        await settle();
        expect(app.status, AppStatus.unauthenticated);
        expect(notices.keys, isEmpty);
        expect(app.newDevices, isEmpty);
      },
    );

    test(
      'what was parked for a sign-in that ended is not posted by the next one',
      () async {
        await backend.add(box2, 'machine', _mid2, 'box2');
        final layout = Completer<void>();
        final (app, notices) = await launch(layoutGate: layout);
        await app.deviceLog!.refresh();
        await backend.add(box3, 'machine', _mid3, 'box3');
        await app.deviceLog!.refresh();
        await settle();
        app.authFailureForTest('gone');
        // The next sign-in (the session is still kept) reaches `authenticated`.
        layout.complete();
        await app.bootstrap();
        await lastBoot;
        await settle();
        expect(app.status, AppStatus.authenticated);
        // box3 was announced once, into a sign-in that is gone: the OS is not told again by this one.
        expect(notices.keys, isEmpty);
      },
    );

    test('a hand sign-in under a key the log removed is spent, not a sign-out (the id is begun once, not overwritten by register)', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      final (first, _) = await launch();
      final phone = b64e((await first.viewer.keys.identity()).pub);
      expect(
        (await first.deviceLog!.list()).members.map((r) => r.member.pub),
        contains(phone),
      );
      first.dispose();
      apps.remove(first);
      await backend.removeBy(phone, box2);

      final (second, _) = await launch(fresh: true);
      expect(second.status, AppStatus.authenticated);
      final now = await second.viewer.keys.identity();
      expect(b64e(now.pub), isNot(phone));
      expect(
        (await second.deviceLog!.list()).members.map((r) => r.member.pub),
        contains(b64e(now.pub)),
      );
    });

    test('a hand sign-in\'s id is minted before the boot can read the log: a read while the pane layout loads is judged by it', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      final (first, _) = await launch();
      expect((await first.deviceLog!.list()).frozen, isNull);
      first.dispose();
      apps.remove(first);

      // Another account signs in by hand on this phone. A read that lands before the boot reaches
      // `register` (a connection, the machine list) must already be that sign-in's.
      backend = _Backend('acct-2');
      await backend.add(box3, 'machine', _mid3, 'box3');
      final layout = Completer<void>();
      final (second, _) = await launch(layoutGate: layout, fresh: true);
      expect(second.status, AppStatus.bootstrapping);
      await second.deviceLog!.refresh();
      expect((await second.deviceLog!.list()).frozen?.reason, isNull);
      layout.complete();
      await lastBoot;
      await settle();
      expect((await second.deviceLog!.list()).frozen, isNull);
    });
  });

  group('a device that joined and left before anyone looked', () {
    test('flagged by the app, kept across a restart, until Got it', () async {
      final (first, _) = await launch();
      await backend.add(box3, 'machine', _mid3, 'box3');
      await first.deviceLog!.refresh();
      await settle();
      expect(pubs(first.newDevices), [b64e(box3.pub)]);
      await backend.removeBy(b64e(box3.pub), box3);
      await first.deviceLog!.refresh();
      await settle();
      expect(first.newDevices, isEmpty);
      expect(first.departedDevices.map((d) => d.pub), [b64e(box3.pub)]);
      expect(first.departedDevices.single.selfRemoved, isTrue);

      first.dispose();
      apps.remove(first);
      final (second, _) = await launch();
      expect(second.departedDevices.map((d) => d.pub), [b64e(box3.pub)]);

      second.dismissDeparted(b64e(box3.pub));
      await settle();
      expect(second.departedDevices, isEmpty);
      expect((await second.deviceLog!.list()).departed, isEmpty);
      second.dispose();
      apps.remove(second);
      final (third, _) = await launch();
      expect(third.departedDevices, isEmpty);
    });

    test('removed by another key: the signer is named; red while that signer is itself new', () async {
      final (app, _) = await launch();
      await backend.add(box2, 'machine', _mid2, 'box2');
      await backend.add(box3, 'machine', _mid3, 'box3');
      await app.deviceLog!.refresh();
      await settle();
      // box3 (still new) removes box2 (also new).
      await backend.removeBy(b64e(box2.pub), box3);
      await app.deviceLog!.refresh();
      await settle();
      final d = app.departedDevices.single;
      expect(d.pub, b64e(box2.pub));
      expect(d.removedBy, b64e(box3.pub));
      expect(d.removedByLabel, 'box3');
      expect(app.departedRed(d), isTrue);
      // Opening the list marks what is new as seen; box2's departure is still unseen.
      app.seenNewDevices(pending: [b64e(box3.pub)]);
      await settle();
      expect(app.departedDevices.map((x) => x.pub), [b64e(box2.pub)]);
    });

    test('a self sign-out notice\'s Got it leaves the departed mark and the History row pending', () async {
      final (app, _) = await launch();
      await backend.add(box3, 'machine', _mid3, 'box3');
      await app.deviceLog!.refresh();
      await backend.removeBy(b64e(box3.pub), box3);
      await app.deviceLog!.refresh();
      await settle();
      final pub = b64e(box3.pub);
      expect(app.departedDevices.map((d) => d.pub), [pub]);
      expect(app.deviceRemovals.map((r) => r.pub), [pub]);
      app.dismissDeviceRemoval(pub);
      await settle();
      expect(app.deviceRemovals, isEmpty);
      expect(app.departedDevices.map((d) => d.pub), [pub]);
      expect((await app.deviceLog!.list()).departed.map((d) => d.pub), [pub]);
      final history = await app.deviceHistory();
      expect(
        history.rows.where((r) => r.pub == pub).any((r) => r.pending),
        isTrue,
      );
      // Its own Got it is what clears it.
      app.dismissDeparted(pub);
      await settle();
      expect(app.departedDevices, isEmpty);
    });

    test(
      'opening the list (seenNewDevices) never dismisses a departed key',
      () async {
        final (app, _) = await launch();
        await backend.add(box3, 'machine', _mid3, 'box3');
        await app.deviceLog!.refresh();
        await backend.removeBy(b64e(box3.pub), box3);
        await app.deviceLog!.refresh();
        await settle();
        final pub = b64e(box3.pub);
        expect(app.departedDevices.map((d) => d.pub), [pub]);
        app.seenNewDevices(pending: [pub], shown: [pub]);
        await settle();
        expect(app.departedDevices.map((d) => d.pub), [pub]);
        expect((await app.deviceLog!.list()).departed.map((d) => d.pub), [pub]);
      },
    );

    test('opening the list with only it on the banner does not cancel a read of the log under way', () async {
      final (app, _) = await launch();
      await backend.add(box3, 'machine', _mid3, 'box3');
      await app.deviceLog!.refresh();
      await settle();
      final member = app.newDevices.single;
      await backend.removeBy(b64e(box3.pub), box3);
      await app.deviceLog!.refresh();
      await settle();
      final pub = b64e(box3.pub);
      expect(app.departedDevices.map((d) => d.pub), [pub]);
      app.newDevices.add(
        member,
      ); // a stale banner for it (a notice replayed at startup)
      // The read of the log that takes it down is under way (and slow)...
      disk.holdDevLogRead(skip: 1);
      unawaited(app.deviceLog!.dismiss(pub: 'nobody'));
      await disk.held!.future;
      // ...when the person opens the list: nothing on the banner is marked, so that read is not stale.
      app.seenNewDevices(shown: [pub]);
      disk.release();
      await settle();
      expect(app.newDevices, isEmpty);
      expect(app.departedDevices.map((d) => d.pub), [pub]);
      expect((await app.deviceLog!.list()).departed.map((d) => d.pub), [pub]);
    });

    test('"It\'s mine" on a stale banner for it takes the banner down and marks nothing', () async {
      final (app, _) = await launch();
      await backend.add(box3, 'machine', _mid3, 'box3');
      await app.deviceLog!.refresh();
      await settle();
      final member = app.newDevices.single;
      await backend.removeBy(b64e(box3.pub), box3);
      await app.deviceLog!.refresh();
      await settle();
      final pub = b64e(box3.pub);
      app.newDevices.add(member);
      app.dismissNewDevice(pub);
      await settle();
      expect(app.newDevices, isEmpty);
      expect(app.departedDevices.map((d) => d.pub), [pub]);
      expect((await app.deviceLog!.list()).departed.map((d) => d.pub), [
        pub,
      ], reason: 'its own Got it is what clears it');
    });

    test(
      'signing out drops it with the rest of the account\'s notices',
      () async {
        final (app, _) = await launch();
        await backend.add(box3, 'machine', _mid3, 'box3');
        await app.deviceLog!.refresh();
        await backend.removeBy(b64e(box3.pub), box3);
        await app.deviceLog!.refresh();
        await settle();
        expect(app.departedDevices, isNotEmpty);
        await app.logout();
        expect(app.departedDevices, isEmpty);
      },
    );
  });

  group('the local sign-in', () {
    Map<String, dynamic> file() =>
        jsonDecode(disk.values['viewer_e2ee_devlog']!) as Map<String, dynamic>;

    test('the log registers the moment the app is authenticated, before the machine list and the profile', () async {
      final profile = Completer<void>(), machines = Completer<void>();
      await launch(profileGate: profile, machinesGate: machines);
      // Neither the machine list nor the profile has answered.
      expect(disk.values['viewer_e2ee_devlog'], isNotNull);
      expect(file()['owner'], isNotNull);
      profile.complete();
      machines.complete();
      await lastBoot;
    });

    test(
      'a stored session is adopted by the log (never a reason to start over)',
      () async {
        await launch();
        expect(file()['owner'], startsWith('adopted:'));
      },
    );

    test('a sign-in by hand keeps the profile\'s account beside its id; a stored session does not', () async {
      final (first, _) = await launch(fresh: true, profileId: _acct);
      expect(jsonDecode(disk.values['viewer_e2ee_sign_in_acct']!), {
        'epoch': disk.values['viewer_e2ee_sign_in'],
        'acct': _acct,
      });
      first.dispose();
      apps.remove(first);
      disk.values.remove('viewer_e2ee_sign_in_acct');
      await launch(profileId: _acct);
      expect(disk.values['viewer_e2ee_sign_in_acct'], isNull);
    });

    test(
      'a sign-in by hand mints the log\'s own id, not the profile\'s',
      () async {
        await launch(fresh: true, profileId: 'u1');
        expect(file()['owner'], isNot(startsWith('adopted:')));
        expect(file()['owner'], isNot('u1'));
      },
    );

    test(
      'a restored session whose profile id differs does not reset the list',
      () async {
        await backend.add(box2, 'machine', _mid2, 'box2');
        final (first, _) = await launch(profileId: 'u1');
        await backend.add(box3, 'machine', _mid3, 'box3');
        await first.deviceLog!.refresh();
        await settle();
        expect(pubs(first.newDevices), [b64e(box3.pub)]);
        final joined = file()['joinedSeq'];
        first.dispose();
        apps.remove(first);

        // The backend answers /me with another id for the same stored session: it says nothing about
        // who signed in here.
        final (second, _) = await launch(profileId: 'u2');
        expect(pubs(second.newDevices), [b64e(box3.pub)]);
        expect(file()['joinedSeq'], joined);
        final listing = await second.deviceLog!.list();
        expect(listing.frozen, isNull);
        expect(listing.pending, [b64e(box3.pub)]);
      },
    );

    test('a backend that says the account changed freezes the log; it does not start over', () async {
      await backend.add(box2, 'machine', _mid2, 'box2');
      final (app, _) = await launch();
      expect((await app.deviceLog!.list()).frozen, isNull);
      backend.acct = 'acct-2';
      await app.deviceLog!.refresh();
      await settle();
      final listing = await app.deviceLog!.list();
      expect(listing.frozen?.reason, 'invalid');
      expect(
        listing.members.map((r) => r.member.pub),
        contains(b64e(box2.pub)),
      );
    });
  });

  // A phone signed in first, then `harness login` on a computer: the machine is new to this phone's
  // copy of the log (or the phone to the machine's), and the refusal says nothing more than "early".
  // It is settled — the phone joins the log, reads it, dials again — before a password is asked for.
  group('a machine that refuses this phone for want of trust', () {
    Future<AppNotifier> withMachine() async {
      final (app, _) = await launch();
      (app.api as _Api).onMachines = () async => [remoteMachine(_mid2)];
      await app.refreshMachines();
      await settle();
      return app;
    }

    Future<void> until(bool Function() done) async {
      for (var i = 0; i < 500 && !done(); i++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
    }

    /// The phone's own key store, whose pins it holds in memory.
    ViewerKeyStore keysOf(AppNotifier app) => app.viewer.keys;

    test(
      'the log names it: pinned and dialled again, no password asked',
      () async {
        final app = await withMachine();
        final keys = keysOf(app);
        await backend.add(box2, 'machine', _mid2, 'box2');
        expect(
          await keys.peer(_mid2),
          isNull,
          reason: 'the phone has not read the log since',
        );
        final redialled = <String>[];
        app.onRedialForTest = redialled.add;

        app.localFailureForTest(_mid2, 4404, 'NO_PEER_LINK');
        expect(
          app.stateOf(_mid2)!.needsLink,
          isFalse,
          reason: 'still connecting while it is settled',
        );
        app.connectionStatusForTest(_mid2, ConnectionStatus.disconnected);
        expect(
          app.stateOf(_mid2)!.connectionStatus,
          ConnectionStatus.connecting,
        );
        await until(() => redialled.isNotEmpty);

        expect(redialled, [_mid2]);
        expect(app.stateOf(_mid2)!.needsLink, isFalse);
        expect(await keys.peer(_mid2), isNotNull);
      },
    );

    test(
      'a key that lands while it is settled ends the wait at once',
      () async {
        final app = await withMachine()
          ..trustSettleRound = const Duration(seconds: 30);
        final redialled = <String>[];
        app.onRedialForTest = redialled.add;
        app.localFailureForTest(_mid2, 4404, 'NO_PEER_LINK');
        await settle();
        await backend.add(box2, 'machine', _mid2, 'box2');
        await app.deviceLog!.refresh(); // a `device_keys_changed`
        await until(() => redialled.isNotEmpty);
        expect(redialled, [_mid2]);
        expect(app.stateOf(_mid2)!.needsLink, isFalse);
      },
    );

    test('denied once, then let in: never asks for a password', () async {
      final app = await withMachine()
        ..trustDeniedWait = const Duration(milliseconds: 10);
      await keysOf(app).pin(_mid2, box2.pub, label: 'box2');
      final redialled = <String>[];
      app.onRedialForTest = redialled.add;

      app.localFailureForTest(_mid2, 4404, 'E2E_DENIED');
      await until(() => redialled.isNotEmpty);
      await settle();

      expect(redialled, [_mid2]);
      expect(app.stateOf(_mid2)!.needsLink, isFalse);
      expect(
        app.stateOf(_mid2)!.agentLoadStatus,
        isNot(AgentLoadStatus.needsLink),
      );
    });

    test('still refused after the grace: the password it is', () async {
      final app = await withMachine()
        ..trustSettleRound = const Duration(milliseconds: 20);
      var redials = 0;
      // Each dial again is refused again: nothing names this machine.
      app.onRedialForTest = (id) {
        redials++;
        scheduleMicrotask(
          () => app.localFailureForTest(id, 4404, 'NO_PEER_LINK'),
        );
      };

      app.localFailureForTest(_mid2, 4404, 'NO_PEER_LINK');
      await until(() => app.stateOf(_mid2)!.needsLink);

      expect(app.stateOf(_mid2)!.needsLink, isTrue);
      expect(app.stateOf(_mid2)!.agentLoadStatus, AgentLoadStatus.needsLink);
      expect(redials, 2, reason: 'two rounds, then the password');
      expect(app.deviceListNeedsReview, isFalse);
    });

    test('a frozen log settles nothing: the password at once, and the list asks for a review', () async {
      backend.refuseAppends =
          true; // this phone is not in it, and cannot get in while it is frozen
      final app = await withMachine();
      final keys = keysOf(app);
      final file = Map<String, Object?>.from(await keys.deviceLog() as Map);
      file['frozen'] = {
        'reason': 'fork',
        'at': 1,
        'lastGoodHead': backend.state.head.toJson(),
      };
      await keys.writeDeviceLog(file);
      final redialled = <String>[];
      app.onRedialForTest = redialled.add;

      app.localFailureForTest(_mid2, 4404, 'NO_PEER_LINK');
      await until(
        () => app.stateOf(_mid2)!.needsLink && app.deviceListNeedsReview,
      );

      expect(app.stateOf(_mid2)!.needsLink, isTrue);
      expect(app.deviceListNeedsReview, isTrue);
      expect(redialled, isEmpty);

      await app.logout();
      expect(
        app.deviceListNeedsReview,
        isFalse,
        reason: 'the next sign-in may be another account',
      );
    });
  });

  group('a phone that hears no machine', () {
    test('reads the machine list again on its own, and on coming back, until a machine connects', () async {
      final (app, _) = await launch();
      final api = app.api as _Api;
      api.onMachines = () async => [remoteMachine(_mid2)];
      app.handleAppPaused();
      app.deafMachineListInterval = const Duration(milliseconds: 40);

      // Back in front (the person was signing in their computer): asked at once, then now and then.
      var before = api.machineFetches;
      app.handleAppResumed();
      await settle();
      expect(api.machineFetches, greaterThan(before));
      before = api.machineFetches;
      await Future<void>.delayed(const Duration(milliseconds: 130));
      await settle();
      expect(api.machineFetches, greaterThan(before));

      // In a pocket: not asked at all.
      app.handleAppPaused();
      await settle();
      before = api.machineFetches;
      await Future<void>.delayed(const Duration(milliseconds: 130));
      expect(api.machineFetches, before);

      // A machine connected: its pushes say what changes.
      app.handleAppResumed();
      await settle();
      app.connectionStatusForTest(_mid2, ConnectionStatus.connected);
      await settle();
      before = api.machineFetches;
      await Future<void>.delayed(const Duration(milliseconds: 130));
      await settle();
      expect(api.machineFetches, before);
    });

    test('a `machines_changed` push reads the list again', () async {
      final (app, _) = await launch();
      final api = app.api as _Api;
      api.onMachines = () async => [remoteMachine(_mid2)];
      await app.refreshMachines();
      await settle();
      final before = api.machineFetches;
      await app.handleMachineEventForTest(_mid2, {
        'type': 'machines_changed',
        'payload': {'reason': 'created'},
      });
      await settle();
      expect(api.machineFetches, before + 1);
    });
  });
}
