import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import '../phone_navigation.dart' show phoneRoute;
import '../tty.dart';
import '../tty_controls.dart';
import 'connect_code.dart';

/// **Yes — scan to connect**: the camera, reading the code the desktop app shows under
/// Harness ▸ Add Phone… ([ConnectCode]). The scan signs the phone in; [signingIn] says so while it
/// does.
///
/// ```
/// ‹
///   ┌──────────────────────┐
///   │    [ camera view ]   │
///   └──────────────────────┘
/// Scan the code on your computer
/// On your Mac: Harness ▸ Add Phone…
///
///           Use email instead
/// ```
///
/// The camera runs only while this page is up. A code that is not ours is ignored, so a stray QR
/// in frame does nothing; no camera (refused, or none) says so and leaves email as the way in.
class ScanToConnectPage extends StatefulWidget {
  const ScanToConnectPage({
    super.key,
    required this.onCode,
    required this.onUseEmail,
    required this.onBack,
    this.signingIn = false,
    this.fallbackLabel = 'Use email instead',
    this.camera,
    this.onSignInCode,
    this.acceptConnectCodes = true,
    this.title = 'Scan the code on your computer',
    this.hint = 'On your Mac: Harness ▸ Add Phone…',
  });

  final ValueChanged<ConnectCode> onCode;

  /// A computer's sign-in QR ([SignInCode]) was read — offered only where the page takes one.
  final ValueChanged<SignInCode>? onSignInCode;

  /// Whether an Add Phone QR ([ConnectCode]) is one this page takes.
  final bool acceptConnectCodes;

  final String title;
  final String hint;
  final VoidCallback onUseEmail;
  final VoidCallback onBack;

  /// A code was read and the phone is signing in with it.
  final bool signingIn;

  /// The way out without a camera or a code: email on the first screen, the computer's password
  /// when unlocking one ([onUseEmail] is called either way).
  final String fallbackLabel;

  /// Stands in for the camera in tests and renders. Null opens the real one.
  final Widget? camera;

  @override
  State<ScanToConnectPage> createState() => _ScanToConnectPageState();
}

class _ScanToConnectPageState extends State<ScanToConnectPage> {
  /// Set once a code of ours is read: the camera keeps reporting it every frame.
  bool _done = false;

  void _onDetect(BarcodeCapture capture) {
    if (_done) return;
    for (final barcode in capture.barcodes) {
      final raw = barcode.rawValue ?? '';
      final signIn = widget.onSignInCode == null ? null : SignInCode.parse(raw);
      if (signIn != null) {
        _done = true;
        HapticFeedback.mediumImpact();
        widget.onSignInCode!(signIn);
        return;
      }
      final code = widget.acceptConnectCodes ? ConnectCode.parse(raw) : null;
      if (code == null) continue;
      _done = true;
      HapticFeedback.mediumImpact();
      widget.onCode(code);
      return;
    }
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: TtyBackButton(onPressed: widget.onBack),
        ),
        const SizedBox(height: 12),
        // As big a square as fits: the full width on a phone, less on a short screen.
        Expanded(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: Tty.origin),
              child: AspectRatio(
                aspectRatio: 1,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(14),
                  child: ColoredBox(
                    color: ttyRaised(tty),
                    child:
                        widget.camera ??
                        MobileScanner(
                          onDetect: _onDetect,
                          errorBuilder: (context, error) => Center(
                            child: Padding(
                              padding: const EdgeInsets.all(24),
                              child: TtyText(
                                'No camera. Allow it in Settings, or use your email.',
                                color: tty.faint,
                                size: TtySize.meta,
                              ),
                            ),
                          ),
                        ),
                  ),
                ),
              ),
            ),
          ),
        ),
        const SizedBox(height: 24),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: Tty.origin),
          child: TtyText(
            widget.signingIn ? 'Signing in…' : widget.title,
            size: TtySize.title,
            weight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 6),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: Tty.origin),
          child: TtyText(
            widget.hint,
            color: tty.faint,
            size: TtySize.meta,
          ),
        ),
        const SizedBox(height: 10),
        // The one line of trust on the way in: the scan hands a phone the run of a computer, and
        // the first-time reviewer's question was what stops anyone else reading it.
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: Tty.origin),
          child: Row(
            children: [
              Icon(LucideIcons.lock300, size: 13, color: tty.faint),
              const SizedBox(width: 6),
              Expanded(
                child: TtyText(
                  'End-to-end encrypted, phone to computer.',
                  color: tty.faint,
                  size: TtySize.meta,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        Center(
          child: TtyTextButton(
            label: widget.fallbackLabel,
            color: tty.faint,
            onPressed: widget.onUseEmail,
          ),
        ),
        const SizedBox(height: 12),
      ],
    );
  }
}

/// The camera over the current page, and the code it read — null when the person went back or
/// took the other way ([fallbackLabel]). For a phone that is already signed in and wants a
/// computer: unlocking one, or pairing with one just set up.
///
/// [onSignInCode]: a computer's sign-in QR read here instead is handed on (after the camera closes)
/// rather than ignored — the person pointed the phone at a computer, whichever code it showed.
Future<ConnectCode?> scanForCode(
  BuildContext context, {
  required String fallbackLabel,
  Widget? camera,
  ValueChanged<SignInCode>? onSignInCode,
}) async {
  ConnectCode? scanned;
  SignInCode? signIn;
  await Navigator.of(context).push(
    phoneRoute(
      (page) => Scaffold(
        backgroundColor: Tty.of(page).ground,
        body: SafeArea(
          child: ScanToConnectPage(
            camera: camera,
            fallbackLabel: fallbackLabel,
            onCode: (code) {
              scanned = code;
              Navigator.of(page).pop();
            },
            onSignInCode: onSignInCode == null
                ? null
                : (code) {
                    signIn = code;
                    Navigator.of(page).pop();
                  },
            onUseEmail: () => Navigator.of(page).pop(),
            onBack: () => Navigator.of(page).pop(),
          ),
        ),
      ),
    ),
  );
  if (signIn case final code?) onSignInCode?.call(code);
  return scanned;
}

/// The camera over the current page, for a computer's sign-in QR only — Settings ▸ Sign in a
/// computer. Null when the person went back.
Future<SignInCode?> scanForSignIn(BuildContext context, {Widget? camera}) async {
  SignInCode? scanned;
  await Navigator.of(context).push(
    phoneRoute(
      (page) => Scaffold(
        backgroundColor: Tty.of(page).ground,
        body: SafeArea(
          child: ScanToConnectPage(
            camera: camera,
            title: 'Scan the code on the computer',
            hint: 'On the computer: Sign in ▸ Scan with your phone',
            fallbackLabel: 'Not now',
            acceptConnectCodes: false,
            onCode: (_) {},
            onSignInCode: (code) {
              scanned = code;
              Navigator.of(page).pop();
            },
            onUseEmail: () => Navigator.of(page).pop(),
            onBack: () => Navigator.of(page).pop(),
          ),
        ),
      ),
    ),
  );
  return scanned;
}
