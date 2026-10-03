import 'package:flutter/widgets.dart';

import '../../core/apple_fonts.dart';
import '../../terminal/terminal_font_store.dart';

/// The app's type scale: which face, size and weight a piece of text gets.
///
/// System typography belongs to app navigation, forms, headings, and prose.
/// Monospace is explicit: terminal content, code, paths, and identifiers.
/// Changing the terminal font must not change desktop controls. The terminal
/// grid, its composer, and in-pane find keep their own selected font and size.
/// These base sizes also respect the platform's accessibility text scaling.
///
/// ```
///   display    sans  28  semibold   one per screen: a page title, sign-in
///   title      sans  20  semibold   a settings pane, a hero card, a figure
///   heading    sans  17  semibold   a section, a dialog title, a card title
///   label      sans  13  medium     buttons, rows, sidebar items, links
///   mono       mono  13  regular    commands, source text, paths
///   monoLabel  mono  12  medium     terminal labels, compact code
///   monoMeta   mono  11  regular    shortcut keys, identifiers, code metadata
///   body       sans  13  regular    prose: descriptions, explanations
///   caption    sans  12  regular    tooltips, footnotes
/// ```
///
/// Every style takes the same optional arguments as `terminalTextStyle`, so a
/// call site states its role and only then its colour or weight.
abstract final class AppType {
  static const double displaySize = 28;
  static const double titleSize = 20;
  static const double headingSize = 17;
  static const double bodySize = 13;
  static const double captionSize = 12;
  static const double monoSize = 13;
  static const double monoLabelSize = 12;
  static const double monoMetaSize = 11;

  /// The system UI face.
  ///
  /// `Ubuntu Sans` (25.04 and later) and `Ubuntu` lead on Linux because they
  /// are what the desktop itself is set in. Both are two-axis variable fonts
  /// that the engine cannot currently reach on Ubuntu 26.04, so there the face
  /// that actually draws is `Noto Sans`, next in [sansFallback].
  static String get sansFamily =>
      hasAppleFonts ? '.AppleSystemUIFont' : 'Ubuntu Sans';

  static List<String> get sansFallback => hasAppleFonts
      ? const ['SF Pro Text', 'Helvetica Neue', 'Arial']
      : const ['Ubuntu', 'Noto Sans', 'DejaVu Sans', 'sans-serif'];

  /// The terminal's face, so mono chrome changes with the terminal font.
  static String get monoFamily => terminalFontStore.value.fontFamily;
  static List<String> get monoFallback =>
      terminalFontStore.value.fontFamilyFallback;

  /// Tracking for the sans face at [size], after Apple's SF Pro table: SF Pro
  /// is optically sized, and Flutter asks CoreText for one static face, so
  /// small text reads cramped and large text reads as one mass without it.
  /// Mono keeps its cell spacing and takes none.
  static double trackingFor(double size) {
    if (size >= 28) return -0.4;
    if (size >= 20) return -0.25;
    if (size >= 17) return -0.1;
    if (size >= 15) return 0;
    if (size >= 13) return 0.05;
    return 0.12;
  }

  static TextStyle display({
    Color? color,
    FontWeight? fontWeight,
    FontStyle? fontStyle,
    double? height,
    double? letterSpacing,
    List<FontFeature>? fontFeatures,
  }) => _sans(
    displaySize,
    fontWeight ?? FontWeight.w600,
    color,
    fontStyle,
    height,
    letterSpacing,
    fontFeatures,
  );

  static TextStyle title({
    Color? color,
    FontWeight? fontWeight,
    FontStyle? fontStyle,
    double? height,
    double? letterSpacing,
    List<FontFeature>? fontFeatures,
  }) => _sans(
    titleSize,
    fontWeight ?? FontWeight.w600,
    color,
    fontStyle,
    height,
    letterSpacing,
    fontFeatures,
  );

  static TextStyle heading({
    Color? color,
    FontWeight? fontWeight,
    FontStyle? fontStyle,
    double? height,
    double? letterSpacing,
    List<FontFeature>? fontFeatures,
  }) => _sans(
    headingSize,
    fontWeight ?? FontWeight.w600,
    color,
    fontStyle,
    height,
    letterSpacing,
    fontFeatures,
  );

