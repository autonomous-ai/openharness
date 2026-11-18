// The glass: the mockup's 1480 x 320 canvas scaled to whatever screen the bar has, letterboxed in black, with the
// default text style and direction the pages assume (there is no MaterialApp).
import 'package:flutter/widgets.dart';

import 'tokens.dart';

class BarFrame extends StatelessWidget {
  const BarFrame({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => ColoredBox(
        color: Ink.bg,
        child: Directionality(
          textDirection: TextDirection.ltr,
          child: DefaultTextStyle(
            style: Face.s(16),
            child: Center(
              child: FittedBox(
                child: SizedBox.fromSize(size: kCanvas, child: ClipRect(child: child)),
              ),
            ),
          ),
        ),
      );
}
