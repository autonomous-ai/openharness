/// One provider's ledger: whether it is switched on, what the last scan found,
/// and how little of the disk the next scan has to touch.
///
/// The three providers share this class the way Orca's three share
/// `UsageProviderStoreLifecycle`, and for the same reason: the scanners disagree
/// about everything except when to run and what to keep.
///
/// ⚠️ **Off is the resting state, and switching one on is the user's to do.**
/// Scanning reads transcripts nobody offered us — every prompt, path and branch
/// name a session touched sits in those files, and this feature wants only the
/// token counts. Nothing is read until somebody asks for it, which is why
/// [enabled] defaults false and [refresh] returns without looking when it is.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../core/harness_file_store.dart';
import '../../core/local_key_value_store.dart';
import '../../core/snapshot_store.dart';
import 'ledger_scanner.dart';
import 'ledger_types.dart';
import 'usage_overview.dart';

/// How long a scan's result stands before [refresh] will look again.
///
/// Five minutes because these files change only when an agent is mid-turn, and a
/// full rescan walks every transcript on the machine. A panel that rescanned on
/// every open would spend seconds of disk for figures that had not moved.
const kLedgerStaleAfter = Duration(minutes: 5);

/// The cache format. Bumped when the persisted shape changes, which discards
/// every older snapshot rather than trying to read one that means something
/// slightly different.
///
/// ⚠️ **A new field on [UsageTotals] IS a shape change, and forgetting to bump
/// this is NOT a self-healing mistake.** `reasoning` was added while this still
/// read 1: every cached source still matched its `{path, mtime, size}`
/// fingerprint, so 70 of 71 transcripts were served from the old snapshot with
/// the new field defaulted to zero, written back out carrying that zero, and the
/// panel reported 90.9k reasoning against a true 2.3M. Nothing would ever have
/// corrected it, because those fingerprints go on matching forever — only a
/// version bump discards the stale rows. `usage_ledger_test.dart` pins the
/// serialised key set so the next field cannot be added quietly.
// Version 2 could cache failed JSONL reads as empty successful files, whose
// unchanged size/mtime then hid their usage even after access was restored.
const _kCacheVersion = 3;

class UsageLedgerStore extends ChangeNotifier {
  UsageLedgerStore({
    required this.scanner,
    LocalKeyValueStore? settings,
    SnapshotStore? snapshots,
  }) : _settings = settings ?? HarnessFileStore.shared,
       _snapshots =
           snapshots ??
           FileSnapshotStore('usage-ledger-${scanner.provider.name}');

  final LedgerScanner scanner;
  final LocalKeyValueStore _settings;
  final SnapshotStore _snapshots;

  LedgerProvider get provider => scanner.provider;

  // `late`, not plain initialisers: both need [provider], which is read off the
  // scanner the constructor was handed.
  late LedgerScanState _state = LedgerScanState(provider: provider);
  late ProviderLedger _ledger = ProviderLedger(provider: provider);

  /// The sources the last scan saw, keyed by path — what makes the next one
  /// incremental.
  Map<String, ScannedSource> _sources = const {};

  Future<void>? _inFlight;
  int? _scanRevision;
  Future<void>? _loading;
  int _revision = 0;
  bool _hasExplicitChoice = false;
  bool _disposed = false;

  // Reopening Settings creates new stores. Those stores must wait for an Off
  // already being persisted by the previous screen before restoring a cache.
  // The shared settings instance identifies the same user's persistence;
  // providers still write independently of one another.
  static final _writes = Expando<Map<LedgerProvider, Future<void>>>();
  Map<LedgerProvider, Future<void>> get _writeQueue =>
      _writes[_settings] ??= {};
  Future<void> get _persisted => _writeQueue[provider] ?? Future.value();

  bool _current(int revision) => !_disposed && revision == _revision;

  Future<void> _persist(Future<void> Function() operation) {
    final next = _persisted.then((_) async {
      try {
        await operation();
      } on Object {
        // Persistence is best effort. An in-session toggle still takes effect,
        // and one failed write must not prevent a following cache clear.
      }
    });
    _writeQueue[provider] = next;
    return next;
  }

  LedgerScanState get state => _state;
  ProviderLedger get ledger => _ledger;

  String get _enabledKey => 'usageLedger.${provider.name}.enabled';

  /// Read the switch and the last snapshot back off disk.
  ///
  /// Never throws: a cache that cannot be read is a cache that is not there, and
  /// a panel that failed to open because last week's snapshot was truncated
  /// would be a worse bug than a rescan.
  Future<void> load() => _loading ??= _load(_revision);

  Future<void> _load(int revision) async {
    if (_disposed || _hasExplicitChoice) return;
    try {
      await _persisted;
      if (!_current(revision)) return;
      final enabled = await _settings.read(_enabledKey) == 'true';
      if (!_current(revision)) return;
      final cache = enabled ? await _readCache().onError((_, _) => null) : null;
      if (!_current(revision)) return;
      _sources = cache?.sources ?? const {};
      _ledger = buildProviderLedger(provider, _sources.values);
      _state = LedgerScanState(
        provider: provider,
        enabled: enabled,
        status: cache == null ? LedgerStatus.disabled : LedgerStatus.ok,
        lastScanAt: cache?.scannedAt,
      );
    } on Object {
      // An unreadable preference/cache leaves the initial empty state.
    }
    if (_current(revision)) _notify();
  }

