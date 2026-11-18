// The toast at the bar's foot.
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';

class ToastOverlay extends StatelessWidget {
  const ToastOverlay({super.key, required this.model});
  final BarModel model;

  @override
  Widget build(BuildContext context) => const SizedBox.expand();
}
