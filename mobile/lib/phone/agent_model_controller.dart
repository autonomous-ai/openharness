/// Everything the model sheet knows, kept off the widget that draws it.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/core/test_run.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/usage/models_menu_controller.dart';

/// The agent as the machine last listed it, or null once it is gone.
Agent? agentOnScreen(AppNotifier notifier, String machineId, String agentId) =>
    notifier
        .stateOf(machineId)
        ?.agents
        .where((a) => a.id == agentId)
        .firstOrNull;

/// The two answers the sheet draws — where this agent could go, and what its
/// engine's own subscription has left — behind one listenable.
///
/// ⚠️ **It does not own the MOVE.** Picking closes the sheet, and this goes
/// with it; the retarget outlives both (see `applyModelChoice`). A controller
/// method would be a call into a disposed object by the time the daemon
/// answered.
class AgentModelController extends ChangeNotifier {
  AgentModelController({
    required this.notifier,
    required this.machineId,
    required this.agentId,
  }) {
    _usage.addListener(_changed);
    // The tick follows the agent: a move made from the desktop, or the one this
    // sheet just asked for, lands as an agent frame and is drawn here.
    notifier.addListener(_changed);
    // ⚠️ Not under `flutter test`: a refresh asks every connected machine over
    // the relay, and a widget test would be left holding its timers after the
    // tree was gone. A test that wants a figure drives the controller itself.
    if (!kUnderTest) unawaited(_usage.refresh().catchError((_) {}));
    unawaited(_load());
  }

  final AppNotifier notifier;
  final String machineId;
  final String agentId;

  /// The same controller the desktop's picker reads, so a percentage on the
  /// phone and one on the laptop cannot disagree. Its refresh is capped at once
  /// a minute and answers from cache in between.
  late final ModelsMenuController _usage = ModelsMenuController(
    remote: notifier.readRemoteUsage,
  );

  GridModels? _answer;
  bool _disposed = false;

  /// The agent this sheet is about, followed live.
  Agent? get agent => agentOnScreen(notifier, machineId, agentId);

  /// What the machine answered, or null while it is still being asked. A
  /// failure is an ANSWER — [GridModels.unreachable] — never a null.
  GridModels? get answer => _answer;

  /// The subscription reading for THIS agent's engine, or null when there is
  /// none to show. Absent means the row says nothing about usage, which reads
  /// as "no figure" rather than as a figure that went missing.
  Map<String, Object?>? get subscription {
    final id = agent?.engine?.trim().toLowerCase();
    if (id == null || id.isEmpty) return null;
    for (final row in _usage.rows) {
      if (row['engine'] == id) return row;
    }
    return null;
  }

  /// Asked as the sheet opens rather than held in app state: an engine can join
  /// or leave a grid between two openings, and an offer nobody is serving any
  /// more is worse than a moment's wait.
  Future<void> _load() async {
    final answer = await notifier.gridModels(machineId);
    if (_disposed) return;
    _answer = answer;
    _changed();
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    notifier.removeListener(_changed);
    _usage.removeListener(_changed);
    _usage.dispose();
    super.dispose();
  }
}
