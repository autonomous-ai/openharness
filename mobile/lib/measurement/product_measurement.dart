import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';

/// Mirrors `PRODUCT_USAGE_FLOWS` in backend/src/types/productUsage.ts; a wire name the backend
/// does not list rejects the whole report. Everything up to [signIn] can happen before an account.
enum ProductFlow {
  setup('setup'),
  setupHarness('setup_harness'),
  setupTmux('setup_tmux'),
  setupClipboard('setup_clipboard'),
  signInScan('sign_in_scan'),
  signInGoogle('sign_in_google'),
  signInApple('sign_in_apple'),
  signInEmail('sign_in_email'),
  signIn('sign_in'),
  workspaceConnect('workspace_connect'),
  computerLink('computer_link'),
  remoteConnect('remote_connect'),
  viewerOpen('viewer_open'),
  updateCheck('update_check'),
  updateStage('update_stage'),
  // From the backend's `HEALTH_FLOWS` (productHealthContract.ts), counted as the desktop counts them.
  appStart('app_start'),
  connectUser('connect_user'),
  connectAuto('connect_auto'),
  resumeRecovery('resume_recovery'),
  computerWait('computer_wait'),
  sessionOpen('session_open'),
  firstMessage('first_message'),
  notifyPermission('notify_permission');

  const ProductFlow(this.wire);
  final String wire;

  /// Whether a signed-out session that opted in may count it.
  bool get beforeSignIn => index <= ProductFlow.signIn.index;

  /// Mirrors `PRODUCT_USAGE_LONG_FLOWS`: a step that can take hours, whose over_1m is split further.
  bool get long => this == computerWait || this == firstMessage;
}

enum ProductOutcome { ok, failed, cancelled, unknown }

/// Mirrors `PRODUCT_USAGE_PHONE_SCREENS` in backend/src/types/productUsage.ts: the phone's two side
/// pages, Find and Computers.
enum PhoneScreen { find, computers }

/// Mirrors `PRODUCT_USAGE_SCREEN_OPENINGS`: a sideways swipe on the terminal, or anything the person
/// pressed instead — a key, a row, a screen reader's action.
enum ScreenOpening { swipe, button }

typedef ProductReportRequest = Future<Map<String, dynamic>> Function(
  Map<String, dynamic> report,
);
typedef ProductChoiceRequest = Future<Map<String, dynamic>> Function();

/// Fixed counters only: no event log, identifiers, errors, request/response objects or content.
/// Counters stay in RAM; a close/crash can lose queued counts. The one thing kept is the signed-out
/// choice, in [setupStorage]: on by default, as the desktop's is, until it is turned off.
/// Requests and retries are serialized and never awaited by a product action.
class ProductMeasurement extends ChangeNotifier {
  ProductMeasurement({
    required this.surface,
    required this.sendSetup,
    DateTime Function()? now,
    String Function()? receipt,
    this.automatic = true,
    this.setupStorage,
  }) : assert(const ['desktop', 'phone', 'web'].contains(surface)),
       _now = now ?? DateTime.now,
       _receipt = receipt ?? newProductReceipt {
    setupChoiceReady = _loadSetupChoice();
  }

  final String surface;
  final ProductReportRequest sendSetup;
  final bool automatic;
  final DateTime Function() _now;
  final String Function() _receipt;
  bool signedOutSharing = false, choiceLoaded = false;

  /// Where the signed-out choice is kept, across launches. With none — a test, the sample — there is
  /// nowhere to keep an opt-out, so sharing starts off and is only ever an explicit choice.
  final LocalKeyValueStore? setupStorage;
  static const setupPreferenceKey = 'product_setup_sharing';

  /// Kept for an opt-out made signed out that the account has not confirmed yet — the desktop's own
  /// value, so the next sign-in turns the account's sharing off as well.
  static const pendingSetupOptOut =
      '{"enabled":false,"accountOptOutPending":true}';

  /// Done once the kept choice is read: until then nothing is counted signed out.
  late final Future<void> setupChoiceReady;

  /// Kept in [setupStorage] once this install's first launch has been counted ([noteFirstOpen]): a yes,
  /// never sent.
  static const firstOpenKey = 'product_first_open_counted';
  bool _firstOpenPending = false;

  /// Done once the latest choice is written.
  Future<void> get setupChoiceSaved => _setupSave ?? Future<void>.value();
  Future<void>? _setupSave;
  String? _persistedSetupChoice;
  bool _accountOptOutPending = false;
  int _setupChoiceGeneration = 0;

