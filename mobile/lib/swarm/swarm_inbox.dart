import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import '../logging/app_log.dart';
import 'model.dart';
import 'swarm_buddy.dart';
import 'swarm_home_cache.dart';
import 'swarm_kept.dart';
import 'swarm_home_keeper.dart';
import 'swarm_read_marks.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';

/// One of the account's Swarms, as the list names it.
typedef SwarmListing = ({String id, String name});

/// What the Swarm page says when the account's server has no Swarm list:
/// one from before Swarm v1, whose one-Swarm route reads "list" as a Swarm's
/// id and answers that it is unavailable (the owner's iPhone, 2026-10-27).
const swarmServerTooOld =
    'Your Harness server does not support Swarm on the phone yet.';

/// An invitation to a Swarm, as the person's invitations list it: the
/// Swarm's name and the role offered, nothing read of the Swarm itself.
typedef SwarmInvitation = ({
  String tabId,
  String name,
  String inviteId,
  String role,
});

/// The account's Swarms on this phone.
///
/// Each read is the list, then one change read per Swarm. It reads only
/// while [shown], as a [SwarmReader] does. One per account: a Swarm that
/// leaves the list is dropped with everything read of it.
class SwarmInbox extends ChangeNotifier {
  SwarmInbox({
    required this.accountId,
    required this.request,
    this.upload = refuseSwarmUpload,
    this.pollInterval = const Duration(seconds: 15),
    DateTime Function()? now,
    SwarmHomeCache? homeCache,
    Duration homeWait = const Duration(seconds: 30),
    this.readMarks,
    SwarmKeptStore? keptStore,
  }) : kept = SwarmKept(accountId: accountId, store: keptStore),
       _now = now ?? DateTime.now,
       _home = homeCache == null
           ? null
           : SwarmHomeKeeper(homeCache, accountId, wait: homeWait) {
    kept.addListener(_dropUnlisted);
    if (_home != null) unawaited(_restore());
  }

  /// The account's drafts and unsent posts ([SwarmKept]).
  final SwarmKept kept;

  /// Keeps the last Home ([SwarmHomeCache]), so a cold start draws it at once.
  final SwarmHomeKeeper? _home;

  /// Where each Swarm's read marks are kept on the phone ([SwarmReadMarks]);
  /// null keeps them in memory only.
  final LocalKeyValueStore? readMarks;

  /// Draws the Home kept until the list is read: each Swarm's reader holds
  /// the view kept, which its first read replaces. One that does not read
  /// back is not drawn.
  Future<void> _restore() async {
    final kept = await _home!.restore();
    if (kept == null || _disposed || loaded || swarms.isNotEmpty) return;
    final shown = <SwarmListing>[];
    for (final swarm in kept) {
      final SuperTabSnapshot snapshot;
      try {
        snapshot = SuperTabSnapshot.fromJson(swarm.state);
      } on FormatException {
        continue;
      }
      final buddies = SwarmBuddies.read(swarm.state, accountId);
      swarmMarkBuddies(snapshot, buddies);
      _readers.putIfAbsent(swarm.id, () => _open(swarm.id))
        ..snapshot = snapshot
        ..buddies = buddies;
      shown.add((id: swarm.id, name: swarm.name));
    }
    swarms = List.unmodifiable(shown);
    _rebuild(told: true);
  }

  final String accountId;
  final SwarmRequest request;

  /// Handed to each Swarm's reader, for its chats' files.
  final SwarmUpload upload;
  final Duration pollInterval;

  /// The account's Swarms, in the list's order.
  List<SwarmListing> swarms = const [];

  /// What the last read of the list could not do; null once one succeeds.
  String? error;

  /// True once the list has been read.
  bool loaded = false;

  /// Invitations waiting for the person: read at every read of the list while
  /// they have no Swarm, and at most every [_invitationsEvery] while they have
  /// one, since the list is read every few seconds on every open phone.
  List<SwarmInvitation> invitations = const [];

  static const _invitationsEvery = Duration(minutes: 5);
  final DateTime Function() _now;

  /// When the invitations were last asked for; null when they are due now.
  DateTime? _invitationsAt;

  /// The last read of the invitations failed, while there is no Swarm: not "no invitation".
  /// Those read before stay meanwhile.
  bool invitationsFailed = false;

  /// Invitations being accepted.
  final Set<String> joining = {};

