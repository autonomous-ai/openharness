import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/theme/custom_background.dart';
import '../shared/theme/harness_background.dart';
import 'engine_identity.dart';

/// Empty pages default to the selected tab's fill. An explicit background is
/// used for picker thumbnails; the page follows the saved appearance choice.
class SwarmWallpaper extends StatelessWidget {
  const SwarmWallpaper({
    super.key,
    this.background,
    this.thumbnail = false,
    this.store,
  });
  final HarnessBackground? background;
  final bool thumbnail;

  /// Where the custom background's image, dim and fit come from.
  final AppearancePrefsStore? store;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final prefs = store ?? appearancePrefsStore;
    // Listened to even for an explicit choice: the custom background's dim and
    // fit move while its card is on screen.
    return ValueListenableBuilder<AppearancePrefs>(
      valueListenable: prefs,
      builder: (context, value, _) => _paint(
        context,
        background ?? value.background,
        value.custom,
        prefs.customBackgroundFile,
      ),
    );
  }

  Widget _paint(
    BuildContext context,
    HarnessBackground choice,
    CustomBackground custom,
    File? customFile,
  ) {
    if (choice == HarnessBackground.plain) {
      return ColoredBox(color: grid.AppPalette.swarmField);
    }
    if (choice == HarnessBackground.custom) {
      return _CustomImage(
        file: customFile,
        custom: custom,
        thumbnail: thumbnail,
      );
    }
    if (choice.asset case final asset?) {
      return Stack(
        fit: StackFit.expand,
        children: [
          Image.asset(
            asset,
            fit: BoxFit.cover,
            cacheWidth: thumbnail ? 360 : 1920,
            excludeFromSemantics: true,
            errorBuilder: (_, _, _) =>
                ColoredBox(color: grid.AppPalette.swarmField),
          ),
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [Color(0x1211111c), Color(0x750c111e)],
              ),
            ),
          ),
        ],
      );
    }
    // Lighter in light mode: a wash that reads as a tint on charcoal reads as
    // a stain on white.
    final strength = grid.AppTheme.pick(0.6, 1.0);
    return CustomPaint(
      painter: _MeshPainter(
        ground: grid.AppPalette.panelBg,
        washes: [
          // Not [grid.AppPalette.swarmAccent]: in the graphite palette that is
          // #bdcbdc, a pale grey-blue made to be TEXT on charcoal, and as a wash
          // it reads as a smudge. This is the blue the mockup was drawn in — the
          // blue the New agent button and the Codex mark already share a family
          // with — and it is only ever seen at 14%.
          _Wash(
            const Color(0xFF6E8BFF),
            0.14 * strength,
            const Alignment(-0.7, -0.5),
            0.40,
            0.50,
          ),
          _Wash(
            engineIdentity('claude').color,
            0.10 * strength,
            const Alignment(0.7, -0.7),
            0.45,
            0.40,
          ),
          _Wash(
            engineIdentity('codex').color,
            0.08 * strength,
            const Alignment(0.2, 0.9),
            0.50,
            0.45,
          ),
        ],
      ),
      size: Size.infinite,
    );
  }
}

/// The user's image, fitted and dimmed. A missing or broken copy paints Blank;
/// its thumbnail says so, since that is where it can be fixed.
class _CustomImage extends StatelessWidget {
  const _CustomImage({
    required this.file,
    required this.custom,
    required this.thumbnail,
  });
  final File? file;
  final CustomBackground custom;
  final bool thumbnail;

  /// The page a thumbnail stands for. Center and tile show the image at its
  /// real size, so a thumbnail draws a whole page and shrinks it, rather than
  /// showing a real-size corner of the image.
  static const _thumbnailPage = Size(1280, 720);

