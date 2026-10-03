// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import 'brand_prefs.dart';

/// The bundled stock Harness icon: the fallback everywhere a logo cannot be drawn.
const harnessIconAsset = 'assets/app_icon.png';

/// A boot logo with the glow treatment, whichever logo was chosen. A monochrome system
/// wordmark (Omarchy's ships black) is tinted with the accent; a custom or stock image keeps its own
/// colours. The glow is always the accent: a blurred silhouette behind the mark at [glow] strength.
/// Any file that fails to load draws the Harness icon instead.
class BrandLogo extends StatelessWidget {
  const BrandLogo({super.key, required this.logo, required this.accent, this.glow = 0.6, this.height = 100});

  final ResolvedLogo logo;
  final Color accent;
  final double glow;
  final double height;

  /// Width over height the logo is laid out at (Omarchy's wordmark is 1215 x 285).
  double get aspect => logo.kind == BootLogo.omarchy ? 1215 / 285 : 1;

  Widget _harness() => Image.asset(harnessIconAsset, fit: BoxFit.contain);

  Widget _mark({required bool tint}) {
    final path = logo.path;
    final filter = tint ? ColorFilter.mode(accent, BlendMode.srcIn) : null;
    if (logo.kind == BootLogo.harness || path == null) {
      return tint ? ColorFiltered(colorFilter: filter!, child: _harness()) : _harness();
    }
    if (logo.isSvg) {
      return SvgPicture.file(File(path), fit: BoxFit.contain, colorFilter: filter, errorBuilder: (_, _, _) => _harness());
    }
    final img = Image.file(File(path), fit: BoxFit.contain, errorBuilder: (_, _, _) => _harness());
    return tint ? ColorFiltered(colorFilter: filter!, child: img) : img;
  }

  @override
  Widget build(BuildContext context) {
    if (logo.kind == BootLogo.none) return const SizedBox.shrink();
    return SizedBox(
      width: height * aspect,
      height: height,
      child: Stack(
        clipBehavior: Clip.none,
        fit: StackFit.expand,
        children: [
          Opacity(
            opacity: glow.clamp(0.0, 1.0),
            child: ImageFiltered(imageFilter: ui.ImageFilter.blur(sigmaX: 14, sigmaY: 14, tileMode: TileMode.decal), child: _mark(tint: true)),
          ),
          _mark(tint: logo.kind == BootLogo.omarchy),
        ],
      ),
    );
  }
}

/// The person an agent is waiting on, as a circle: their picture cropped to the circle,
/// their initials, or a neutral glyph. Never anyone's real face by default.
class AvatarBadge extends StatelessWidget {
  const AvatarBadge({super.key, required this.avatar, required this.size, required this.color, required this.background});

  final ResolvedAvatar avatar;
  final double size;
  final Color color, background;

  @override
  Widget build(BuildContext context) {
    final generic = Icon(Icons.person_outline, size: size * 0.78, color: color);
    final Widget inner = switch (avatar.kind) {
      AvatarSource.initials => FittedBox(
          child: Padding(
            padding: const EdgeInsets.all(2),
            child: Text(avatar.initials, style: TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.w700, color: color)),
          ),
        ),
      AvatarSource.system || AvatarSource.custom when avatar.path != null => avatar.path!.toLowerCase().endsWith('.svg')
          ? SvgPicture.file(File(avatar.path!), fit: BoxFit.cover, errorBuilder: (_, _, _) => generic)
          // Decoded at the size it is drawn (cached by Flutter's image cache), cropped to the circle.
          : Image.file(File(avatar.path!), fit: BoxFit.cover, cacheWidth: (size * 3).round(), errorBuilder: (_, _, _) => generic),
      _ => generic,
    };
    return SizedBox.square(
      dimension: size,
      child: ClipOval(child: ColoredBox(color: background, child: Center(child: inner))),
    );
  }
}
