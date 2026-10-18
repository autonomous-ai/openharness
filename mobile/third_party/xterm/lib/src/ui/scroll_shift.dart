import 'dart:math' show max, min;

/// AUTONOMOUS PATCH: how far a full-screen program's redraw moved its content —
/// what `RemoteScrollAnimator` slides instead of letting the screen jump.
///
/// Row `i` of the new screen shows what row `i + rows` showed before, for the
/// rows from [top] to [bottom] — the scrolled lines; the rows outside them, the
/// program's own fixed rows, stay where they are.
class ScrollShift {
  const ScrollShift(this.top, this.bottom, this.rows);

  final int top;
  final int bottom;

  /// Negative when the content moved down — a scroll up, towards older lines.
  final int rows;

  @override
  String toString() => 'ScrollShift($top..$bottom by $rows)';
}

/// Rows that must agree on one shift before it is believed.
const _minRowsAgreeing = 3;

/// Compares two screens, one signature per row, and finds the shift that turned
/// [before] into [after] — or null when there is none to be sure of.
///
/// [blank] marks the rows of [after] with nothing on them: they agree with
/// every other blank row, so they are no evidence of anything. [up] and [down]
/// say which way the wheel went; a shift the other way is not this scroll.
///
/// ⚠️ **Null is the safe answer.** A program redraws for many reasons, and a
/// slide drawn for a change that was not a scroll moves the wrong text. A shift
/// is taken only when at least three rows, and most of the rows that could show
/// it, agree on it, and no other shift comes close.
ScrollShift? detectScrollShift({
  required List<int> before,
  required List<int> after,
  required List<bool> blank,
  required bool up,
  required bool down,
}) {
  final rowCount = after.length;
  if (before.length != rowCount || blank.length != rowCount) return null;
  if (!up && !down) return null;

  // The rows that changed. Above and below them — a header, the prompt — the
  // screen stood still.
  var top = 0;
  while (top < rowCount && before[top] == after[top]) {
    top++;
  }
  if (top == rowCount) return null;
  var bottom = rowCount - 1;
  while (before[bottom] == after[bottom]) {
    bottom--;
  }
  final span = bottom - top + 1;
  if (span < _minRowsAgreeing) return null;

  var best = 0;
  var bestAgreeing = 0;
  var bestCandidates = 0;
  var runnerUpAgreeing = 0;
  for (var rows = -(span - 1); rows <= span - 1; rows++) {
    if (rows == 0 || (rows < 0 && !up) || (rows > 0 && !down)) continue;
    // The rows whose old content, `rows` away, is still inside the region.
    final from = max(top, top - rows);
    final to = min(bottom, bottom - rows);
    var agreeing = 0;
    var candidates = 0;
    for (var i = from; i <= to; i++) {
      if (blank[i] || before[i] == after[i]) continue;
      candidates++;
      if (after[i] == before[i + rows]) agreeing++;
    }
    if (agreeing > bestAgreeing) {
      runnerUpAgreeing = bestAgreeing;
      best = rows;
      bestAgreeing = agreeing;
      bestCandidates = candidates;
    } else if (agreeing > runnerUpAgreeing) {
      runnerUpAgreeing = agreeing;
    }
  }

  if (bestAgreeing < _minRowsAgreeing) return null;
  // Most of the rows that could show it, show it.
  if (bestAgreeing * 10 < bestCandidates * 6) return null;
  // And nothing else is nearly as good: repeated rows — rules, borders, a
  // column of equal lines — agree with more than one shift.
  if (runnerUpAgreeing * 2 >= bestAgreeing) return null;

  // The rows that moved, and next to them the rows that came in or went out
  // with them — up to a row with something on it that stood still. Without
  // that stop, a status line that changed below the prompt would stretch the
  // region over the prompt, and slide it with the scrolled lines.
  var first = -1;
  var last = -1;
  for (var i = max(top, top - best); i <= min(bottom, bottom - best); i++) {
    if (!blank[i] && before[i] != after[i] && after[i] == before[i + best]) {
      if (first < 0) first = i;
      last = i;
    }
  }
  bool stoodStill(int row) => !blank[row] && before[row] == after[row];
  while (first > top && !stoodStill(first - 1)) {
    first--;
  }
  while (last < bottom && !stoodStill(last + 1)) {
    last++;
  }
  return ScrollShift(first, last, best);
}
