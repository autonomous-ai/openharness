import 'dart:async';

import '../measurement/product_measurement.dart';

/// One embedded viewer's navigations, as the webview reports them, turned into what the pane shows
/// and one `viewer_load` observation per load the app asked for.
///
/// It knows nothing of the webview: [WebPanePanel] passes each navigation callback in, and loads
/// what [load] names. Pure, so the decisions below are unit tested without a native view.
///
/// Why each rule exists (prod, 2026-10-15 → 16: viewer_load started 54 → 112, failed 0 → 23):
/// - WKWebView reports every failed navigation as the main frame's, so the panel's main-frame filter
///   filtered nothing, and a navigation cancelled by the next one (NSURLErrorCancelled, -999; WebKit's
///   "frame load interrupted", 102) counted as a failed load and put the overlay up.
/// - A late error belonging to an earlier address marked the current load failed, and finishing a
///   load never took the overlay down.
/// - Every page start began an observation: Reload, Retry, the page's own navigations.
/// - A remote viewer's address lives only as long as one connection (the CLI's per-connection
///   gateway), and a forced reconnect or a CLI update takes it down: the viewer stops answering for a
///   moment and nothing tried again.
class ViewerLoadTracker {
  ViewerLoadTracker({
    required this.begin,
    required this.load,
    required this.changed,
  });

  /// Opens a `viewer_load` observation and returns how to end it.
  final void Function(ProductOutcome) Function() begin;

  /// Loads [url] into the webview again: an automatic retry.
  final void Function(String url) load;

  /// What [failure] or [loading] reads has changed.
  final void Function() changed;

  /// Waits before each automatic retry of a viewer that refused or dropped the connection: about
  /// 30 s in all, long enough for a reconnect to bring the machine back and name the viewer's new
  /// address, which then loads in place of these retries.
  static const retryDelays = <Duration>[
    Duration(seconds: 1),
    Duration(seconds: 2),
    Duration(seconds: 4),
    Duration(seconds: 8),
    Duration(seconds: 8),
    Duration(seconds: 8),
  ];

  /// NSURLErrorCancelled: this navigation was replaced by another, which reports for itself.
  static const _cancelled = -999;

  /// WebKitErrorFrameLoadInterruptedByPolicyChange: likewise, a load stopped rather than failed.
  static const _interrupted = 102;

  /// NSURLErrorCannotConnectToHost and NSURLErrorNetworkConnectionLost: nothing is listening at
  /// the address yet, or it went away mid-load.
  static const _retryable = {-1004, -1005};

  void Function(ProductOutcome)? _finish;
  Timer? _retry;
  int _attempt = 0;
  String? _target;
  bool _expectingStart = false;
  final _urls = <String>{};

  /// Why the viewer is not showing, for the pane's notice; null while it is (or may be) fine.
  String? get failure => _failure;
  String? _failure;

  /// A navigation is under way, or a retry is waiting to start one.
  bool get loading => _loading;
  bool _loading = false;

  /// Whether a `viewer_load` observation is open.
  bool get measuring => _finish != null;

  /// The app is about to load [url]: the first load, a new address from the daemon, or a person's
  /// Retry or Reload. An observation still open goes on with it — it is the same viewer still
  /// trying to load — and one begins if none is.
  void request(String url) {
    _retry?.cancel();
    _retry = null;
    _attempt = 0;
    _target = url;
    _expectingStart = true;
    _urls
      ..clear()
      ..add(url);
    _failure = null;
    _loading = true;
    _finish ??= begin();
  }

  /// The webview started a navigation to [url] (`onPageStarted`): the one just requested or retried,
  /// or the page's own, which starts no observation.
  void started(String url) {
    _retry?.cancel();
    _retry = null;
    if (!_expectingStart) _urls.clear();
    _expectingStart = false;
    if (url.isNotEmpty) _urls.add(url);
    _loading = true;
    changed();
  }

  /// The webview finished loading [url] (`onPageFinished`).
  void finished(String url) {
    if (!_belongs(url)) return;
    _retry?.cancel();
    _retry = null;
    _attempt = 0;
    _expectingStart = false;
    _failure = null;
    _loading = false;
    _end(ProductOutcome.ok);
    changed();
  }

  /// The webview could not load [url] (`onWebResourceError`). [domain] is the NSError domain where
  /// the platform gives one.
  void failed({
    required int code,
    String? domain,
    String? url,
    required String description,
  }) {
    if (!_belongs(url)) return;
    if (_isCancellation(code, domain)) {
      // Whatever replaced it reports its own outcome; an observation still open waits for that.
      _loading = false;
      changed();
      return;
    }
    final target = _target;
    final message = description.isNotEmpty
        ? description
        : 'The viewer did not answer.';
    if (target != null &&
        _isRetryable(code, domain) &&
        _attempt < retryDelays.length) {
      _failure = message;
      _loading = true;
      _retry?.cancel();
      _retry = Timer(retryDelays[_attempt++], () {
        _retry = null;
        _expectingStart = true;
        load(target);
      });
      changed();
      return;
    }
    _retry?.cancel();
    _retry = null;
    _failure = message;
    _loading = false;
    _end(ProductOutcome.failed);
    changed();
  }

  /// The pane is going away: an open observation ends unfinished.
  void dispose() {
    _retry?.cancel();
    _retry = null;
    _end(ProductOutcome.cancelled);
  }

  void _end(ProductOutcome outcome) {
    final finish = _finish;
    _finish = null;
    finish?.call(outcome);
  }

  static bool _isCancellation(int code, String? domain) =>
      (code == _cancelled &&
          (domain == null || domain == 'NSURLErrorDomain')) ||
      (code == _interrupted &&
          (domain == null || domain == 'WebKitErrorDomain'));

  static bool _isRetryable(int code, String? domain) =>
      _retryable.contains(code) &&
      (domain == null || domain == 'NSURLErrorDomain');

  /// Whether a report about [url] is about the current navigation. A report with no address is (the
  /// web content process ending names none). A redirect stays on its origin — a remote viewer's
  /// gateway answers its first address with a redirect to the viewer's own path — so any address on
  /// the current navigation's origin belongs to it; a new viewer address is another port, and a
  /// report about that one is late.
  bool _belongs(String? url) {
    if (url == null || url.isEmpty || _urls.isEmpty) return true;
    if (_urls.contains(url)) return true;
    final reported = Uri.tryParse(url);
    if (reported == null || reported.host.isEmpty) return false;
    for (final known in _urls) {
      final current = Uri.tryParse(known);
      if (current != null &&
          current.scheme == reported.scheme &&
          current.host == reported.host &&
          current.port == reported.port) {
        return true;
      }
    }
    return false;
  }
}