  /// Turned off signed out, and not yet carried to the account: the next account read asks it to
  /// turn sharing off (`AppNotifier.productUsageSettings`), and nothing is counted for it until then.
  bool get accountOptOutPending => _sharingByDefault && _accountOptOutPending;

  /// Signed-out reports say which kind they are: `sharing: 'default'` where sharing starts on (as on
  /// the desktop — not consent), `consent: true` where it was only ever ticked.
  bool get _sharingByDefault => setupStorage != null && surface != 'web';

  /// Which build reports: `{surface, release, platform, channel}`, as backend
  /// `ProductUsageContext` takes it. Sent with the account's reports only, so the totals split by
  /// release and by platform; a `development` build's reports are not kept. Null: no context.
  Map<String, String>? context;
  String? _coverageDay;
  bool _disposed = false;
  Object? _account;
  bool? _enabled;
  int _revision = -1, _accountEpoch = 0, _guestEpoch = 0;
  ProductChoiceRequest? _readChoice;
  ProductReportRequest? _sendAccount;
  Timer? _timer;
  DateTime? _lastAttempt;
  final _active = <Object, String>{};
  Future<void>? _flushing;
  final _days = <String, Map<String, int>>{};
  final _pending = <String, Map<String, dynamic>>{};
  final _setup = <ProductFlow, void Function(ProductOutcome)>{};
  final _setupFacts = <ProductFlow, String>{};

  bool get sharing =>
      _account != null &&
      _enabled == true &&
      (!_sharingByDefault || choiceLoaded) &&
      !accountOptOutPending;

  /// Moves with every account or choice change: an observation begun before one never counts after.
  int get observationGeneration => _accountEpoch;

  /// The account's choice has read off: what waits to be counted for it never is.
  bool get declined => _account != null && _enabled == false;
  bool get _setupAllowed =>
      surface != 'web' &&
      signedOutSharing &&
      (_account == null || _enabled == true);

  /// The kept choice: on unless it was turned off. One that cannot be read is an opt-out still to
  /// carry to the account, as on the desktop — it must never come back on for an unreadable file.
  Future<void> _loadSetupChoice() async {
    final storage = setupStorage;
    if (storage == null) {
      choiceLoaded = true;
      return;
    }
    final generation = _setupChoiceGeneration;
    String? value;
    try {
      value = await storage.read(setupPreferenceKey);
    } catch (_) {
      value = pendingSetupOptOut;
    }
    // Ticked or unticked meanwhile, or the account answered: that word stands.
    if (_disposed || generation != _setupChoiceGeneration) return;
    _persistedSetupChoice = value;
    _accountOptOutPending =
        value != null && value != 'true' && value != 'false';
    signedOutSharing = surface != 'web' && (value == null || value == 'true');
    choiceLoaded = true;
    if (signedOutSharing) _observeSetupFacts();
    notifyListeners();
  }

  /// The signed-out choice. [fromAccount]: the account's own confirmed choice, remembered for the next
  /// signed-out launch — not an opt-out to carry to it.
  Future<void> setSignedOutSharing(
    bool enabled, {
    bool fromAccount = false,
  }) async {
    _setupChoiceGeneration++;
    _accountOptOutPending = _sharingByDefault && !enabled && !fromAccount;
    if (accountOptOutPending) {
      _accountEpoch++;
      _clear('ui');
    }
    if (signedOutSharing != enabled || !choiceLoaded) {
      _guestEpoch++;
      signedOutSharing = enabled;
      choiceLoaded = true;
      _clear('setup');
      _setup.clear();
      if (enabled) _observeSetupFacts();
      notifyListeners();
    }
    final storage = setupStorage;
    if (storage == null) return;
    final value = accountOptOutPending
        ? pendingSetupOptOut
        : enabled.toString();
    // One write at a time, so an older one cannot land after a newer off. Best effort: a choice that
    // is not kept still holds for this run.
    final previous = _setupSave;
    final saving = () async {
      if (previous != null) await previous;
      try {
        await storage.write(setupPreferenceKey, value);
        _persistedSetupChoice = value;
      } catch (_) {}
    }();
    _setupSave = saving;
    await saving;
  }

  /// The scope is RAM-only and never serialized. A sign-out or account change discards its queue.
  void account(
    Object? scope, {
    ProductChoiceRequest? choice,
    ProductReportRequest? send,
  }) {
    if (_disposed || scope == _account) return;
    _accountEpoch++;
    _account = scope;
    _enabled = null;
    _revision = -1;
    _readChoice = choice;
    _sendAccount = send;
    _clear('ui');
    if (scope != null && automatic) unawaited(flush());
    _schedule();
    _countFirstOpen();
  }

