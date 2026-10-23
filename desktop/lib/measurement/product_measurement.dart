import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import 'product_health_contract.dart';
import 'product_report_failure.dart';
export 'product_health_contract.dart';

enum ProductFlow {
  setup('setup'),
  setupHarness('setup_harness'),
  setupTmux('setup_tmux'),
  setupClipboard('setup_clipboard'),
  signIn('sign_in'),
  workspaceConnect('workspace_connect'),
  computerLink('computer_link'),
  remoteConnect('remote_connect'),
  viewerOpen('viewer_open'),
  updateCheck('update_check'),
  updateStage('update_stage'),
  appStart('app_start'),
  workspaceReady('workspace_ready'),
  viewerLoad('viewer_load'),
  updateApply('update_apply'),
  updateRelaunch('update_relaunch'),
  connectUser('connect_user'),
  connectAuto('connect_auto'),
  resumeRecovery('resume_recovery'),
  // The Add Phone card (widgets/phone_offer_card.dart), offered once per computer: begun when it is on
  // screen, ok by its Add Phone, cancelled by its ×, unknown when it goes another way.
  phoneOffer('phone_offer'),
  shareInvite('share_invite'),
  shareAccept('share_accept'),
  // The same card offered once to a computer that never had it, after one of its own harnesses
  // finished a turn (`AppNotifier._offerPhoneAfterWork`): counted apart, so the two offers read apart.
  phoneOfferAfterWork('phone_offer_after_work'),
  // The same card offered when the person comes back after five minutes or more away to a harness
  // that waited on them, or one that finished (`AppNotifier._offerPhoneAway`), each counted apart.
  phoneOfferAwayWaited('phone_offer_away_waited'),
  phoneOfferAwayFinished('phone_offer_away_finished'),
  // The phone's own flows, listed so this enum names every flow the phone's copy does; the desktop
  // never begins them.
  signInScan('sign_in_scan'),
  signInGoogle('sign_in_google'),
  signInApple('sign_in_apple'),
  signInEmail('sign_in_email'),
  computerWait('computer_wait'),
  sessionOpen('session_open'),
  firstMessage('first_message'),
  notifyPermission('notify_permission');

  const ProductFlow(this.wire);
  final String wire;
  bool get beforeSignIn => index <= ProductFlow.signIn.index;

  /// The revision of the local CLI's report proxy that knows this flow's
  /// names, as [ProductHealthMeasure.vocabulary] — but its counts wait in the
  /// queue for that answer instead of being skipped ([ProductMeasurement]).
  int get vocabulary => switch (this) {
    phoneOffer => 3,
    shareInvite || shareAccept => 5,
    phoneOfferAfterWork || phoneOfferAwayWaited || phoneOfferAwayFinished => 4,
    _ => 1,
  };

  /// Ended only by what the person does, never by the 15-minute observation
  /// bound: the card waits beside the work until it is used or put away, and
  /// an Add Phone pressed after 15 minutes would otherwise be lost to unknown.
  bool get unbounded =>
      this == phoneOffer ||
      this == phoneOfferAfterWork ||
      this == phoneOfferAwayWaited ||
      this == phoneOfferAwayFinished;
}

enum ProductOutcome { ok, failed, cancelled, unknown }

/// Where Add Phone was opened from, counted each time it opens
/// (`ui_desktop_add_phone_<wire>`): which way in, nothing else.
enum AddPhoneOpening {
  /// The Add Phone card's own button ([ProductFlow.phoneOffer]).
  offer('offer'),

  /// The title bar's phone: the native one on macOS, the tab row's elsewhere.
  titlebar('titlebar'),

  /// Harness ▸ Add Phone… in the macOS app menu, or a key bound to it there.
  menu('menu'),

  /// The account menu's Add Phone.
  account('account'),

  /// The Machines picker's Add Phone.
  machines('machines'),

  /// The `app.add_phone` command: `> add phone` in the palette, a key bound
  /// to it outside the macOS menu, the start guide's phone row (shown only
  /// without the New Harness box).
  command('command');

