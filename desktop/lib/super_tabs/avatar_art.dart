import 'package:flutter/material.dart';

import '../widgets/desktop_chrome.dart';
import 'profile_model.dart';

/// A stable hash of [text] (FNV-1a, 32 bits): the same name draws the same
/// avatar on every computer and in every build.
int _hash(String text) {
  var hash = 0x811c9dc5;
  for (final unit in text.codeUnits) {
    hash = ((hash ^ unit) * 0x01000193) & 0xffffffff;
  }
  return hash;
}

double _hue(String identity) {
  var hash = 0;
  for (final rune in identity.runes) {
    hash = (hash * 31 + rune) & 0x7fffffff;
  }
  hash = ((hash ^ (hash >> 16)) * 0x45d9f3b) & 0x7fffffff;
  return (hash % 360).toDouble();
}

Color _tone(BuildContext context, double hue) => HSLColor.fromAHSL(
  1,
  hue,
  .42,
  Theme.of(context).brightness == Brightness.dark ? .72 : .36,
).toColor();

/// An agent's default face: a 5×5 grid mirrored left to right, and a hue, both
/// from its name alone.
({List<bool> cells, double hue}) superTabAgentPattern(String name) {
  final hash = _hash(name.trim().toLowerCase());
  final half = [for (var bit = 0; bit < 15; bit++) (hash >> bit) & 1 == 1];
  if (!half.contains(true)) half[7] = true;
  return (
    cells: [
      for (var row = 0; row < 5; row++)
        for (final column in const [0, 1, 2, 1, 0]) half[row * 3 + column],
    ],
    hue: ((hash >> 16) % 360).toDouble(),
  );
}

/// The round face inside an avatar: [picture] when there is one, else the
/// agent pattern when [pattern] is set, else the name's initial.
class SuperTabAvatarFace extends StatelessWidget {
  const SuperTabAvatarFace({
    super.key,
    required this.identity,
    required this.name,
    required this.size,
    this.picture,
    this.pattern = false,
  });
  final String identity, name;
  final double size;
  final SuperTabAvatarPicture? picture;
  final bool pattern;

  @override
  Widget build(BuildContext context) => switch (picture) {
    SuperTabUploadedAvatar(:final url) => ClipOval(
      child: Image.network(
        url.toString(),
        width: size,
        height: size,
        fit: BoxFit.cover,
        errorBuilder: (context, _, _) => _fallback(context),
      ),
    ),
    SuperTabPresetAvatar(:final glyph) => _disc(
      context,
      Text(
        glyph,
        textScaler: TextScaler.noScaling,
        style: TextStyle(fontSize: size * .58, height: 1),
      ),
    ),
    null => _fallback(context),
  };

  Widget _fallback(BuildContext context) =>
      pattern ? _pattern(context) : _initial(context);

  Widget _disc(BuildContext context, Widget child, [Color? color]) => Container(
    width: size,
    height: size,
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: (color ?? _tone(context, _hue(identity))).withValues(alpha: .14),
      shape: BoxShape.circle,
    ),
    child: child,
  );

  Widget _initial(BuildContext context) {
    final color = _tone(context, _hue(identity));
    final words = name
        .trim()
        .split(RegExp(r'[\s@._-]+'))
        .where((w) => w.isNotEmpty)
        .toList();
    final initial = words.isEmpty
        ? '?'
        : words.first.characters.first.toUpperCase();
    return _disc(
      context,
      Text(
        initial,
        textScaler: TextScaler.noScaling,
        style: DesktopChrome.control(
          medium: true,
          color: color,
        ).copyWith(fontSize: size * .43),
      ),
      color,
    );
  }

  Widget _pattern(BuildContext context) {
    final art = superTabAgentPattern(name);
    final color = _tone(context, art.hue);
    return _disc(
      context,
      CustomPaint(
        key: const ValueKey('super-avatar-pattern'),
        size: Size.square(size * .56),
        painter: _PatternPainter(art.cells, color),
      ),
      color,
    );
  }
}

class _PatternPainter extends CustomPainter {
  const _PatternPainter(this.cells, this.color);
  final List<bool> cells;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final cell = size.width / 5;
    final paint = Paint()..color = color;
    for (var i = 0; i < cells.length; i++) {
      if (!cells[i]) continue;
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH((i % 5) * cell, (i ~/ 5) * cell, cell, cell),
          Radius.circular(cell * .2),
        ),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_PatternPainter old) =>
      old.color != color || !identical(old.cells, cells);
}
