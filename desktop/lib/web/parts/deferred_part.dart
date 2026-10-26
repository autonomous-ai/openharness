import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../widgets/desktop_chrome.dart';
import 'page_reload.dart' if (dart.library.js_interop) 'page_reload_web.dart';

/// A part of the browser build that `main.dart.js` leaves out: a `deferred`
/// library, downloaded the first time something needs it. One download is
/// shared by every place that asks; a failed one is forgotten, so the next ask
/// downloads it again (dart2js has already retried it three times by then).
/// A download still pending is not asked again: dart2js would hand back the
/// same one.
class DeferredPart {
  DeferredPart(this._download);

  /// The library's `loadLibrary`.
  final Future<void> Function() _download;
  Future<void>? _loading;

  /// Whether the part is in, so a view of it draws at once.
  bool get loaded => _loaded;
  bool _loaded = false;

  Future<void> load() => _loading ??= _download().then(
    (_) => _loaded = true,
    onError: (Object error, StackTrace stack) {
      _loading = null;
      Error.throwWithStackTrace(error, stack);
    },
  );
}

/// [builder]'s widget once [part] is in. Until then a loading line in its
/// place; if the download fails, a sentence and Retry instead of a blank, and
/// a Retry that fails too offers to reload the page: an older page cannot
/// download a part a release replaced. A download still going after
/// [stallAfter] offers Reload alone: asked again, dart2js hands back the same
/// pending download.
class DeferredPartView extends StatefulWidget {
  const DeferredPartView({
    super.key,
    required this.part,
    required this.builder,
    this.reload = reloadPage,
  });

  final DeferredPart part;
  final WidgetBuilder builder;

  /// Reloads the page; tests pass a recorder.
  final VoidCallback reload;

  /// How long a download goes before Reload is offered.
  static const stallAfter = Duration(seconds: 20);

  @override
  State<DeferredPartView> createState() => _DeferredPartViewState();
}

class _DeferredPartViewState extends State<DeferredPartView> {
  var _failures = 0;
  bool _failed = false, _stalled = false;
  Timer? _stall;

  @override
  void initState() {
    super.initState();
    if (!widget.part.loaded) _load(widget.part.load());
  }

  @override
  void dispose() {
    _stall?.cancel();
    super.dispose();
  }

  void _load(Future<void> download) {
    _stall?.cancel();
    _stall = Timer(DeferredPartView.stallAfter, () {
      if (mounted) setState(() => _stalled = true);
    });
    download.then(
      (_) {
        _stall?.cancel();
        if (mounted) setState(() => _failed = _stalled = false);
      },
      onError: (Object _) {
        _stall?.cancel();
        if (!mounted) return;
        setState(() {
          _failures++;
          _failed = true;
          _stalled = false;
        });
      },
    );
  }

  void _retry() {
    setState(() => _failed = _stalled = false);
    _load(widget.part.load());
  }

  @override
  Widget build(BuildContext context) {
    if (widget.part.loaded) return widget.builder(context);
    grid.AppTheme.watch(context);
    final Widget shown;
    if (_failed && _failures > 1) {
      shown = _Problem(
        title: 'Could not load this part of Harness',
        detail:
            'Harness may have been updated since this page opened. '
            'Reload the page to get the new version.',
        onRetry: _retry,
        onReload: widget.reload,
      );
    } else if (_failed) {
      shown = _Problem(
        title: 'Could not load this part of Harness',
        detail: 'Check the connection, then retry.',
        onRetry: _retry,
      );
    } else if (_stalled) {
      shown = _Problem(
        title: 'Still loading this part of Harness',
        detail: 'Check the connection, then reload the page.',
        onReload: widget.reload,
      );
    } else {
      shown = const _Loading();
    }
    // Its own Material: the workspace's part is drawn above any page.
    return Material(
      type: MaterialType.transparency,
      child: Center(
        child: Padding(padding: const EdgeInsets.all(16), child: shown),
      ),
    );
  }
}

class _Loading extends StatelessWidget {
  const _Loading();

  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox.square(
          dimension: 12,
          child: CircularProgressIndicator(
            strokeWidth: 1.5,
            color: DesktopChrome.muted,
          ),
        ),
        const SizedBox(width: 10),
        Text('Loading…', style: DesktopChrome.metadata()),
      ],
    ),
  );
}

/// What went wrong in a sentence, and what to do: Retry, Reload, or both.
class _Problem extends StatelessWidget {
  const _Problem({
    required this.title,
    required this.detail,
    this.onRetry,
    this.onReload,
  });

  final String title;
  final String detail;
  final VoidCallback? onRetry;
  final VoidCallback? onReload;

  @override
  Widget build(BuildContext context) {
    final buttonStyle = TextButton.styleFrom(minimumSize: const Size(44, 44));
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          liveRegion: true,
          child: Text(
            title,
            textAlign: TextAlign.center,
            style: DesktopChrome.text(color: DesktopChrome.foreground),
          ),
        ),
        const SizedBox(height: 4),
        Text(
          detail,
          textAlign: TextAlign.center,
          style: DesktopChrome.metadata(),
        ),
        const SizedBox(height: 8),
        Wrap(
          alignment: WrapAlignment.center,
          spacing: 8,
          children: [
            if (onReload case final reload?)
              TextButton.icon(
                style: buttonStyle,
                onPressed: reload,
                icon: const Icon(AppIcons.refreshCw, size: 14),
                label: const Text('Reload'),
              ),
            if (onRetry case final retry?)
              TextButton.icon(
                style: buttonStyle,
                onPressed: retry,
                icon: const Icon(AppIcons.rotateCw, size: 14),
                label: const Text('Retry'),
              ),
          ],
        ),
      ],
    );
  }
}
