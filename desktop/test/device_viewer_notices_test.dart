// A viewer build (web) keeps the account's device key log itself: the new-device banner is rebuilt
// from what that log kept as pending (so it survives a restart), "seen" is written back to it, and a
// removal it reads becomes a band — red when a device nobody has looked at did it.
import 'dart:async';

import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/notify/system_notifications.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/e2ee/bytes.dart';
import 'package:harness/e2ee/keys.dart';
import 'package:harness/state/account_devices.dart' show NewDeviceNotice;
import 'package:harness/state/app_state.dart';
import 'package:harness/viewer/device_log.dart';
import 'package:harness/viewer/device_log_sync.dart';
import 'package:harness/viewer/direct_auth_api.dart' show IssuedTokens;
import 'package:harness/viewer/viewer_key_store.dart';
import 'package:harness/viewer/viewer_services.dart';

import 'swarm_state_test.dart' show MemoryStore;

const _acct = 'acct-1';

/// Records the device notices that would have reached the operating system.
class _Posts extends SystemNotifications {
  _Posts() : super(notifier: const NoSystemNotifier());

  final ids = <String>[];

  @override
  void postNotice({
    required String id,
    required String title,
    required String body,
    String? devicePub,
  }) => ids.add(id);
}

/// A key-value store that tells the test when the app reads it (the boot's pane restore).
class _HookedStore extends MemoryStore {
  Future<void> Function()? onRead;

  @override
  Future<String?> read(String key) async {
    final hook = onRead;
    onRead = null;
    await hook?.call();
    return super.read(key);
  }
}

/// A backend that keeps the log honestly.
class _Backend {
  _Backend([this.acct = _acct]) : state = DevLogState.empty(acct);

  final String acct;
  final entries = <DevLogEntry>[];
  DevLogState state;

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

  DeviceLogFetched fetch(int since) => (
    acct: acct,
    head: state.head,
    entries: [
      for (final e in entries)
        if (e.seq > since) e.toJson(),
    ],
  );

  /// Every append is refused with this code while set.
  String? refuse;

  Future<DeviceLogAppendAnswer> append(DevLogEntry entry) async {
    if (refuse case final code?) return (head: null, error: code);
    if (entry.seq != state.head.seq + 1 || entry.prev != state.head.hash) {
      return (head: state.head, error: 'STALE_HEAD');
    }
    await _push(entry);
    return (head: state.head, error: null);
  }
}

class _Api extends ApiClient {
  _Api(this.backend) : super(config: AppConfig.dev, session: AuthSession());

  final _Backend backend;

  /// The backend cannot be reached.
  bool offline = false;

  /// When set, the last-seen request waits on it (the backend can delay it as long as it likes).
  Completer<void>? seenGate;

  /// The `self` every read of the log named.
  final selves = <String?>[];

  @override
  Future<DeviceLogFetched?> deviceKeys(int since, {String? self}) async {
    selves.add(self);
    return offline ? null : backend.fetch(since);
  }

  @override
  Future<DeviceLogAppendAnswer?> appendDeviceKey(DevLogEntry entry) =>
      backend.append(entry);

  @override
  Future<Map<String, int>> deviceKeysSeen() async {
    await seenGate?.future;
    return const {};
  }

  @override
  Future<Map<String, dynamic>?> daemonDevices() async =>
      throw StateError('a viewer build has no daemon');

  /// Who `/api/auth/me` says is signed in (null: no profile).
  String? user;

  @override
  Future<Map<String, dynamic>?> me() async {
    final id = user;
    return id == null
        ? null
        : {
            'user': {'id': id, 'email': '$id@example.com'},
          };
  }

  /// How many times the machine list was read.
  int machineReads = 0;

  @override
  Future<List<Machine>> machines() async {
    machineReads++;
    return const [];
  }
}

/// A viewer that is already signed in when it opens.
class _SignedIn extends CliLogin {
  @override
  Future<CliAuthStatus> checkStatus() async =>
      const CliAuthStatus(loggedIn: true);

  @override
  Future<void> logout() async {}
}

