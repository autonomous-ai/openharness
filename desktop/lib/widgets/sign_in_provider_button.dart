import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../auth/sign_in_provider.dart';
import '../shared/theme/app_theme.dart' as grid;

/// One of the login screen's two ways in: "Continue with Google", "Continue with Apple".
///
/// Each wears its provider's own colours rather than the app's accent — Google's white with its
/// four-colour mark, Apple's black with a white one — because that is how a person recognises
/// them, and how the Autonomous storefront's sign-in already shows them. The shape and the type
/// stay the app's.
class SignInProviderButton extends StatelessWidget {
  const SignInProviderButton({
    super.key,
    required this.provider,
    required this.onPressed,
    this.busyLabel,
    this.prominent = false,
    this.focusNode,
    this.autofocus = false,
  });

  final SignInProvider provider;

  /// Null while a sign-in is in flight, on this button or on the other.
  final VoidCallback? onPressed;

  /// What this button says while ITS sign-in is in flight; a spinner takes the mark's place.
  /// Disabled without one is the other button's sign-in, and this one dims.
  final String? busyLabel;

  /// The web page's scale: its sign-in is the page's one call to action, and at
  /// phone width a thumb's target.
  final bool prominent;
  final FocusNode? focusNode;
  final bool autofocus;

  static const double _markSize = 18;

  /// Every way in shares it — the two accounts and whatever is offered beside them — so they
  /// read as one control in rows of one size.
  static Size minimumSize({required bool prominent}) => prominent
      ? const Size(320, 56)
      : Size(280, grid.AppControl.heightFieldScaled);

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final look = _look(provider);
    final busy = busyLabel != null;
    return Opacity(
      // The button that is working stays itself; only the one that cannot be pressed steps back.
      opacity: onPressed == null && !busy ? .5 : 1,
      child: FilledButton(
        key: Key('login-continue-${provider.name}'),
        focusNode: focusNode,
        autofocus: autofocus,
        onPressed: onPressed,
        style:
            FilledButton.styleFrom(
              backgroundColor: look.fill,
              foregroundColor: look.ink,
              disabledBackgroundColor: look.fill,
              disabledForegroundColor: look.ink,
              // ⚠️ One rim in every state, focus included. The first button holds the
              // screen's focus at rest (Enter signs in), so anything focus draws is drawn
              // ALWAYS — and a ring on one of the pair made it read as the larger button
              // (owner, 2026-10-01).
              side: BorderSide(color: look.rim),
              minimumSize: minimumSize(prominent: prominent),
              textStyle: prominent ? grid.AppType.heading() : null,
            ).copyWith(
              // For the same reason, no focus wash: Material's greyed the white fill.
              overlayColor: WidgetStateProperty.resolveWith(
                (states) => look.ink.withValues(
                  alpha: states.contains(WidgetState.pressed)
                      ? .12
                      : states.contains(WidgetState.hovered)
                      ? .08
                      : 0,
                ),
              ),
            ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox.square(
              dimension: _markSize,
              child: busy
                  ? CircularProgressIndicator(strokeWidth: 2, color: look.ink)
                  : _mark(look),
            ),
            const SizedBox(width: 10),
            Flexible(
              child: Text(
                busyLabel ?? 'Continue with ${provider.label}',
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _mark(_ProviderLook look) => ExcludeSemantics(
    child: SvgPicture.asset(
      'assets/sign-in/${provider.name}.svg',
      width: _markSize,
      height: _markSize,
      // Google's mark is its four colours; Apple's is one shape in the button's ink.
      colorFilter: look.tintMark
          ? ColorFilter.mode(look.ink, BlendMode.srcIn)
          : null,
    ),
  );
}

/// A provider's own colours. Not theme tokens: they are the providers' brands, the same in light
/// and dark — except the rim, which each wears only on the card it would otherwise melt into:
/// Google's white on a light one, Apple's black on a dark one. Where the fill already stands
/// apart the rim is the fill's own colour, so neither button looks a line larger than the other.
typedef _ProviderLook = ({Color fill, Color ink, Color rim, bool tintMark});

_ProviderLook _look(SignInProvider provider) => switch (provider) {
  SignInProvider.google => (
    fill: Colors.white,
    ink: const Color(0xFF1F1F1F),
    rim: grid.AppTheme.pick(const Color(0xFFDADCE0), Colors.white),
    tintMark: false,
  ),
  SignInProvider.apple => (
    fill: Colors.black,
    ink: Colors.white,
    rim: grid.AppTheme.pick(Colors.black, const Color(0x3DFFFFFF)),
    tintMark: true,
  ),
};