  @override
  Widget build(BuildContext context) {
    final blank = ColoredBox(color: grid.AppPalette.swarmField);
    final file = this.file;
    if (file == null) return blank;
    // Checked here rather than in an errorBuilder so the note is drawn at the
    // card's size, not shrunk with the page and dimmed.
    if (thumbnail && !file.existsSync()) {
      return Container(
        key: const ValueKey('custom-background-missing'),
        color: grid.AppPalette.swarmField,
        alignment: Alignment.center,
        padding: const EdgeInsets.all(8),
        child: Text(
          'Image missing, choose again',
          textAlign: TextAlign.center,
          // On the workspace grey, so a light palette needs dark ink here.
          style: grid.AppType.label(
            color: grid.AppTheme.pick(
              grid.AppPalette.textSecondary,
              const Color(0xffdededb),
            ),
          ),
        ),
      );
    }
    // Real size as the OS shows it: one image pixel per device pixel.
    final scale = MediaQuery.devicePixelRatioOf(context);
    Widget missing(BuildContext _, Object _, StackTrace? _) => blank;
    final image = switch (custom.fit) {
      BackgroundFit.fill => Image.file(
        file,
        fit: BoxFit.cover,
        excludeFromSemantics: true,
        errorBuilder: missing,
      ),
      BackgroundFit.fit => Image.file(
        file,
        fit: BoxFit.contain,
        excludeFromSemantics: true,
        errorBuilder: missing,
      ),
      BackgroundFit.center => Image.file(
        file,
        scale: scale,
        fit: BoxFit.none,
        excludeFromSemantics: true,
        errorBuilder: missing,
      ),
      BackgroundFit.tile => Image.file(
        file,
        scale: scale,
        fit: BoxFit.none,
        alignment: Alignment.topLeft,
        repeat: ImageRepeat.repeat,
        excludeFromSemantics: true,
        errorBuilder: missing,
      ),
    };
    final page = Stack(
      fit: StackFit.expand,
      children: [
        blank,
        image,
        IgnorePointer(
          child: ColoredBox(
            color: const Color(0xff000000).withValues(alpha: custom.dim),
          ),
        ),
      ],
    );
    if (!thumbnail) return page;
    return ClipRect(
      child: FittedBox(
        fit: BoxFit.cover,
        child: SizedBox.fromSize(size: _thumbnailPage, child: page),
      ),
    );
  }
}

/// One wash: a radial fade from `opacity` at `at` to nothing, `rx`/`ry` wide
/// and tall as fractions of the canvas — the CSS
/// `radial-gradient(ellipse rx ry at …)` the mockup was drawn with.
class _Wash {
  const _Wash(this.color, this.opacity, this.at, this.rx, this.ry);
  final Color color;
  final double opacity;
  final Alignment at;
  final double rx, ry;
}

class _MeshPainter extends CustomPainter {
  const _MeshPainter({required this.ground, required this.washes});
  final Color ground;
  final List<_Wash> washes;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = ground);
    for (final w in washes) {
      final c = at(w.at, size);
      final rx = size.width * w.rx, ry = size.height * w.ry;
      // A circle of radius rx, squashed to ry vertically about its centre:
      // the shader's own transform, so the fade itself is elliptical rather
      // than a circle drawn in an oval.
      final m = Matrix4.identity()
        ..translateByDouble(c.dx, c.dy, 0, 1)
        ..scaleByDouble(1, ry / rx, 1, 1)
        ..translateByDouble(-c.dx, -c.dy, 0, 1);
      final paint = Paint()
        ..shader = ui.Gradient.radial(
          c,
          rx,
          [w.color.withValues(alpha: w.opacity), w.color.withValues(alpha: 0)],
          const [0.0, 0.7],
          TileMode.clamp,
          m.storage,
        );
      canvas.drawRect(Offset.zero & size, paint);
    }
  }

  static Offset at(Alignment a, Size s) =>
      Offset(s.width * (a.x + 1) / 2, s.height * (a.y + 1) / 2);

  @override
  bool shouldRepaint(_MeshPainter old) =>
      old.ground != ground ||
      old.washes.length != washes.length ||
      Iterable.generate(washes.length).any(
        (i) =>
            old.washes[i].color != washes[i].color ||
            old.washes[i].opacity != washes[i].opacity,
      );
}
