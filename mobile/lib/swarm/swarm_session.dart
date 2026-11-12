import 'dart:async';

import 'package:flutter/widgets.dart';

import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';
import '../notify/system_notices.dart';
import '../phone/voice_recorder.dart';
import '../settings/experimental_features.dart';
import 'swarm_choices.dart';
import 'swarm_face.dart';
import 'swarm_home_cache.dart';
import 'swarm_home_prefs.dart';
import 'swarm_inbox.dart';
import 'swarm_kept.dart';
import 'swarm_mark_all.dart';
import 'swarm_message_reads.dart';
import 'swarm_notices.dart';
import 'swarm_request.dart';
import 'swarm_start.dart';

/// The account's Swarm on this phone: its Swarms ([inbox]) and the notices
/// that tell of their chats.
///
/// One per account and only while Swarm is on: [SwarmHost] makes it, and
/// drops it with everything it holds — notices on the lock screen included —
/// when the account leaves or Swarm is turned off.
class SwarmSession extends ChangeNotifier {
  SwarmSession({
    required this.accountId,
    required SwarmRequest request,
    SwarmUpload upload = refuseSwarmUpload,
    required SwarmNotices notices,
    Duration pollInterval = const Duration(seconds: 15),
    this.markAllHold = swarmMarkAllHold,
    SwarmHomeCache? homeCache,
    LocalKeyValueStore? readMarks,
    SwarmKeptStore? kept,
    SwarmTold? told,
    DateTime Function()? now,
  }) : inbox = SwarmInbox(
         accountId: accountId,
         request: request,
         upload: upload,
         pollInterval: pollInterval,
         homeCache: homeCache,
         readMarks: readMarks,
         keptStore: kept,
       ),
       home = SwarmHomePrefs(accountId: accountId, store: readMarks) {
    _announcer = SwarmAnnouncer(
      notices,
      quiet: () => !swarmLocalNotices || _screens > 0,
      told: told,
      now: now,
    );
    _chatNotices = SwarmChatNotices(_announcer);
    inbox
      ..onSwarmRead = _swarmRead
      ..addListener(_inboxChanged);
  }

  final String accountId;
  final SwarmInbox inbox;

  /// Messages read one at a time: quoted originals and what message links
  /// point at ([SwarmMessageReads]), dropped with the session.
  final messageReads = SwarmMessageReads();

  /// What the person chose for Home on this phone: the projects pinned and
  /// the one Swarm shown. A Swarm the account no longer has takes its own.
  final SwarmHomePrefs home;

  /// How long Mark all read waits for its Undo before the marks are sent.
  final Duration markAllHold;

  /// The one Mark all read waiting for its Undo, if any.
  SwarmMarkAll? get markAll => _markAll;
  SwarmMarkAll? _markAll;

  /// Mark all read on Home (the desktop's Shift+Esc): every chat of Swarms
  /// [swarmIds] shown unread reads as read on this phone at once, and on
  /// the server once [markAllHold] passes without [SwarmMarkAll.undo]. Null
  /// when nothing is unread. A second one sends the first's marks before
  /// it starts; leaving the app or closing the session sends them at once.
  SwarmMarkAll? markAllRead(Iterable<String> swarmIds) {
    if (_disposed) return null;
    _markAll?.commit();
    late final SwarmMarkAll? held;
    held = SwarmMarkAll.start(
      [
        for (final id in swarmIds)
          if (inbox.reader(id) case final reader? when !reader.accessRevoked)
            ?reader.readMarks,
      ],
      hold: markAllHold,
      onDone: () {
        if (_markAll != held) return;
        _markAll = null;
        if (!_disposed) notifyListeners();
      },
    );
    _markAll = held;
    if (held != null) notifyListeners();
    return held;
  }

  late final SwarmAnnouncer _announcer;

  /// What tells of new messages in chats set to All new messages.
  late final SwarmChatNotices _chatNotices;
  int _screens = 0;
  final _watching = <String, int>{};
  bool _foreground = false, _disposed = false;

  /// Harness is in front: the Swarms are read every poll, and those a screen
  /// watches every few seconds. Behind, nothing is. Going behind sends a
  /// held Mark all read at once: the app may not come back to send it.
  set foreground(bool value) {
    if (!value) {
      _markAll?.commit();
      // The app going behind may be its last moment.
      unawaited(inbox.kept.flush());
    }
    _foreground = value;
    inbox.shown = value;
    _show();
  }

