import 'product_measurement.dart';

/// Existing connection keys stay in this bounded RAM map and never reach a counter.
class ProductConnections {
  ProductConnections(this.measurement) {
    measurement.addListener(_choiceChanged);
  }
  final ProductMeasurement measurement;
  final _pending = <String, void Function(ProductOutcome)>{};
  final _manual = <String, Object>{};
  final _failures = <String, ProductHealthMeasure>{};
  int _generation = -1;
  void _choiceChanged() {
    if (!measurement.sharing ||
        _generation != measurement.observationGeneration) {
      clear();
    }
    _generation = measurement.observationGeneration;
  }

  void refused(String key, ProductHealthMeasure failure) {
    if (_pending.containsKey(key) || _manual.containsKey(key)) {
      _failures.putIfAbsent(key, () => failure);
    }
  }

  void Function(ProductOutcome) manual(String key) {
    _choiceChanged();
    if (!measurement.healthEnabled || !measurement.sharing) return (_) {};
    if (_manual.length >= 64 && !_manual.containsKey(key)) {
      measurement.health(ProductHealthMeasure.observationOverflow);
      return (_) {};
    }
    _pending.remove(key)?.call(ProductOutcome.cancelled);
    _failures.remove(key);
    final ticket = Object();
    _manual[key] = ticket;
    final finish = measurement.begin(ProductFlow.connectUser);
    var done = false;
    return (outcome) {
      if (done) return;
      done = true;
      if (_manual[key] == ticket) {
        _manual.remove(key);
        final failure = _failures.remove(key);
        if (outcome == ProductOutcome.failed && failure != null) {
          measurement.health(failure);
        }
      }
      finish(outcome);
    };
  }

  void status(
    String key, {
    required bool connecting,
    required bool connected,
    ProductHealthMeasure? failure,
    bool suppressStart = false,
  }) {
    _choiceChanged();
    if (!measurement.healthEnabled || !measurement.sharing) {
      clear();
      return;
    }
    if (_manual.containsKey(key)) return;
    if (connecting) {
      // A known unlinked computer's background probes are the same blocked
      // episode. Preserve an already-open observation, but do not start one
      // for every probe. Explicit Connect has its separate manual observation.
      if (suppressStart) return;
      if (_pending.length >= 64 && !_pending.containsKey(key)) {
        measurement.health(ProductHealthMeasure.observationOverflow);
        return;
      }
      _pending.putIfAbsent(
        key,
        () => measurement.begin(ProductFlow.connectAuto),
      );
    } else {
      final finish = _pending.remove(key);
      failure = _failures.remove(key) ?? failure;
      if (finish == null) return;
      finish(
        connected
            ? ProductOutcome.ok
            : failure == null
            ? ProductOutcome.unknown
            : ProductOutcome.failed,
      );
      if (!connected && failure != null) measurement.health(failure);
    }
  }

  void clear() {
    _pending.clear();
    _manual.clear();
    _failures.clear();
  }

  void dispose() {
    measurement.removeListener(_choiceChanged);
    clear();
  }
}
