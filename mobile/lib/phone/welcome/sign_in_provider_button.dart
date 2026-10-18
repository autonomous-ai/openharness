import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/auth/sign_in_provider.dart';

import '../tty.dart';
import '../tty_controls.dart';

/// One of the welcome screen's two accounts: "Continue with Google", "Continue with Apple" — the
/// desktop's login buttons (`desktop/lib/widgets/sign_in_provider_button.dart`), on a phone.
///
/// Each wears its provider's own colours rather than the terminal's — Google's white with its
/// four-colour mark, Apple's black with a white one — because that is how a person recognises
/// them, and what both providers ask of a button that signs in with them. The shape and the type
/// stay the phone's: the welcome rows' height and corners, the terminal's face.
///
/// The marks are `assets/sign-in/`, drawn from the desktop's `assets/sign-in/*.svg` by
/// `scripts/render_svg.swift` at 1x, 2x and 3x — this app draws no SVG (see `pubspec.yaml`).
class SignInProviderButton extends StatefulWidget {
  const SignInProviderButton({
    super.key,
    required this.provider,
    required this.onPressed,
    this.busyLabel,
  });

  final SignInProvider provider;

  /// Null while a sign-in is in flight, on this button or on the other.
  final VoidCallback? onPressed;

  /// What this button says while ITS sign-in is in flight; a spinner takes the mark's place.
  /// Disabled without one is the other button's sign-in, and this one steps back.
  final String? busyLabel;

  /// The welcome rows' own height: the two accounts sit under the question's two answers.
  static const double height = 52;

  static const double _markSize = 18;

  @override
  State<SignInProviderButton> createState() => _SignInProviderButtonState();
}

class _SignInProviderButtonState extends State<SignInProviderButton> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final look = _look(widget.provider, light: tty.isLight);
    final busy = widget.busyLabel != null;
    final enabled = widget.onPressed != null;
    final label = widget.busyLabel ?? 'Continue with ${widget.provider.label}';
    return Semantics(
      button: true,
      enabled: enabled,
      label: label,
      excludeSemantics: true,
      child: Opacity(
        // The button that is working stays itself; only the one that cannot be pressed steps back.
        opacity: !enabled && !busy ? .5 : 1,
        child: GestureDetector(
          key: Key('welcome-continue-${widget.provider.name}'),
          behavior: HitTestBehavior.opaque,
          onTapDown: enabled ? (_) => setState(() => _down = true) : null,
          onTapCancel: enabled ? () => setState(() => _down = false) : null,
          onTapUp: enabled ? (_) => setState(() => _down = false) : null,
          onTap: enabled
              ? () {
                  HapticFeedback.lightImpact();
                  widget.onPressed!();
                }
              : null,
          child: Container(
            // At least this tall, and taller when the text is larger — never clipped.
            constraints: const BoxConstraints(
              minHeight: SignInProviderButton.height,
            ),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            decoration: BoxDecoration(
              // Pressed, it darkens on the finger's way DOWN, as the phone's other buttons do.
              color: _down
                  ? Color.alphaBlend(look.ink.withValues(alpha: .12), look.fill)
                  : look.fill,
              border: Border.all(color: look.rim),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                SizedBox.square(
                  dimension: SignInProviderButton._markSize,
                  child: busy
                      ? CircularProgressIndicator(
                          strokeWidth: 2,
                          color: look.ink,
                        )
                      : _mark(look),
                ),
                const SizedBox(width: 10),
                Flexible(
                  child: TtyText(
                    label,
                    color: look.ink,
                    weight: FontWeight.w600,
                    size: TtySize.row,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _mark(_ProviderLook look) => Image.asset(
    'assets/sign-in/${widget.provider.name}.png',
    width: SignInProviderButton._markSize,
    height: SignInProviderButton._markSize,
    filterQuality: FilterQuality.medium,
    // Google's mark is its four colours; Apple's is one shape in the button's ink.
    color: look.tintMark ? look.ink : null,
    colorBlendMode: look.tintMark ? BlendMode.srcIn : null,
  );
}

/// A provider's own colours. Not the terminal's: they are the providers' brands, the same on a
/// light ground and a dark one — except the rim, which each wears only on the ground it would
/// otherwise melt into: Google's white on a light one, Apple's black on a dark one. Where the fill
/// already stands apart the rim is the fill's own colour, so neither reads a line larger.
typedef _ProviderLook = ({Color fill, Color ink, Color rim, bool tintMark});

_ProviderLook _look(SignInProvider provider, {required bool light}) =>
    switch (provider) {
      SignInProvider.google => (
        fill: Colors.white,
        ink: const Color(0xFF1F1F1F),
        rim: light ? const Color(0xFFDADCE0) : Colors.white,
        tintMark: false,
      ),
      SignInProvider.apple => (
        fill: Colors.black,
        ink: Colors.white,
        rim: light ? Colors.black : const Color(0x3DFFFFFF),
        tintMark: true,
      ),
    };
