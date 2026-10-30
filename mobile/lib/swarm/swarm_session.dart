import 'dart:async';

import 'package:flutter/widgets.dart';

import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';
import '../notify/system_notices.dart';
import '../phone/voice_input_controller.dart';
import '../settings/experimental_features.dart';
import 'swarm_activity.dart';
import 'swarm_buddy_list.dart';
import 'swarm_chat_peeks.dart';
import 'swarm_choices.dart';
import 'swarm_dictation.dart';
import 'swarm_face.dart';
import 'swarm_home_cache.dart';
import 'swarm_home_prefs.dart';
import 'swarm_inbox.dart';
import 'swarm_notices.dart';
import 'swarm_profile.dart';
import 'swarm_request.dart';
import 'swarm_start.dart';

/// The account's Swarm on this phone: what its Swarms ask of the person
/// ([inbox]), the notices that tell them, and the answers held for Undo.
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
    this.undoWindow = swarmUndoWindow,
    SwarmHomeCache? homeCache,
    LocalKeyValueStore? readMarks,
  }) : inbox = SwarmInbox(
         accountId: accountId,
         request: request,
         upload: upload,
         pollInterval: pollInterval,
         homeCache: homeCache,
         readMarks: readMarks,
       ),
       home = SwarmHomePrefs(accountId: accountId, store: readMarks) {
    _announcer = SwarmAnnouncer(
      notices,
      quiet: (_) => !swarmLocalNotices || _screens > 0,
    );
    inbox
      ..onArrived = announce
      ..addListener(_needsChanged);
  }

  final String accountId;
  final SwarmInbox inbox;

  /// The project and Buddy chats read for Activity and Buddies, a few at a
  /// time ([SwarmChatPeeks]).
  final peeks = SwarmChatPeeks();

  /// Activity, in place of Needs you: its filters, counts and handled rows.
  /// Made when a screen first asks for it.
  SwarmActivity get activity => _activity ??= SwarmActivity(this);
  SwarmActivity? _activity;

  /// Buddies: the person's own Buddy in each project, with its chat's last
  /// message. Made when a screen first asks for it.
  SwarmBuddyList get buddyList => _buddyList ??= SwarmBuddyList(this);
  SwarmBuddyList? _buddyList;

  /// What the person chose for Home on this phone: the projects pinned and
  /// the one Swarm shown. A Swarm the account no longer has takes its own.
  final SwarmHomePrefs home;

  /// How long a decision's answer is held before it is sent.
  final Duration undoWindow;

  late final SwarmAnnouncer _announcer;
  int _screens = 0;
  final _watching = <String, int>{};
  final _held = <String, ({int choice, Timer timer})>{};

  /// Needs whose held answer was dropped unsent: their card says so until
  /// another answer is held.
  final _dropped = <String>{};
  bool _foreground = false, _disposed = false;

  /// Harness is in front: the Swarms are read every poll, and those a screen
  /// watches every few seconds. Behind, nothing is.
  set foreground(bool value) {
    _foreground = value;
    inbox.shown = value;
    _show();
  }

  /// A Swarm screen is up: what arrives shows there, so no notice tells it.
  void enter() => _screens++;
  void leave() => _screens = _screens > 0 ? _screens - 1 : 0;

  /// Posts [need]'s notice, unless a Swarm screen is up.
  void announce(SwarmNeed need) => _announcer.announce(need);

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

  /// The option held for [need], while its Undo window runs.
  int? held(SwarmDecisionNeed need) => _held[need.key]?.choice;

  /// [need]'s held answer was dropped before it was sent: it left the list
  /// meanwhile (the Swarm read again in full) and came back.
  bool dropped(SwarmDecisionNeed need) => _dropped.contains(need.key);

  /// Answers [need] with option [choice] once [undoWindow] has passed,
  /// unless [undo] takes it back first.
  void hold(SwarmDecisionNeed need, int choice) {
    if (_disposed) return;
    // Off the list since it was asked (answered elsewhere, or access taken
    // away): there is nothing to answer.
    if (!inbox.needs.any((open) => open.key == need.key)) return;
    _held.remove(need.key)?.timer.cancel();
    _dropped.remove(need.key);
    if (undoWindow <= Duration.zero) {
      _send(need, choice);
      return;
    }
    _held[need.key] = (
      choice: choice,
      timer: Timer(undoWindow, () {
        if (_held.remove(need.key) case final held?) _send(need, held.choice);
      }),
    );
    notifyListeners();
  }

  void undo(SwarmDecisionNeed need) {
    if (_held.remove(need.key) case final held?) {
      held.timer.cancel();
      notifyListeners();
    }
  }

  void _send(SwarmDecisionNeed need, int choice) {
    if (_disposed) return;
    notifyListeners();
    unawaited(inbox.asks(need.swarmId)?.answer(need.decision, choice));
  }

  void _needsChanged() {
    _show();
    if (inbox.loaded) {
      home.keepOnly({for (final swarm in inbox.swarms) swarm.id});
    }
    // What was read of a Swarm off the list, or out of reach, leaves memory.
    peeks.keepOnly([for (final swarm in inbox.swarms) ?inbox.reader(swarm.id)]);
    _announcer.settle(inbox.needs);
    // Answered somewhere else meanwhile, or out of the list while the Swarm
    // is read again: nothing is sent, and a card that comes back says so.
    final open = {for (final need in inbox.needs) need.key};
    final gone = [
      for (final key in _held.keys)
        if (!open.contains(key)) key,
    ];
    for (final key in gone) {
      _held.remove(key)!.timer.cancel();
      _dropped.add(key);
    }
    if (gone.isNotEmpty) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    for (final held in _held.values) {
      held.timer.cancel();
    }
    _held.clear();
    _activity?.dispose();
    _buddyList?.dispose();
    peeks.dispose();
    inbox.removeListener(_needsChanged);
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
    required this.account,
    required this.request,
    this.upload = refuseSwarmUpload,
    required this.notices,
    ExperimentalFeaturesStore? features,
    this.computers,
    SwarmHomeCache? homeCache,
    LocalKeyValueStore? readMarks,
    this.uploadAvatar,
    this.voice,
    this.dictation,
  }) : features = features ?? experimentalFeaturesStore,
       homeCache = homeCache ?? SwarmHomeCache.device(),
       readMarks = readMarks ?? HarnessFileStore.shared {
    account.addListener(_update);
    this.features.addListener(_update);
    computers?.addListener(_computersChanged);
    _update();
  }

  /// The signed-in account's id; null while nobody is.
  final String? Function() accountId;

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

  /// Sends an avatar photo with the phone's own sign-in; null where none can
  /// go, and only the built-in pictures are offered.
  final SwarmAvatarUpload? uploadAvatar;

  /// A new voice input for a chat's mic, which owns and disposes it — the
  /// terminal's speech-to-text; null where none can be heard, and the
  /// composer has no mic.
  final VoiceInputController Function()? voice;

  /// The phone's own speech recognizer, which shows a chat's words as they
  /// are said; null where there is none, and the mic records and has [voice]
  /// transcribe the take.
  final SwarmDictation? dictation;

  SwarmSession? session;
  bool _foreground = true;

  /// Whether Swarm was on at the last [_update]; null before the first.
  bool? _on;

  set foreground(bool value) {
    _foreground = value;
    session?.foreground = value;
  }

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
    if (id == session?.accountId) {
      // Swarm off with no session to end: its switch is read before the first
      // frame, so this is known, and what an earlier run kept goes. A missing
      // account is not: the signed-in shell is up before the account is read.
      if (!on && wasOn != false) unawaited(homeCache.clear());
      return;
    }
    // Signed out, another account, or Swarm turned off: nothing of it stays.
    if (session != null) {
      unawaited(homeCache.clear());
      swarmForgetAvatarImages();
    }
    session?.dispose();
    session = id == null
        ? null
        : (SwarmSession(
            accountId: id,
            request: request,
            upload: upload,
            notices: notices,
            homeCache: homeCache,
            readMarks: readMarks,
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

  /// How an avatar photo goes up ([SwarmHost.uploadAvatar]); null outside
  /// the shell or where none can.
  static SwarmAvatarUpload? uploadAvatarOf(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<SwarmScope>()
      ?.notifier
      ?.uploadAvatar;

  /// The account's computers ([SwarmHost.computers]); null outside the shell
  /// or where none were handed in.
  static SwarmComputers? computersOf(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<SwarmScope>()
      ?.notifier
      ?.computers;

  /// How a chat's mic makes its voice input ([SwarmHost.voice]); null
  /// outside the shell or where none can be heard.
  static VoiceInputController Function()? voiceOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<SwarmScope>()?.notifier?.voice;

  /// The phone's own recognizer for a chat's mic ([SwarmHost.dictation]);
  /// null outside the shell or where there is none.
  static SwarmDictation? dictationOf(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<SwarmScope>()
      ?.notifier
      ?.dictation;
}
