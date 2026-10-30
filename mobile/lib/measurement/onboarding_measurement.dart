import 'dart:async';

import '../core/local_key_value_store.dart';
import 'product_measurement.dart';

/// Mirrors `PRODUCT_USAGE_ONBOARDING_MARKS` in backend/src/types/productUsage.ts, with the steps
/// each is listed under there ([flows]); another pairing would reject the whole report.
enum OnboardingMark {
  /// A sign-in went through after an attempt in this app run failed or was cancelled.
  retried('retried', {ProductFlow.signIn}),

  /// A sign-in went through on another button than the first one tried in this app run.
  switched('switched', {ProductFlow.signIn}),

  /// The sign-in created the account: minutes old, its first Harness sign-in anywhere. Under the steps
  /// after it as well, each counted once in such a sign-in, so the new people's funnel reads apart
  /// from everyone who signs in again ([newAccountOk] for how it ended).
  newAccount('new_account', {
    ProductFlow.signIn,
    ProductFlow.computerWait,
    ProductFlow.sessionOpen,
    ProductFlow.firstMessage,
  }),

  /// The step ended `ok` in a sign-in that created the account ([newAccount]).
  newAccountOk('new_account_ok', {
    ProductFlow.computerWait,
    ProductFlow.sessionOpen,
    ProductFlow.firstMessage,
  }),

  /// The step started in an app run that did not sign in: reopened mid-step, not a new start.
  resumed('resumed', {
    ProductFlow.computerWait,
    ProductFlow.sessionOpen,
    ProductFlow.firstMessage,
  }),

  /// "Not you? Sign out" under the account the computer has to sign in to.
  notYou('not_you', {ProductFlow.computerWait}),

  /// The computer's address sent from the phone (share sheet).
  linkShared('link_shared', {ProductFlow.computerWait}),

  /// The computer the wait was for turned up after the app had left the wait: a launch later found it
  /// on the account. That wait never saw it, so it has no `ok` of its own.
  joinedAfterLeaving('joined_after_leaving', {ProductFlow.computerWait}),

  /// The joining computer wants its password before its session can open.
  blockedPassword('blocked_password', {ProductFlow.sessionOpen}),

  /// The joining computer is offline, as the account says too.
  blockedOffline('blocked_offline', {ProductFlow.sessionOpen});

  const OnboardingMark(this.wire, this.flows);
  final String wire;
  final Set<ProductFlow> flows;
}

/// The phone's onboarding after sign-in, as fixed flows that hand over to each other: waiting for a
/// computer → opening its session → the first message sent there → the notification prompt.
///
/// Counts and duration buckets only, through [ProductMeasurement]: no account, computer, session,
/// message or answer text, and nothing at all unless the account shares product usage.
///
/// Each flow and each mark counts once per sign-in ([reset] on sign-out). Whatever happens before
/// the account's sharing choice has loaded — right after sign-in — waits here: a step is counted
/// from when it really started once sharing is confirmed, and nothing waiting is counted once the
/// choice reads off. A step that ends before then is never counted; the sign-in itself, which
/// always does, is the exception ([signedIn]).
class OnboardingMeasurement {
  OnboardingMeasurement(this._usage, {this.storage}) {
    _usage.addListener(_admit);
  }

  final ProductMeasurement _usage;

  /// Where a wait for a computer is remembered across launches ([waitingKey]): a yes or nothing, never
  /// sent. None (a test, the sample): nothing outlives the run.
  final LocalKeyValueStore? storage;

  /// Set while a wait for a computer is open, cleared once it ends or the account signs out. A launch
  /// that finds it set and a computer on the account counts [OnboardingMark.joinedAfterLeaving].
  static const waitingKey = 'onboarding_computer_wait_open';

  /// How old an account may be at its sign-in to count as made by it ([accountCreated]). Its record is
  /// written by the first Harness sign-in anywhere, seconds before the profile is read; the margin is
  /// for a slow sign-in and for this phone's clock.
  static const newAccountWithin = Duration(minutes: 15);
  final _waiting = <ProductFlow, ({Stopwatch watch, bool resumed})>{};
  final _running = <ProductFlow, void Function(ProductOutcome)>{};
  final _seen = <ProductFlow>{};
  final _signedIn = <ProductFlow, Duration>{};
  final _marks = <(ProductFlow, OnboardingMark)>{};
  final _marked = <(ProductFlow, OnboardingMark)>{};
  bool _signedInThisRun = false;
  ProductFlow? _firstMethod;
  bool _troubled = false;