void main() {
  late _Backend backend;
  late ViewerKeyStore keys;
  late E2eeIdentity box2, phone, intruder;

  AppNotifier start({SystemNotifications? notices}) {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(storage: MemoryStore()),
      configStore: null,
      systemNotifications: notices,
      viewer: ViewerServices(
        config: AppConfig.dev,
        session: AuthSession(storage: MemoryStore()),
        keys: keys,
      ),
    );
    app.api = _Api(backend);
    // Signed in: the boot's announcements are only taken from a signed-in app.
    app.status = AppStatus.authenticated;
    return app;
  }

  ViewerDeviceLog logOf(AppNotifier app) => app.viewer!.links.deviceLog!;

  /// Lets the listeners the log fired (`onChanged` → the pending sync) finish.
  Future<void> settle() async {
    for (var i = 0; i < 20; i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  setUp(() async {
    backend = _Backend();
    // Whatever this app persists — its key, the log's copy — lives here, across "restarts".
    keys = ViewerKeyStore(storage: MemoryStore());
    box2 = await E2eeIdentity.fromSeed(List.filled(32, 2));
    phone = await E2eeIdentity.fromSeed(List.filled(32, 3));
    intruder = await E2eeIdentity.fromSeed(List.filled(32, 4));
  });

  test('opening signed in registers with the log and brings back what is still pending — nothing else asked', () async {
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    Future<AppNotifier> open() async {
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(storage: MemoryStore()),
        configStore: null,
        cliLogin: _SignedIn(),
        viewer: ViewerServices(
          config: AppConfig.dev,
          session: AuthSession(storage: MemoryStore()),
          keys: keys,
        ),
      );
      app.api = _Api(backend);
      addTearDown(app.dispose);
      await app.bootstrap();
      await settle();
      expect(app.status, AppStatus.authenticated);
      return app;
    }

    final first = await open();
    final me = b64e((await keys.identity()).pub);
    expect(
      backend.state.active[me]?.kind,
      'viewer',
      reason: 'the boot itself put this app into the log',
    );
    expect(first.newDevices, isEmpty);
    await backend.add(phone, 'viewer', '', 'Phone');
    await logOf(first).refresh();
    await settle();
    expect(first.newDevices.map((d) => d.label), ['Phone']);

    // A restart: the banner is back from the boot alone, before the log reads anything new.
    final again = await open();
    expect(again.newDevices.map((d) => d.label), ['Phone']);
  });

  Future<AppNotifier> openAs(
    _Backend on,
    String user, {
    bool byHand = false,
  }) async {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(storage: MemoryStore()),
      configStore: null,
      cliLogin: _SignedIn(),
      viewer: ViewerServices(
        config: AppConfig.dev,
        session: AuthSession(storage: MemoryStore()),
        keys: keys,
      ),
    );
    app.api = _Api(on)..user = user;
    // A sign-in by hand is what the boot reads as fresh; a restored session never is.
    if (byHand) {
      await app.viewer!.auth.signIn(const IssuedTokens(token: 'token'));
    }
    addTearDown(app.dispose);
    await app.bootstrap();
    await settle();
    return app;
  }

  test('every read of the log names this app\'s key; too many devices is said until a register lands', () async {
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    backend.refuse = 'TOO_MANY';
    final app = await openAs(backend, 'user-a');
    final me = b64e((await keys.identity()).pub);
    final api = app.api as _Api;
    expect(api.selves, isNotEmpty);
    expect(api.selves.toSet(), {me});
    expect(app.deviceListTooMany, isTrue);
    expect((await logOf(app).list()).registerError, 'TOO_MANY');

    backend.refuse = null;
    await logOf(app).register();
    await settle();
    expect(backend.state.active[me], isNotNull);
    expect(app.deviceListTooMany, isFalse);
  });

  test('with no machine to hear pushes from, the machine list is read again on its own and on coming back to the tab', () async {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(storage: MemoryStore()),
      configStore: null,
      cliLogin: _SignedIn(),
      viewer: ViewerServices(
        config: AppConfig.dev,
        session: AuthSession(storage: MemoryStore()),
        keys: keys,
      ),
    )..deafMachineListInterval = const Duration(milliseconds: 40);
    final api = _Api(backend)..user = 'user-a';
    app.api = api;
    addTearDown(app.dispose);
    await app.bootstrap();
    await settle();
    final afterBoot = api.machineReads;
    expect(afterBoot, greaterThan(0));

    // Nothing connected: no `machines_changed` can reach this tab, so the list is asked for again.
    await Future<void>.delayed(const Duration(milliseconds: 130));
    await settle();
    expect(api.machineReads, greaterThan(afterBoot));

    // Behind other tabs: not asked for at all.
    app.appLifecycleChanged(AppLifecycleState.hidden);
    final hidden = api.machineReads;
    await Future<void>.delayed(const Duration(milliseconds: 130));
    await settle();
    expect(api.machineReads, hidden);

    // Back to the tab (the person was signing in their computer): asked for at once.
    final beforeResume = api.machineReads;
    app.deafMachineListInterval = const Duration(hours: 1);
    app.appLifecycleChanged(AppLifecycleState.resumed);
    await settle();
    expect(api.machineReads, greaterThan(beforeResume));
  });

  test('signing in by hand as another account starts that account\'s list over', () async {
    // Account A: this browser joined its log.
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    await openAs(backend, backend.acct, byHand: true);
    final me = b64e((await keys.identity()).pub);
    expect(backend.state.active[me]?.kind, 'viewer');

    // Signed in as B in the same browser, by hand: B's log is another account's, and this sign-in is
    // new — a new list, not a backend that lies. A fresh sign-in's profile names the same account
    // as its signed log; restored-session profile mismatches are exercised below.
    final other = _Backend('acct-2');
    await other.add(phone, 'viewer', '', 'Phone');
    final b = await openAs(other, other.acct, byHand: true);
    final listing = await logOf(b).list();
    expect(
      listing.frozen,
      isNull,
      reason: 'a new local sign-in is a new list, not a backend that lies',
    );
    expect(
      other.state.active[me]?.kind,
      'viewer',
      reason: 'this browser joined B\'s log',
    );
    expect(listing.members.map((m) => m.member.label), contains('Phone'));
  });

  test('a restored session whose /me id differs does not reset the list', () async {
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    await openAs(backend, backend.acct, byHand: true);
    await backend.add(phone, 'viewer', '', 'Phone');
    final first = await openAs(backend, 'user-a');
    expect(first.newDevices.map((d) => d.label), ['Phone']);

    // The backend now says another person is signed in (the profile is the backend's word): the log
    // is the same account's, so nothing is reset — the marks and the list stay.
    final again = await openAs(backend, 'user-evil');
    expect((await logOf(again).list()).frozen, isNull);
    expect(again.newDevices.map((d) => d.label), ['Phone']);

    // And a restored session on another ACCOUNT's log is frozen, not started over.
    final other = _Backend('acct-2');
    await other.add(intruder, 'viewer', '', 'Chrome');
    final lied = await openAs(other, 'user-b');
    expect((await logOf(lied).list()).frozen, isNotNull);
    expect(
      other.state.active.keys,
      isNot(contains(b64e((await keys.identity()).pub))),
      reason: 'it did not join',
    );
    expect(lied.newDevices.map((d) => d.label), [
      'Phone',
    ], reason: 'the marks are still the old account\'s');
  });

  test(
    'a device that joins later is banner-worthy, and still is after a restart',
    () async {
      await backend.add(box2, 'machine', 'b' * 32, 'box2');
      final app = start();
      addTearDown(app.dispose);
      await logOf(app).register();
      await settle();
      // What was there before this app joined is not news.
      expect(app.newDevices, isEmpty);

      await backend.add(phone, 'viewer', '', 'Phone');
      await logOf(app).refresh();
      await settle();
      expect(app.newDevices.map((d) => d.label), ['Phone']);

      // A restart: same storage, fresh app. The log kept it as pending, so the banner is back on the
      // next change the log reads — no announcement needed.
      final again = start();
      addTearDown(again.dispose);
      expect(again.newDevices, isEmpty);
      await backend.add(intruder, 'viewer', '', 'Chrome on macOS');
      await logOf(again).refresh();
      await settle();
      expect(again.newDevices.map((d) => d.label), [
        'Phone',
        'Chrome on macOS',
      ]);
    },
  );

  test('"It’s mine" and opening the list are written to the log, so they hold across a restart', () async {
    final app = start();
    addTearDown(app.dispose);
    await logOf(app).register();
    await backend.add(phone, 'viewer', '', 'Phone');
    await backend.add(intruder, 'viewer', '', 'Chrome');
    await logOf(app).refresh();
    await settle();
    expect(app.newDevices.length, 2);

    app.dismissNewDevice(b64e(phone.pub));
    await settle();
    expect((await logOf(app).list()).pending, [b64e(intruder.pub)]);
    expect(app.newDevices.map((d) => d.label), ['Chrome']);

    app.seenNewDevices();
    await settle();
    expect((await logOf(app).list()).pending, isEmpty);

    final again = start();
    addTearDown(again.dispose);
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    await logOf(again).refresh();
    await settle();
    // Only what joined since: the two seen ones stay seen.
    expect(again.newDevices.map((d) => d.label), ['box2']);
  });

  test('opening the list writes back what it read as pending even with no banner up', () async {
    final app = start();
    addTearDown(app.dispose);
    await logOf(app).register();
    await backend.add(phone, 'viewer', '', 'Phone');
    await logOf(app).refresh();
    await settle();
    // The banner was closed here, but the write did not land (say, the tab closed first).
    app.newDevices.clear();
    final devices = (await app.loadDevices())!;
    expect(devices.pending, [b64e(phone.pub)]);
    app.seenNewDevices(pending: devices.pending);
    await settle();
    expect((await logOf(app).list()).pending, isEmpty);
  });

  test(
    'the baseline panel is shown until Got it, which the log keeps',
    () async {
      await backend.add(box2, 'machine', 'b' * 32, 'box2');
      final app = start();
      addTearDown(app.dispose);
      await logOf(app).register();
      final before = (await app.loadDevices())!;
      expect(before.baselineSeen, isFalse);
      expect(before.baseline.map((d) => d.label), ['box2']);
      expect(before.historyAvailable, isTrue);

      await app.seeDeviceBaseline();
      final again = start();
      addTearDown(again.dispose);
      expect((await again.loadDevices())!.baselineSeen, isTrue);
    },
  );

  test('a removal read from the log is a band: plain, signed out, or red when a new device did it', () async {
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    await backend.add(phone, 'viewer', '', 'Phone');
    final app = start();
    addTearDown(app.dispose);
    await logOf(app).register();
    await settle();

    // A device that was here before this app joined takes another out: the owner tidying up.
    await backend.removeBy(b64e(phone.pub), box2);
    await logOf(app).refresh();
    await settle();
    expect(app.deviceRemovals.single.red, isFalse);
    expect(app.deviceRemovals.single.title, 'Device removed');
    expect(
      app.deviceRemovals.single.sentence,
      'Phone was removed from your account by box2.',
    );

    // A device nobody has looked at yet removes a computer: red, naming it with its short code.
    await backend.add(intruder, 'viewer', '', 'Chrome on macOS');
    await backend.removeBy(b64e(box2.pub), intruder);
    await logOf(app).refresh();
    await settle();
    final red = app.deviceRemovals.last;
    expect(red.pub, b64e(box2.pub));
    expect(red.red, isTrue);
    expect(red.title, 'Removed by a new device');
    expect(
      red.sentence,
      startsWith(
        'box2 was removed from your account by a new device you haven’t looked at (Chrome on macOS · ',
      ),
    );
    expect(red.sentence, endsWith('…).'));

    // It signs itself out: its own act, never red even though it is still new.
    await backend.removeBy(b64e(intruder.pub), intruder);
    await logOf(app).refresh();
    await settle();
    final out = app.deviceRemovals.last;
    expect(
      (out.selfRemoved, out.red, out.title),
      (true, false, 'Device signed out'),
    );
    expect(out.sentence, 'Chrome on macOS signed out of your account.');

    app.dismissDeviceRemoval(out.pub);
    expect(app.deviceRemovals.map((n) => n.pub), [
      b64e(phone.pub),
      b64e(box2.pub),
    ]);
  });

  test('the History dialog reads this app’s own log', () async {
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    final app = start();
    addTearDown(app.dispose);
    await logOf(app).register();
    final history = (await app.loadDeviceHistory())!;
    expect(history.complete, isTrue);
    // Newest first: this app's own add, then the computer that was already there.
    expect(history.rows.map((r) => (r.op, r.thisDevice)), [
      ('added', true),
      ('added', false),
    ]);
  });

  test(
    'signing out forgets what was said about the old account’s devices',
    () async {
      await backend.add(box2, 'machine', 'b' * 32, 'box2');
      await backend.add(phone, 'viewer', '', 'Phone');
      final app = start();
      addTearDown(app.dispose);
      await logOf(app).register();
      await backend.removeBy(b64e(phone.pub), box2);
      await logOf(app).refresh();
      await settle();
      await app.seeDeviceBaseline();
      expect(app.deviceRemovals, isNotEmpty);
      expect(app.baselineSeenLocally, isTrue);
      await app.logout();
      expect(app.deviceRemovals, isEmpty);
      expect(app.baselineSeenLocally, isFalse);
    },
  );

  test('a new device announced while the last-seen request waits is not marked seen with the list', () async {
    final app = start();
    addTearDown(app.dispose);
    await logOf(app).register();
    await backend.add(phone, 'viewer', '', 'Phone');
    await logOf(app).refresh();
    await settle();
    expect(app.newDevices.map((d) => d.label), ['Phone']);

    final api = app.api as _Api;
    api.seenGate = Completer<void>();
    List<String>? shown;
    final read = app.loadDevices(onListed: (b) => shown = b);
    await settle();
    // The intruder joins while the backend sits on the request.
    await backend.add(intruder, 'viewer', '', 'Chrome');
    await logOf(app).refresh();
    await settle();
    api.seenGate!.complete();
    final devices = (await read)!;
    expect(shown, [b64e(phone.pub)]);
    app.seenNewDevices(pending: devices.pending, shown: shown);
    await settle();
    expect(app.newDevices.map((d) => d.label), ['Chrome']);
    expect((await logOf(app).list()).pending, [b64e(intruder.pub)]);
  });

  test(
    'a head that moved while reviewing is "changed"; an unreadable log is null',
    () async {
      final app = start();
      addTearDown(app.dispose);
      await logOf(app).register();
      final preview = (await app.rebaselineDevices(confirm: false))!;
      expect(preview.logChanged, isFalse);

      await backend.add(intruder, 'viewer', '', 'Chrome');
      final moved = (await app.rebaselineDevices(
        confirm: true,
        head: preview.head,
      ))!;
      expect(moved.logChanged, isTrue);

      (app.api as _Api).offline = true;
      expect(
        await app.rebaselineDevices(confirm: true, head: preview.head),
        isNull,
      );
    },
  );

  test(
    'a key a fork suspended is marked so on the banner (the app\'s own log)',
    () async {
      await backend.add(box2, 'machine', 'b' * 32, 'box2');
      final app = start();
      addTearDown(app.dispose);
      await logOf(app).register();
      await backend.add(phone, 'viewer', '', 'Phone');
      await logOf(app).refresh();
      await settle();
      expect(app.newDevices.single.suspended, isFalse);

      // A fork left the key suspended in this app's copy of the log (kept as pending).
      final file = Map<String, dynamic>.from((await keys.deviceLog())! as Map);
      file['suspended'] = [b64e(phone.pub)];
      await keys.writeDeviceLog(file);
      await backend.add(intruder, 'viewer', '', 'Chrome');
      await logOf(app).refresh();
      await settle();
      expect(app.newDevices.map((d) => (d.label, d.suspended)), [
        ('Phone', true),
        ('Chrome', false),
      ]);
    },
  );

  test('a removal read while the app starts up is said once it is signed in, not lost', () async {
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    await backend.add(phone, 'viewer', '', 'Phone');
    final posts = _Posts();
    final app = start(notices: posts);
    addTearDown(app.dispose);
    await logOf(app).register();
    await settle();
    await backend.removeBy(b64e(phone.pub), box2);
    app.status = AppStatus.checkingEnvironment;
    await logOf(app).refresh();
    await settle();
    expect(
      app.deviceRemovals,
      isEmpty,
      reason: 'not before the app is signed in',
    );
    expect(posts.ids, isEmpty);
    app.status = AppStatus.authenticated;
    expect(app.deviceRemovals.single.pub, b64e(phone.pub));
    expect(posts.ids, ['harness-device-removed:${b64e(phone.pub)}']);
  });

  test('a new device read while the app starts up reaches the operating system once it is signed in', () async {
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    final posts = _Posts();
    final app = start(notices: posts);
    addTearDown(app.dispose);
    await logOf(app).register();
    await settle();
    // The log has already recorded it as announced: this is the only chance the notification gets.
    await backend.add(phone, 'viewer', '', 'Phone');
    app.status = AppStatus.bootstrapping;
    await logOf(app).refresh();
    await settle();
    expect(posts.ids, isEmpty);
    app.status = AppStatus.authenticated;
    expect(posts.ids, ['harness-device:${b64e(phone.pub)}']);
    expect(app.newDevices.map((d) => d.label), ['Phone']);
    // Said once: a later change of status does not say it again.
    app.status = AppStatus.authenticated;
    expect(posts.ids, hasLength(1));
  });

  test(
    'a notice that waited for the app and was then dismissed is not said',
    () async {
      await backend.add(box2, 'machine', 'b' * 32, 'box2');
      final posts = _Posts();
      final app = start(notices: posts);
      addTearDown(app.dispose);
      await logOf(app).register();
      await settle();
      await backend.add(phone, 'viewer', '', 'Phone');
      app.status = AppStatus.bootstrapping;
      await logOf(app).refresh();
      await settle();
      app.dismissNewDevice(b64e(phone.pub));
      app.status = AppStatus.authenticated;
      expect(posts.ids, isEmpty);
    },
  );

  test('a notice that waited for the app is dropped when the person signs out instead', () async {
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    await backend.add(phone, 'viewer', '', 'Phone');
    final posts = _Posts();
    final app = start(notices: posts);
    addTearDown(app.dispose);
    await logOf(app).register();
    await settle();
    await backend.removeBy(b64e(phone.pub), box2);
    await backend.add(intruder, 'viewer', '', 'Chrome');
    app.status = AppStatus.preparingEnvironment;
    await logOf(app).refresh();
    await settle();
    app.status = AppStatus.unauthenticated;
    app.status = AppStatus.authenticated;
    expect(posts.ids, isEmpty);
    expect(app.deviceRemovals, isEmpty);
  });

  test('what waited for the app is not said after the account it was about is left', () async {
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    final posts = _Posts();
    final app = start(notices: posts);
    addTearDown(app.dispose);
    await logOf(app).register();
    await settle();
    await backend.add(phone, 'viewer', '', 'Phone');
    app.status = AppStatus.bootstrapping;
    await logOf(app).refresh();
    await settle();
    app.clearDeviceNoticeStateForTest();
    app.status = AppStatus.authenticated;
    expect(posts.ids, isEmpty);
  });

  test('a key that joined and left before anyone looked stays flagged from this app\'s own log until Got it', () async {
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    final app = start();
    addTearDown(app.dispose);
    await logOf(app).register();
    await settle();
    await backend.add(phone, 'viewer', '', 'Phone');
    await backend.removeBy(b64e(phone.pub), box2);
    await logOf(app).refresh();
    await settle();
    final gone = app.departedDevices.single;
    expect(
      (gone.pub, gone.label, gone.removedByLabel, gone.selfRemoved),
      (b64e(phone.pub), 'Phone', 'box2', false),
    );
    expect(app.departedIsRed(gone), isFalse);
    expect(app.newDevices, isEmpty);

    // Opening the list (or a restart) does not clear it.
    app.seenNewDevices();
    await settle();
    final again = await openAs(backend, 'user-a');
    expect(again.departedDevices.map((d) => d.pub), [b64e(phone.pub)]);

    // Got it clears it, and that holds across a restart too.
    again.dismissDeparted(b64e(phone.pub));
    await settle();
    expect(again.departedDevices, isEmpty);
    final last = await openAs(backend, 'user-a');
    expect(last.departedDevices, isEmpty);
  });

  test('a notice replayed after the key already left does not put it back in the banner', () async {
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    final app = start();
    addTearDown(app.dispose);
    await logOf(app).register();
    await settle();
    // Announced while the app starts up (so the notice waits), and taken out again before it is said.
    await backend.add(phone, 'viewer', '', 'Phone');
    app.status = AppStatus.bootstrapping;
    await logOf(app).refresh();
    await backend.removeBy(b64e(phone.pub), box2);
    await logOf(app).refresh();
    await settle();
    expect(app.newDevices, isEmpty);
    app.status = AppStatus.authenticated;
    await settle();
    expect(
      app.newDevices,
      isEmpty,
      reason: 'the log says it is not pending: the replay must not keep it',
    );
    expect(app.departedDevices.map((d) => d.pub), [b64e(phone.pub)]);
  });

  test('opening the list never marks a key that joined and left unseen as seen — only its own Got it does', () async {
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    final app = start();
    addTearDown(app.dispose);
    await logOf(app).register();
    await settle();
    await backend.add(phone, 'viewer', '', 'Phone');
    await backend.removeBy(b64e(phone.pub), box2);
    await logOf(app).refresh();
    await settle();
    final gone = b64e(phone.pub);
    expect(app.departedDevices.map((d) => d.pub), [gone]);

    // A banner set that still names the key (a replay that raced the sync), and a list that read it as new.
    app.seenNewDevices(shown: [gone], pending: [gone]);
    await settle();
    expect(app.departedDevices.map((d) => d.pub), [gone]);
    final again = await openAs(backend, 'user-a');
    expect(again.departedDevices.map((d) => d.pub), [
      gone,
    ], reason: 'nothing was written for it');

    again.dismissDeparted(gone);
    await settle();
    expect(again.departedDevices, isEmpty);
  });

  test('opening the list: the departed keys that same read listed are not marked seen even before the app read them', () async {
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    final app = start();
    addTearDown(app.dispose);
    await logOf(app).register();
    await settle();
    await backend.add(phone, 'viewer', '', 'Phone');
    await backend.removeBy(b64e(phone.pub), box2);
    await logOf(app).refresh();
    await settle();
    final gone = b64e(phone.pub);
    expect(app.departedDevices.map((d) => d.pub), [gone]);

    // The app has not read the key as departed yet (startup), but the list's own read did.
    app.departedDevices.clear();
    final listing = (await app.loadDevices())!;
    expect(listing.departed, [gone]);
    app.seenNewDevices(
      shown: [gone],
      pending: [gone],
      departed: listing.departed,
    );
    // The next change of the log re-reads the marks: the key is still flagged, because nothing was written for it.
    await backend.add(intruder, 'viewer', '', 'Chrome');
    await logOf(app).refresh();
    await settle();
    expect(app.departedDevices.map((d) => d.pub), [
      gone,
    ], reason: 'not marked seen: only its own Got it clears it');
  });

  test('opening the list with only a departed key up does not cancel the replay\'s read of the log', () async {
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    final app = start();
    addTearDown(app.dispose);
    await logOf(app).register();
    await settle();
    await backend.add(phone, 'viewer', '', 'Phone'); // new, still pending
    await logOf(app).refresh();
    await settle();
    // Announced while the app starts up (the notice waits), and taken out again before it is said.
    app.status = AppStatus.bootstrapping;
    await backend.add(intruder, 'viewer', '', 'Chrome');
    await logOf(app).refresh();
    await backend.removeBy(b64e(intruder.pub), box2);
    await logOf(app).refresh();
    await settle();
    final gone = b64e(intruder.pub);
    expect(app.departedDevices.map((d) => d.pub), [gone]);
    app.newDevices.clear(); // the banner not rebuilt yet: only the replay's read brings Phone back
    // The list opens the moment the replay put the departed key up, its read of the log under way.
    var opened = false;
    void open() {
      if (opened || !app.newDevices.any((d) => d.pub == gone)) return;
      opened = true;
      scheduleMicrotask(() => app.seenNewDevices(shown: [gone]));
    }

    app.addListener(open);
    app.status = AppStatus.authenticated;
    await settle();
    app.removeListener(open);
    expect(opened, isTrue);
    expect(app.newDevices.map((d) => d.pub), [
      b64e(phone.pub),
    ], reason: 'nothing was marked: the read lands');
    expect(app.departedDevices.map((d) => d.pub), [gone]);
  });

  test('"It\'s mine" on a stale banner for a departed key takes it down and marks nothing', () async {
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    final app = start();
    addTearDown(app.dispose);
    await logOf(app).register();
    await settle();
    await backend.add(phone, 'viewer', '', 'Phone');
    await backend.removeBy(b64e(phone.pub), box2);
    await logOf(app).refresh();
    await settle();
    final gone = b64e(phone.pub);
    app.newDevices.add(
      NewDeviceNotice(pub: gone, label: 'Phone', kind: 'viewer'),
    );
    app.dismissNewDevice(gone);
    await settle();
    expect(app.newDevices, isEmpty);
    expect(app.departedDevices.map((d) => d.pub), [gone]);
    expect((await logOf(app).list()).departed.map((d) => d.pub), [
      gone,
    ], reason: 'its own Got it is what clears it');
    final again = await openAs(backend, 'user-a');
    expect(again.departedDevices.map((d) => d.pub), [gone]);
  });

  test('a new device that took the key out is what makes it red; its own sign-out is not', () async {
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    final app = start();
    addTearDown(app.dispose);
    await logOf(app).register();
    await settle();
    await backend.add(intruder, 'viewer', '', 'Chrome on macOS');
    await backend.add(phone, 'viewer', '', 'Phone');
    await backend.removeBy(b64e(phone.pub), intruder);
    await logOf(app).refresh();
    await settle();
    final byIntruder = app.departedDevices.single;
    expect(app.departedIsRed(byIntruder), isTrue);
    expect(
      byIntruder.sentence(red: true),
      contains('a new device you haven’t looked at'),
    );
    await backend.removeBy(b64e(intruder.pub), intruder);
    await logOf(app).refresh();
    await settle();
    final own = app.departedDevices.firstWhere(
      (d) => d.pub == b64e(intruder.pub),
    );
    expect(own.selfRemoved, isTrue);
    expect(app.departedIsRed(own), isFalse);
  });

  test('the sign-in is known to the log before the boot reads anything else (a pane restore reads it first)', () async {
    // Account A: this browser joined its log by hand.
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    await openAs(backend, backend.acct, byHand: true);
    final me = b64e((await keys.identity()).pub);
    // A's sign-in is long past: only a sign-in made just now may start another account's list.
    const old = 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0@1000';
    await keys.writeSignInEpoch(old);
    await keys.writeDeviceLog({
      ...Map<String, dynamic>.from((await keys.deviceLog())! as Map),
      'owner': old,
    });

    // Signing in as B by hand: whatever reads the log first — here the boot's own pane restore — must
    // already be under the new sign-in, or A's list would be frozen as a lie before B's is joined.
    final other = _Backend('acct-2');
    await other.add(phone, 'viewer', '', 'Phone');
    final store = _HookedStore();
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(storage: MemoryStore()),
      configStore: null,
      cliLogin: _SignedIn(),
      paneLayoutStore: PaneLayoutStore(storage: store),
      viewer: ViewerServices(
        config: AppConfig.dev,
        session: AuthSession(storage: MemoryStore()),
        keys: keys,
      ),
    );
    app.api = _Api(other)..user = 'user-b';
    addTearDown(app.dispose);
    store.onRead = () => logOf(app).refresh();
    await app.viewer!.auth.signIn(const IssuedTokens(token: 'token'));
    await app.bootstrap();
    await settle();
    final listing = await logOf(app).list();
    expect(listing.frozen, isNull);
    expect(
      other.state.active[me]?.kind,
      'viewer',
      reason: 'this browser joined B\'s log',
    );
    // A's list was put aside as it was — not frozen as a lie, which coming back to A would have to be
    // trusted again from.
    final kept = (await keys.deviceLogArchive())[_acct]! as Map;
    expect(kept['frozen'], isNull);
  });

  test('an announcement that lands after signing out is dropped', () async {
    await backend.add(box2, 'machine', 'b' * 32, 'box2');
    final app = start();
    addTearDown(app.dispose);
    await logOf(app).register();
    await backend.add(phone, 'viewer', '', 'Phone');
    app.status = AppStatus.unauthenticated;
    await logOf(app).refresh();
    await settle();
    expect(app.newDevices, isEmpty);
    expect(app.deviceRemovals, isEmpty);
  });

  // A web app signed in first, then `harness login` on a computer: the machine is new to this app's
  // copy of the log (or this app to the machine's), and the refusal says nothing more than "early".
  // It is settled — this app joins the log, reads it, dials again — before a password is asked for.
  group('a machine that refuses this app for want of trust', () {
    final mid = 'b' * 32;

    AppNotifier withMachine() {
      final app = start();
      addTearDown(app.dispose);
      const name = 'box2';
      final machine = Machine(
        machineId: mid,
        authMode: MachineAuthMode.remote,
        name: name,
      );
      app.machines = [machine];
      app.machineStates[mid] = MachineState(machine)..nodeOnline = true;
      return app;
    }

    Future<void> until(bool Function() done) async {
      for (var i = 0; i < 500 && !done(); i++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
    }

    test(
      'the log names it: pinned and dialled again, no password asked',
      () async {
        final app = withMachine();
        await backend.add(box2, 'machine', mid, 'box2');
        expect(
          await keys.peer(mid),
          isNull,
          reason: 'this app has not read the log since',
        );
        final redialled = <String>[];
        app.onRedialForTest = redialled.add;

        app.localFailureForTest(mid, 4404, 'NO_PEER_LINK');
        expect(
          app.stateOf(mid)!.needsLink,
          isFalse,
          reason: 'still connecting while it is settled',
        );
        await until(() => redialled.isNotEmpty);

        expect(redialled, [mid]);
        expect(app.stateOf(mid)!.needsLink, isFalse);
        expect(await keys.peer(mid), isNotNull);
        final me = b64e((await keys.identity()).pub);
        expect(
          backend.state.active[me]?.kind,
          'viewer',
          reason: 'this app joined the log on the way',
        );
      },
    );

    test('denied once, then let in: never asks for a password', () async {
      final app = withMachine()
        ..trustDeniedWait = const Duration(milliseconds: 10);
      await keys.pin(mid, box2.pub, label: 'box2');
      final redialled = <String>[];
      app.onRedialForTest = redialled.add;

      app.localFailureForTest(mid, 4404, 'E2E_DENIED');
      await until(() => redialled.isNotEmpty);
      await settle();

      expect(redialled, [mid]);
      expect(app.stateOf(mid)!.needsLink, isFalse);
      expect(
        app.stateOf(mid)!.agentLoadStatus,
        isNot(AgentLoadStatus.needsLink),
      );
    });

    test('still refused after the grace: the password it is', () async {
      final app = withMachine()
        ..trustSettleRound = const Duration(milliseconds: 20);
      var redials = 0;
      // Each dial again is refused again: nothing names this machine.
      app.onRedialForTest = (id) {
        redials++;
        scheduleMicrotask(
          () => app.localFailureForTest(id, 4404, 'NO_PEER_LINK'),
        );
      };

      app.localFailureForTest(mid, 4404, 'NO_PEER_LINK');
      await until(() => app.stateOf(mid)!.needsLink);

      expect(app.stateOf(mid)!.needsLink, isTrue);
      expect(app.stateOf(mid)!.agentLoadStatus, AgentLoadStatus.needsLink);
      expect(redials, 2, reason: 'two rounds, then the password');
    });

    test('a frozen log settles nothing: the password at once, and the list asks for a review', () async {
      final app = withMachine();
      await backend.add(box2, 'machine', 'c' * 32, 'box3');
      await logOf(app).refresh();
      final file = Map<String, Object?>.from(await keys.deviceLog() as Map);
      file['frozen'] = {
        'reason': 'fork',
        'at': 1,
        'lastGoodHead': backend.state.head.toJson(),
      };
      await keys.writeDeviceLog(file);
      final redialled = <String>[];
      app.onRedialForTest = redialled.add;

      app.localFailureForTest(mid, 4404, 'NO_PEER_LINK');
      await until(
        () => app.stateOf(mid)!.needsLink && app.deviceListNeedsReview,
      );

      expect(app.stateOf(mid)!.needsLink, isTrue);
      expect(app.deviceListNeedsReview, isTrue);
      expect(redialled, isEmpty);
    });
  });
}