  const AddPhoneOpening(this.wire);
  final String wire;

  /// As [ProductFlow.phoneOffer]'s ([ProductFlow.vocabulary]).
  static const vocabulary = 3;
}

typedef ProductReportRequest = Future<Map<String, dynamic>> Function(
  Map<String, dynamic> report,
);
typedef ProductChoiceRequest = Future<Map<String, dynamic>> Function();

/// Fixed counters only: no event log, identifiers, errors, request/response objects or content.
/// Counters stay in RAM. The separate runtime observer saves only last-run control flags locally.
/// Desktop setup sharing defaults on; only its preference is persisted locally.
/// Counters remain in RAM, so a close/crash can lose queued counts.
/// Requests and retries are serialized and never awaited by a product action.
class ProductMeasurement extends ChangeNotifier {
  ProductMeasurement({
    required this.surface,
    required this.sendSetup,
    DateTime Function()? now,
    String Function()? receipt,
    this.automatic = true,
    this.context,
    LocalKeyValueStore? setupStorage,
  }) : assert(const ['desktop', 'phone', 'web'].contains(surface)),
       _setupStorage = setupStorage,
       _now = now ?? DateTime.now,
       _receipt = receipt ?? newProductReceipt {
    signedOutSharing = surface == 'desktop' && setupStorage == null;
    choiceLoaded = setupStorage == null;
    setupChoiceReady = _loadSetupChoice();
  }

  final String surface;
  ProductUsageContext? context;
  bool get healthEnabled => surface == 'desktop' && context != null;

  /// The counter vocabulary the local CLI's report proxy announced on its
  /// latest answer (`x-harness-usage-vocabulary`): 1, the names every proxy
  /// knows, until one says more. A health measure newer than it is not
  /// counted ([ProductHealthMeasure.vocabulary]).
  int proxyVocabulary = 1;
  String? _coverageDay;
  // The day each once-a-day measure was last counted; cleared with
  // collector_days' own day so the two stay comparable.
  final _countedOn = <ProductHealthMeasure, String>{};
  final _funnelSeen = <String, Set<ProductHealthMeasure>>{};
  final _funnelStarted = <String, DateTime>{};
  DateTime? _firstRunAt;
  bool _firstRunRequested = false;
  (String, String)? _firstRunTarget;
  final _firstRunStages = <String>{};
  bool _setupShown = false;
  final _expires = <Object, DateTime>{};
  final _expire = <Object, void Function(ProductOutcome)>{};
  int get choiceRevision => _revision;
  int get observationGeneration => _accountEpoch;
  final ProductReportRequest sendSetup;
  final bool automatic;
  final DateTime Function() _now;
  final String Function() _receipt;
  bool signedOutSharing = false, choiceLoaded = false;
  static const setupPreferenceKey = 'product_setup_sharing';
  static const pendingSetupOptOut =
      '{"enabled":false,"accountOptOutPending":true}';
  final LocalKeyValueStore? _setupStorage;
  late final Future<void> setupChoiceReady;
  Future<void>? _setupSave;
  Future<void> get setupChoiceSaved => _setupSave ?? Future<void>.value();
  String? _persistedSetupChoice;
  bool _accountOptOutPending = false;
  bool get accountOptOutPending =>
      surface == 'desktop' && _accountOptOutPending;
  int _setupChoiceGeneration = 0;
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
  // Steps whose tool was missing at a check during the span now open; counted once per span.
  final _setupMissing = <ProductFlow>{};

  bool get sharing =>
      _account != null &&
      _enabled == true &&
      (surface != 'desktop' || choiceLoaded) &&
      !accountOptOutPending;
  bool get _setupAllowed =>
      surface != 'web' &&
      (!healthEnabled || context!.production) &&
      choiceLoaded &&
      signedOutSharing &&
      (_account == null || _enabled == true);

