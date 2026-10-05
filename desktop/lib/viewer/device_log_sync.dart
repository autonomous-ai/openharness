import 'dart:async';
import 'dart:math';

import '../e2ee/bytes.dart';
import '../e2ee/keys.dart';
import 'device_history.dart';
import 'device_log.dart';
import 'group_sync.dart';
import 'viewer_key_store.dart';

export 'device_history.dart'
    show DeviceDepartedCopy, DeviceLogDeparted, DeviceRemovalCopy, DeviceRemovalNotice, historySentence;

/// The account's device key log, on a device with no harness CLI — the viewer's half of
/// cli/src/lib/e2ee/deviceLogSyncer.ts.
///
/// Signing in is what puts this app's key into the log ([register]); every machine the log names is
/// then pinned here with no password, and every machine trusts this app. A backend that rewrites the
/// log or rolls it back FREEZES it here: nothing more is pinned from it until someone reviews what
/// changed ([rebaseline]). A key added after this app joined the log is announced ("New device: X") and
/// stays pending until it is marked seen; what the log says is never read against what the roster holds.

/// What `GET /api/device-keys?since=` answered; null from the fetcher when there is no log to read.
typedef DeviceLogFetched = ({String acct, DevLogHead head, List<Object?> entries});

/// `POST /api/device-keys`: the new head, or a refusal (with the current head on `STALE_HEAD`).
typedef DeviceLogAppendAnswer = ({DevLogHead? head, String? error});

typedef DeviceLogFetch = Future<DeviceLogFetched?> Function(int since);
typedef DeviceLogAppend = Future<DeviceLogAppendAnswer?> Function(DevLogEntry entry);

class DeviceLogFreeze {
  const DeviceLogFreeze(this.reason, this.at, this.lastGoodHead);

  /// `fork` | `rollback` | `invalid` — see deviceLogStore.ts.
  final String reason;
  final int at;
  final DevLogHead lastGoodHead;

  Map<String, Object?> toJson() => {'reason': reason, 'at': at, 'lastGoodHead': lastGoodHead.toJson()};

  static DeviceLogFreeze? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final reason = raw['reason'], at = raw['at'], head = DevLogHead.fromJson(raw['lastGoodHead']);
    if (reason is! String || at is! int || head == null) return null;
    return DeviceLogFreeze(reason, at, head);
  }
}

class _File {
  _File(
    this.state,
    this.recent,
    this.frozen,
    this.notifiedUpTo, {
    this.joinedSeq,
    this.preLog = const [],
    this.pending = const [],
    this.announced = const [],
    this.suspended = const [],
    this.baselineSeen = true,
    this.looseRemoved = const [],
    this.reviewedSeq,
    this.owner,
    this.joining = false,
    this.departed = const [],
  });

  DevLogState? state;
  List<DevLogEntry> recent;
  DeviceLogFreeze? frozen;
  int notifiedUpTo;

  /// The head seq this app's first read ended at: only an `add` past it is news. Null in a file from
  /// before this existed (migrated on first use).
  int? joinedSeq;

  /// Keys this app trusted when it joined (or migrated): never news.
  List<String> preLog;

  /// New keys nobody has marked as seen yet.
  List<String> pending;

  /// Keys already announced — never twice.
  List<String> announced;

  /// Keys not trusted here after a fork, until [ViewerDeviceLog.rebaseline].
  List<String> suspended;

  /// false until the "Already on your account" panel was dismissed.
  bool baselineSeen;

  /// Removals applied while frozen: never in [recent], which is handed to peers as a chained tail.
  List<DevLogEntry> looseRemoved;

  /// The head seq of the list a person last reviewed ([ViewerDeviceLog.rebaseline]): a key at or
  /// before it was looked at, so a later fork never suspends it.
  int? reviewedSeq;

  /// Which sign-in by hand this file belongs to (see [ViewerDeviceLog.register]). Null in a file from
  /// before this existed.
  String? owner;

  /// true from the fresh write of a log until the first read of it reaches the head (or stops on a
  /// freeze): while set, whatever is verified is what was there at joining — none of it is news.
  bool joining;

  /// New keys removed before anyone looked (oldest first, at most [_departedKept]).
  List<DeviceLogDeparted> departed;

  Map<String, Object?> toJson() => {
    'state': state?.toJson(),
    'recent': [for (final e in recent.skip(max(0, recent.length - _recentKept))) e.toJson()],
    'frozen': frozen?.toJson(),
    'notifiedUpTo': notifiedUpTo,
    if (joinedSeq != null) ...{
      'joinedSeq': joinedSeq,
      'preLog': preLog,
      'pending': pending,
      'announced': announced,
      'baselineSeen': baselineSeen,
    },
    if (suspended.isNotEmpty) 'suspended': suspended,
    if (reviewedSeq != null) 'reviewedSeq': reviewedSeq,
    if (owner != null) 'owner': owner,
    if (joining) 'joining': true,
    if (looseRemoved.isNotEmpty)
      'looseRemoved': [for (final e in looseRemoved.skip(max(0, looseRemoved.length - _recentKept))) e.toJson()],
    if (departed.isNotEmpty)
      'departed': [for (final d in departed.skip(max(0, departed.length - _departedKept))) d.toJson()],
  };

  static List<String> _strings(Object? raw) => raw is List ? [for (final v in raw) if (v is String) v] : <String>[];

  static _File parse(Object? raw) {
    if (raw is! Map) return _File(null, [], null, 0);
    final recent = raw['recent'];
    final loose = raw['looseRemoved'];
    return _File(
      DevLogState.fromJson(raw['state']),
      recent is List ? recent.map(DevLogEntry.parse).whereType<DevLogEntry>().toList() : [],
      DeviceLogFreeze.fromJson(raw['frozen']),
      raw['notifiedUpTo'] is int ? raw['notifiedUpTo'] as int : 0,
      joinedSeq: raw['joinedSeq'] is int && (raw['joinedSeq'] as int) >= 0 ? raw['joinedSeq'] as int : null,
      preLog: _strings(raw['preLog']),
      pending: _strings(raw['pending']),
      announced: _strings(raw['announced']),
      suspended: _strings(raw['suspended']),
      baselineSeen: raw['baselineSeen'] is bool ? raw['baselineSeen'] as bool : true,
      looseRemoved: loose is List ? loose.map(DevLogEntry.parse).whereType<DevLogEntry>().toList() : [],
      reviewedSeq: raw['reviewedSeq'] is int && (raw['reviewedSeq'] as int) >= 0 ? raw['reviewedSeq'] as int : null,
      owner: raw['owner'] is String && (raw['owner'] as String).isNotEmpty ? raw['owner'] as String : null,
      joining: raw['joining'] == true,
      departed: DeviceLogDeparted.listFromJson(raw['departed']),
    );
  }
}

const _recentKept = 64;

/// How many departed keys are kept ([_File.departed]); the oldest goes first.
const _departedKept = 32;

/// How long after a sign-in by hand a read of another account may start the log over: past it, with no
/// read of that account yet, the backend has had the time to pick when it says so.
const _resetWindowMs = 10 * 60 * 1000;
const _appendAttempts = 5;
const _pages = 20;

/// How many other accounts' logs are kept ([ViewerKeyStore.deviceLogArchive]); the oldest goes first.
const _archivedKept = 4;

/// How a sign-in id given to a session from before sign-in ids existed starts: nobody saw that
/// sign-in being made here, so it may take a file over but never starts one over.
const _adoptedSignIn = 'adopted:';

/// One device on the account, for the Devices list.
class DeviceLogRow {
  const DeviceLogRow(
    this.member, {
    required this.fingerprint,
    required this.self,
    this.pending = false,
    this.suspended = false,
  });

