import 'package:flutter/services.dart';

/// The system bars' style for an app of [brightness]: icons that contrast with it, over the
/// transparent bars `main.dart` draws edge to edge under. The colours are restated because an
/// [AnnotatedRegion]'s style replaces the one set at launch.
SystemUiOverlayStyle systemBarsFor(Brightness brightness) {
  // The icons are the opposite of the app; iOS's `statusBarBrightness` names the GROUND instead.
  final icons = brightness == Brightness.dark
      ? Brightness.light
      : Brightness.dark;
  return SystemUiOverlayStyle(
    statusBarColor: const Color(0x00000000),
    systemNavigationBarColor: const Color(0x00000000),
    statusBarIconBrightness: icons,
    systemNavigationBarIconBrightness: icons,
    statusBarBrightness: brightness,
  );
}