  Future<void> _loadSetupChoice() async {
    final storage = _setupStorage;
    if (storage == null) return;
    final generation = _setupChoiceGeneration;
    String? value;
    try {
      value = await storage.read(setupPreferenceKey);
    } catch (_) {
      // An unreadable preference must not turn a saved opt-out back on.
      value = pendingSetupOptOut;
    }
    if (_disposed || generation != _setupChoiceGeneration) return;
    _persistedSetupChoice = value;
    _accountOptOutPending =
        value != null && value != 'true' && value != 'false';
    signedOutSharing = value == null ? surface == 'desktop' : value == 'true';
    choiceLoaded = true;
    _observeSetupFacts();
    notifyListeners();
  }

  Future<void> setSignedOutSharing(
    bool enabled, {
    bool fromAccount = false,
  }) async {
    _setupChoiceGeneration++;
    _accountOptOutPending = surface == 'desktop' && !enabled && !fromAccount;
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
      _setupMissing.clear();
      if (enabled) _observeSetupFacts();
      notifyListeners();
    }
    final storage = _setupStorage;
    if (storage == null) return;
    final value = accountOptOutPending
        ? pendingSetupOptOut
        : enabled.toString();
    // Serialize rapid changes so an older write cannot restore sharing after off.
    final previous = _setupSave;
    final saving = () async {
      if (previous != null) {
        try {
          await previous;
        } catch (_) {}
      }
      await storage.write(setupPreferenceKey, value);
      _persistedSetupChoice = value;
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
    if (_account != null) {
      _guestEpoch++;
      if (surface != 'desktop') signedOutSharing = false;
      _clear('setup');
      _setup.clear();
      _setupMissing.clear();
    }
    _account = scope;
    _enabled = null;
    _revision = -1;
    _readChoice = choice;
    _sendAccount = send;
    _clear('ui');
    if (scope != null && automatic) unawaited(flush());
    _schedule();
  }

  /// A saved switch applies immediately in this app, even while a report is in flight.
  void savedChoice(Map<String, dynamic> value, {bool explicit = false}) {
    final enabled = value['enabled'], revision = value['revision'];
    if (enabled is! bool || revision is! int || revision < 0) {
      _enabled = null;
      return;
    }
    if (surface == 'desktop' && !choiceLoaded && enabled && !explicit) {
      _enabled = null;
      return;
    }
    // Initial preference loading must not omit an eligible first arrival.
    // Keep only its eligibility/current harness, never pre-consent work or responses.
    final firstRunPending = _revision < 0 && _firstRunRequested;
    final firstRunTarget = firstRunPending ? _firstRunTarget : null;
    if (revision != _revision || !enabled) {
      _accountEpoch++;
      _clear('ui');
    }
    _revision = revision;
    _enabled = enabled;
    if (surface == 'desktop' &&
        (!accountOptOutPending || !enabled || explicit) &&
        (signedOutSharing != enabled ||
            !choiceLoaded ||
            accountOptOutPending ||
            (_setupStorage != null &&
                _persistedSetupChoice != enabled.toString()))) {
      // Remember the confirmed account choice for the next signed-out launch.
      // Persistence failure never restores the in-memory sharing it just stopped.
      unawaited(
        setSignedOutSharing(
          enabled,
          fromAccount: true,
        ).catchError((Object _) {}),
      );
    }
    if (!enabled) {
      _guestEpoch++;
      signedOutSharing = false;
      _clear('setup');
      _setup.clear();
      _setupMissing.clear();
    }
    if (firstRunPending && sharing) {
      firstRunStarted();
      if (firstRunTarget case final target?) {
        firstRunReady(target.$1, target.$2);
      }
    }
    notifyListeners();
  }

  void _clear(String channel) {
    _days.removeWhere((key, _) => key.startsWith('$channel:'));
    _pending.remove(channel);
    for (final ticket
        in _active.keys.where((key) => _active[key] == channel).toList()) {
      _active.remove(ticket);
      _expires.remove(ticket);
      _expire.remove(ticket);
    }
    _funnelSeen.remove(channel);
    _funnelStarted.remove(channel);
    if (channel == 'ui') {
      _coverageDay = null;
      _countedOn.clear();
      _firstRunAt = null;
      _firstRunRequested = false;
      _firstRunTarget = null;
      _firstRunStages.clear();
    }
  }