  final DevLogMember member;
  final String fingerprint;
  final bool self;

  /// Joined after this app did and nobody marked it as seen.
  final bool pending;

  /// Not trusted here after a fork, until the list is reviewed.
  final bool suspended;
}

class DeviceLogListing {
  const DeviceLogListing({
    required this.members,
    required this.frozen,
    required this.frozenPeers,
    this.pending = const [],
    this.suspended = const [],
    this.joinedSeq = 0,
    this.baseline = const [],
    this.baselineSeen = true,
    this.departed = const [],
  });

  static const empty = DeviceLogListing(members: [], frozen: null, frozenPeers: []);

  final List<DeviceLogRow> members;
  final DeviceLogFreeze? frozen;

  /// Machines whose own copy of the log is frozen, as their last `group_sync` said.
  final List<String> frozenPeers;

  /// Keys that joined after this app did and nobody marked as seen.
  final List<String> pending;

  /// Keys not trusted here after a fork, until the list is reviewed.
  final List<String> suspended;
  final int joinedSeq;

  /// The keys that were on the account before this app joined (the "Already on your account" list):
  /// active, not this app, at or before [joinedSeq] — plus any key this app already trusted at joining
  /// whose entry came after it (a log cut short at the first read must not hide it).
  final List<String> baseline;

  /// false until the "already on your account" list was acknowledged.
  final bool baselineSeen;

  /// New keys removed before anyone marked them as seen (oldest first): flagged until [ViewerDeviceLog.dismiss]
  /// names them (`pub`, or `pubs`) or clears every one.
  final List<DeviceLogDeparted> departed;
}

/// The newest hashes a `group_sync` carries, so a fork can be located.
const _gossipHashes = 64;

/// Where a peer's log first differs from [state]: the first seq, in the window of hashes the peer sent
/// (`theirs['hashes']`, the last of which is `theirs['head']`), whose hash is not ours — only when the
/// entry before it matches (or it is the first), so the split is proven rather than guessed. Null when
/// the peer sent no usable hashes, nothing in the shared window differs, or the split lies before it.
int? devLogDivergence(DevLogState state, Object? theirs) {
  if (theirs is! Map) return null;
  final hashes = theirs['hashes'];
  if (hashes is! List || hashes.isEmpty || hashes.length > 4 * _gossipHashes) return null;
  final window = <int, String>{};
  var prev = 0;
  for (final h in hashes) {
    if (h is! Map) return null;
    final seq = h['seq'], hash = h['hash'];
    if (seq is! int || seq < 1 || hash is! String || hash.length > 128) return null;
    if (prev != 0 && seq != prev + 1) return null;
    prev = seq;
    window[seq] = hash;
  }
  // The window must end where the peer's head is, or it describes some other log.
  final head = DevLogHead.fromJson(theirs['head']);
  if (head == null || head.seq != prev || head.hash != window[prev]) return null;
  final first = window.keys.reduce(min);
  for (final e in window.entries) {
    if (e.key > state.head.seq || state.hashes[e.key - 1] == e.value) continue;
    if (e.key == 1) return 1;
    if (e.key == first) return null;
    return state.hashes[e.key - 2] == window[e.key - 1] ? e.key : null;
  }
  return null;
}


/// What a step under the file lock found to tell the app — said once the lock is let go, since a
/// listener may well read the log again (and signing out waits on the app).
class _Effects {
  final announce = <DevLogMember>[];
  final removed = <DeviceRemovalNotice>[];
  bool signOut = false;
  bool changed = false;
}

class DeviceLogRebaseline {
  const DeviceLogRebaseline(this.head, this.added, this.removed) : logChanged = false, otherAccount = false;

  /// The backend's list is no longer the one that was previewed: nothing was done. Branch on
  /// [logChanged]; [head], [added] and [removed] are empty placeholders then.
  const DeviceLogRebaseline.changed()
    : head = const DevLogHead(0, ''),
      added = const [],
      removed = const [],
      logChanged = true,
      otherAccount = false;

  /// The backend's list is another account's while the live log is the one of the sign-in this app is
  /// under: nothing was done — only a sign-in switches accounts. Branch on [otherAccount]; [head],
  /// [added] and [removed] are empty placeholders then.
  const DeviceLogRebaseline.otherAccount()
    : head = const DevLogHead(0, ''),
      added = const [],
      removed = const [],
      logChanged = false,
      otherAccount = true;

  final DevLogHead head;
  final List<DevLogMember> added;
  final List<DevLogMember> removed;
  final bool logChanged;
  final bool otherAccount;
}

class ViewerDeviceLog {
  ViewerDeviceLog({
    required this.keys,
    required this.fetch,
    required this.append,
    required this.label,
    this.onAnnounce,
    this.onRemoved,
    this.onSignedOut,
    this.onChanged,
    int Function()? now,
    Future<void> Function(Duration)? sleep,
  }) : _now = now ?? (() => DateTime.now().millisecondsSinceEpoch),
       _sleep = sleep ?? Future.delayed;

  final ViewerKeyStore keys;
  final DeviceLogFetch fetch;
  final DeviceLogAppend append;

  /// How this app calls itself in the account's list of devices.
  final String Function() label;

  /// A key joined the account after this app did: "New device: X".
  final void Function(DevLogMember member)? onAnnounce;

  /// A device was taken out of the account after this app joined it (not by this app).
  final void Function(DeviceRemovalNotice notice)? onRemoved;

  /// This app's own key was removed from the account: it is signed out.
  final Future<void> Function()? onSignedOut;

  /// The list, or whether it is frozen, changed.
  final void Function()? onChanged;

  final int Function() _now;
  final Future<void> Function(Duration) _sleep;
  final Map<String, bool> _frozenPeers = {};
  Future<void>? _refreshing;
  final _random = Random();
  final Set<String> _removing = {};

  /// Every entry fetched for the history so far (seq 1..n), this run only: never written to disk.
  List<DevLogEntry> _histCache = [];
  String? _histAcct;

  /// Set while a sign-in by hand registers: this app's old key being removed is then expected, and is
  /// replaced rather than signed out over.
  bool _signingInAgain = false;
  bool _signedOut = false;

  /// Set while [register] runs.
  bool _registering = false;

  /// Moves on with each [beginSignIn]: a read that began after one, outside [register], ends what it
  /// set — a sign-in by hand that never registers must not keep this app's own removal from signing
  /// it out for good.
  int _signInRound = 0;

  /// Which sign-in by hand this app is under ([ViewerKeyStore.signInEpoch]), once known: minted by
  /// [beginSignIn] (or [register] with `freshSignIn`), never anything the backend sends (not the
  /// profile's id either).
  String? _epoch;

  /// Set by [beginSignIn] until [register] takes it: a sign-in by hand waiting to be registered.
  bool _freshPending = false;

  /// The write of the sign-in id [beginSignIn] minted; [register] waits for it.
  Future<void>? _epochSaving;

  /// This app's key is gone from the log: sign out, once.
  Future<void> _signOut() async {
    if (_signedOut) return;
    _signedOut = true;
    await onSignedOut?.call();
  }

  Future<_File> _read() async => _File.parse(await keys.deviceLog());
  Future<void> _write(_File f) => keys.writeDeviceLog(f.toJson());
  Future<String> _selfPub() async => b64e((await keys.identity()).pub);

