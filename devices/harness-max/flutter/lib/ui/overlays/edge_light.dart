// The light that runs around the glass's edge while Attention is up (yellow ask, green done, red failed).
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';

class EdgeLight extends StatelessWidget {
  const EdgeLight({super.key, required this.model});
  final BarModel model;

  @override
  Widget build(BuildContext context) => const SizedBox.expand();
}
