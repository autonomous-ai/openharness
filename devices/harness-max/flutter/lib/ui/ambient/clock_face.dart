// Ambient's clock (the mockup's `.clock`): the time large in Chakra Petch Light, its colon blinking once a second,
// and the date under it ("Wednesday 18 November").
import 'package:flutter/widgets.dart';

import '../tokens.dart';

const _days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const _months = [
  'January', 'February', 'March', 'April', 'May', 'June', //
  'July', 'August', 'September', 'October', 'November', 'December',
];

String _two(int n) => n.toString().padLeft(2, '0');

/// The date as the mockup's `toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long'})`.
String dateLine(DateTime t) => '${_days[t.weekday - 1]} ${t.day} ${_months[t.month - 1]}';

class ClockFace extends StatelessWidget {
  const ClockFace({super.key, required this.time, required this.colonLit});
  final DateTime time;

  /// The colon's half of its 2 s blink (`colon 2s steps(1)`): lit, else at a fifth.
  final bool colonLit;

  @override
  Widget build(BuildContext context) {
    final digits = Face.n(150, weight: FontWeight.w300, color: Ink.words, height: 1, spacing: -3)
        .copyWith(leadingDistribution: TextLeadingDistribution.even);
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text.rich(
        TextSpan(style: digits, children: [
          TextSpan(text: _two(time.hour)),
          TextSpan(text: ':', style: TextStyle(color: Ink.words.withValues(alpha: colonLit ? 1 : 0.2))),
          TextSpan(text: _two(time.minute)),
        ]),
        maxLines: 1,
        softWrap: false,
      ),
      const SizedBox(height: 8),
      Text(dateLine(time), style: Face.s(20, color: Ink.rest)),
    ]);
  }
}
