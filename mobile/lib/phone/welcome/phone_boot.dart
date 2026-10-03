import 'package:flutter/material.dart';

import '../tty.dart';
import '../tty_controls.dart';

/// The phone while the app starts: the terminal's ground and the mark, nothing to read — a second
/// at most, and the welcome or the last harness follows. No spinner: nothing moves while nothing is
/// asked of the person.
class PhoneBoot extends StatelessWidget {
  const PhoneBoot({super.key});

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return ColoredBox(
      color: tty.ground,
      child: Center(
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            TtyText('harness', size: TtySize.title, weight: FontWeight.w600),
            Container(
              width: 9,
              height: 18,
              margin: const EdgeInsets.only(left: 2),
              color: tty.green,
            ),
          ],
        ),
      ),
    );
  }
}
