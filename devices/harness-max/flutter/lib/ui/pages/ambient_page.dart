// Ambient: the clock, the date and the bar's mood.
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';

class AmbientPage extends StatelessWidget {
  const AmbientPage({super.key, required this.model});
  final BarModel model;

  @override
  Widget build(BuildContext context) => const SizedBox.expand();
}
