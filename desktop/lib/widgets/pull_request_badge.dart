import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../core/pull_request_status.dart';

/// A separate PR label: branch colour does not encode review state.
class PullRequestBadge extends StatefulWidget {
  const PullRequestBadge({
    super.key,
    required this.identity,
    required this.read,
    this.open,
    this.compact = false,
    this.foreground,
    this.now,
  });
  final Object identity;
  final bool compact;
  final Future<Map<String, dynamic>> Function() read;
  final Future<bool> Function(Uri)? open;
  final ValueListenable<bool>? foreground;
  final DateTime Function()? now;
  @override
  State<PullRequestBadge> createState() => _PullRequestBadgeState();
}

class _PullRequestBadgeState extends State<PullRequestBadge> {
  static const _interval = Duration(seconds: 60);
  Timer? _timer;
  ValueListenable<TickerModeData>? _tickerMode;
  int _revision = 0;
  int? _pendingRevision;
  DateTime? _updatedAt;
  bool _attached = true;
  Map<String, dynamic>? _result;
  @override
  void initState() {
    super.initState();
    widget.foreground?.addListener(_scheduleRefresh);
    _restart();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _updateTickerMode();
  }

  @override
  void activate() {
    super.activate();
    _attached = true;
    _updateTickerMode();
  }

  @override
  void deactivate() {
    _attached = false;
    _timer?.cancel();
    super.deactivate();
  }

  void _updateTickerMode() {
    final mode = TickerMode.getValuesNotifier(context);
    if (!identical(mode, _tickerMode)) {
      _tickerMode?.removeListener(_scheduleRefresh);
      _tickerMode = mode..addListener(_scheduleRefresh);
    }
    _scheduleRefresh();
  }

  @override
  void didUpdateWidget(PullRequestBadge oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.foreground, widget.foreground)) {
      oldWidget.foreground?.removeListener(_scheduleRefresh);
      widget.foreground?.addListener(_scheduleRefresh);
    }
    if (oldWidget.identity != widget.identity) {
      _restart();
    } else {
      _scheduleRefresh();
    }
  }

  void _restart() {
    _timer?.cancel();
    _result = null;
    _updatedAt = null;
    ++_revision;
    _scheduleRefresh();
  }

  bool get _visible =>
      _attached &&
      (_tickerMode?.value.enabled ?? false) &&
      (widget.foreground?.value ?? true);

  DateTime get _now => widget.now?.call() ?? DateTime.now();

  void _scheduleRefresh() {
    _timer?.cancel();
    _timer = null;
    if (!mounted || !_visible || _pendingRevision == _revision) return;
    final revision = _revision;
    final age = _updatedAt == null ? _interval : _now.difference(_updatedAt!);
    if (age >= Duration.zero && age < _interval) {
      _timer = Timer(_interval - age, () => _refresh(revision));
    } else {
      unawaited(_refresh(revision));
    }
  }

  Future<void> _refresh(int revision) async {
    if (!mounted ||
        !_visible ||
        revision != _revision ||
        _pendingRevision == revision) {
      return;
    }
    _pendingRevision = revision;
    Map<String, dynamic> result;
    try {
      result = await widget.read();
    } catch (_) {
      result = {'status': 'unavailable'};
    }
    if (_pendingRevision == revision) _pendingRevision = null;
    if (!mounted || revision != _revision) return;
    setState(() {
      _result = result;
      _updatedAt = _now;
    });
    _scheduleRefresh();
  }

  @override
  void dispose() {
    _revision++;
    _timer?.cancel();
    _tickerMode?.removeListener(_scheduleRefresh);
    widget.foreground?.removeListener(_scheduleRefresh);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final pr = PullRequestStatus.fromResult(_result);
    if (pr == null) return const SizedBox.shrink();
    final number = pr.number, state = pr.state, uri = pr.url;
    final label = pr.label;
    return Tooltip(
      message: '#$number $state — Open on GitHub',
      child: TextButton(
        style: TextButton.styleFrom(
          minimumSize: const Size(0, 28),
          padding: const EdgeInsets.symmetric(horizontal: 6),
          textStyle: grid.AppType.monoLabel(),
        ),
        onPressed: () async {
          final opened =
              await (widget.open?.call(uri) ??
                  launchUrl(uri, mode: LaunchMode.externalApplication));
          if (!opened && context.mounted) {
            ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              const SnackBar(content: Text('Could not open GitHub.')),
            );
          }
        },
        child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis),
      ),
    );
  }
}