  /// A saved switch applies immediately in this app, even while a report is in flight. [explicit]: the
  /// person set it just now (Settings ▸ Privacy), which also settles an opt-out still to carry.
  void savedChoice(Map<String, dynamic> value, {bool explicit = false}) {
    final enabled = value['enabled'], revision = value['revision'];
    if (enabled is! bool || revision is! int || revision < 0) {
      _enabled = null;
      return;
    }
    // A default-on answer before this phone's own choice is read waits for it: it may be an opt-out.
    if (_sharingByDefault && !choiceLoaded && enabled && !explicit) {
      _enabled = null;
      return;
    }
    if (revision != _revision || !enabled) {
      _accountEpoch++;
      _clear('ui');
    }
    _revision = revision;
    _enabled = enabled;
    if (_sharingByDefault &&
        (!accountOptOutPending || !enabled || explicit) &&
        (signedOutSharing != enabled ||
            !choiceLoaded ||
            accountOptOutPending ||
            _persistedSetupChoice != enabled.toString())) {
      // The account's confirmed choice is the phone's next signed-out one, as on the desktop.
      unawaited(setSignedOutSharing(enabled, fromAccount: true));
    }
    if (!enabled) {
      _guestEpoch++;
      signedOutSharing = false;
      _clear('setup');
      _setup.clear();
    }
    _countFirstOpen();
    notifyListeners();
  }

  /// This install's first launch, counted once: `setup_phone_first_open` signed out — the usual first
  /// launch, after a store's download — or `ui_phone_first_open` on an account that shares, if it opens
  /// signed in. The step between the download and a sign-in, which nothing else counts.
  ///
  /// The flag is written before anything is counted, so a first launch that may not count it (sharing
  /// off) never has a later launch counted as the first. Nothing without [setupStorage] (a test, the
  /// sample), and nothing on the web.
  Future<void> noteFirstOpen() async {
    final storage = setupStorage;
    if (storage == null || surface != 'phone') return;
    await setupChoiceReady;
    if (_disposed) return;
    try {
      if (await storage.read(firstOpenKey) != null) return;
      await storage.write(firstOpenKey, '1');
    } catch (_) {
      return;
    }
    if (_disposed) return;
    _firstOpenPending = true;
    _countFirstOpen();
  }

  /// [noteFirstOpen]'s count, on whichever channel may take it first; dropped once neither ever will.
  void _countFirstOpen() {
    if (!_firstOpenPending || _disposed) return;
    final channel = _account == null && _setupAllowed
        ? 'setup'
        : sharing
        ? 'ui'
        : null;
    if (channel == null) {
      // Off signed out, or the account's choice read off: this launch is not counted, now or later.
      if (_account == null ? choiceLoaded && !signedOutSharing : declined) {
        _firstOpenPending = false;
      }
      return;
    }
    _firstOpenPending = false;
    _count(
      channel,
      _now().toUtc().toIso8601String().substring(0, 10),
      '${channel}_${surface}_first_open',
    );
  }

  void _clear(String channel) {
    _days.removeWhere((key, _) => key.startsWith('$channel:'));
    _pending.remove(channel);
    _active.removeWhere((_, value) => value == channel);
    if (channel == 'ui') _coverageDay = null;
  }

  /// Sends what the account has queued before a sign-out discards it ([account]): a step ended by
  /// signing out, and why. At most [within]; what is still queued then is lost as before.
  Future<void> sendBeforeSignOut({
    Duration within = const Duration(seconds: 2),
  }) async {
    final watch = Stopwatch()..start();
    for (var round = 0; round < 3; round++) {
      if (_disposed || !sharing || !_queued('ui') || watch.elapsed >= within) {
        return;
      }
      try {
        await flush().timeout(within - watch.elapsed);
      } on TimeoutException {
        return;
      }
    }
  }

