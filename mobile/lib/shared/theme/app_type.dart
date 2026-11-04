import 'package:flutter/widgets.dart';

import 'app_theme.dart';

/// The phone's type scale: Desktop's `AppType` roles at a thumb's sizes.
///
/// The same role names, faces and weights as `desktop/lib/shared/theme/
/// app_type.dart`; only the sizes differ, as the Phone section of
/// `desktop/design/desktop-design-system.md` lists them.
///
/// ```
///   display    sans  34  semibold   one per screen: a page title, sign-in
///   title      sans  22  semibold   a settings pane, a hero card, a figure
///   heading    sans  17  semibold   a section, a sheet title, a card title
///   label      sans  17  medium     buttons, rows, list items, links
///   mono       mono  13  regular    commands, source text, paths
///   monoLabel  mono  12  medium     terminal labels, compact code
///   monoMeta   mono  11  regular    shortcut keys, identifiers, code metadata
///   body       sans  17  regular    prose: descriptions, explanations
///   caption    sans  13  regular    metadata, footnotes
/// ```
///
/// Every style takes the same optional arguments, so a call site states its
/// role and only then its colour, weight or figures.
abstract final class AppType {
  static const double displaySize = 34;
  static const double titleSize = 22;
  static const double headingSize = 17;
  static const double bodySize = 17;
  static const double captionSize = 13;
  static const double monoSize = 13;
  static const double monoLabelSize = 12;
  static const double monoMetaSize = 11;

  static TextStyle display({
    Color? color,
    FontWeight? fontWeight,
    FontStyle? fontStyle,
    double? height,
    double? letterSpacing,
    List<FontFeature>? fontFeatures,
  }) => _sans(
    displaySize,
    fontWeight ?? AppFont.semibold,
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
    fontWeight ?? AppFont.semibold,
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
    fontWeight ?? AppFont.semibold,
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
    fontWeight ?? AppFont.regular,
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
    fontWeight ?? AppFont.medium,
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
    fontWeight ?? AppFont.regular,
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
    fontWeight ?? AppFont.regular,
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
    fontWeight ?? AppFont.medium,
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
    fontWeight ?? AppFont.regular,
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
    fontFamily: AppFont.sans,
    fontFamilyFallback: AppFont.sansFallback,
    fontSize: size,
    fontWeight: weight,
    color: color,
    fontStyle: fontStyle,
    height: height,
    letterSpacing: letterSpacing ?? AppFont.trackingFor(size),
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
    fontFamily: AppFont.mono,
    fontFamilyFallback: AppFont.monoFallback,
    fontSize: size,
    fontWeight: weight,
    color: color,
    fontStyle: fontStyle,
    height: height,
    letterSpacing: letterSpacing,
    fontFeatures: fontFeatures,
  );
}