  void _coverage() {
    if (!healthEnabled || !sharing || _disposed) return;
    final day = _now().toUtc().toIso8601String().substring(0, 10);
    if (_coverageDay == day) return;
    _coverageDay = day;
    _count('ui', day, 'health_desktop_collector_days');
  }

  /// Only fixed enum scalars enter the queue. Called after checking the account choice.
  void health(ProductHealthMeasure measure) {
    if (!healthEnabled || !sharing || _disposed) return;
    // A proxy older than this name would refuse every report carrying it.
    if (measure.vocabulary > proxyVocabulary) return;
    _coverage();
    _count(
      'ui',
      _now().toUtc().toIso8601String().substring(0, 10),
      'health_desktop_${measure.wire}',
    );
  }

  /// [measure] at most once per UTC day of this collector, like
  /// collector_days, so its total reads against collector_days: how many
  /// collector days had one, not how many there were.
  void healthOncePerDay(ProductHealthMeasure measure) {
    if (!healthEnabled || !sharing || _disposed) return;
    if (measure.vocabulary > proxyVocabulary) return;
    final day = _now().toUtc().toIso8601String().substring(0, 10);
    if (_countedOn[measure] == day) return;
    _countedOn[measure] = day;
    health(measure);
  }

  /// Observed readiness since process launch; only its coarse duration is kept.
  void observedStartup(Duration elapsed) {
    if (!healthEnabled || !sharing || _disposed) return;
    _coverage();
    final day = _now().toUtc().toIso8601String().substring(0, 10);
    const prefix = 'ui_desktop_app_start_';
    final ms = elapsed.inMilliseconds;
    _count('ui', day, '${prefix}started');
    _count('ui', day, '${prefix}ok');
    _count(
      'ui',
      day,
      '$prefix${ms < 1000
          ? 'under_1s'
          : ms < 10000
          ? '1s_to_10s'
          : ms < 60000
          ? '10s_to_1m'
          : 'over_1m'}',
    );
  }

  /// A sharing-enabled app-session funnel, never a click trail or an account join.
  /// Its clock starts at the first permitted observation, not retrospectively at install.
  void milestone(ProductHealthMeasure measure) {
    if (!healthEnabled || _disposed || !measure.wire.startsWith('funnel_')) {
      return;
    }
    final channel = sharing
        ? 'ui'
        : _setupAllowed
        ? 'setup'
        : null;
    if (channel == null) return;
    final seen = _funnelSeen.putIfAbsent(channel, () => {});
    if (!seen.add(measure)) return;
    final now = _now().toUtc();
    final start = _funnelStarted.putIfAbsent(channel, () => now);
    final day = now.toIso8601String().substring(0, 10);
    if (channel == 'ui') _coverage();
    void count(String name) => _count(
      channel,
      day,
      channel == 'setup' ? 'setup_desktop_$name' : 'health_desktop_$name',
    );
    count(measure.wire);
    if (measure == ProductHealthMeasure.funnelFirstWork ||
        measure == ProductHealthMeasure.funnelFirstResponse) {
      final elapsed = now.difference(start).inSeconds;
      final value = measure == ProductHealthMeasure.funnelFirstWork
          ? 'first_work'
          : 'first_response';
      count(
        '${value}_${elapsed < 60
            ? 'under_1m'
            : elapsed < 300
            ? '1m_to_5m'
            : 'over_5m'}',
      );
    }
  }

  void Function(ProductOutcome) begin(ProductFlow flow) {
    if (flow == ProductFlow.signIn) {
      milestone(ProductHealthMeasure.funnelSignInSeen);
    }
    if (flow.index >= ProductFlow.appStart.index && !healthEnabled) {
      return (_) {};
    }
    _coverage();
    final channel = sharing
        ? 'ui'
        : flow.beforeSignIn && _setupAllowed
        ? 'setup'
        : null;
    if (_disposed || channel == null) return (_) {};
    if (_active.length >= 64) {
      health(ProductHealthMeasure.observationOverflow);
      return (_) {};
    }
    final epoch = channel == 'setup' ? _guestEpoch : _accountEpoch;
    final started = _now().toUtc();
    final watch = Stopwatch()..start();
    final day = started.toIso8601String().substring(0, 10);
    final prefix = '${channel}_${surface}_${flow.wire}_';
    final ticket = Object();
    _active[ticket] = channel;
    _count(channel, day, '${prefix}started');
    var done = false;
    void finish(ProductOutcome outcome) {
      if (done) return;
      done = true;
      if (_active.remove(ticket) == null) return;
      _expires.remove(ticket);
      _expire.remove(ticket);
      watch.stop();
      if (_disposed ||
          (channel == 'setup'
              ? epoch != _guestEpoch || !signedOutSharing || _enabled == false
              : epoch != _accountEpoch || !sharing)) {
        return;
      }
      _count(channel, day, '$prefix${outcome.name}');
      final ms = watch.elapsedMilliseconds;
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
    }

    if (healthEnabled && !flow.unbounded) {
      _expires[ticket] = started.add(const Duration(minutes: 15));
      _expire[ticket] = finish;
    }
    return finish;
  }

  /// Add Phone opened, and from where ([AddPhoneOpening]): one fixed name per
  /// way in, nothing about the dialog or what follows. A signed-in, sharing
  /// Desktop only; the browser has no such names.
  void addPhoneOpened(AddPhoneOpening from) {
    if (!healthEnabled || !sharing || _disposed) return;
    _coverage();
    _count(
      'ui',
      _now().toUtc().toIso8601String().substring(0, 10),
      'ui_desktop_add_phone_${from.wire}',
    );
  }

  /// One first-arrival episode in this app run. Retries share its denominator;
  /// routine launches never call this. Targets stay in RAM and are never reported.
  void firstRunStarted() {
    if (!healthEnabled ||
        _disposed ||
        _account == null ||
        _firstRunAt != null ||
        accountOptOutPending) {
      return;
    }
    if (_enabled == null && _revision < 0) {
      _firstRunRequested = true;
      return;
    }
    if (!sharing) return;
    _firstRunRequested = false;
    _firstRunAt = _now().toUtc();
    _firstRunStage('started');
  }

  /// Counts acknowledged invitation results, never addresses, tab ids or invite ids.
  void sharedInvites({required int sent, required int refused}) {
    if (!healthEnabled || !sharing || _disposed) return;
    _coverage();
    final day = _now().toUtc().toIso8601String().substring(0, 10);
    for (final (name, count) in [('sent', sent), ('refused', refused)]) {
      for (var i = 0; i < count.clamp(0, 1000); i++) {
        _count('ui', day, 'health_desktop_shared_invites_$name');
      }
    }
  }

  void firstRunReady(String machineId, String? agentId) {
    if ((_firstRunAt == null && !_firstRunRequested) || agentId == null) return;
    _firstRunTarget = (machineId, agentId);
    _firstRunStage('ready');
  }

  void firstRunWork(String machineId, String agentId) {
    if (_firstRunTarget == (machineId, agentId)) _firstRunStage('work');
  }

  void firstRunResponse(String machineId, String agentId) {
    if (_firstRunTarget != (machineId, agentId) ||
        !_firstRunStages.contains('work') ||
        _firstRunStages.contains('response')) {
      return;
    }
    _firstRunStage('response');
    final start = _firstRunAt;
    if (start == null || !_firstRunStages.contains('response')) return;
    final seconds = _now().toUtc().difference(start).inSeconds;
    _firstRunStage(
      'response_${seconds < 60
          ? 'under_1m'
          : seconds < 300
          ? '1m_to_5m'
          : 'over_5m'}',
    );
  }

  void _firstRunStage(String stage) {
    final start = _firstRunAt;
    if (!healthEnabled || !sharing || _disposed || start == null) return;
    final elapsed = _now().toUtc().difference(start);
    if (elapsed.isNegative ||
        elapsed > const Duration(hours: 24) ||
        !_firstRunStages.add(stage)) {
      return;
    }
    _coverage();
    _count(
      'ui',
      start.toIso8601String().substring(0, 10),
      'health_desktop_first_run_$stage',
    );
  }

  /// Called only when setup is actually visible. A successful readiness probe
  /// on a normal launch is not an impression of setup.
  void setupShown() {
    _setupShown = true;
    milestone(ProductHealthMeasure.funnelSetupSeen);
  }

  void setupHidden() => _setupShown = false;

  /// The proxy revision ([proxyVocabulary]) that forwards [metric]: the Add
  /// Phone card's flow and the ways Add Phone opened are 3, the card offered
  /// after work or after time away 4, and first-run/invite counters 5. Other
  /// health measures use [health] to wait for support before counting.
  static int _vocabularyOf(String metric) {
    if (metric.startsWith('health_desktop_first_run_') ||
        metric.startsWith('health_desktop_shared_invites_')) return 5;
    for (final flow in _newerFlows) {
      if (metric.startsWith('ui_desktop_${flow.wire}_')) return flow.vocabulary;
    }
    return metric.startsWith('ui_desktop_add_phone_')
        ? AddPhoneOpening.vocabulary
        : 1;
  }

  /// The flows newer than revision 1, longest name first: `phone_offer_after_work_` starts with
  /// `phone_offer_`, and must be read as itself.
  static final _newerFlows =
      ProductFlow.values.where((flow) => flow.vocabulary > 1).toList()
        ..sort((a, b) => b.wire.length.compareTo(a.wire.length));

  /// A widget's delayed callback cannot count after sign-out or a choice revision.
  VoidCallback observer(ProductHealthMeasure measure) {
    final epoch = _accountEpoch;
    return () {
      if (epoch == _accountEpoch) health(measure);
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
    if (_setupShown) milestone(ProductHealthMeasure.funnelSetupSeen);
    if (!_setupAllowed && !sharing) return;
    for (final entry in _setupFacts.entries) {
      if (!entry.key.beforeSignIn || entry.key == ProductFlow.signIn) continue;
      // `missing`: a check found the step's tool not installed yet, so setup goes on to install it.
      // The step stays open until the install ends; only a setup that ends failed fails it.
      if (const [
        'pending',
        'running',
        'needsTerminal',
        'missing',
      ].contains(entry.value)) {
        _setup.putIfAbsent(entry.key, () => begin(entry.key));
        if (entry.value == 'missing') _countSetupMissing(entry.key);
      } else if (const [
        'ready',
        'notApplicable',
        'failed',
        'unavailable',
      ].contains(entry.value)) {
        _setupMissing.remove(entry.key);
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

  /// How many new computers needed a tool installed: a signed-out setup count only, because a
  /// signed-in report goes through the local CLI, whose copy of the contract may be older.
  void _countSetupMissing(ProductFlow flow) {
    if (sharing || !_setupAllowed || surface != 'desktop' || _disposed) return;
    if (!_setupMissing.add(flow)) return;
    _count(
      'setup',
      _now().toUtc().toIso8601String().substring(0, 10),
      'setup_${surface}_${flow.wire}_missing',
    );
  }

  /// An agent download beside setup (AgentPrefetch): started when [ok] is null, then ok or failed
  /// with how long it took. Anonymous setup counts only, so the setup preference governs them
  /// whether or not the person has signed in meanwhile; a fixed engine name, nothing else.
  void setupDownload(String engine, {bool? ok, Duration? took}) {
    if (!_setupAllowed ||
        surface != 'desktop' ||
        _disposed ||
        !const ['opencode', 'codex', 'claude'].contains(engine)) {
      return;
    }
    final day = _now().toUtc().toIso8601String().substring(0, 10);
    final prefix = 'setup_desktop_agent_download_${engine}_';
    if (ok == null) {
      _count('setup', day, '${prefix}started');
      return;
    }
    _count('setup', day, '$prefix${ok ? 'ok' : 'failed'}');
    final minutes = (took ?? Duration.zero).inSeconds / 60;
    _count(
      'setup',
      day,
      '$prefix${minutes < 1
          ? 'under_1m'
          : minutes < 5
          ? '1m_to_5m'
          : 'over_5m'}',
    );
  }

  // Report days are UTC dates. Parsing a date without Z uses the machine's
  // timezone and can make today's UTC report look like it is from the future.
  DateTime _utcDayStart(String day) => DateTime.parse('${day}T00:00:00Z');

  void _count(String channel, String day, String metric) {
    final today = _now().toUtc();
    final date = _utcDayStart(day);
    if (today.difference(date).inDays > 1 || date.isAfter(today)) return;
    _days.removeWhere(
      (key, _) => today.difference(_utcDayStart(key.split(':')[1])).inDays > 1,
    );
    final counters = _days.putIfAbsent('$channel:$day', () => {});
    if ((counters[metric] ?? 0) >= 1000 && healthEnabled && channel == 'ui') {
      counters['health_desktop_queue_capped'] = 1;
    }
    counters[metric] = min(1000, (counters[metric] ?? 0) + 1);
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
    if (!choiceLoaded) await setupChoiceReady;
    if (_disposed) return;
    _lastAttempt = _now();
    for (final ticket in _expires.keys.toList()) {
      if (!_now().toUtc().isBefore(_expires[ticket]!)) {
        _expire[ticket]?.call(ProductOutcome.unknown);
      }
    }
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
        // A name newer than the proxy is known to forward waits here for an
        // answer that says it does, rather than being skipped as a health
        // measure is: the Add Phone card shows once per computer, often before
        // the first answer. Each minute's runtime sample sends a report, so
        // an answer comes; an older CLI's never does, and the day expires.
        bool ready(String metric) => _vocabularyOf(metric) <= proxyVocabulary;
        final keys =
            _days.keys
                .where(
                  (k) => k.startsWith('$channel:') && _days[k]!.keys.any(ready),
                )
                .toList()
              ..sort();
        if (keys.isEmpty) continue;
        final key = keys.first, counts = _days[key]!;
        final batch = Map<String, int>.fromEntries(
          counts.entries.where((entry) => ready(entry.key)).take(32),
        );
        for (final metric in batch.keys) {
          counts.remove(metric);
        }
        if (counts.isEmpty) _days.remove(key);
        report = {
          'schemaVersion': 1,
          'id': _receipt(),
          'day': key.split(':')[1],
          'counters': batch,
          if (channel == 'setup')
            if (surface == 'desktop') 'sharing': 'default' else 'consent': true
          else
            'revision': _revision,
          if (channel == 'ui' && healthEnabled) 'context': context!.toJson(),
        };
        _pending[channel] = report;
      }
      if (_now()
              .toUtc()
              .difference(_utcDayStart(report['day'] as String))
              .inDays >
          1) {
        _pending.remove(channel);
        if (channel == 'ui') health(ProductHealthMeasure.reportExpired);
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
          if (result['reason'] == 'EXPIRED' && channel == 'ui') {
            health(ProductHealthMeasure.reportExpired);
          }
        }
        if (result['accepted'] != true &&
            result['reason'] != 'EXPIRED' &&
            result['reason'] != 'CHOICE_CHANGED') {
          health(ProductHealthMeasure.reportRejected);
        }
        if (result['reason'] == 'CHOICE_CHANGED') {
          _enabled = null;
          _clear('ui');
          _clear('setup');
        }
      } catch (error) {
        // A late failure belongs to the old choice/account, just like a late success.
        if (_disposed ||
            (channel == 'setup'
                ? epoch != _guestEpoch
                : epoch != _accountEpoch))
          continue;
        if (channel == 'ui') {
          health(ProductHealthMeasure.reportFailed);
          health(
            error is ProductReportFailure
                ? error.measure
                : ProductHealthMeasure.reportFailureOther,
          );
        }
        // A malformed/oversized immutable packet will never succeed. Drop only that
        // packet so new counts can proceed; transient failures keep the same receipt.
        if (error is ProductReportFailure && error.permanent)
          _pending.remove(channel);
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
    _setupMissing.clear();
    _active.clear();
    _expires.clear();
    _expire.clear();
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
