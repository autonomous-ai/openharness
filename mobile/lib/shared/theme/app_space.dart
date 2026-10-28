/// The phone's spacing scale and icon sizes, as the Phone section of
/// `desktop/design/desktop-design-system.md` lists them: the same spacing
/// steps as Desktop, and icons one step larger for a thumb.
///
/// ```
///   xs   4   a hairline's air, a progress bar's thickness
///   s    8   between a control and its label, inside a chip
///   m   12   between related rows
///   l   16   the screen's side inset, a group's gap
///   xl  24   between sections
/// ```
abstract final class AppSpace {
  static const double xs = 4;
  static const double s = 8;
  static const double m = 12;
  static const double l = 16;
  static const double xl = 24;
}

/// Icon sizes on the phone: beside text, and standing alone in a control.
abstract final class AppIconSize {
  static const double besideText = 20;
  static const double standalone = 24;
}