  /// Sends what is queued on either channel, at most [within]: the app is leaving the screen, where iOS
  /// suspends it within seconds and may end it unannounced, and every count still in RAM goes with it.
  /// On 2026-10-19 the phone's signed-out screen counted 17 sign-ins that went through and the
  /// accounts counted 9; counts lost this way are the likely gap, since a sign-in is often followed
  /// by leaving for the computer to install Harness, before the minute's report. An account whose
  /// sharing choice is still unread is asked first, which also counts what waits on that answer
  /// (`OnboardingMeasurement`).
  Future<void> sendBeforeBackground({
    Duration within = const Duration(seconds: 2),
  }) async {
    final watch = Stopwatch()..start();
    for (var round = 0; round < 3; round++) {
      final unread =
          round == 0 &&
          _account != null &&
          _readChoice != null &&
          _enabled == null;
      final queued =
          (sharing && _queued('ui')) || (_setupAllowed && _queued('setup'));
      if (_disposed || !(unread || queued) || watch.elapsed >= within) return;
      try {
        await flush().timeout(within - watch.elapsed);
      } on TimeoutException {
        return;
      }
      // A report a flush leaves pending was refused or lost: it waits for the next timer, which
      // keeps retries to one a minute, rather than going again at once.
      if (_pending.isNotEmpty) {
        return;
      }
    }
  }

  bool _queued(String channel) =>
      _pending.containsKey(channel) ||
      _days.keys.any((key) => key.startsWith('$channel:'));

