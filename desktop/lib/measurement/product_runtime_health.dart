import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cryptography/dart.dart' show DartSha256;
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart' show AppLifecycleListener;

import '../core/app_version.dart';
import '../core/harness_file_store.dart';
import 'product_measurement.dart';

/// Only the last consented run's control flags live locally. No history or content.
/// The local scope hash fences account changes; it is never a report field.
class ProductRuntimeHealth {
  static final _launchClock = Stopwatch();
  static void launched() {
    if (!_launchClock.isRunning) _launchClock.start();
  }

  ProductRuntimeHealth(
    this.measurement, {
    this.readState,
    this.writeState,
    this.readVersion,
    AppLifecycleState? Function()? lifecycle,
  }) : _lifecycle =
           lifecycle ?? (() => SchedulerBinding.instance.lifecycleState) {
    measurement.addListener(_choiceChanged);
  }
  final ProductMeasurement measurement;
  final Future<Map<String, dynamic>> Function()? readState;
  final Future<void> Function(Map<String, dynamic>)? writeState;
  final Future<String> Function()? readVersion;
  final AppLifecycleState? Function() _lifecycle;
  AppLifecycleListener? _lifecycleListener;
  String? _scope;
  String? _accountId;
  int _epoch = 0, _revision = -1, _frame = 0;
  bool _disposed = false,
      _active = false,
      _timingsInstalled = false,
      _ready = false,
      _readyCounted = false,
      _skipCatchUp = false;
  bool newInstallation = false;
  Timer? _sample;
  Map<String, dynamic> _state = {};
  Map<String, dynamic>? _pending;
  Future<void>? _saving;
  void Function(ProductOutcome)? _workspace;

  File get _file => File(
    '${HarnessFileStore.defaultDirectoryPath()}/product-health-state.json',
  );

  void account(String? account) {
    if (_accountId == account) return;
    _accountId = account;
    final scope = account == null
        ? null
        : const DartSha256()
              .hashSync(utf8.encode(account))
              .bytes
              .map((b) => b.toRadixString(16).padLeft(2, '0'))
              .join();
    if (_scope == scope) return;
    final previous = _scope;
    _scope = scope;
    _ready = false;
    _stop();
    if (previous != null) _save({});
    _choiceChanged();
  }

  void _choiceChanged() {
    final permitted =
        !_disposed &&
        _scope != null &&
        measurement.healthEnabled &&
        measurement.sharing;
    if (!permitted) {
      _stop();
      // An explicit off is observable through the revision; never keep a previous run across it.
      if (measurement.choiceRevision >= 0 && !measurement.sharing) _save({});
      return;
    }
    if (_active && _revision == measurement.choiceRevision) return;
    _stop();
    _active = true;
    _revision = measurement.choiceRevision;
    unawaited(_start(_epoch));
  }

  Future<void> _start(int epoch) async {
    try {
      final previous = readState != null ? await readState!() : await _read();
      final rawVersion = await (readVersion?.call() ?? runningAppVersion());
      if (!_active || _disposed || epoch != _epoch) return;
      final oldContext = measurement.context!;
      measurement.context = ProductUsageContext(
        release: rawVersion,
        platform: oldContext.platform,
        production: oldContext.production,
      );
      final version = measurement.context!.release;
      final same =
          previous['scope'] == _scope && previous['revision'] == _revision;
      if (same && previous['pendingUpdate'] is String) {
        measurement.begin(ProductFlow.updateRelaunch)(
          version != 'unknown' && previous['pendingUpdate'] == version
              ? ProductOutcome.ok
              : ProductOutcome.unknown,
        );
      } else if (same && previous['clean'] == false) {
        measurement.health(ProductHealthMeasure.uncleanRestart);
      }
      measurement.health(
        newInstallation
            ? ProductHealthMeasure.installNew
            : same &&
                  version != 'unknown' &&
                  previous['release'] != null &&
                  previous['release'] != 'unknown' &&
                  previous['release'] != version
            ? ProductHealthMeasure.installUpgrade
            : ProductHealthMeasure.installUnknown,
      );
      _state = {
        'scope': _scope,
        'revision': _revision,
        'release': measurement.context!.release,
        'clean': false,
      };
      _save(_state);
      _workspace = measurement.begin(ProductFlow.workspaceReady);
      if (_ready) ready();
      SchedulerBinding.instance.addTimingsCallback(_frames);
      _timingsInstalled = true;
      _lifecycleListener ??= AppLifecycleListener(
        onStateChange: lifecycleChanged,
      );
      _sample = Timer.periodic(
        const Duration(minutes: 1),
        (_) => sampleResources(),
      );
      sampleResources();
    } catch (_) {
      // Unavailable local measurement storage does not affect startup.
      if (epoch == _epoch) _stop();
    }
  }

  Future<Map<String, dynamic>> _read() async {
    try {
      if (await _file.length() > 2048) return {};
      final value = jsonDecode(await _file.readAsString());
      return value is Map<String, dynamic> ? value : {};
    } catch (_) {
      return {};
    }
  }

  void _save(Map<String, dynamic> value) {
    _pending = Map.of(value);
    _saving ??= _drain().whenComplete(() {
      _saving = null;
      if (_pending != null) _save(_pending!);
    });
  }

  Future<void> _drain() async {
    while (_pending != null) {
      final value = _pending!;
      _pending = null;
      try {
        if (writeState != null) {
          await writeState!(value);
        } else if (value.isEmpty) {
          if (await _file.exists()) await _file.delete();
        } else {
          await _file.parent.create(recursive: true);
          final temporary = File('${_file.path}.tmp');
          await temporary.writeAsString(jsonEncode(value), flush: true);
          await temporary.rename(_file.path);
        }
      } catch (_) {
        /* Only one in-flight write and one latest state, never a promise queue. */
      }
    }
  }