  /// A Swarm screen is up: what arrives shows there, so no notice tells it.
  void enter() => _screens++;
  void leave() => _screens = _screens > 0 ? _screens - 1 : 0;

  void _swarmRead(String id) {
    if (inbox.reader(id) case final reader?) _chatNotices.read(id, reader);
    _announcer.swarmRead();
  }

  /// A screen shows Swarm [swarmId] closely (a conversation): it is read
  /// every few seconds while Harness is in front, until no screen does.
  void watch(String swarmId) {
    _watching[swarmId] = (_watching[swarmId] ?? 0) + 1;
    _show();
  }

  void unwatch(String swarmId) {
    final left = (_watching[swarmId] ?? 1) - 1;
    if (left > 0) {
      _watching[swarmId] = left;
      return;
    }
    _watching.remove(swarmId);
    inbox.reader(swarmId)?.shown = false;
  }

  /// Each watched Swarm's reader reads on its own only while Harness is in
  /// front; one listed again after it left is a new reader, shown here too.
  void _show() {
    for (final id in _watching.keys) {
      inbox.reader(id)?.shown = _foreground;
    }
  }

  void _inboxChanged() {
    _show();
    if (inbox.loaded) {
      final listed = {for (final swarm in inbox.swarms) swarm.id};
      home.keepOnly(listed);
      _chatNotices.keepOnly(listed);
      // A Swarm off the list, or out of reach, keeps no notice up.
      _announcer.settle({
        for (final swarm in inbox.swarms)
          if (inbox.reader(swarm.id) case final reader?
              when !reader.accessRevoked)
            swarm.id,
      });
    }
  }

  @override
  void dispose() {
    // Closing the account or Swarm is no Undo: held marks go now.
    _markAll?.commit();
    _disposed = true;
    messageReads.dispose();
    inbox.removeListener(_inboxChanged);
    _announcer.clear();
    inbox.dispose();
    home.dispose();
    super.dispose();
  }
}

/// Keeps one [SwarmSession] for the signed-in account while Settings ▸
/// Experimental ▸ Swarm is on, and none otherwise.
class SwarmHost extends ChangeNotifier {
  SwarmHost({
    required this.accountId,
    this.accountReading,
    required this.account,
    required this.request,
    this.upload = refuseSwarmUpload,
    required this.notices,
    ExperimentalFeaturesStore? features,
    this.computers,
    SwarmHomeCache? homeCache,
    LocalKeyValueStore? readMarks,
    SwarmKeptStore? kept,
    this.voice,
  }) : features = features ?? experimentalFeaturesStore,
       homeCache = homeCache ?? SwarmHomeCache.device(),
       readMarks = readMarks ?? HarnessFileStore.shared,
       kept = kept ?? SealedSwarmKeptStore.device() {
    account.addListener(_update);
    this.features.addListener(_update);
    computers?.addListener(_computersChanged);
    _update();
  }

  /// Where the session's drafts and unsent posts are kept, sealed; cleared when
  /// the account leaves or Swarm is turned off, not while it is being read.
  final SwarmKeptStore kept;

  /// The signed-in account's id; null while nobody is.
  final String? Function() accountId;

  /// Whether someone is signed in and [accountId] is on its way; null where
  /// nobody can tell, and no account is taken to be coming.
  final bool Function()? accountReading;

  /// Tells when [accountId] may have changed.
  final Listenable account;
  final SwarmRequest request;

  /// Sends a chat's file to the backend, straight from the phone.
  final SwarmUpload upload;
  final SwarmNotices notices;
  final ExperimentalFeaturesStore features;

  /// The account's computers, for the start screens ([swarmStartView]); null
  /// where nobody handed them in, and no start screen shows.
  final SwarmComputers? computers;

  /// The last Home of the session's account, kept for a cold start; cleared
  /// when the account leaves or Swarm is turned off.
  final SwarmHomeCache homeCache;

  /// Where the session's read marks are kept on the phone: each chat's id
  /// and how far it was read, under the account and the Swarm.
  final LocalKeyValueStore readMarks;