  /// [elapsed] is time the flow already ran before it could be counted; it lands in the duration.
  void Function(ProductOutcome) begin(
    ProductFlow flow, {
    Duration elapsed = Duration.zero,
  }) {
    final channel = sharing
        ? 'ui'
        : flow.beforeSignIn && _setupAllowed
        ? 'setup'
        : null;
    if (_disposed || channel == null || _active.length >= 64) return (_) {};
    final epoch = channel == 'setup' ? _guestEpoch : _accountEpoch;
    final started = _now().toUtc();
    final watch = Stopwatch()..start();
    final day = started.toIso8601String().substring(0, 10);
    final prefix = '${channel}_${surface}_${flow.wire}_';
    final ticket = Object();
    _active[ticket] = channel;
    _count(channel, day, '${prefix}started');
    var done = false;
    return (outcome) {
      if (done) return;
      done = true;
      if (_active.remove(ticket) == null) return;
      watch.stop();
      if (_disposed ||
          (channel == 'setup'
              ? epoch != _guestEpoch || !signedOutSharing || _enabled == false
              : epoch != _accountEpoch || !sharing)) {
        return;
      }
      _count(channel, day, '$prefix${outcome.name}');
      final ms = watch.elapsedMilliseconds + elapsed.inMilliseconds;
      _count(
        channel,
        day,
        '$prefix${ms < 1000
            ? 'under_1s'
            : ms < 10000
            ? '1s_to_10s'
            : ms < 60000
            ? '10s_to_1m'
            : 'over_1m'}',
      );
      if (!flow.long || ms < 60000) return;
      _count(
        channel,
        day,
        '$prefix${ms < 300000
            ? '1m_to_5m'
            : ms < 900000
            ? '5m_to_15m'
            : ms < 3600000
            ? '15m_to_1h'
            : 'over_1h'}',
      );
    };
  }

  /// Counts [measure] of [flow] — one of `PRODUCT_USAGE_ONBOARDING_MARKS` — for an account that shares.
  void mark(ProductFlow flow, String measure) {
    if (_disposed || !sharing) return;
    final day = _now().toUtc().toIso8601String().substring(0, 10);
    _count('ui', day, 'ui_${surface}_${flow.wire}_$measure');
  }

  /// [screen] opened, by [how] — `ui_phone_screen_<screen>_<how>`, which the backend names for the phone
  /// alone. For an account that shares; which page and which way, nothing more.
  void screenOpened(PhoneScreen screen, ScreenOpening how) {
    if (_disposed || !sharing || surface != 'phone') return;
    final day = _now().toUtc().toIso8601String().substring(0, 10);
    _count('ui', day, 'ui_${surface}_screen_${screen.name}_${how.name}');
  }

  /// One attempt counted under several flows at once — `sign_in` and the button that started it.
  void Function(ProductOutcome) beginEach(List<ProductFlow> flows) {
    final finishers = [for (final flow in flows) begin(flow)];
    return (outcome) {
      for (final finish in finishers) {
        finish(outcome);
      }
    };
  }

  /// The adapter hands over only enum-derived status names, never setup logs or commands.
  void setupFacts(Map<ProductFlow, String> facts) {
    _setupFacts
      ..clear()
      ..addAll(facts);
    _observeSetupFacts();
  }

  void _observeSetupFacts() {
    if (!_setupAllowed && !sharing) return;
    for (final entry in _setupFacts.entries) {
      if (!entry.key.beforeSignIn || entry.key == ProductFlow.signIn) continue;
      if (const ['pending', 'running', 'needsTerminal'].contains(entry.value)) {
        _setup.putIfAbsent(entry.key, () => begin(entry.key));
      } else if (const [
        'ready',
        'notApplicable',
        'failed',
        'unavailable',
      ].contains(entry.value)) {
        _setup
            .remove(entry.key)
            ?.call(
              const ['ready', 'notApplicable'].contains(entry.value)
                  ? ProductOutcome.ok
                  : ProductOutcome.failed,
            );
      }
    }
  }

  void _count(String channel, String day, String metric) {
    final today = _now().toUtc();
    final date = DateTime.parse(day);
    if (today.difference(date).inDays > 1 || date.isAfter(today)) return;
    _days.removeWhere(
      (key, _) =>
          today.difference(DateTime.parse(key.split(':')[1])).inDays > 1,
    );
    final counters = _days.putIfAbsent('$channel:$day', () => {});
    counters[metric] = min(1000, (counters[metric] ?? 0) + 1);
    // One collector day per app run and UTC day: the backend shows a release or platform split
    // only above a floor of these.
    if (channel == 'ui' && context != null && _coverageDay != day) {
      _coverageDay = day;
      counters['health_${surface}_collector_days'] = 1;
    }
    _schedule();
  }

  void _schedule() {
    if (!automatic ||
        _disposed ||
        _timer != null ||
        (_account == null && _days.isEmpty && _pending.isEmpty)) {
      return;
    }
    final delay = _lastAttempt == null
        ? const Duration(seconds: 2)
        : Duration(
            milliseconds: max(
              1000,
              60000 - _now().difference(_lastAttempt!).inMilliseconds,
            ),
          );
    _timer = Timer(delay, () {
      _timer = null;
      unawaited(flush());
    });
  }

  Future<void> flush() => _flushing ??= _flush().whenComplete(() {
    _flushing = null;
    _schedule();
  });

  Future<void> _flush() async {
    if (_disposed) return;
    _lastAttempt = _now();
    final account = _account, read = _readChoice;
    final choiceEpoch = _accountEpoch;
    if (account != null && read != null) {
      try {
        final choice = await read();
        if (_disposed || account != _account || choiceEpoch != _accountEpoch) {
          return;
        }
        savedChoice(choice);
      } catch (_) {
        _enabled = null;
        return;
      }
    }
    for (final channel in ['setup', 'ui']) {
      if (_disposed || (channel == 'setup' ? !_setupAllowed : !sharing)) {
        continue;
      }
      final epoch = channel == 'setup' ? _guestEpoch : _accountEpoch;
      var report = _pending[channel];
      if (report == null) {
        final keys = _days.keys.where((k) => k.startsWith('$channel:')).toList()
          ..sort();
        if (keys.isEmpty) continue;
        final key = keys.first, counts = _days[key]!;
        final batch = Map<String, int>.fromEntries(counts.entries.take(32));
        for (final metric in batch.keys) {
          counts.remove(metric);
        }
        if (counts.isEmpty) _days.remove(key);
        report = {
          'schemaVersion': 1,
          'id': _receipt(),
          'day': key.split(':')[1],
          'counters': batch,
          if (channel == 'setup' && _sharingByDefault)
            'sharing': 'default'
          else if (channel == 'setup')
            'consent': true
          else
            'revision': _revision,
          if (channel == 'ui' && context != null) 'context': context,
        };
        _pending[channel] = report;
      }
      if (_now()
              .toUtc()
              .difference(DateTime.parse(report['day'] as String))
              .inDays >
          1) {
        _pending.remove(channel);
        continue;
      }
      try {
        final result = await (channel == 'setup' ? sendSetup : _sendAccount!)(
          report,
        );
        if (_disposed ||
            (channel == 'setup'
                ? epoch != _guestEpoch
                : epoch != _accountEpoch)) {
          continue;
        }
        if (result['accepted'] == true || result['reason'] == 'EXPIRED') {
          _pending.remove(channel);
        }
        if (result['reason'] == 'CHOICE_CHANGED') {
          _enabled = null;
          _clear('ui');
          _clear('setup');
        }
      } catch (_) {
        /* Same receipt on the next timer. No logs, aggressive retry, or product failure. */
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _days.clear();
    _pending.clear();
    _setup.clear();
    _active.clear();
    super.dispose();
  }
}

String newProductReceipt() {
  final random = Random.secure();
  final bytes = List.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  final h = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}
