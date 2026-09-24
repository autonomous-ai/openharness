import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/pull_request_status.dart';
import 'app_state.dart';
import 'workspace_status.dart';

typedef _Identity = (String, String, String?, String?, String?);

/// One PR reader for the focused harness, including a dependent viewer's owner.
/// Never publishes a late reply for a different pane or branch.
class WorkspacePullRequest extends ChangeNotifier {
  WorkspacePullRequest(
    this.app, {
    Future<Map<String, dynamic>> Function(String, String)? read,
  }) : _read = read ?? app.readAgentPullRequest {
    app.addListener(_focusChanged);
    _focusChanged();
  }
  final AppNotifier app;
  final Future<Map<String, dynamic>> Function(String, String) _read;
  final _cache = <_Identity, (DateTime, PullRequestStatus?)>{};
  _Identity? _identity;
  PullRequestStatus? value;
  Timer? _timer;
  int _revision = 0;

  void _focusChanged() {
    final focused = WorkspacePaneContext.focused(app);
    final agent = focused?.agent;
    final project = agent == null
        ? null
        : app.stateOf(focused!.pane.machineId)?.projectOf(agent);
    final identity =
        focused == null || agent == null || project?.shownBranch == null
        ? null
        : (
            focused.pane.machineId,
            agent.id,
            project?.cwd,
            project?.remote,
            project?.shownBranch,
          );
    if (identity == _identity) return;
    _identity = identity;
    final revision = ++_revision;
    _timer?.cancel();
    final cached = _cache[identity];
    value = cached?.$2;
    notifyListeners();
    if (identity == null) return;
    final age = cached == null
        ? const Duration(seconds: 60)
        : DateTime.now().difference(cached.$1);
    if (age < const Duration(seconds: 60)) {
      _timer = Timer(
        const Duration(seconds: 60) - age,
        () => _refresh(identity, revision),
      );
    } else {
      unawaited(_refresh(identity, revision));
    }
  }

  Future<void> _refresh(_Identity identity, int revision) async {
    Map<String, dynamic>? result;
    try {
      result = await _read(identity.$1, identity.$2);
    } catch (_) {
      /* Hidden until available. */
    }
    if (revision != _revision) return;
    value = PullRequestStatus.fromResult(result);
    if (_cache.length >= 32 && !_cache.containsKey(identity)) {
      _cache.remove(_cache.keys.first);
    }
    _cache[identity] = (DateTime.now(), value);
    notifyListeners();
    if (revision != _revision) return;
    _timer = Timer(
      const Duration(seconds: 60),
      () => _refresh(identity, revision),
    );
  }

  @override
  void dispose() {
    _revision++;
    _timer?.cancel();
    app.removeListener(_focusChanged);
    super.dispose();
  }
}
