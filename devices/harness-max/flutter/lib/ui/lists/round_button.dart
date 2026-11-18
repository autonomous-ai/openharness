// The mockup's `.round`: a 64 px disc in the card's colour with a 1 px rim and a line icon in it.
import 'package:flutter/widgets.dart';

import '../attention/glyphs.dart';
import '../tokens.dart';

class RoundButton extends StatelessWidget {
  const RoundButton(this.glyph, {super.key});
  final Glyph glyph;

  @override
  Widget build(BuildContext context) => Container(
        width: 64,
        height: 64,
        alignment: Alignment.center,
        decoration: const BoxDecoration(color: Ink.card, shape: BoxShape.circle),
        foregroundDecoration:
            BoxDecoration(shape: BoxShape.circle, border: Border.all(color: Ink.rim, width: 1)),
        child: GlyphIcon(glyph, size: 28, color: Ink.fg),
      );
}