  static TextStyle body({
    Color? color,
    FontWeight? fontWeight,
    FontStyle? fontStyle,
    double? height,
    double? letterSpacing,
    List<FontFeature>? fontFeatures,
  }) => _sans(
    bodySize,
    fontWeight ?? FontWeight.w400,
    color,
    fontStyle,
    height,
    letterSpacing,
    fontFeatures,
  );

  static TextStyle label({
    Color? color,
    FontWeight? fontWeight,
    FontStyle? fontStyle,
    double? height,
    double? letterSpacing,
    List<FontFeature>? fontFeatures,
  }) => _sans(
    bodySize,
    fontWeight ?? FontWeight.w500,
    color,
    fontStyle,
    height,
    letterSpacing,
    fontFeatures,
  );

  static TextStyle caption({
    Color? color,
    FontWeight? fontWeight,
    FontStyle? fontStyle,
    double? height,
    double? letterSpacing,
    List<FontFeature>? fontFeatures,
  }) => _sans(
    captionSize,
    fontWeight ?? FontWeight.w400,
    color,
    fontStyle,
    height,
    letterSpacing,
    fontFeatures,
  );

  static TextStyle mono({
    Color? color,
    FontWeight? fontWeight,
    FontStyle? fontStyle,
    double? height,
    double? letterSpacing,
    List<FontFeature>? fontFeatures,
  }) => _mono(
    monoSize,
    fontWeight ?? FontWeight.w400,
    color,
    fontStyle,
    height,
    letterSpacing,
    fontFeatures,
  );

  static TextStyle monoLabel({
    Color? color,
    FontWeight? fontWeight,
    FontStyle? fontStyle,
    double? height,
    double? letterSpacing,
    List<FontFeature>? fontFeatures,
  }) => _mono(
    monoLabelSize,
    fontWeight ?? FontWeight.w500,
    color,
    fontStyle,
    height,
    letterSpacing,
    fontFeatures,
  );

  static TextStyle monoMeta({
    Color? color,
    FontWeight? fontWeight,
    FontStyle? fontStyle,
    double? height,
    double? letterSpacing,
    List<FontFeature>? fontFeatures,
  }) => _mono(
    monoMetaSize,
    fontWeight ?? FontWeight.w400,
    color,
    fontStyle,
    height,
    letterSpacing,
    fontFeatures,
  );

  static TextStyle _sans(
    double size,
    FontWeight weight,
    Color? color,
    FontStyle? fontStyle,
    double? height,
    double? letterSpacing,
    List<FontFeature>? fontFeatures,
  ) => TextStyle(
    fontFamily: sansFamily,
    fontFamilyFallback: sansFallback,
    fontSize: size,
    fontWeight: weight,
    color: color,
    fontStyle: fontStyle,
    height: height,
    letterSpacing: letterSpacing ?? trackingFor(size),
    fontFeatures: fontFeatures,
  );

  static TextStyle _mono(
    double size,
    FontWeight weight,
    Color? color,
    FontStyle? fontStyle,
    double? height,
    double? letterSpacing,
    List<FontFeature>? fontFeatures,
  ) => TextStyle(
    fontFamily: monoFamily,
    fontFamilyFallback: monoFallback,
    fontSize: size,
    fontWeight: weight,
    color: color,
    fontStyle: fontStyle,
    height: height,
    letterSpacing: letterSpacing,
    fontFeatures: fontFeatures,
  );
}

/// How much larger than drawn the UI's text is, for sizing the box around it.
///
/// The UI's counterpart to `terminalTextScaleOf`, which follows the terminal's
/// size setting and so belongs only to the terminal's own surfaces. This one
/// follows the platform text scale alone, so chrome keeps its layout when the
/// terminal is zoomed.
double appTextScaleOf(BuildContext context) =>
    MediaQuery.textScalerOf(context).scale(AppType.bodySize) / AppType.bodySize;