  /// This sign-in created the account ([accountCreated]).
  bool _newAccount = false;

  /// The steps of this sign-in that were counted, and those of them that ended `ok`: the profile can
  /// be read after either, and a step never counted (it ended before sharing was known) marks nothing.
  final _begun = <ProductFlow>{};
  final _ok = <ProductFlow>{};

  /// A sign-in attempt by [method] ended with [outcome]. Kept in RAM for this app run only: before
  /// an account there is nobody's choice to ask, so it is counted — as [OnboardingMark.retried] or
  /// [OnboardingMark.switched] — only with a sign-in that goes through ([signedIn]).
  void attempted(ProductFlow method, ProductOutcome outcome) {
    _firstMethod ??= method;
    if (outcome == ProductOutcome.failed ||
        outcome == ProductOutcome.cancelled) {
      _troubled = true;
    }
  }

  /// A sign-in by [method] went through after [took]. Counted under the account's own sharing — a
  /// far larger group than the signed-out opt-in — as `sign_in` and the button, both ok.
  void signedIn(ProductFlow method, Duration took) {
    _signedInThisRun = true;
    _signedIn[ProductFlow.signIn] = took;
    _signedIn[method] = took;
    if (_troubled) _marks.add((ProductFlow.signIn, OnboardingMark.retried));
    if (_firstMethod != null && _firstMethod != method) {
      _marks.add((ProductFlow.signIn, OnboardingMark.switched));
    }
    _firstMethod = null;
    _troubled = false;
    _admit();
  }

  /// Starts [flow] the first time it is asked for in this sign-in; build methods may call it on
  /// every frame. Started in an app run that did not sign in, it is counted with
  /// [OnboardingMark.resumed] as well.
  void start(ProductFlow flow) {
    if (!_seen.add(flow)) return;
    if (flow == ProductFlow.computerWait) _rememberWaiting(true);
    _waiting[flow] = (
      watch: Stopwatch()..start(),
      resumed: !_signedInThisRun && OnboardingMark.resumed.flows.contains(flow),
    );
    _admit();
  }

  /// Ends [flow] with [outcome] if it is running; otherwise nothing.
  void end(ProductFlow flow, ProductOutcome outcome) {
    if (flow == ProductFlow.computerWait && _seen.contains(flow)) {
      _rememberWaiting(false);
    }
    _waiting.remove(flow);
    final running = _running.remove(flow);
    running?.call(outcome);
    if (running != null && outcome == ProductOutcome.ok) {
      _ok.add(flow);
      if (_newAccount) _markNew(flow, OnboardingMark.newAccountOk);
    }
  }

  /// The account's profile, read after a sign-in in this run: one created by it ([newAccountWithin])
  /// counts [OnboardingMark.newAccount]. [createdAt] is the account record's; null says nothing.
  void accountCreated(DateTime? createdAt, {DateTime? now}) {
    if (!_signedInThisRun || createdAt == null) return;
    final age = (now ?? DateTime.now()).difference(createdAt);
    // A record from the future is this phone's clock running behind, by as much as the margin allows.
    if (age > newAccountWithin || age < -newAccountWithin) return;
    if (!_marked.add((ProductFlow.signIn, OnboardingMark.newAccount))) return;
    _marks.add((ProductFlow.signIn, OnboardingMark.newAccount));
    _newAccount = true;
    // Steps counted — or ended `ok` — before the profile was read are the new account's too.
    for (final flow in _begun) {
      _markNew(flow, OnboardingMark.newAccount);
    }
    for (final flow in _ok) {
      _markNew(flow, OnboardingMark.newAccountOk);
    }
    _admit();
  }

