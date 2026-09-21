/// replayWindow.ts: the counters of one key domain are accepted each once, in any order, within
/// [e2eeReplayWindowSize] of the highest seen. The machine can deliver a stream's frames over two
/// transports (P2P and the relay) that reorder against each other, so "strictly increasing" would
/// drop authentic frames.
const int e2eeReplayWindowSize = 4096;

/// JavaScript's `Number.MAX_SAFE_INTEGER` — the CLI refuses any counter above it, so this does too.
const int maxSafeInteger = 9007199254740991;

class ReplayWindow {
  int _highest = -1;
  int _prunedThrough = -1;
  final Set<int> _seen = {};

  bool allows(int counter) =>
      counter >= 0 &&
      counter <= maxSafeInteger &&
      !_seen.contains(counter) &&
      (_highest < 0 || counter > _highest - e2eeReplayWindowSize);

  void commit(int counter) {
    _seen.add(counter);
    if (counter <= _highest) return;
    _highest = counter;
    final oldest = _highest - e2eeReplayWindowSize;
    if (oldest <= _prunedThrough) return;
    // A counter far ahead makes the whole old set stale — clear it rather than walk a gap a
    // hostile peer chose the size of.
    if (oldest - _prunedThrough > e2eeReplayWindowSize) {
      _seen
        ..clear()
        ..add(counter);
    } else {
      for (var value = _prunedThrough + 1; value <= oldest; value++) {
        _seen.remove(value);
      }
    }
    _prunedThrough = oldest;
  }
}
