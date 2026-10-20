import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'hub_usage_browser_native.dart'
    if (dart.library.js_interop) 'hub_usage_browser_web.dart'
    as browser;
import 'product_measurement.dart' show newProductReceipt;

/// What a shared link (`/s/:id`) showed, each counted at most once per page. The wires are the
/// backend's `HUB_SHARED_OPENS` (`backend/src/lib/hubMetricsContract.ts`; `hub_usage_contract_test.dart`
/// fails when they drift).
enum SharedOpen {
  live('live'),
  offline('offline'),
  private('private'),
  noAccess('no_access'),
  failed('failed');

  const SharedOpen(this.wire);
  final String wire;
  String get metric => 'hub_shared_open_$wire';
}

/// One per click on a shared link, or once when its live viewer first draws; the backend's
/// `shared_*` entries of `HUB_ACTIONS`.
enum SharedAction {
  viewerShown('viewer_shown'),
  commentsOpen('comments_open'),
  commentPost('comment_post'),
  signInClick('sign_in_click'),
  retry('retry'),
  getApp('get_app'),
  productPage('product_page');

  const SharedAction(this.wire);
  final String wire;
  String get metric => 'hub_shared_$wire';
}

/// The shared page drawn, by a signed-out visitor or a signed-in member.
String sharedViewMetric({required bool member}) =>
    'hub_view_shared_${member ? 'member' : 'visitor'}';

/// How long a live shared harness stayed in view, bucketed as the backend's `HUB_DWELL`.
String sharedDwellMetric(Duration shown) =>
    'hub_shared_dwell_${shown < const Duration(seconds: 10)
        ? 'under_10s'
        : shown < const Duration(minutes: 1)
        ? '10s_to_1m'
        : 'over_1m'}';

const hubReportMaxValue = 1000;

/// The web app's half of the Hub's anonymous counters (the website's is `hubMeasure.ts`): daily
/// totals kept in memory and sent to the website's server (`/api/hub-usage`) a minute after the
/// first count and as the tab hides, without cookies. A sign-in rides along only so that server
/// can leave out a member who turned sharing off; it never reaches the backend. Nothing is counted
/// in a native or debug build, or under Global Privacy Control or Do Not Track. A failed send is
/// lost: measurement never retries into the reader's way.
class HubUsage {
  HubUsage({
    bool Function()? enabled,
    void Function(String body, String? authorization)? post,
    DateTime Function()? now,
    String Function()? receipt,
    this.flushAfter = const Duration(minutes: 1),
  }) : _enabled =
           enabled ??
           (() => kIsWeb && kReleaseMode && browser.hubUsageAllowed()),
       _post = post ?? browser.postHubUsage,
       _now = now ?? DateTime.now,
       _receipt = receipt ?? newProductReceipt;

  final bool Function() _enabled;
  final void Function(String body, String? authorization) _post;
  final DateTime Function() _now;
  final String Function() _receipt;
  final Duration flushAfter;
  final _counts = <String, int>{};
  String _day = '';
  Timer? _timer;
  bool _listening = false;

  Future<String?> Function()? _accessToken;
  String? _authorization;
  bool _authorizationKnown = true;
  int _reads = 0;

  /// Reads the reader's sign-in (null when signed out); set by the page that counts. Until the first
  /// read answers, nothing is sent, so a member is never counted without their choice being checked.
  set accessToken(Future<String?> Function()? read) {
    _accessToken = read;
    _authorization = null;
    _authorizationKnown = read == null;
    _reads++;
    if (read != null) _readAuthorization();
  }

  void _readAuthorization() {
    final read = _accessToken, generation = _reads;
    if (read == null) return;
    read().then(
      (token) {
        if (generation != _reads) return;
        _authorization = token == null ? null : 'Bearer $token';
        _authorizationKnown = true;
      },
      onError: (Object _) {
        // An unreadable sign-in keeps the last answer, or, with none yet, sends nothing.
      },
    );
  }

  String _utcDay() => _now().toUtc().toIso8601String().substring(0, 10);

  /// One more of [metric] today.
  void count(String metric) {
    if (!_enabled()) return;
    _listen();
    if (_day.isNotEmpty && _day != _utcDay()) flush();
    _day = _utcDay();
    _counts[metric] = ((_counts[metric] ?? 0) + 1).clamp(1, hubReportMaxValue);
    if (_timer != null) return;
    _timer = Timer(flushAfter, flush);
    // A fresh read per report: a sign-in that changed or was renewed since the last one.
    _readAuthorization();
  }

  /// Sends what is counted so far, once.
  void flush() {
    _timer?.cancel();
    _timer = null;
    if (_counts.isEmpty) return;
    final report = {
      'schemaVersion': 1,
      'id': _receipt(),
      'day': _day,
      'counters': Map.of(_counts),
    };
    _counts.clear();
    if (!_authorizationKnown) return;
    _post(jsonEncode(report), _authorization);
  }

  void _listen() {
    if (_listening) return;
    _listening = true;
    browser.watchPage(
      visibility: (visible) {
        if (!visible) flush();
      },
      leave: flush,
    );
  }
}

/// The web app's one collector.
final hubUsage = HubUsage();

/// How long something stayed in view, hidden time not counted, reported once as it is left: the
/// page closing, or [finish] (a widget going away).
class VisibleTime {
  VisibleTime(this._done) {
    if (browser.pageVisible()) _shown.start();
    _unwatch = browser.watchPage(
      visibility: (visible) => visible ? _shown.start() : _shown.stop(),
      leave: finish,
    );
  }

  final void Function(Duration shown) _done;
  final _shown = Stopwatch();
  late final void Function() _unwatch;
  bool _finished = false;

  void finish() {
    if (_finished) return;
    _finished = true;
    _unwatch();
    _shown.stop();
    _done(_shown.elapsed);
  }
}
