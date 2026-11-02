import 'dart:async';

import 'package:flutter/widgets.dart';

import '../../core/web_release.dart';
import '../../ws/ws_conn.dart' show appVersionRead, declaredAppVersion;
import '../parts/page_reload.dart'
    if (dart.library.js_interop) '../parts/page_reload_web.dart';
import 'page_visible.dart'
    if (dart.library.js_interop) 'page_visible_web.dart'
    as visible;
import 'web_update_bar.dart';
import 'web_update_watcher.dart';

/// The browser build's watch for a newer release (task #2185): it learns which
/// release this page runs once the start-up read of it lands, then asks the
/// host which one it serves now every few minutes and whenever the page comes
/// back to the front, and draws [WebUpdateFrame]'s bar when they differ. Until
/// then, and for a page that cannot tell its own release, [child] is drawn
/// alone: the app is never held for this.
class WebUpdateHost extends StatefulWidget {
  WebUpdateHost({
    super.key,
    required this.child,
    Future<String?> Function()? readRunning,
    Future<String?> Function()? readLatest,
    VoidCallback? reload,
    this.every = const Duration(minutes: 5),
    Stream<void>? pageShown,
  }) : readRunning = readRunning ?? _runningVersion,
       readLatest = readLatest ?? webReleaseVersion,
       reload = reload ?? (() => unawaited(reloadForNewVersion())),
       pageShown = pageShown ?? _pageShown();

  final Widget child;

  /// The release this page started on, as the start-up read says it.
  final Future<String?> Function() readRunning;

  /// The release the host serves now.
  final Future<String?> Function() readLatest;

  /// Loads the new build.
  final VoidCallback reload;
  final Duration every;

  /// Each time the page comes back to the front.
  final Stream<void> pageShown;

  static Future<String?> _runningVersion() async {
    await appVersionRead;
    return declaredAppVersion;
  }

  static Stream<void> _pageShown() => visible.pageShown();

  @override
  State<WebUpdateHost> createState() => _WebUpdateHostState();
}

class _WebUpdateHostState extends State<WebUpdateHost> {
  WebUpdateWatcher? _watcher;
  StreamSubscription<void>? _shown;
  bool _disposed = false;

  @override
  void initState() {
    super.initState();
    unawaited(_begin());
  }

  Future<void> _begin() async {
    String? running;
    try {
      running = await widget.readRunning();
    } catch (_) {
      // A page that cannot say its release never says another is ready.
    }
    if (_disposed || running == null) return;
    final watcher = WebUpdateWatcher(
      running: running,
      readLatest: widget.readLatest,
      every: widget.every,
    )..start();
    _shown = widget.pageShown.listen((_) => unawaited(watcher.check()));
    setState(() => _watcher = watcher);
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(_shown?.cancel());
    _watcher?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final watcher = _watcher;
    // One shape from the first frame: the app is not remounted when the
    // watch starts.
    return WebUpdateFrame(
      watcher: watcher ?? _never,
      reload: widget.reload,
      child: widget.child,
    );
  }

  static final _never = WebUpdateWatcher(
    running: null,
    readLatest: () async => null,
  );
}
