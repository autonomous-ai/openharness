import 'package:flutter/widgets.dart';

import 'terminal_font_store.dart';
import 'terminal_typography.dart';
export 'terminal_font_store.dart';
export 'terminal_typography.dart' show terminalFontSize;

/// The selected terminal face and size, also used by the welcome page and
/// shortcut browser. Other app controls use the roles in AppType.
TextStyle terminalTextStyle({
  Color? color,
  FontWeight? fontWeight,
  FontStyle? fontStyle,
  double? height,
  double? letterSpacing,
  List<FontFeature>? fontFeatures,
}) => TextStyle(
  fontFamily: terminalFontStore.value.fontFamily,
  fontFamilyFallback: terminalFontStore.value.fontFamilyFallback,
  fontSize: terminalFontStore.size,
  color: color,
  fontWeight: fontWeight,
  fontStyle: fontStyle,
  height: height,
  letterSpacing: letterSpacing,
  fontFeatures: fontFeatures,
);

/// Keeps retained widgets and open overlays on the same live typography.
class TerminalFontScope extends InheritedNotifier<TerminalFontStore> {
  TerminalFontScope({super.key, required super.child})
    : super(notifier: terminalFontStore);

  static void watch(BuildContext context) {
    context.dependOnInheritedWidgetOfExactType<TerminalFontScope>();
  }
}

/// Scale control geometry with the font, without scaling the text a second time.
double terminalTextScaleOf(BuildContext context) {
  TerminalFontScope.watch(context);
  return MediaQuery.textScalerOf(context).scale(terminalFontStore.size) /
      terminalFontSize;
}
