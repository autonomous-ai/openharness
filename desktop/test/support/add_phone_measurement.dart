import 'package:harness/measurement/product_measurement.dart';

/// Records the Add Phone card's observation and each way Add Phone opened,
/// instead of reporting them.
class AddPhoneRecorder extends ProductMeasurement {
  AddPhoneRecorder()
    : super(surface: 'desktop', automatic: false, sendSetup: (_) async => {});

  /// Each flow begun, by its enum name.
  final started = <String>[];

  /// Each flow's end, as `flow:outcome`.
  final ended = <String>[];
  final openings = <AddPhoneOpening>[];

  @override
  void Function(ProductOutcome) begin(ProductFlow flow) {
    started.add(flow.name);
    return (outcome) => ended.add('${flow.name}:${outcome.name}');
  }

  @override
  void addPhoneOpened(AddPhoneOpening from) => openings.add(from);
}