  /// [what] of [flow], once per sign-in, for a step of a new account ([OnboardingMark.newAccount],
  /// [OnboardingMark.newAccountOk]); [_admit] counts it.
  void _markNew(ProductFlow flow, OnboardingMark what) {
    if (!what.flows.contains(flow) || !_marked.add((flow, what))) return;
    _marks.add((flow, what));
  }

  /// The account's computers have been read and it has at least one. A wait for a computer that a
  /// launch before this one left open ([waitingKey]) ended there: counted once as
  /// [OnboardingMark.joinedAfterLeaving]. Nothing once this sign-in has a wait of its own, open or
  /// ended: it saw the computer itself (`ok`), or is still looking — asked again after the read below
  /// too, which a wait may end meanwhile.
  Future<void> computersSeen() async {
    final storage = this.storage;
    if (storage == null || _seen.contains(ProductFlow.computerWait)) return;
    String? open;
    try {
      open = await storage.read(waitingKey);
    } catch (_) {
      return;
    }
    if (open == null || _seen.contains(ProductFlow.computerWait)) return;
    _rememberWaiting(false);
    if (!_marked.add((
      ProductFlow.computerWait,
      OnboardingMark.joinedAfterLeaving,
    ))) {
      return;
    }
    _marks.add((ProductFlow.computerWait, OnboardingMark.joinedAfterLeaving));
    _admit();
  }

  /// Best effort: a flag not written costs one [OnboardingMark.joinedAfterLeaving] at most.
  void _rememberWaiting(bool open) {
    final storage = this.storage;
    if (storage == null) return;
    unawaited(
      (open ? storage.write(waitingKey, '1') : storage.delete(waitingKey))
          .catchError((Object _) {}),
    );
  }

  /// Counts [what] of [flow], once per sign-in; build methods may call it on every frame. Only for
  /// a step this sign-in has [start]ed — the same screens outside the onboarding count nothing — and
  /// one [what] is listed under.
  void mark(ProductFlow flow, OnboardingMark what) {
    if (!_seen.contains(flow) || !what.flows.contains(flow)) return;
    if (!_marked.add((flow, what))) return;
    _marks.add((flow, what));
    _admit();
  }

  /// Asks the OS for notifications through [ask], counting the answer: allowed is `ok`, refused is
  /// `cancelled`, no answer is `unknown`.
  Future<void> askNotifications(Future<bool?> Function() ask) async {
    start(ProductFlow.notifyPermission);
    final allowed = await ask();
    end(ProductFlow.notifyPermission, switch (allowed) {
      true => ProductOutcome.ok,
      false => ProductOutcome.cancelled,
      null => ProductOutcome.unknown,
    });
  }

  /// Signed out: whatever was still running was abandoned, and the next sign-in starts afresh.
  void reset() {
    for (final flow in [..._running.keys]) {
      end(flow, ProductOutcome.cancelled);
    }
    // A wait this account left open is not the next account's.
    _rememberWaiting(false);
    _clearWaiting();
    _seen.clear();
    _marked.clear();
    _begun.clear();
    _ok.clear();
    _newAccount = false;
    _signedInThisRun = false;
    _firstMethod = null;
    _troubled = false;
  }

  void _clearWaiting() {
    _waiting.clear();
    _signedIn.clear();
    _marks.clear();
  }

  void _admit() {
    if (_usage.declined) return _clearWaiting();
    if (!_usage.sharing) return;
    for (final MapEntry(key: flow, value: step) in [..._waiting.entries]) {
      _waiting.remove(flow);
      _running[flow] = _usage.begin(flow, elapsed: step.watch.elapsed);
      _begun.add(flow);
      if (step.resumed) _usage.mark(flow, OnboardingMark.resumed.wire);
      if (_newAccount) _markNew(flow, OnboardingMark.newAccount);
    }
    for (final MapEntry(key: flow, value: took) in [..._signedIn.entries]) {
      _signedIn.remove(flow);
      _usage.begin(flow, elapsed: took)(ProductOutcome.ok);
    }
    for (final (flow, what) in [..._marks]) {
      _marks.remove((flow, what));
      _usage.mark(flow, what.wire);
    }
  }

  void dispose() {
    _usage.removeListener(_admit);
    _clearWaiting();
    _running.clear();
  }
}
