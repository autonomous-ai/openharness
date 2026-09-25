/// When a fresh model list is the one an open picker already draws.
///
/// The picker redraws its open menu when a read or a push lands with a different list; a rebuild
/// for an identical one would only flicker the hover. "Different" is what the menu SHOWS — rows,
/// their nodes and labels, and what each section says about itself — not every field under it:
/// `lastKnownAge` moves on every read, and a subtitle that rounds to the same words is the same.
library;

import '../core/models.dart';
import 'resting_model_words.dart';

bool drawsSameMenu(GridModels a, GridModels b) {
  if (a.reachable != b.reachable ||
      a.gridName != b.gridName ||
      a.gridCli != b.gridCli) {
    return false;
  }
  if (a.models.length != b.models.length) return false;
  for (var i = 0; i < a.models.length; i += 1) {
    if (!_sameRow(a.models[i], b.models[i])) return false;
  }
  if (a.grids.length != b.grids.length) return false;
  for (var i = 0; i < a.grids.length; i += 1) {
    final left = a.grids[i];
    final right = b.grids[i];
    // What a section SAYS, not every field: `lastKnownAge` moves on every read.
    if (left.name != right.name ||
        left.own != right.own ||
        left.state != right.state ||
        sectionWords(left) != sectionWords(right) ||
        left.models.length != right.models.length) {
      return false;
    }
    for (var j = 0; j < left.models.length; j += 1) {
      if (!_sameRow(left.models[j], right.models[j])) return false;
    }
  }
  return true;
}

bool _sameRow(GridModel a, GridModel b) =>
    a.id == b.id &&
    a.node == b.node &&
    a.grid == b.grid &&
    a.unavailable?.machine == b.unavailable?.machine;
