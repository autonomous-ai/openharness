// Attention's answer buttons (the mockup's `.at-btns button`): an option, Say it, Allow, Deny.
import 'package:flutter/widgets.dart';

import '../tokens.dart';
import 'glyphs.dart';

/// How a button looks.
/// - [plain]: an option or Say it.
/// - [chosen]: an option already chosen while the answer goes (V2's ring in the done green).
/// - [allow]: the permission's yes, filled green.
/// - [deny]: the permission's no, a red outline.
/// - [off]: nothing to press while an answer is read or goes.
enum AnswerLook { plain, chosen, allow, deny, off }

class AnswerButton extends StatelessWidget {
  const AnswerButton({super.key, required this.label, this.look = AnswerLook.plain, this.mic = false, this.held = false});
  final String label;
  final AnswerLook look;

  /// Say it: the mic glyph before the label.
  final bool mic;

  /// A finger is on it: it sinks to 98 %, as the mockup's `:active`.
  final bool held;

  static const _allowInk = Color(0xFF00130B);
  static const _denyInk = Color(0xFFFFB4B4);
  static const _denyRim = Color(0xFFAA3333);

  @override
  Widget build(BuildContext context) {
    final (fill, ring, width, ink) = switch (look) {
      AnswerLook.plain => (Ink.card, Ink.rim, 1.0, Ink.fg),
      AnswerLook.chosen => (Ink.card, Ink.done, 2.0, Ink.fg),
      AnswerLook.allow => (Ink.done, null, 0.0, _allowInk),
      AnswerLook.deny => (Ink.card, _denyRim, 1.5, _denyInk),
      AnswerLook.off => (Ink.card, Ink.rim, 1.0, Ink.faint),
    };
    const radius = BorderRadius.all(Radius.circular(16));
    return Transform.scale(
      scale: held ? 0.98 : 1,
      child: Container(
        height: 58,
        constraints: const BoxConstraints(maxWidth: 520),
        padding: const EdgeInsets.symmetric(horizontal: 30),
        decoration: BoxDecoration(color: fill, borderRadius: radius),
        // The mockup's ring is an inset box-shadow: drawn over the fill, it takes no room from the label.
        foregroundDecoration: ring == null
            ? null
            : BoxDecoration(borderRadius: radius, border: Border.all(color: ring, width: width)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (mic) ...[GlyphIcon(Glyph.mic, size: 22, color: ink), const SizedBox(width: 10)],
          Flexible(
            child: Text(label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Face.s(21, weight: FontWeight.w600, color: ink)),
          ),
        ]),
      ),
    );
  }
}
