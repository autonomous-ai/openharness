import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../widgets/desktop_chrome.dart';

/// A part of the browser build that `main.dart.js` leaves out: a `deferred`
/// library, downloaded the first time something needs it. One download is
/// shared by every place that asks; a failed one is forgotten, so the next ask
/// downloads it again (dart2js has already retried it three times by then).
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

  /// [action] once the part is in; fails as the download does.
  Future<T> run<T>(FutureOr<T> Function() action) async {
    await load();
    return action();
  }
}

/// [builder]'s widget once [part] is in. Until then a loading line in its
/// place, and if the download fails, a sentence and Retry instead of a blank.
class DeferredPartView extends StatefulWidget {
  const DeferredPartView({
    super.key,
    required this.part,
    required this.builder,
  });

  final DeferredPart part;
  final WidgetBuilder builder;

  @override
  State<DeferredPartView> createState() => _DeferredPartViewState();
}

class _DeferredPartViewState extends State<DeferredPartView> {
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    if (!widget.part.loaded) _load();
  }

  void _load() {
    widget.part.load().then(
      (_) {
        if (mounted) setState(() => _failed = false);
      },
      onError: (Object _) {
        if (mounted) setState(() => _failed = true);
      },
    );
  }

  void _retry() {
    setState(() => _failed = false);
    _load();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.part.loaded) return widget.builder(context);
    grid.AppTheme.watch(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: _failed ? _Failed(onRetry: _retry) : const _Loading(),
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

class _Failed extends StatelessWidget {
  const _Failed({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Semantics(
        liveRegion: true,
        child: Text(
          'Could not load this part of Harness',
          textAlign: TextAlign.center,
          style: DesktopChrome.text(color: DesktopChrome.foreground),
        ),
      ),
      const SizedBox(height: 4),
      Text(
        'Check the connection, then retry.',
        textAlign: TextAlign.center,
        style: DesktopChrome.metadata(),
      ),
      const SizedBox(height: 8),
      TextButton.icon(
        style: TextButton.styleFrom(minimumSize: const Size(44, 44)),
        onPressed: onRetry,
        icon: const Icon(AppIcons.rotateCw, size: 14),
        label: const Text('Retry'),
      ),
    ],
  );
}