  void ready() {
    _ready = true;
    if (!_active || _state.isEmpty || _readyCounted) return;
    _readyCounted = true;
    _workspace?.call(ProductOutcome.ok);
    _workspace = null;
    if (_launchClock.isRunning) {
      measurement.observedStartup(_launchClock.elapsed);
    }
    measurement.milestone(ProductHealthMeasure.funnelWorkspaceReady);
  }

  void sampleResources() {
    if (!_active || !measurement.sharing) return;
    try {
      final rss = ProcessInfo.currentRss;
      measurement.health(
        rss < 256 * 1024 * 1024
            ? ProductHealthMeasure.rssUnder256m
            : rss < 1024 * 1024 * 1024
            ? ProductHealthMeasure.rss256mTo1g
            : ProductHealthMeasure.rssOver1g,
      );
    } catch (_) {
      /* Unsupported resource samples stay unknown. */
    }
  }

  @visibleForTesting
  void framesForTest(List<FrameTiming> timings) => _frames(timings);

  /// Hidden, minimised or occluded: the first frame reported after it is the
  /// OS throttling's catch-up (or one drawn while hidden), not the app's.
  /// Flutter draws nothing while hidden, so no batch arrives to say so.
  @visibleForTesting
  void lifecycleChanged(AppLifecycleState state) {
    if (_hidden(state)) _skipCatchUp = true;
  }

  static bool _hidden(AppLifecycleState? state) =>
      state == AppLifecycleState.hidden ||
      state == AppLifecycleState.paused ||
      state == AppLifecycleState.detached;

  void _frames(List<FrameTiming> timings) {
    if (!_active || _state.isEmpty || !measurement.sharing) return;
    // A hidden, minimised or occluded window is throttled by the OS (App Nap, the compositor), so its
    // frames time the OS, not the app; the first frame back is that throttling's catch-up. Frames of a
    // visible window without focus (inactive) still count: a person can see them.
    if (_hidden(_lifecycle())) {
      _skipCatchUp = true;
      return;
    }
    for (final frame in timings) {
      // Not counted towards the one-in-60 either: the next frame takes its place.
      if (_skipCatchUp) {
        _skipCatchUp = false;
        continue;
      }
      // Every 60th frame, never the first: `_frame++` sampled index 0, each launch's workspace
      // restore, which app_start already times. Oct 16 had 155 app starts, one long sample each.
      if (++_frame % 60 != 0) continue;
      final ms = frame.totalSpan.inMilliseconds;
      measurement.health(
        ms < 16
            ? ProductHealthMeasure.frameUnder16ms
            : ms < 50
            ? ProductHealthMeasure.frame16msTo50ms
            : ms < 250
            ? ProductHealthMeasure.frame50msTo250ms
            : ProductHealthMeasure.frameOver250ms,
      );
      // The buckets alone could not say why Linux's sampled frames were long
      // (Oct 17: 6.7% of Linux samples over 250 ms, macOS 0.25%), nor whether
      // a few computers or many had them.
      if (ms >= 50) measurement.health(_slowPhase(frame));
      if (ms >= 250) {
        measurement.healthOncePerDay(ProductHealthMeasure.frameLongCollector);
      }
    }
  }

  /// The longest of a slow frame's phases; a tie goes to the earlier one.
  ///
  /// Wait is vsync to build start: the UI thread was busy before the frame
  /// could start. On macOS and Linux that thread is the platform's main thread
  /// (Flutter 3.47), so timers, channel and native callbacks, synchronous IO
  /// and AppKit or GTK work all land there. Build is the framework's build,
  /// layout and paint; raster is the raster thread drawing it. The gap between
  /// build finish and raster start (a raster thread still busy with an
  /// earlier frame) is not a phase of its own.
  static ProductHealthMeasure _slowPhase(FrameTiming frame) {
    final wait = frame.vsyncOverhead, build = frame.buildDuration;
    final raster = frame.rasterDuration;
    if (wait >= build && wait >= raster) {
      return ProductHealthMeasure.frameSlowWait;
    }
    return build >= raster
        ? ProductHealthMeasure.frameSlowBuild
        : ProductHealthMeasure.frameSlowRaster;
  }

  void expectUpdate(String version) {
    if (!_active || !measurement.sharing) return;
    _state['pendingUpdate'] = ProductUsageContext(
      release: version,
      platform: 'other',
      production: true,
    ).release;
    _save(_state);
  }

  void cancelUpdate() {
    if (_active && _state.isNotEmpty) {
      _state.remove('pendingUpdate');
      _save(_state);
    }
  }

  void cleanExit() {
    if (_active && _state.isNotEmpty) {
      _state['clean'] = true;
      _save(_state);
    }
  }

  void _stop() {
    _epoch++;
    _active = false;
    _sample?.cancel();
    _sample = null;
    if (_timingsInstalled) {
      SchedulerBinding.instance.removeTimingsCallback(_frames);
      _timingsInstalled = false;
    }
    _lifecycleListener?.dispose();
    _lifecycleListener = null;
    _workspace = null;
    _state = {};
    _readyCounted = false;
  }

  void dispose() {
    if (_disposed) return;
    cleanExit();
    _disposed = true;
    _stop();
    measurement.removeListener(_choiceChanged);
  }
}