  /// A new microphone for a chat's voice messages (swarm_voice.dart), which
  /// the chat owns and disposes; null where none can be heard, and the
  /// composer has no mic.
  final VoiceRecorder Function()? voice;

  SwarmSession? session;
  bool _foreground = true;

  /// What the account was told on this phone, kept across its sessions: a
  /// session made again (the account read again) tells none of it again.
  final _told = SwarmTold();

  /// No session yet, only because the account is on its way: Swarm is on and
  /// someone is signed in, so Home shows its skeleton, not that Swarm is off.
  bool get accountComing =>
      session == null &&
      features.isOn(PhoneExperiment.swarm) &&
      (accountReading?.call() ?? false);

  /// Whether Swarm was on at the last [_update]; null before the first.
  bool? _on;

  set foreground(bool value) {
    _foreground = value;
    session?.foreground = value;
  }

  /// Notices the person was already shown by a push while the app was away,
  /// by their keys and slots: a chat a push still shows gets no notice of its
  /// own ([SwarmTold.pushesShown]).
  void toldElsewhere(Iterable<String> keys) => _told.pushesShown(keys);

  /// A computer may have come up: a Swarm waiting for one reads at once.
  void _computersChanged() {
    session?.inbox.computerUp();
    notifyListeners();
  }

  void _update() {
    final on = features.isOn(PhoneExperiment.swarm);
    final wasOn = _on;
    _on = on;
    final id = on ? accountId() : null;
    // Swarm off forgets what was told; a moment with no account does not, as
    // the same account may be back at once. Another account starts over.
    if (!on) {
      _told.account = null;
    } else if (id != null) {
      _told.account = id;
    }
    if (id == session?.accountId) {
      // Swarm off with no session to end: its switch is read before the first
      // frame, so this is known, and what an earlier run kept goes. A missing
      // account is not: the signed-in shell is up before the account is read.
      if (!on && wasOn != false) {
        unawaited(homeCache.clear());
        unawaited(kept.clear());
      }
      // No session either way, but [accountComing] may have moved with it.
      if (wasOn != null && on != wasOn) notifyListeners();
      return;
    }
    // Signed out, another account, or Swarm turned off: nothing of it stays.
    if (session != null) {
      unawaited(homeCache.clear());
      swarmForgetAvatarImages();
    }
    final hadSession = session != null;
    // What it was still writing goes first: the clear comes after it.
    session?.dispose();
    // The same account still being read is no leaving: what it wrote waits.
    if (hadSession &&
        (!on || id != null || !(accountReading?.call() ?? false))) {
      unawaited(kept.clear());
    }
    session = id == null
        ? null
        : (SwarmSession(
            accountId: id,
            request: request,
            upload: upload,
            notices: notices,
            homeCache: homeCache,
            readMarks: readMarks,
            kept: kept,
            told: _told,
          )..foreground = _foreground);
    notifyListeners();
  }

  @override
  void dispose() {
    account.removeListener(_update);
    features.removeListener(_update);
    computers?.removeListener(_computersChanged);
    session?.dispose();
    session = null;
    super.dispose();
  }
}

/// The [SwarmHost] of the signed-in shell, for the screens under it.
class SwarmScope extends InheritedNotifier<SwarmHost> {
  const SwarmScope({
    super.key,
    required SwarmHost super.notifier,
    required super.child,
  });

  /// The account's session, or null while Swarm is off, nobody is signed in,
  /// or outside the shell.
  static SwarmSession? of(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<SwarmScope>()
      ?.notifier
      ?.session;

  /// Whether there is no session only because the account is on its way
  /// ([SwarmHost.accountComing]); false outside the shell.
  static bool accountComingOf(BuildContext context) =>
      context
          .dependOnInheritedWidgetOfExactType<SwarmScope>()
          ?.notifier
          ?.accountComing ??
      false;

  /// The account's computers ([SwarmHost.computers]); null outside the shell
  /// or where none were handed in.
  static SwarmComputers? computersOf(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<SwarmScope>()
      ?.notifier
      ?.computers;

  /// How a chat's mic makes its microphone ([SwarmHost.voice]); null
  /// outside the shell or where none can be heard.
  static VoiceRecorder Function()? voiceOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<SwarmScope>()?.notifier?.voice;
}