  /// Read the log and put this app's key into it. Never throws.
  ///
  /// [freshSignIn]: the person has just signed in, by hand. A key the log removed is then spent, not
  /// a reason to sign out — this app may have been signed out by the removal before it could read it
  /// (a revoked session answers 401 first), and signing in again must not end in a second sign-out.
  /// A stored session (the app opening) under a removed key signs out, as it always did.
  ///
  /// A sign-in by hand is also what lets this app's copy of the log move to another account (keeping
  /// the one it leaves, to restore if it comes back) — for a short while after it ([_resetWindowMs]).
  /// Its id is minted by [beginSignIn], which [register] calls itself when it was not called before.
  Future<void> register({bool freshSignIn = false}) async {
    if (freshSignIn && !_freshPending) beginSignIn(fresh: true);
    final fresh = _freshPending;
    _freshPending = false;
    _signingInAgain = fresh;
    _signedOut = false;
    _registering = true;
    try {
      await _epochSaving;
      await refresh();
      var identity = await keys.identity();
      var pub = b64e(identity.pub);
      final name = _clip(label());
      for (var attempt = 0; attempt < _appendAttempts; attempt++) {
        final file = await _read();
        final state = file.state;
        if (state == null || file.frozen != null) return;
        if (state.removed.contains(pub)) {
          if (!fresh) {
            await _signOut();
            return;
          }
          await keys.forgetIdentity();
          await refresh();
          identity = await keys.identity();
          pub = b64e(identity.pub);
          continue;
        }
        final mine = state.active[pub];
        if (mine != null && (mine.label == name || mine.kind != 'viewer')) return;
        final entry = await signDevLogEntry(
          nextDevLogEntry(state, op: 'add', pub: pub, kind: 'viewer', machineId: '', label: name, signer: pub, at: _now()),
          identity,
        );
        final answer = await append(entry);
        if (answer == null) return;
        if (answer.error == null) {
          await refresh();
          return;
        }
        if (answer.error != 'STALE_HEAD') return;
        await refresh();
        await _sleep(Duration(milliseconds: 200 + _random.nextInt(800) * (attempt + 1)));
      }
    } catch (_) {
      // The next sign-in, resume or push tries again.
    } finally {
      _signingInAgain = false;
      _registering = false;
    }
  }

  /// The app knows who is signed in — call it synchronously, before anything that reads the log (a
  /// restored pane, a machine list, a connection) can start, then [register]. [fresh]: the person
  /// signed in by hand just now (`DirectAuth.consumeFreshSignIn()`); its id is minted here, so a read
  /// already on its way judges by this sign-in, not the one before. A stored session (the app opening)
  /// is not fresh: nothing is minted.
  void beginSignIn({required bool fresh}) {
    _signedOut = false;
    _freshPending = fresh;
    // A removal of this app's old key read before [register] runs is then expected, not a sign-out —
    // for the read that comes first ([_doRefresh] ends it), or until [register] takes over.
    _signingInAgain = fresh;
    _signInRound++;
    if (!fresh) return;
    final previous = _epoch;
    final minted = _mintEpoch();
    _epoch = minted;
    _epochSaving = keys.writeSignInEpoch(minted).then(
      (_) {},
      onError: (Object _) {
        // Not kept, not used: after a restart the file would be another sign-in's than the store's.
        if (_epoch == minted) _epoch = previous;
      },
    );
  }

  /// Read and verify whatever the log gained. Concurrent calls share one read. Never throws.
  Future<void> refresh() => _refreshing ??= _doRefresh().catchError((Object _) {}).whenComplete(() => _refreshing = null);

  /// The tail of the queue every read-modify-write of the file waits in. A refresh, a peer's tail, a
  /// dismissal and a review each read the file, change it and write it back; two of them interleaved
  /// would write the older read over the newer one — a head rolled back, an announcement forgotten
  /// and made twice, a dismissal undone.
  Future<void> _fileQueue = Future.value();

  /// Run [body] alone against the file — within this instance: two instances over one store (two web
  /// tabs) do not see each other's lock and can still interleave. [body] must not wait on anything
  /// that takes the lock itself (and nothing the app is told runs inside it: see [_Effects]).
  Future<T> _locked<T>(Future<T> Function() body) {
    final before = _fileQueue;
    final done = Completer<void>();
    _fileQueue = done.future;
    return before.then((_) => body()).whenComplete(() => done.complete());
  }

  /// Tell the app what a step under the lock decided, once the lock is let go.
  Future<void> _fire(_Effects e) async {
    for (final m in e.announce) {
      onAnnounce?.call(m);
    }
    for (final n in e.removed) {
      onRemoved?.call(n);
    }
    if (e.signOut) await _signOut();
    if (e.changed) onChanged?.call();
  }

  /// A sign-in id: random, then `@` and when it was made (ms) — see [_mayStartOver].
  String _mintEpoch() =>
      '${[for (var i = 0; i < 16; i++) _secure.nextInt(256).toRadixString(16).padLeft(2, '0')].join()}@${_now()}';
  static final _secure = Random.secure();

  /// Whether [local] — a sign-in by hand the file is not yet the log of — may start it over for another
  /// account: never an adopted one, and only shortly after it was made. A backend that holds the log
  /// back after a sign-in must not keep that door open, to name another account days later.
  bool _mayStartOver(String local) {
    if (local.startsWith(_adoptedSignIn)) return false;
    final made = RegExp(r'@(\d{1,15})$').firstMatch(local);
    if (made == null) return false;
    return (_now() - int.parse(made.group(1)!)).abs() <= _resetWindowMs;
  }

  /// Whether [file] is the log of the sign-in this app is under (or that cannot be told). Until a read
  /// of it under a new sign-in it may be the account just left: what a machine gossips is not judged
  /// against it — a machine of the new account would read as a fork of the old one.
  Future<bool> _ownsFile(_File file) async {
    final local = await _localOwner();
    return local == null || file.owner == local;
  }

  /// The sign-in by hand this app is under; a session from before sign-in ids existed is given one,
  /// adopted ([_adoptedSignIn]). Null when the store cannot be read.
  Future<String?> _localOwner() async {
    if (_epoch case final epoch?) return epoch;
    try {
      final stored = await keys.signInEpoch();
      if (stored != null && stored.isNotEmpty) return _epoch ??= stored;
      final adopted = '$_adoptedSignIn${_mintEpoch()}';
      await keys.writeSignInEpoch(adopted);
      return _epoch ??= adopted;
    } catch (_) {
      return null;
    }
  }

  /// The first read of the log is over, however it ended: what is verified from here on is news.
  Future<void> _endJoin() => _locked(() async {
    final file = await _read();
    if (!file.joining) return;
    file.joining = false;
    await _write(file);
  });

  /// The logs of accounts this app was signed in to before, by account id.
  Future<Map<String, Object?>> _archived() async {
    try {
      return await keys.deviceLogArchive();
    } catch (_) {
      return {};
    }
  }

  /// Keep [file] — the log of an account this app is leaving — to restore if it comes back. Under the lock.
  Future<void> _archiveIn(_File file) async {
    final acct = file.state?.acct;
    if (acct == null) return;
    final all = await _archived()
      ..remove(acct);
    all[acct] = file.toJson();
    while (all.length > _archivedKept) {
      all.remove(all.keys.first);
    }
    await keys.writeDeviceLogArchive(all);
  }

  /// The kept log of [acct], made the live file (this sign-in's: [owner]) and only then taken out of
  /// the archive — a crash in between leaves it in both, never in neither. Null when there is none.
  /// Under the lock.
  Future<_File?> _restoreIn(String acct, String? owner) async {
    final kept = _File.parse((await _archived())[acct]);
    if (kept.state?.acct != acct) return null;
    kept.owner = owner ?? kept.owner;
    await _carrySuspensionsIn(kept);
    await _write(kept);
    final all = await _archived()
      ..remove(acct);
    await keys.writeDeviceLogArchive(all);
    return kept;
  }

