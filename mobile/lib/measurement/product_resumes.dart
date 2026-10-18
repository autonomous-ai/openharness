import 'product_measurement.dart';

/// `resume_recovery` as the desktop counts it (`desktop/lib/state/app_state.dart`, its restart
/// attempt): from a stopped harness's resume being sent to the first turn it starts afterwards —
/// back at work, not merely relaunched. A refusal, or a failed launch, is `failed`.
///
/// Keys stay in this bounded RAM map and never reach a counter.
class ProductResumes {
  ProductResumes(this.measurement) {
    measurement.addListener(_choiceChanged);
  }

  final ProductMeasurement measurement;
  final _open = <String, void Function(ProductOutcome)>{};
  int _generation = -1;

  void _choiceChanged() {
    if (!measurement.sharing ||
        _generation != measurement.observationGeneration) {
      _open.clear();
    }
    _generation = measurement.observationGeneration;
  }

  /// A resume of [key] went to its machine. One already open for [key] was given up on.
  void sent(String key) {
    _choiceChanged();
    if (!measurement.sharing) return;
    _open.remove(key)?.call(ProductOutcome.cancelled);
    // The oldest gives way, as on the desktop: one never heard of again is not a failure.
    if (_open.length >= 64) {
      _open.remove(_open.keys.first)?.call(ProductOutcome.unknown);
    }
    _open[key] = measurement.begin(ProductFlow.resumeRecovery);
  }

  /// The machine refused [key]'s resume, or its launch failed.
  void refused(String key) => _open.remove(key)?.call(ProductOutcome.failed);

  /// [key] started a turn — live, not a replay. Only a resume still open is ended by it.
  void worked(String key) => _open.remove(key)?.call(ProductOutcome.ok);

  void clear() => _open.clear();

  void dispose() {
    measurement.removeListener(_choiceChanged);
    _open.clear();
  }
}
