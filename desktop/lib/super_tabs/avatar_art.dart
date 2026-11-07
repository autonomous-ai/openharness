import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/swarm_palette.dart';
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

/// An agent's default face (anh Dee, task #4461): its fill, top to bottom, and how far its eyes and smile shift
/// sideways (units of a 100-unit disc) and tilt (degrees), all from its name alone.
({Color top, Color bottom, double shift, double tilt}) superTabAgentFace(
  String name,
) {
  final hash = _hash(name.trim().toLowerCase());
  final (top, bottom) = SwarmPalette.faces[hash % 8];
  return (
    top: top,
    bottom: bottom,
    shift: const [-3.0, 0.0, 3.0][(hash >> 9) % 3],
    tilt: const [-9.0, -4.0, 0.0, 5.0, 10.0][(hash >> 5) % 5],
  );
}

/// The face inside an avatar: [picture] when there is one, else the agent
/// face when [face] is set, else the name's initial. Round, or a rounded
/// square with [radius] corners; the agent face is always a disc.
class SuperTabAvatarFace extends StatelessWidget {
  const SuperTabAvatarFace({
    super.key,
    required this.identity,
    required this.name,
    required this.size,
    this.picture,
    this.face = false,
    this.radius,
    this.faceCorner,
  });
  final String identity, name;
  final double size;
  final SuperTabAvatarPicture? picture;
  final bool face;
  final double? radius;

  /// The corner of a rounded-square agent face: a Lead on the Projects list (task #4662). Null draws the disc, which
  /// every other place keeps whatever its [radius].
  final double? faceCorner;

  @override
  Widget build(BuildContext context) => switch (picture) {
    SuperTabUploadedAvatar(:final url) => _clip(
      Image.network(
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

  Widget _clip(Widget child) => switch (radius) {
    final radius? => ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: child,
    ),
    null => ClipOval(child: child),
  };

  Widget _fallback(BuildContext context) => face ? _face() : _initial(context);

  Widget _disc(BuildContext context, Widget child, [Color? color]) => Container(
    width: size,
    height: size,
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: (color ?? _tone(context, _hue(identity))).withValues(alpha: .14),
      shape: radius == null ? BoxShape.circle : BoxShape.rectangle,
      borderRadius: switch (radius) {
        final radius? => BorderRadius.circular(radius),
        null => null,
      },
    ),
    child: child,
  );

  Widget _initial(BuildContext context) {
    // People are grey: colour is only on agent faces (task #4466).
    final color = identity.startsWith('person:')
        ? grid.AppPalette.textSecondary
        : _tone(context, _hue(identity));
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

  Widget _face() => CustomPaint(
    key: const ValueKey('super-agent-face'),
    size: Size.square(size),
    painter: _FacePainter(
      superTabAgentFace(name),
      corner: switch (faceCorner) {
        final corner? => corner / size * 100,
        null => null,
      },
    ),
  );
}

/// The face on a 100-unit disc: a soft top-to-bottom fill, two eyes and a
/// small smile in [SwarmPalette.faceInk], shifted and tilted around the centre.
class _FacePainter extends CustomPainter {
  const _FacePainter(this.face, {this.corner});
  final ({Color top, Color bottom, double shift, double tilt}) face;

  /// The corner of a rounded-square face; a disc when null.
  final double? corner;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.scale(size.width / 100);
    final fill = Paint()
      ..shader = LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [face.top, face.bottom],
      ).createShader(const Rect.fromLTWH(0, 0, 100, 100));
    switch (corner) {
      case final corner?:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(0, 0, 100, 100),
            Radius.circular(corner),
          ),
          fill,
        );
      case null:
        canvas.drawCircle(const Offset(50, 50), 50, fill);
    }
    canvas
      ..translate(50, 50)
      ..rotate(face.tilt * math.pi / 180)
      ..translate(-50, -50);
    final dx = face.shift;
    final ink = Paint()..color = SwarmPalette.faceInk;
    for (final x in [36.0, 64.0]) {
      canvas.drawOval(
        Rect.fromCenter(center: Offset(x + dx, 45), width: 10.4, height: 14),
        ink,
      );
    }
    canvas.drawPath(
      Path()
        ..moveTo(37 + dx, 62)
        ..quadraticBezierTo(50 + dx, 74, 63 + dx, 62),
      Paint()
        ..color = SwarmPalette.faceInk
        ..style = PaintingStyle.stroke
        ..strokeWidth = 5.6
        ..strokeCap = StrokeCap.round,
    );
  }

  @override
  bool shouldRepaint(_FacePainter old) =>
      old.face != face || old.corner != corner;
}