  /// [file], with every key a fork suspended in another account's kept log, and active in this one,
  /// suspended (and new) here as well: it is not trusted either way, so the list says so — and "It's
  /// mine" lifts it, everywhere (a review of this list does not: it never showed that suspension).
  /// Under the lock.
  Future<void> _carrySuspensionsIn(_File file) async {
    final state = file.state;
    if (state == null) return;
    final selfPub = await _selfPub();
    final carried = [
      for (final k in await _archivedSuspended())
        if (state.active.containsKey(k) && k != selfPub && !file.suspended.contains(k)) k,
    ];
    if (carried.isEmpty) return;
    file
      ..suspended = [...file.suspended, ...carried]
      ..pending = {...file.pending, ...carried}.toList();
  }

  /// A suspension lifted here holds for every kept account too: none of them keeps [pubs] out. Under
  /// the lock.
  Future<void> _unsuspendArchivedIn(Iterable<String> pubs) async {
    final lift = pubs.toSet();
    final all = await _archived();
    var changed = false;
    for (final e in all.entries.toList()) {
      final f = _File.parse(e.value);
      if (!f.suspended.any(lift.contains)) continue;
      f.suspended = [for (final k in f.suspended) if (!lift.contains(k)) k];
      all[e.key] = f.toJson();
      changed = true;
    }
    if (changed) await keys.writeDeviceLogArchive(all);
  }

  /// [gone], just taken out by [e], kept flagged: it was new here and nobody had looked at it yet.
  DeviceLogDeparted _departedOf(DevLogMember gone, DevLogEntry e, String signerLabel) => DeviceLogDeparted(
    pub: gone.pub,
    label: gone.label,
    kind: gone.kind,
    machineId: gone.machineId,
    fingerprint: fingerprint(b64d(gone.pub)),
    addedAt: gone.addedAt,
    removedAt: e.at,
    removedBy: e.signer,
    removedByLabel: signerLabel,
    selfRemoved: e.signer == gone.pub,
  );

  /// [prev] plus [more] (a key once, at its newest), the oldest dropped past [_departedKept].
  List<DeviceLogDeparted> _withDeparted(List<DeviceLogDeparted> prev, List<DeviceLogDeparted> more) {
    if (more.isEmpty) return prev;
    final pubs = {for (final d in more) d.pub};
    final all = [for (final d in prev) if (!pubs.contains(d.pub)) d, ...more];
    return all.skip(max(0, all.length - _departedKept)).toList();
  }

  /// The kept log of [acct], left in the archive; null when there is none.
  Future<_File?> _archivedFileIn(String acct) async {
    final kept = _File.parse((await _archived())[acct]);
    return kept.state?.acct == acct ? kept : null;
  }

  /// What a review ([rebaseline]) takes out that was new here and never looked at: a key pending in
  /// [base] that the reviewed list does not keep — and a key the list added and removed again at
  /// entries this app never verified (while it was frozen) — stays flagged as departed.
  List<DeviceLogDeparted> _reviewDeparted(
    _File base,
    DevLogState next,
    List<DevLogEntry> parsed,
    List<DevLogMember> removed,
    String selfPub,
    Set<String> pre,
  ) {
    final verified = base.state;
    if (verified == null) return [];
    final known = <String, ({String label, String kind})>{};
    final adds = <String, DevLogEntry>{};
    final out = <String, DeviceLogDeparted>{};
    for (final e in [...parsed]..sort((a, b) => a.seq.compareTo(b.seq))) {
      if (e.op == 'add') {
        if (!known.containsKey(e.pub)) adds[e.pub] = e; // added (not renamed)
        known[e.pub] = (label: e.label, kind: e.kind);
        continue;
      }
      final was = removed.where((m) => m.pub == e.pub).firstOrNull;
      final add = adds[e.pub];
      final label = known[e.pub]?.label;
      known.remove(e.pub);
      if (e.pub == selfPub || next.active[e.pub] != null) continue;
      // Added at an entry this app never verified, and gone again before it could see it.
      final unseen = was == null &&
          add != null &&
          (add.seq > verified.hashes.length || verified.hashes[add.seq - 1] != devLogHash(add)) &&
          !pre.contains(e.pub);
      if ((was != null && base.pending.contains(e.pub)) || unseen) {
        final member = was ??
            DevLogMember(pub: e.pub, kind: add!.kind, machineId: add.machineId, label: label ?? add.label, addedAt: add.at, seq: add.seq);
        out[e.pub] = _departedOf(member, e, known[e.signer]?.label ?? '');
      }
    }
    // Pending here, and not on the reviewed list at all (a branch the backend no longer serves).
    for (final m in removed) {
      if (out.containsKey(m.pub) || m.pub == selfPub || !base.pending.contains(m.pub)) continue;
      out[m.pub] = DeviceLogDeparted(
        pub: m.pub,
        label: m.label,
        kind: m.kind,
        machineId: m.machineId,
        fingerprint: fingerprint(b64d(m.pub)),
        addedAt: m.addedAt,
        removedAt: _now(),
        removedBy: '',
        removedByLabel: '',
        selfRemoved: false,
      );
    }
    return [...out.values];
  }

  /// Every key a fork suspended in another account's kept log: no other account's log brings it back.
  Future<Set<String>> _archivedSuspended() async => {
    for (final f in (await _archived()).values) ..._File.parse(f).suspended,
  };

  Future<_File> _marks() => _locked(_marksIn);

  /// [_marks], for a caller already holding the lock: the file, with the joined point filled in for one
  /// written before it existed (or by a client that dropped it) — everything up to what was already
  /// announced is then known, as it was.
  Future<_File> _marksIn() async {
    final file = await _read();
    if (file.state == null || file.joinedSeq != null) return file;
    file.joinedSeq = file.notifiedUpTo;
    file.preLog = (await _knownPubs()).toList();
    file.pending = [];
    file.announced = [];
    file.baselineSeen = true;
    await _write(file);
    return file;
  }

  Future<void> _doRefresh() async {
    // A sign-in by hand waiting for [register]: this read is the one its old key's removal is expected
    // in. After it, with no [register] under way, a removal of this app's key signs out again.
    final round = _signInRound;
    final expecting = _signingInAgain;
    try {
      await _readPages();
    } finally {
      // However the read ended — at the head, on a freeze, or cut short (no answer, the page cap) — the
      // first read of a log is over: what is verified from here on is news. Held open, a backend that
      // stalls the second page would have every key it adds later taken for one there at joining.
      await _endJoin();
      if (expecting && !_registering && round == _signInRound) _signingInAgain = false;
    }
  }

