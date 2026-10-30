/// The phone's spacing, as the Phone section of
/// `desktop/design/desktop-design-system.md` gives it: Desktop's scale of 4, 8,
/// 12, 16 and 24, and a 16-point side inset for a screen's content.
abstract final class AppSpace {
  static const double xs = 4;
  static const double s = 8;
  static const double m = 12;
  static const double l = 16;
  static const double xl = 24;

  /// A screen's content from its left and right edges.
  static const double screenInset = l;
}
