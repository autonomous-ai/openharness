/// Icon sizes on the phone, as the Phone section of
/// `desktop/design/desktop-design-system.md` gives them: one step larger than
/// Desktop's 16 and 20, for a thumb.
abstract final class AppIconSize {
  /// An icon beside text: a row's mark, a chip's ✕.
  static const double besideText = 20;

  /// An icon alone in a control: the composer's + and @, a sheet row's mark.
  static const double standalone = 24;
}