  Future<void> _readPages() async {
    await _marks();
    var bootstrap = ((await _read()).state?.head.seq ?? 0) == 0;
    for (var page = 0; page < _pages; page++) {
      final seen = (await _read()).state;
      final since = seen?.head.seq ?? 0;
      final got = await fetch(since);
      if (got == null) return;
      // A head that is not a position is the backend lying (or broken): nothing to verify it against.
      if (!_isPosition(got.head.seq)) return;
      final effects = _Effects();
      // Whether to read another page.
      final more = await _locked(() async {
        var file = await _marksIn();
        final local = await _localOwner();
        var reset = file.state == null;
        if (!reset) {
          final signedInAgain = local != null && file.owner != local;
          if (file.state!.acct != got.acct) {
            // Another account only after a sign-in by hand here. Otherwise it is the backend saying so
            // — and starting over would clear every mark a fork put on the list, the real log then
            // adopted whole.
            if (local == null || !signedInAgain || !_mayStartOver(local)) {
              await _freezeIn(file, 'invalid', effects);
              return false;
            }
            reset = true;
          } else if (signedInAgain) {
            // Signed in again to the same account: the same list, now this sign-in's.
            file.owner = local;
            await _write(file);
          }
        }
        if (reset) {
          if (file.state != null) await _archiveIn(file);
          // Back to an account this app was signed in to before: its log as verified then, and every
          // mark on it (frozen, suspended, pending), go on from where they were.
          final kept = await _restoreIn(got.acct, local);
          if (kept != null) {
            bootstrap = (kept.state?.head.seq ?? 0) == 0;
            return true;
          }
          // First read, or signed in to another account here: that account's log starts from nothing.
          // `joinedSeq` starts at 0 and follows the head of each page this app VERIFIES ([_acceptIn]):
          // never the head the backend merely claims, or it could park it far ahead and have every key
          // it forges below that adopted without a word. `preLog` is what was trusted already.
          file = _File(
            DevLogState.empty(got.acct),
            [],
            null,
            0,
            joinedSeq: 0,
            preLog: (await _knownPubs()).toList(),
            baselineSeen: false,
            joining: true,
            owner: local,
          );
          await _write(file);
          bootstrap = true;
          if (got.head.seq == 0) return false;
          if (since != 0) return true;
        } else if (seen == null || seen.acct != file.state!.acct || seen.head != file.state!.head) {
          // The log moved here while this page was on its way (a peer handed over its tail): the page
          // answers a question nobody is asking any more — judged against the newer head it would read
          // as a rollback, or as entries out of order. Ask again from where the log is now.
          return true;
        }
        final state = file.state!;
        if (file.frozen != null) {
          await _looseRemovalsIn(file, got.entries, effects);
          return false;
        }
        if (got.head.seq < state.head.seq) {
          await _freezeIn(file, 'rollback', effects);
          return false;
        }
        if (got.head.seq == state.head.seq) {
          if (got.head.hash != state.head.hash) await _freezeIn(file, 'fork', effects);
          return false;
        }
        if (got.entries.isEmpty) {
          await _freezeIn(file, 'invalid', effects);
          return false;
        }
        if (!await _acceptIn(file, got.entries, bootstrap, effects)) return false;
        return file.state!.head.seq < got.head.seq;
      });
      await _fire(effects);
      if (!more) return;
    }
  }

  /// [keys] cut to the ones still active — the marks never outlive the key.
  List<String> _prune(List<String> keys, DevLogState state) => [
    for (final k in keys.toSet())
      if (state.active.containsKey(k)) k,
  ];

  /// What each active key in [state] is called now, to be walked forward through entries.
  Map<String, ({String label, String kind})> _knownOf(DevLogState state) => {
    for (final m in state.active.values) m.pub: (label: m.label, kind: m.kind),
  };

  /// The notice for a `remove`, or null when there is nothing to say: this app's own removal, its own
  /// key, or a removal from before it joined. [known] says what each key was called, and what kind it
  /// was, BEFORE this removal — the remove entry's own label and kind are the signer's to pick, so they
  /// are never what the person is told.
  DeviceRemovalNotice? _removalNotice(
    DevLogEntry e,
    int joinedSeq,
    String selfPub,
    List<String> pending,
    Map<String, ({String label, String kind})> known,
  ) {
    if (e.op != 'remove' || e.seq <= joinedSeq || e.pub == selfPub || e.signer == selfPub) return null;
    final was = known[e.pub];
    return DeviceRemovalNotice(
      pub: e.pub,
      label: was?.label ?? e.label,
      kind: was?.kind ?? e.kind,
      fingerprint: fingerprint(b64d(e.pub)),
      signer: e.signer,
      signerLabel: known[e.signer]?.label ?? '',
      signerFingerprint: fingerprint(b64d(e.signer)),
      signerPending: pending.contains(e.signer),
      selfRemoved: e.signer == e.pub,
      at: _now(),
    );
  }

  /// The entries a peer handed over that this app lacks, applied under the lock — judged against the
  /// head the file has by then, which a refresh may have moved since the peer was heard.
  Future<bool> _acceptFromPeer(List<Object?> entries) async {
    final effects = _Effects();
    final ok = await _locked(() async {
      final file = await _marksIn();
      final state = file.state;
      if (state == null || file.frozen != null) return false;
      final missing = [
        for (final e in entries)
          if ((DevLogEntry.parse(e)?.seq ?? 0) > state.head.seq) e,
      ];
      if (missing.isEmpty) return true;
      return _acceptIn(file, missing, false, effects);
    });
    await _fire(effects);
    return ok;
  }

  /// Apply [entries] to [file] and write it; under the lock. What the app is told goes in [effects].
  Future<bool> _acceptIn(_File file, List<Object?> entries, bool bootstrap, _Effects effects) async {
    // While the first read of this log is open (a peer's tail can arrive between its pages too):
    // whatever is verified before it reaches the head is what was there at joining.
    final joining = file.joining;
    final DevLogApplied applied;
    try {
      applied = await applyDevLogEntries(file.state!, entries);
    } on DevLogError catch (err) {
      await _freezeIn(file, err.code == 'BROKEN_CHAIN' || err.code == 'OUT_OF_ORDER' ? 'fork' : 'invalid', effects);
      return false;
    }
    final selfPub = await _selfPub();
    // While joining, everything this page verified is what was there before: the joined point moves up
    // to the verified head (never past it), and none of it is news.
    final joinedSeq = joining ? applied.state.head.seq : file.joinedSeq ?? 0;
    final pre = file.preLog.toSet();
    final parsed = entries.map(DevLogEntry.parse).whereType<DevLogEntry>().toList();
    // News is decided from the log alone: an `add` past the point this app joined, for a key it did not
    // already trust then. What the roster or the pins hold now says nothing — a key can reach them
    // (over `group_sync`) before this app reads the entry that adds it.
    final news = [
      for (final m in applied.added)
        if (m.seq > joinedSeq && m.pub != selfPub && !pre.contains(m.pub)) m,
    ];
    final pendingNow = [...file.pending, for (final m in news) m.pub];
    // Walk the entries in order: a removal is described by what the key was called when it was removed.
    final known = _knownOf(file.state!);
    final notices = <DeviceRemovalNotice>[];
    final gone = {for (final m in applied.removed) m.pub: m};
    final departed = <DeviceLogDeparted>[];
    for (final e in [...parsed]..sort((a, b) => a.seq.compareTo(b.seq))) {
      if (e.op == 'add') {
        known[e.pub] = (label: e.label, kind: e.kind);
      } else {
        final n = _removalNotice(e, joinedSeq, selfPub, pendingNow, known);
        if (n != null) notices.add(n);
        // A new key nobody looked at, gone again (even within this page): it stays flagged.
        final member = gone[e.pub];
        if (member != null && pendingNow.contains(e.pub) && e.pub != selfPub) {
          departed.add(_departedOf(member, e, known[e.signer]?.label ?? ''));
        }
        known.remove(e.pub);
      }
    }
    final toAnnounce = [
      for (final m in news)
        if (!file.announced.contains(m.pub)) m,
    ];
    // A key taken into the "already on your account" list after that list was acknowledged: show it.
    if (joining && applied.added.any((m) => m.pub != selfPub)) file.baselineSeen = false;
    file
      ..state = applied.state
      ..joinedSeq = joinedSeq
      ..recent = [...file.recent, ...parsed]
      ..frozen = null
      ..notifiedUpTo = applied.state.head.seq
      ..pending = _prune(pendingNow, applied.state)
      ..announced = _prune([...file.announced, for (final m in toAnnounce) m.pub], applied.state)
      ..suspended = _prune(file.suspended, applied.state)
      ..departed = _withDeparted(file.departed, departed);
    await _carrySuspensionsIn(file);
    await _write(file);
    await _trust(bootstrap ? applied.state.active.values.toList() : [...applied.added, ...applied.relabeled]);
    for (final m in applied.removed) {
      await _drop(m);
    }
    effects.announce.addAll(toAnnounce);
    effects.removed.addAll(notices);
    if (applied.state.removed.contains(selfPub) && !_signingInAgain) effects.signOut = true;
    effects.changed = true;
    return true;
  }

