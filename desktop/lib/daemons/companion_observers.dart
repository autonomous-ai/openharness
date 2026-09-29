import 'dart:async';

import '../core/pull_request_status.dart';
import 'companion_life.dart';

/// Only a tool result whose start was observed during a live turn is news.
/// We never inspect command output or treat words such as "bug" as evidence.
class CompanionTools {
  CompanionTools(this.react);
  final void Function(CompanionEvent, String) react;
  final _running = <String, String>{};
  final _failed = <String>{};
  void reset() {
    _running.clear();
    _failed.clear();
  }

  void observe(String owner, String type, Map<String, dynamic> payload) {
    final id = payload['id'], tool = payload['tool'];
    if (id is! String || id.isEmpty || id.length > 256) return;
    final key = '$owner/$id';
    if (type == 'tool_start') {
      if (tool is! String || tool.isEmpty || tool.length > 128) return;
      _running[key] = '$owner/$tool';
      if (_running.length > 256) _running.remove(_running.keys.first);
    } else if (type == 'tool_end') {
      final family = _running.remove(key);
      if (family == null) return;
      // Wire IDs contain no prose and stay inside the ASCII protocol bounds.
      final eventId = 'tool:${key.hashCode.toUnsigned(32)}';
      if (payload['isError'] == true) {
        _failed.add(family);
        if (_failed.length > 128) _failed.remove(_failed.first);
        react(CompanionEvent.bug, eventId);
      } else if (payload['isError'] == false && _failed.remove(family)) {
        react(CompanionEvent.recovered, eventId);
      }
    }
  }
}

typedef CompanionPrSource = ({String key, String machine, String agent});

/// Follow PRs across the supervised workspaces, including background panes.
/// Two reads at a time, one minute between cycles, no historical celebrations.
class CompanionPullRequests {
  CompanionPullRequests({
    required this.sources,
    required this.read,
    required this.merged,
  });
  final Iterable<CompanionPrSource> Function() sources;
  final Future<Map<String, dynamic>> Function(String, String) read;
  final void Function(PullRequestStatus) merged;
  final _known = <String, String>{};
  Timer? _timer;
  String? _scope;
  int _generation = 0;
  bool _enabled = false, _polling = false;

  void bind({required bool enabled, required String? scope}) {
    if (_enabled == enabled && _scope == scope) return;
    _generation++;
    _scope = scope;
    _enabled = enabled;
    _known.clear();
    _timer?.cancel();
    _timer = null;
    if (enabled) unawaited(poll());
  }

  Future<void> poll() async {
    if (!_enabled || _polling) return;
    _polling = true;
    final generation = _generation;
    final unique = {for (final source in sources()) source.key: source};
    final pending = unique.values.take(64).toList();
    try {
      for (var i = 0; i < pending.length; i += 2) {
        if (generation != _generation) return;
        await Future.wait(
          pending.skip(i).take(2).map((source) async {
            Map<String, dynamic>? result;
            try {
              result = await read(source.machine, source.agent);
            } catch (_) {
              return;
            }
            if (generation != _generation) return;
            final pr = PullRequestStatus.fromResult(result);
            if (pr == null) return;
            final key = pr.url.toString(), before = _known[key];
            _known[key] = pr.state;
            if (_known.length > 128) _known.remove(_known.keys.first);
            if ((before == 'Open' || before == 'Draft') &&
                pr.state == 'Merged') {
              merged(pr);
            }
          }),
        );
      }
    } finally {
      _polling = false;
      if (_enabled) {
        _timer?.cancel();
        _timer = Timer(
          generation == _generation
              ? const Duration(minutes: 1)
              : Duration.zero,
          poll,
        );
      }
    }
  }

  void dispose() {
    _enabled = false;
    _generation++;
    _timer?.cancel();
  }
}