  Future<({Map<String, ScannedSource> sources, DateTime? scannedAt})?>
  _readCache() async {
    final contents = await _snapshots.read();
    if (contents == null) return null;
    final Object? decoded;
    try {
      decoded = jsonDecode(contents);
    } on Object {
      return null;
    }
    if (decoded is! Map<String, Object?> ||
        decoded['version'] != _kCacheVersion ||
        decoded['provider'] != provider.name) {
      return null;
    }

    final sources = decoded['sources'];
    if (sources is! List) return null;
    final restored = <String, ScannedSource>{};
    for (final raw in sources) {
      if (raw is! Map<String, Object?>) continue;
      final source = ScannedSource.fromJson(provider, raw);
      if (source != null) restored[source.path] = source;
    }
    return (
      sources: restored,
      scannedAt: DateTime.tryParse('${decoded['lastScanAt']}'),
    );
  }

  /// Switch this provider on or off.
  ///
  /// Switching off drops the snapshot from memory AND from disk. Keeping it
  /// would mean a provider the user turned off still had its transcripts
  /// summarised in a file on their machine, which is not what "off" reads as.
  Future<void> setEnabled(bool enabled) {
    if (_disposed) return Future.value();
    if (_hasExplicitChoice && _state.enabled == enabled) {
      return enabled ? refresh() : _persisted;
    }
    _hasExplicitChoice = true;
    final revision = ++_revision;
    _state = LedgerScanState(
      provider: provider,
      enabled: enabled,
      status: enabled ? LedgerStatus.scanning : LedgerStatus.disabled,
    );
    var saved = _persist(() => _settings.write(_enabledKey, '$enabled'));
    if (!enabled) {
      _sources = const {};
      _ledger = ProviderLedger(provider: provider);
      saved = _persist(_snapshots.clear);
    }
    // Queue persistence before notifying: a listener can make the next choice
    // synchronously, and the writes must retain that same order.
    _notify();
    return Future.wait([
      saved,
      if (enabled && _current(revision)) refresh(force: true),
    ]);
  }

  /// Rescan if the last result has gone stale, or [force] regardless.
  ///
  /// Concurrent calls share one scan rather than queueing a second walk of the
  /// same disk.
  Future<void> refresh({bool force = false}) {
    if (_disposed || !_state.enabled) return Future.value();
    final revision = _revision;
    if (_inFlight case final pending?) {
      if (_scanRevision == revision &&
          (_state.status == LedgerStatus.scanning ||
              (!force && _state.status == LedgerStatus.ok))) {
        return pending;
      }
      // Off/On invalidates the old result, but cannot cancel a scanner's disk
      // operation. Finish that read before starting the newly requested one.
      // A Retry after a visible failure also waits for the old cache clear,
      // then starts a fresh read instead of joining the finished failure.
      return pending.then((_) async {
        if (_current(revision) && _state.enabled) await refresh(force: force);
      });
    }
    final lastScanAt = _state.lastScanAt;
    if (!force &&
        _state.status == LedgerStatus.ok &&
        lastScanAt != null &&
        DateTime.now().difference(lastScanAt) < kLedgerStaleAfter) {
      return Future.value();
    }
    final done = Completer<void>();
    _inFlight = done.future;
    _scanRevision = revision;
    // Install the shared future before _run notifies synchronous listeners.
    unawaited(
      _run(revision).then(
        (_) {
          _inFlight = null;
          _scanRevision = null;
          done.complete();
        },
        onError: (Object error, StackTrace stack) {
          _inFlight = null;
          _scanRevision = null;
          done.completeError(error, stack);
        },
      ),
    );
    return done.future;
  }

  Future<void> _run(int revision) async {
    _state = _state.copyWith(
      status: LedgerStatus.scanning,
      clearMessage: _state.status != LedgerStatus.partial,
    );
    _notify();
    if (!_current(revision) || !_state.enabled) return;

    LedgerScanResult result;
    try {
      result = await scanner.scan(_sources);
    } on Object catch (error) {
      await _failed(
        revision,
        LedgerStatus.failed,
        'Could not read ${provider.label} usage: $error',
      );
      return;
    }
    if (!_current(revision) || !_state.enabled) return;

    if (result.status != LedgerStatus.ok &&
        result.status != LedgerStatus.partial) {
      // The sources are dropped with the result: a provider that has become
      // unavailable must not keep showing the totals from when it was not.
      await _failed(revision, result.status, result.message);
      return;
    }

    _sources = {for (final source in result.sources) source.path: source};
    _ledger = buildProviderLedger(provider, _sources.values);
    _state = _state.copyWith(
      status: result.status,
      lastScanAt: DateTime.now(),
      message: result.message,
      clearMessage: result.status == LedgerStatus.ok,
    );
    if (result.status == LedgerStatus.partial) {
      // Keep readable figures in this view, but never restore an incomplete
      // snapshot as a fresh complete result when Settings is reopened.
      final cleared = _persist(_snapshots.clear);
      _notify();
      await cleared;
      return;
    }
    _notify();
    await _persist(() async {
      if (!_current(revision) || !_state.enabled) return;
      await _snapshots.write(
        jsonEncode({
          'version': _kCacheVersion,
          'provider': provider.name,
          'lastScanAt': _state.lastScanAt?.toIso8601String(),
          'sources': [for (final source in _sources.values) source.toJson()],
        }),
      );
    });
  }

  Future<void> _failed(
    int revision,
    LedgerStatus status,
    String? message,
  ) async {
    if (!_current(revision) || !_state.enabled) return;
    _sources = const {};
    _ledger = ProviderLedger(provider: provider);
    _state = LedgerScanState(
      provider: provider,
      enabled: true,
      status: status,
      message: message,
    );
    final cleared = _persist(_snapshots.clear);
    _notify();
    await cleared;
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