  /// What this app trusts right now — its pins and its trust group — snapshotted once, when it joins
  /// the log (or migrates), so what it already knew then is never news.
  Future<Set<String>> _knownPubs() async {
    final roster = GroupRoster.parse(await keys.groupRoster());
    return {
      for (final p in await keys.peers()) b64e(p.pub),
      for (final m in roster.members) m.pub,
    };
  }

  /// Pin every machine the log adds, and put it in the trust group this app swaps with machines, so
  /// a machine that predates the log hears of it too. A removal the group made first stands.
  Future<void> _trust(List<DevLogMember> members) async {
    final selfPub = await _selfPub();
    final stored = GroupRoster.parse(await keys.groupRoster());
    final inRoster = {for (final m in stored.members) m.pub};
    final tombstoned = {for (final t in stored.removed) if (!inRoster.contains(t.pub)) t.pub};
    final suspended = await suspendedPubs();
    final now = _now();
    final adopt = [
      for (final m in members)
        if (m.pub != selfPub && !tombstoned.contains(m.pub) && !suspended.contains(m.pub)) m,
    ];
    final incoming = [
      for (final m in adopt)
        ?GroupMember.tryParse({
          'pub': m.pub,
          'kind': m.kind,
          'label': m.label,
          'at': min(m.addedAt, now),
          if (m.machineId.isNotEmpty) 'machineId': m.machineId,
        }),
    ];
    if (incoming.isNotEmpty) {
      final merged = mergeGroupRoster(stored, GroupRoster(incoming, const []), selfPub);
      await keys.writeGroupRoster(merged.roster.toJson());
    }
    for (final m in adopt) {
      if (m.kind != 'machine') continue;
      final current = await keys.peer(m.machineId);
      if (current != null && b64e(current.pub) == m.pub) continue;
      await keys.pin(m.machineId, b64d(m.pub), label: m.label);
    }
    // A removal the group made before the log existed must not be undone by the log. Not awaited:
    // this runs inside a read of the log, and a removal reads the log again when it lands — waiting
    // for it here would wait for this very read to finish.
    final state = (await _read()).state;
    if (state != null && state.active[selfPub] != null) {
      for (final pub in tombstoned) {
        if (state.active[pub] != null && !_removing.contains(pub)) unawaited(remove(pub));
      }
    }
  }

  Future<void> _drop(DevLogMember m) async {
    final selfPub = await _selfPub();
    final stored = GroupRoster.parse(await keys.groupRoster());
    final merged = mergeGroupRoster(stored, GroupRoster(const [], [GroupTombstone(m.pub, _now())]), selfPub);
    await keys.writeGroupRoster(merged.roster.toJson());
    if (m.kind == 'machine') {
      final current = await keys.peer(m.machineId);
      if (current != null && b64e(current.pub) == m.pub) await keys.unlink(m.machineId);
    }
  }

  /// While frozen, a removal still counts — if a key this app trusts signed it. A key a fork suspended
  /// is not trusted here, so what it signs does not count either.
  /// Under the lock.
  Future<void> _looseRemovalsIn(_File file, List<Object?> entries, _Effects effects) async {
    final state = file.state;
    if (state == null) return;
    final selfPub = await _selfPub();
    final joinedSeq = file.joinedSeq ?? 0;
    final suspended = file.suspended.toSet();
    final known = _knownOf(state);
    final loose = <DevLogEntry>[];
    final notices = <DeviceRemovalNotice>[];
    final departed = <DeviceLogDeparted>[];
    for (final raw in entries) {
      final e = DevLogEntry.parse(raw);
      if (e == null || e.op != 'remove' || state.active[e.signer] == null || suspended.contains(e.signer)) continue;
      final target = state.active[e.pub];
      if (target == null) continue;
      if (!await verifySignature(b64d(e.signer), devLogMessage(e), b64d(e.sig))) continue;
      final notice = _removalNotice(e, joinedSeq, selfPub, file.pending, known);
      if (file.pending.contains(e.pub) && e.pub != selfPub) departed.add(_departedOf(target, e, known[e.signer]?.label ?? ''));
      state.active.remove(e.pub);
      state.removed.add(e.pub);
      await _drop(target);
      loose.add(e);
      if (notice != null) notices.add(notice);
    }
    if (loose.isEmpty) return;
    file
      ..looseRemoved = [...file.looseRemoved, ...loose]
      ..pending = _prune(file.pending, state)
      ..announced = _prune(file.announced, state)
      ..suspended = _prune(file.suspended, state)
      ..departed = _withDeparted(file.departed, departed);
    await _write(file);
    effects.removed.addAll(notices);
    effects.changed = true;
  }

  Future<void> _freeze(String reason) async {
    final effects = _Effects();
    await _locked(() async => _freezeIn(await _read(), reason, effects));
    await _fire(effects);
  }

  /// [_freeze], for a caller already holding the lock.
  Future<void> _freezeIn(_File file, String reason, _Effects effects) async {
    if (file.frozen != null || file.state == null) return;
    file.frozen = DeviceLogFreeze(reason, _now(), file.state!.head);
    file.joining = false;
    await _write(file);
    effects.changed = true;
  }

  /// Remove a device from the account, signed by this app. It stops being trusted here at once.
  /// Null when done, else why not.
  Future<String?> remove(String pub) async {
    _removing.add(pub);
    try {
      return await _removeOnce(pub);
    } finally {
      _removing.remove(pub);
    }
  }

  Future<String?> _removeOnce(String pub) async {
    final identity = await keys.identity();
    final selfPub = b64e(identity.pub);
    for (var attempt = 0; attempt < _appendAttempts; attempt++) {
      final file = await _read();
      final state = file.state;
      if (state == null) return 'UNAVAILABLE';
      final target = state.active[pub];
      if (target == null) return 'NOT_IN_LOG';
      if (state.active[selfPub] == null) return 'NOT_ACTIVE';
      await _drop(target);
      final entry = await signDevLogEntry(
        nextDevLogEntry(state, op: 'remove', pub: pub, kind: target.kind, machineId: target.machineId,
            label: target.label, signer: selfPub, at: _now()),
        identity,
      );
      final answer = await append(entry);
      if (answer == null) return 'UNAVAILABLE';
      if (answer.error == null) {
        await refresh();
        return null;
      }
      if (answer.error != 'STALE_HEAD') return answer.error;
      await refresh();
      await _sleep(Duration(milliseconds: 200 + _random.nextInt(800) * (attempt + 1)));
    }
    return 'UNAVAILABLE';
  }

  /// Signing out of this app: its key leaves the account's devices (best effort).
  Future<void> leave() async {
    try {
      await remove(await _selfPub());
    } catch (_) {}
  }

