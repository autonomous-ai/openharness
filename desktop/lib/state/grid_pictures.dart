import 'package:flutter/foundation.dart';

import '../core/models.dart';

/// The app's one picture of what each machine's daemon says the account's grids serve.
///
/// The pane picker, the macOS Models menu and the Model Manager used to keep an answer each, asked
/// for on their own schedules — three reads for one list, and three chances to disagree. They now
/// read this, and it is fed from two places: every `grid_models_list` answer ([AppNotifier.refreshGridModels])
/// and the daemon's `grid_models_changed` push, which carries the same document and needs no
/// request at all.
///
/// Its own notifier rather than [AppNotifier]'s, so a surface listening for a new list is not
/// rebuilt on every terminal frame, and a list changing does not rebuild the workspace.
class GridPictures extends ChangeNotifier {
  final Map<String, GridModels> _byMachine = {};
  final Map<String, int> _epochs = {};

  /// Moves on every [clear], so a read that started under the previous account can never land.
  int _generation = 0;

  /// The latest answer from [machineId]'s daemon, or null before it has said anything.
  GridModels? operator [](String machineId) => _byMachine[machineId];

  /// How many answers [machineId]'s picture has taken so far. A read captures it when it starts, so
  /// that an answer which was already on its way when a push landed cannot overwrite the push.
  int epochOf(String machineId) =>
      (_generation << 32) | (_epochs[machineId] ?? 0);

  /// Take [answer] as [machineId]'s picture. With [ifEpoch], only when nothing else has been
  /// adopted for that machine since the caller read [epochOf]. Returns whether it was adopted.
  bool adopt(String machineId, GridModels answer, {int? ifEpoch}) {
    if (ifEpoch != null && epochOf(machineId) != ifEpoch) return false;
    _byMachine[machineId] = answer;
    _epochs[machineId] = (_epochs[machineId] ?? 0) + 1;
    notifyListeners();
    return true;
  }

  /// Forget every machine — a sign-out, where the next account's grids are not these.
  void clear() {
    _generation++;
    _epochs.clear();
    if (_byMachine.isEmpty) return;
    _byMachine.clear();
    notifyListeners();
  }
}
