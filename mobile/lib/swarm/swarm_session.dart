import 'dart:async';

import 'package:flutter/widgets.dart';

import '../notify/system_notices.dart';
import '../settings/experimental_features.dart';
import 'swarm_choices.dart';
import 'swarm_inbox.dart';
import 'swarm_notices.dart';
import 'swarm_request.dart';

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
    required SwarmNotices notices,
    Duration pollInterval = const Duration(seconds: 15),
    this.undoWindow = swarmUndoWindow,
  }) : inbox = SwarmInbox(
         accountId: accountId,
         request: request,
         pollInterval: pollInterval,
       ) {
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

  /// How long a decision's answer is held before it is sent.
  final Duration undoWindow;

  late final SwarmAnnouncer _announcer;
  int _screens = 0;
  final _watching = <String, int>{};
  final _held = <String, ({int choice, Timer timer})>{};
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

  /// Answers [need] with option [choice] once [undoWindow] has passed,
  /// unless [undo] takes it back first.
  void hold(SwarmDecisionNeed need, int choice) {
    if (_disposed) return;
    _held.remove(need.key)?.timer.cancel();
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
    _announcer.settle(inbox.needs);
    // Answered somewhere else meanwhile: there is nothing left to send.
    final open = {for (final need in inbox.needs) need.key};
    final gone = [
      for (final key in _held.keys)
        if (!open.contains(key)) key,
    ];
    for (final key in gone) {
      _held.remove(key)!.timer.cancel();
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
    inbox.removeListener(_needsChanged);
    _announcer.clear();
    inbox.dispose();
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
    required this.notices,
    ExperimentalFeaturesStore? features,
  }) : features = features ?? experimentalFeaturesStore {
    account.addListener(_update);
    this.features.addListener(_update);
    _update();
  }

  /// The signed-in account's id; null while nobody is.
  final String? Function() accountId;

  /// Tells when [accountId] may have changed.
  final Listenable account;
  final SwarmRequest request;
  final SwarmNotices notices;
  final ExperimentalFeaturesStore features;

  SwarmSession? session;
  bool _foreground = true;

  set foreground(bool value) {
    _foreground = value;
    session?.foreground = value;
  }

  void _update() {
    final id = features.isOn(PhoneExperiment.swarm) ? accountId() : null;
    if (id == session?.accountId) return;
    session?.dispose();
    session = id == null
        ? null
        : (SwarmSession(accountId: id, request: request, notices: notices)
            ..foreground = _foreground);
    notifyListeners();
  }

  @override
  void dispose() {
    account.removeListener(_update);
    features.removeListener(_update);
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
}