  /// What trusting the backend's log again would change; with [confirm], do it. [expectedHead] is the
  /// head the person was shown in the preview: if the backend's log is not that one any more, nothing is
  /// done and the result has [DeviceLogRebaseline.logChanged] set — what gets trusted is what was
  /// reviewed. Another account's list under the sign-in the live log belongs to is refused, preview and
  /// confirm alike ([DeviceLogRebaseline.otherAccount]). Null: the backend's list could not be read or
  /// did not verify.
  Future<DeviceLogRebaseline?> rebaseline({required bool confirm, DevLogHead? expectedHead}) async {
    final entries = <Object?>[];
    var acct = '';
    DevLogHead? head;
    for (var page = 0; page < _pages; page++) {
      final got = await fetch(entries.length);
      if (got == null || !_isPosition(got.head.seq)) return null;
      acct = got.acct;
      head = got.head;
      entries.addAll(got.entries);
      if (got.entries.isEmpty || entries.length >= got.head.seq) break;
    }
    final DevLogState next;
    try {
      next = (await applyDevLogEntries(DevLogState.empty(acct), entries)).state;
    } on DevLogError {
      return null;
    }
    if (head == null || next.head != head) return null;
    final effects = _Effects();
    final result = await _locked(() async {
      final file = await _marksIn();
      final same = file.state != null && file.state!.acct == next.acct;
      // Another account's list while the live log is the one of the sign-in this app is under: the
      // backend switched accounts on its own. A review must not move this app there (the account it is
      // signed in to, and every mark on it, would go out of sight): only a sign-in switches accounts.
      // Only a sign-in by hand the list is not stamped with is that switch: none recorded, an adopted one
      // (a session this app took over — whatever stamp the list has, or lacks, from an older version), or
      // the sign-in the list is stamped with is not.
      if (file.state != null && !same) {
        final local = await _localOwner();
        if (local == null || local.startsWith(_adoptedSignIn) || file.owner == local) {
          return const DeviceLogRebaseline.otherAccount();
        }
      }
      if (confirm && expectedHead != null && next.head != expectedHead) return const DeviceLogRebaseline.changed();
      // The list under review is judged against this account's own log as this app verified it: the
      // live file, or — for another account — the one kept when this app left it (its marks go on), or
      // else nothing (every key on it is new here). Never against the account being left.
      final kept = same ? null : await _archivedFileIn(next.acct);
      final base = same ? file : kept ?? _File(null, [], null, 0, joinedSeq: 0, preLog: [...file.preLog]);
      final before = base.state?.active ?? const <String, DevLogMember>{};
      final added = [for (final m in next.active.values) if (before[m.pub] == null) m];
      final removed = [for (final m in before.values) if (next.active[m.pub] == null) m];
      if (confirm) {
        final selfPub = await _selfPub();
        final pre = base.preLog.toSet();
        // Every key the review let in is new here — however the preview and this read differ — unless
        // this app knew it already.
        final news = [
          for (final m in added)
            if (m.pub != selfPub && !pre.contains(m.pub)) m,
        ];
        final toAnnounce = [
          for (final m in news)
            if (!base.announced.contains(m.pub)) m,
        ];
        final parsed = entries.map(DevLogEntry.parse).whereType<DevLogEntry>().toList();
        final departed = _reviewDeparted(base, next, parsed, removed, selfPub, pre);
        // The reviewed list is another account's: the one this app leaves is kept, as on a sign-in (and
        // what a fork suspended in it stays suspended here) — and a kept one of the reviewed account
        // goes on from where it was.
        if (file.state != null && !same) await _archiveIn(file);
        base
          ..state = next
          ..recent = parsed
          ..frozen = null
          ..notifiedUpTo = next.head.seq
          // The joined point never moves up past the reviewed head: a shorter list (rolled back, or
          // another account's) must leave every key added to it from here on news.
          ..joinedSeq = min(base.joinedSeq ?? base.notifiedUpTo, next.head.seq)
          ..pending = _prune([...base.pending, for (final m in news) m.pub], next)
          ..announced = _prune([...base.announced, for (final m in toAnnounce) m.pub], next)
          // A review lifts what a fork suspended in this list; a kept list's suspensions were never in
          // the preview, so they stay.
          ..suspended = same ? [] : _prune(base.suspended, next)
          ..looseRemoved = []
          ..joining = false
          ..reviewedSeq = next.head.seq
          ..departed = _withDeparted(base.departed, departed)
          ..owner = await _localOwner() ?? base.owner;
        await _carrySuspensionsIn(base);
        // Live first, then out of the archive: a crash in between leaves it in both, never in neither.
        await _write(base);
        if (kept != null) {
          final all = await _archived();
          if (all.remove(next.acct) != null) await keys.writeDeviceLogArchive(all);
        }
        await _trust(next.active.values.toList());
        for (final m in removed) {
          await _drop(m);
        }
        effects.announce.addAll(toAnnounce);
        effects.changed = true;
      }
      return DeviceLogRebaseline(next.head, added, removed);
    });
    await _fire(effects);
    return result;
  }

  /// What rides this app's side of a `group_sync`.
  Future<Map<String, Object?>?> gossip() async {
    final file = await _read();
    final state = file.state;
    // Not this sign-in's log yet (it may be the account this app just left): nothing to say.
    if (state == null || !await _ownsFile(file)) return null;
    // The newest hashes let a peer that finds the logs forked say where they split.
    final from = max(0, state.hashes.length - _gossipHashes);
    return {
      'head': state.head.toJson(),
      'frozen': file.frozen != null,
      'hashes': [
        for (var i = from; i < state.hashes.length; i++) {'seq': i + 1, 'hash': state.hashes[i]},
      ],
    };
  }

  /// A machine's answer to this app's `group_sync`: its head, whether it is frozen, and the entries
  /// this app lacks if it is behind.
  Future<void> heard(String machinePub, Object? raw) async {
    final file = await _marks();
    final state = file.state;
    if (state == null || raw is! Map) return;
    // A sign-in waiting for its first read: the file may be the account left behind, and a machine of
    // the new one would freeze it as a fork. Nothing is judged until the log is this sign-in's.
    if (!await _ownsFile(file)) return;
    _frozenPeers[machinePub] = raw['frozen'] == true;
    final theirs = DevLogHead.fromJson(raw['head']);
    if (theirs == null) return;
    final relation = compareDevLogHead(state, theirs);
    if (relation == 'fork') {
      await _freeze('fork');
      return _suspendAfterFork(raw);
    }
    if (relation == 'behind') {
      final tail = raw['tail'];
      final missing = tail is List
          ? [for (final e in tail) if ((DevLogEntry.parse(e)?.seq ?? 0) > state.head.seq) e]
          : const <Object?>[];
      // A tail that does not continue this log is a fork; and a log already frozen on one can still
      // learn from this machine's hashes where it split.
      if (file.frozen != null || (missing.isNotEmpty && !await _acceptFromPeer(missing))) {
        await _suspendAfterFork(raw);
      }
      unawaited(refresh());
    }
  }

  /// A fork a peer proved with its hashes: the keys added at or after the split — and new here — are
  /// not trusted until the list is reviewed ([rebaseline]). Only locally: nothing is tombstoned or
  /// written to the log. Without usable hashes the freeze alone stands.
  Future<void> _suspendAfterFork(Object? theirs) async {
    final changed = await _locked(() async {
      final file = await _read();
      final state = file.state;
      if (state == null || file.frozen?.reason != 'fork') return false;
      final split = devLogDivergence(state, theirs);
      if (split == null) return false;
      final selfPub = await _selfPub();
      // Only keys nobody here has marked as seen — and not one a review (`rebaseline`) already let in:
      // another device's old branch must not cost this one the devices its user just looked at.
      final reviewed = file.reviewedSeq ?? -1;
      final fresh = [
        for (final m in state.active.values)
          if (m.seq >= split &&
              m.pub != selfPub &&
              file.pending.contains(m.pub) &&
              m.seq > reviewed &&
              !file.suspended.contains(m.pub))
            m,
      ];
      if (fresh.isEmpty) return false;
      file.suspended = [...file.suspended, for (final m in fresh) m.pub];
      await _write(file);
      for (final m in fresh) {
        if (m.kind != 'machine') continue;
        final current = await keys.peer(m.machineId);
        if (current != null && b64e(current.pub) == m.pub) await keys.unlink(m.machineId);
      }
      return true;
    });
    if (changed) onChanged?.call();
  }

