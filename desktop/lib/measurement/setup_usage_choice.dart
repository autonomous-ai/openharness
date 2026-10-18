import 'package:flutter/material.dart';

import '../shared/widgets/setting_row.dart';
import 'product_measurement.dart';

/// What sharing product usage data means, said the same wherever its switch is: Settings ▸ Experimental's row, signed
/// in or not, and the web's Privacy page.
const productUsageDetail =
    'Help improve Harness by sharing usage counts and duration statistics. '
    'Your prompts, code, files, and conversations are never included.';

/// Settings-only control for this computer before an account preference is known.
class SetupUsageChoice extends StatefulWidget {
  const SetupUsageChoice({super.key, required this.measurement});
  final ProductMeasurement measurement;

  @override
  State<SetupUsageChoice> createState() => _SetupUsageChoiceState();
}

class _SetupUsageChoiceState extends State<SetupUsageChoice> {
  bool _saving = false;

  Future<void> _set(bool enabled) async {
    if (!mounted) return;
    ScaffoldMessenger.of(context).hideCurrentSnackBar();
    setState(() {
      _saving = true;
    });
    try {
      await widget.measurement.setSignedOutSharing(enabled);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: const Text(
              'Couldn’t save this setting for the next launch.',
            ),
            action: SnackBarAction(
              label: 'Retry saving',
              onPressed: () => _set(widget.measurement.signedOutSharing),
            ),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.measurement,
    builder: (context, _) => SettingRow(
      title: 'Share product usage data',
      detail: productUsageDetail,
      controlSemanticLabel: 'Share product usage data',
      control: Switch(
        key: const ValueKey('product-usage-sharing'),
        value: widget.measurement.signedOutSharing,
        onChanged: widget.measurement.choiceLoaded && !_saving ? _set : null,
      ),
    ),
  );
}