  /// What the last [join] could not do; null once one succeeds.
  String? joinError;

  /// Invitations put off with Not now: not offered again this session, and
  /// left as they are on the server.
  final _putOff = <String>{};

  /// The last read of the list failed for want of a computer to ask.
  bool get noComputer => _away != null;

  /// Accepts [invitation] (the desktop's Tab invites), under one receipt per
  /// invitation so a retry is the same accept, then reads the list.
  Future<bool> join(SwarmInvitation invitation) async {
    if (_disposed || !joining.add(invitation.inviteId)) return false;
    joinError = null;
    notifyListeners();
    try {
      await request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(invitation.tabId)}/commands',
        body: {
          'operationId': 'accept-${invitation.inviteId}',
          'command': {'type': 'invite.accept', 'inviteId': invitation.inviteId},
        },
      );
    } on SuperTabFailure catch (failure) {
      joinError = failure.message;
      return false;
    } catch (_) {
      joinError = 'Could not join. Try again.';
      return false;
    } finally {
      joining.remove(invitation.inviteId);
      if (!_disposed) notifyListeners();
    }
    // Gone at once, and not brought back by a read already under way.
    _putOff.add(invitation.inviteId);
    invitations = List.unmodifiable(
      invitations.where((other) => other.inviteId != invitation.inviteId),
    );
    await refreshAll();
    return true;
  }

  /// Names sent for a Swarm and not yet read back, with the number of the
  /// rename that sent each ([rename]): what the list shows for it meanwhile,
  /// so a read under way does not put the old name back.
  final _renaming = <String, (String, int)>{};
  int _renames = 0;

  /// Renames Swarm [id] to [name], trimmed (backend `tab.rename`, the
  /// desktop's Rename Tab): Home and the switcher show it at once, and the
  /// name before it again when the server did not keep it. A newer rename of
  /// the same Swarm settles it. Null once kept, when nothing changes, or once
  /// the Swarm is no longer the person's to read; else the sentence to show.
  Future<String?> rename(String id, String name) async {
    final trimmed = name.trim();
    final before = swarms.where((swarm) => swarm.id == id).firstOrNull?.name;
    final reader = _readers[id];
    if (_disposed || before == null || reader == null) return null;
    if (reader.accessRevoked || !swarmCanWrite(reader)) {
      return 'You can’t rename this Swarm.';
    }
    if (trimmed.isEmpty) return 'Name cannot be empty';
    if (trimmed == before) return null;
    final asked = ++_renames;
    _renaming[id] = (trimmed, asked);
    _named(id, trimmed);
    String? error;
    try {
      await request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(id)}/commands',
        body: {
          'operationId': superTabOperationId(),
          'command': {'type': 'tab.rename', 'name': trimmed},
        },
      );
    } on SuperTabFailure catch (failure) {
      error = failure.message;
    } catch (_) {
      // A call lost on the way (a timeout, a socket dropped) is no answer.
      error = 'Could not rename the Swarm.';
    }
    if (_disposed) return null;
    final newest = _renaming[id]?.$2 == asked;
    if (error != null) {
      if (newest) {
        _renaming.remove(id);
        _named(id, before);
      }
      // Lost meanwhile: the refusal is for a Swarm no longer shown.
      return reader.accessRevoked || !identical(_readers[id], reader)
          ? null
          : error;
    }
    // Read back past a read under way, which may have been sent before it.
    if (_refreshing case final reading?) await reading;
    await Future.wait([refresh(), reader.refresh()]);
    if (_renaming[id]?.$2 == asked) _renaming.remove(id);
    return null;
  }

  /// Swarm [id] is called [name] in [swarms], at once.
  void _named(String id, String name) {
    if (!swarms.any((swarm) => swarm.id == id)) return;
    swarms = List.unmodifiable([
      for (final swarm in swarms) swarm.id == id ? (id: id, name: name) : swarm,
    ]);
    _rebuild(told: true);
  }

  /// Leaves [invitation] for now: it stays on the server, and the start
  /// screen goes on to what else there is.
  void notNow(SwarmInvitation invitation) {
    if (!_putOff.add(invitation.inviteId)) return;
    invitations = List.unmodifiable(
      invitations.where((other) => other.inviteId != invitation.inviteId),
    );
    joinError = null;
    notifyListeners();
  }

  /// The person's invitations; none from a server without the list, which
  /// reads "invitations" as a Swarm's id and answers that it is not found. A
  /// read that fails, or answers anything but the list, throws: it is not "no
  /// invitation" (#1802's review).
  Future<List<SwarmInvitation>> _invitations() async {
    final Object? answer;
    try {
      answer = await request('GET', '/api/super-tabs/invitations');
    } on SuperTabFailure catch (failure) {
      // A server with the invitations never answers them "not found".
      if (failure.statusCode == 404) return const [];
      rethrow;
    }
    if (answer is! List) throw const FormatException('Missing invitations');
    final invitations = <SwarmInvitation>[];
    for (final raw in answer) {
      if (raw
          case {
            'tabId': final String tabId,
            'name': final String name,
            'inviteId': final String inviteId,
          }
          when raw['role'] is String?) {
        if (_putOff.contains(inviteId)) continue;
        invitations.add((
          tabId: tabId,
          name: name,
          inviteId: inviteId,
          role: raw['role'] as String? ?? '',
        ));
      } else {
        throw const FormatException('Invalid invitation');
      }
    }
    return invitations;
  }

  /// Swarm [swarmId] was read: what tells of a chat's new messages.
  void Function(String swarmId)? onSwarmRead;

  /// Swarms read during a read of the list, told once it ends.
  final _readDuringList = <String>{};

  final _readers = <String, SwarmReader>{};
  Future<void>? _refreshing;
  Timer? _poll;
  bool _shown = false, _disposed = false;

  /// A read of the list is under way: what its Swarms tell meanwhile is
  /// told once, at its end.
  bool _polling = false;

  /// A Swarm's reader told of a change since the last notify.
  bool _below = false;

  /// While no computer can be asked, the next read comes this soon — 2 seconds, doubling up to
  /// [pollInterval] — so Swarm is back within seconds of one coming up, not at the next poll.
  /// Null once a read gets through.
  Duration? _away;

  /// [id]'s reader, while it is listed.
  SwarmReader? reader(String id) => _readers[id];

  bool get shown => _shown;

  /// One of the account's computers came up: while none could be asked, the
  /// list is read now, not at the next quick try ([_away]) — at a cold start
  /// the socket comes up after the first read failed, and that try was 2 to
  /// 8 seconds off. A read under way is read again once it ends.
  void computerUp() {
    if (_disposed || !_shown || !noComputer) return;
    if (_refreshing case final reading?) {
      unawaited(reading.whenComplete(computerUp));
      return;
    }
    _poll?.cancel();
    _poll = null;
    unawaited(_tick());
  }

  /// On screen (or wanted for notices): reads at once and every
  /// [pollInterval] after. Otherwise reads nothing.
  set shown(bool value) {
    if (_shown == value) return;
    _shown = value;
    _poll?.cancel();
    _poll = null;
    if (value) {
      unawaited(_tick());
    } else {
      _home?.flush(_readers, swarms);
    }
  }

  Future<void> _tick() async {
    await refresh();
    if (_disposed || !_shown) return;
    _poll?.cancel();
    _poll = Timer(_away ?? pollInterval, () => unawaited(_tick()));
  }

  /// One read now, joining one under way.
  Future<void> refresh() {
    if (_disposed) return Future.value();
    return _refreshing ??= _read().whenComplete(() => _refreshing = null);
  }

  /// One read now with the invitations in it: a pull, or a join just made. Runs
  /// after a read already under way, which may have passed them by.
  Future<void> refreshAll() async {
    if (_refreshing case final reading?) await reading;
    _invitationsAt = null;
    await refresh();
  }

  bool get _invitationsDue {
    final at = _invitationsAt;
    return at == null || _now().difference(at) >= _invitationsEvery;
  }

  /// What a screen draws of the inbox itself: a read that leaves it as it
  /// was tells nobody.
  Object get _face =>
      (swarms, error, loaded, invitations, invitationsFailed, noComputer);

  Future<void> _read() async {
    final before = _face;
    _polling = true;
    try {
      final (:listed, :changedAt) = await _list();
      List<SwarmInvitation>? invited;
      Object? unread;
      if (listed.isEmpty || _invitationsDue) {
        _invitationsAt = _now();
        try {
          invited = await _invitations();
        } catch (failure) {
          // With a Swarm, Home has work to show: it stays as it is, and the
          // read comes round again.
          if (listed.isEmpty) {
            unread = failure;
          } else {
            appLog.warn('swarm', 'Invitations not read', error: failure);
          }
        }
      }
      if (_disposed) return;
      if (!listEquals(listed, swarms)) swarms = listed;
      _listedIds = {for (final swarm in listed) swarm.id};
      _dropUnlisted();
      // What was read of them stays while they cannot be read again.
      if (invited != null && !listEquals(invited, invitations)) {
        invitations = invited;
      }
      invitationsFailed = unread != null;
      loaded = true;
      error = null;
      _away = unread is SuperTabFailure && unread.code == 'MACHINE_UNAVAILABLE'
          ? _sooner()
          : null;
      final ids = {for (final swarm in listed) swarm.id};
      for (final id in _readers.keys.toList()) {
        if (!ids.contains(id)) _drop(id);
      }
      for (final swarm in listed) {
        _readers.putIfAbsent(swarm.id, () => _open(swarm.id));
      }
      await Future.wait([
        for (final swarm in listed)
          if (_due(swarm.id, changedAt[swarm.id] ?? 0))
            _readers[swarm.id]!.refresh(),
      ]);
    } on SuperTabFailure catch (failure) {
      if (_disposed) return;
      // Once per failure, not once per poll.
      if (error != failure.message) {
        appLog.warn(
          'swarm',
          'Swarm list not read: ${failure.code} ${failure.statusCode}',
          error: failure,
        );
      }
      error = failure.message;
      _away = failure.code == 'MACHINE_UNAVAILABLE' ? _sooner() : null;
    } catch (failure, stack) {
      if (_disposed) return;
      const unread = 'Could not load your Swarms. Try again.';
      if (error != unread) {
        appLog.failure(
          'swarm',
          'Swarm list not read',
          error: failure,
          stackTrace: stack,
        );
      }
      error = unread;
      _away = null;
    } finally {
      _polling = false;
    }
    _rebuild(told: _face != before);
    final read = _readDuringList.toList();
    _readDuringList.clear();
    for (final id in read) {
      if (_disposed) return;
      if (_readers.containsKey(id)) onSwarmRead?.call(id);
    }
  }

  /// [reader] answered a read: told after the reader's own notify, or at the
  /// end of the list read under way.
  void _readerRead(String id, SwarmReader reader) {
    scheduleMicrotask(() {
      if (_disposed || !identical(_readers[id], reader)) return;
      if (_polling) {
        _readDuringList.add(id);
      } else {
        onSwarmRead?.call(id);
      }
    });
  }

  /// The next quick read while no computer can be asked ([_away]).
  Duration _sooner() {
    final next = _away == null ? const Duration(seconds: 2) : _away! * 2;
    return next < pollInterval ? next : pollInterval;
  }

  /// Whether a poll reads Swarm [id] again, listed as last changed at
  /// [listedAt]: only when there may be something new. Its last change
  /// moved, it holds no Swarm yet, or its last read failed.
  bool _due(String id, int listedAt) {
    final reader = _readers[id]!;
    return reader.snapshot == null ||
        reader.error != null ||
        reader.lastChangedAt != listedAt;
  }

  /// Every page of the list before any is applied: a failed page cannot drop
  /// Swarms (the desktop's `refreshTabs`). With each Swarm's last change, 0
  /// for one never changed.
  Future<({List<SwarmListing> listed, Map<String, int> changedAt})>
  _list() async {
    final listed = <String, SwarmListing>{};
    final changedAt = <String, int>{};
    final cursors = <String>{};
    String? after;
    do {
      final Object? answer;
      try {
        answer = await request(
          'GET',
          '/api/super-tabs/list'
              '${after == null ? '' : '?after=${Uri.encodeQueryComponent(after)}'}',
        );
      } on SuperTabFailure catch (failure) {
        // A server with the list never answers it "not found".
        if (failure.statusCode != 404) rethrow;
        throw SuperTabFailure(
          'SWARM_UNSUPPORTED',
          swarmServerTooOld,
          statusCode: failure.statusCode,
        );
      }
      final page = superTabMap(answer);
      if (page['tabs'] is! List) throw const FormatException('Missing tabs');
      for (final raw in page['tabs'] as List) {
        final row = superTabMap(raw);
        if (row['id'] is! String || row['name'] is! String) {
          throw const FormatException('Invalid tab');
        }
        // A deleted Swarm is never the person's to show, whatever lists it
        // (backend superTabs/deletion.ts): one marked so is left out.
        if (row['deletedAt'] != null) continue;
        final id = row['id'] as String;
        // A rename on its way is shown until a read after it carries it.
        listed[id] = (id: id, name: _renaming[id]?.$1 ?? row['name'] as String);
        changedAt[id] = (row['lastChangedAt'] as num?)?.toInt() ?? 0;
      }
      after = page['next'] as String?;
      if (after != null && !cursors.add(after)) {
        throw const FormatException('Repeated tab cursor');
      }
    } while (after != null);
    return (listed: listed.values.toList(), changedAt: changedAt);
  }

  SwarmReader _open(String id) {
    final reader = SwarmReader(
      tabId: id,
      accountId: accountId,
      request: request,
      upload: upload,
    )..addListener(_relay);
    reader.reads.addListener(() => _readerRead(id, reader));
    reader.readMarks = SwarmReadMarks(reader, store: readMarks)
      ..addListener(_relay);
    reader.kept = kept;
    void watch() => _checkKept(id, reader);
    _keptWatches[id] = watch;
    reader.addListener(watch);
    kept.addListener(watch);
    return reader;
  }

  /// A Swarm off the list ([lost]), or the inbox closing: what a screen
  /// still holds of it is taken back ([SwarmReader.revoke]) before it is
  /// dropped.
  /// The Swarms the last list that answered named; null before one has.
  Set<String>? _listedIds;

  /// A Swarm the account no longer has goes from what is kept, also one lost
  /// while the app was closed, which has no reader to say so. Once what was
  /// kept is back, and only from a list that answered.
  void _dropUnlisted() {
    final listed = _listedIds;
    if (_disposed || listed == null || !kept.loaded) return;
    for (final id in kept.tabs) {
      if (!listed.contains(id)) kept.dropSwarm(id);
    }
  }

  /// How [_checkKept] follows each Swarm, by its id.
  final _keptWatches = <String, VoidCallback>{};

  /// Chats kept but not in a Swarm's read, already asked for this session.
  final _keptAsked = <(String, String)>{};

  /// What is kept of Swarm [id] goes when the person has lost it, and of one of
  /// its chats when that is lost, opened or not: a closed chat is in no full
  /// read, so one missing from it is asked for by id, once a session.
  void _checkKept(String id, SwarmReader reader) {
    if (_disposed || !kept.loaded) return;
    if (reader.accessRevoked) {
      kept.dropSwarm(id);
      return;
    }
    final snapshot = reader.snapshot;
    if (snapshot == null || reader.heldLoad == 0) return;
    for (final chat in kept.chats(id)) {
      if (snapshot.conversation(chat) != null) continue;
      if (!_keptAsked.add((id, chat))) continue;
      unawaited(() async {
        try {
          if (!await reader.loadConversation(chat) && !_disposed) {
            kept.dropChat(id, chat);
          }
        } catch (_) {
          // Not known either way: it stays, and is asked for again next session.
        }
      }());
    }
  }

  void _drop(String id, {bool lost = true}) {
    final watch = _keptWatches.remove(id);
    if (watch != null) kept.removeListener(watch);
    if (lost) kept.dropSwarm(id);
    final reader = _readers.remove(id)?..removeListener(_relay);
    if (reader != null) {
      if (watch != null) reader.removeListener(watch);
      final marks = reader.readMarks;
      // Lost, it is revoked first, so its read marks leave the phone too;
      // the inbox closing keeps them, written now, for the next one.
      if (!lost) marks?.dispose();
      reader.revoke();
      if (lost) marks?.dispose();
      reader.dispose();
    }
  }

  /// A Swarm's reader told of a change: what it holds is drawn through the
  /// inbox (Home's projects), so it is told on, once per list read at most.
  void _relay() {
    _below = true;
    if (!_polling) _rebuild();
  }

  /// Notifies when the inbox itself ([told]) or a Swarm below it changed.
  void _rebuild({bool told = false}) {
    if (_disposed) return;
    final tell = told || _below;
    _below = false;
    if (!tell) return;
    notifyListeners();
    _home?.keep(_readers, swarms);
  }

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    for (final id in _readers.keys.toList()) {
      _drop(id, lost: false);
    }
    kept
      ..removeListener(_dropUnlisted)
      ..dispose();
    super.dispose();
  }
}