  /// Keys not trusted here after a fork, until [rebaseline] — and every key a fork suspended in another
  /// account's kept log, which no other account's log can bring back in.
  Future<Set<String>> suspendedPubs() async => {...(await _read()).suspended, ...await _archivedSuspended()};

  /// Mark new devices as seen: the ones in [pubs] (what a window displayed), one ([pub]), or every one
  /// (neither). The "already on your account" list is [seeBaseline]. Persisted, so it holds across
  /// restarts. A key a fork suspended stays flagged when it is only part of a list that was looked at;
  /// [pub] — "It's mine" on that very device — is the person vouching for it, and lifts its suspension
  /// (here and in every kept account's log). A key that joined and left before anyone looked
  /// ([DeviceLogListing.departed]) is cleared the same way: named, or every one.
  Future<void> dismiss({String? pub, List<String>? pubs}) async {
    final lifted = <DevLogMember>[];
    final changed = await _locked(() async {
      final file = await _marksIn();
      if (file.state == null) return false;
      final named = pub != null || pubs != null;
      final gone = {...?pubs, ?pub};
      file.pending = [
        for (final k in file.pending)
          if ((named ? !gone.contains(k) : false) || (file.suspended.contains(k) && k != pub)) k,
      ];
      file.departed = [
        for (final d in file.departed)
          if (named && !gone.contains(d.pub)) d,
      ];
      final lifting = pub != null && file.suspended.contains(pub) ? pub : null;
      if (lifting != null) {
        file.suspended = [for (final k in file.suspended) if (k != lifting) k];
        final m = file.state!.active[lifting];
        if (m != null) lifted.add(m);
      }
      await _write(file);
      if (lifting != null) await _unsuspendArchivedIn([lifting]);
      if (lifted.isNotEmpty) await _trust(lifted);
      return true;
    });
    if (changed) onChanged?.call();
  }

  /// The "Already on your account" list was acknowledged: the first read is over, whatever comes after
  /// is news — or a backend that stalls that read could add a key to a list nobody looks at again.
  Future<void> seeBaseline() => _change((file) {
    file
      ..baselineSeen = true
      ..joining = false;
  });

  /// Read the file, [edit] it and write it back, under the lock; nothing when there is no log yet.
  Future<void> _change(void Function(_File file) edit) async {
    final changed = await _locked(() async {
      final file = await _marksIn();
      if (file.state == null) return false;
      edit(file);
      await _write(file);
      return true;
    });
    if (changed) onChanged?.call();
  }

  /// Every add and remove in the log, newest first, as this app verified it: the entries come from the
  /// backend but each must hash to what this app already verified, or the log freezes. Offline, what
  /// is kept locally (`complete: false`).
  Future<DeviceLogHistory> history() => _historying ??= _historyOnce().whenComplete(() => _historying = null);

  /// One walk at a time: two interleaved on the same cache would each read the other's entries as a
  /// gap in the log and freeze it.
  Future<DeviceLogHistory>? _historying;

  Future<DeviceLogHistory> _historyOnce() async {
    await refresh();
    final file = await _marks();
    final state = file.state;
    if (state == null) return const DeviceLogHistory(rows: [], complete: false);
    if (_histAcct != state.acct) {
      _histAcct = state.acct;
      _histCache = [];
    }
    final last = _histCache.isEmpty ? null : _histCache.last;
    if (last != null && (last.seq > state.head.seq || devLogHash(last) != state.hashes[last.seq - 1])) {
      _histCache = [];
    }
    for (var page = 0; page < _pages && _histCache.length < state.head.seq; page++) {
      final since = _histCache.length;
      final got = await fetch(since);
      if (got == null || got.acct != state.acct) break;
      var progressed = false;
      for (final raw in got.entries) {
        final e = DevLogEntry.parse(raw);
        final rawSeq = raw is Map ? raw['seq'] : null;
        final seq = e?.seq ?? (rawSeq is int ? rawSeq : 0);
        if (seq <= _histCache.length || seq > state.head.seq) continue;
        // At a position this app verified, anything unreadable or off-hash means the backend is lying
        // about the past: freeze, and show only what was already checked.
        if (e == null || e.seq != _histCache.length + 1 || devLogHash(e) != state.hashes[e.seq - 1]) {
          // Only against the log this walk started from: if the file was rebaselined (or moved to
          // another account) while the pages were on their way, the mismatch is with a log that is
          // gone, and says nothing about the backend.
          final now = (await _read()).state;
          if (now == null || now.acct != state.acct || now.head != state.head) {
            _histCache = [];
            _histAcct = null;
            return _historyOf(const [], false);
          }
          await _freeze('fork');
          return _historyOf(_histCache, false);
        }
        _histCache.add(e);
        progressed = true;
      }
      if (!progressed) break;
    }
    return _historyOf(_histCache, _histCache.length >= state.head.seq);
  }

  Future<DeviceLogHistory> _historyOf(List<DevLogEntry> fetched, bool complete) async {
    final file = await _read();
    final state = file.state;
    if (state == null) return const DeviceLogHistory(rows: [], complete: false);
    // Offline, the newest entries kept locally fill in what could not be fetched.
    final from = fetched.isEmpty ? 0 : fetched.last.seq;
    final entries = complete ? fetched : [...fetched, for (final e in file.recent) if (e.seq > from) e];
    return DeviceLogHistory(
      rows: devLogHistory(
        entries,
        selfPub: await _selfPub(),
        joinedSeq: file.joinedSeq,
        // A key that joined and left before anyone looked is still new, in its rows too.
        pending: [...file.pending, for (final d in file.departed) d.pub],
        active: state.active,
        loose: file.looseRemoved,
      ),
      complete: complete,
    );
  }

  /// The account's devices as this app's log has them.
  Future<DeviceLogListing> list() async {
    final file = await _marks();
    final selfPub = await _selfPub();
    final members = (file.state?.active.values.toList() ?? [])..sort((a, b) => a.seq.compareTo(b.seq));
    final labels = {for (final m in members) m.pub: m.label};
    final joinedSeq = file.joinedSeq ?? 0;
    final pre = file.preLog.toSet();
    return DeviceLogListing(
      members: [
        for (final m in members)
          DeviceLogRow(
            m,
            fingerprint: fingerprint(b64d(m.pub)),
            self: m.pub == selfPub,
            pending: file.pending.contains(m.pub),
            suspended: file.suspended.contains(m.pub),
          ),
      ],
      frozen: file.frozen,
      frozenPeers: [
        for (final e in _frozenPeers.entries)
          if (e.value) labels[e.key] ?? fingerprint(b64d(e.key)),
      ],
      pending: file.pending,
      suspended: file.suspended,
      joinedSeq: joinedSeq,
      baseline: [
        for (final m in members)
          if (m.pub != selfPub && (m.seq <= joinedSeq || pre.contains(m.pub))) m.pub,
      ],
      baselineSeen: file.baselineSeen,
      departed: file.departed,
    );
  }
}

/// Whether [seq] can be a log position: a whole number, not negative, not past what a double holds.
bool _isPosition(int seq) => seq >= 0 && seq <= 9007199254740991;

String _clip(String label) {
  final clean = label.replaceAll(RegExp(r'[\u0000-\u001f\u007f]'), ' ').trim();
  return clean.length > devLogLabelMax ? clean.substring(0, devLogLabelMax) : clean;
}
