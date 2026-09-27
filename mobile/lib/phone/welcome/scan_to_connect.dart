import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

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
    this.camera,
  });

  final ValueChanged<ConnectCode> onCode;
  final VoidCallback onUseEmail;
  final VoidCallback onBack;

  /// A code was read and the phone is signing in with it.
  final bool signingIn;

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
      final code = ConnectCode.parse(barcode.rawValue ?? '');
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
            widget.signingIn ? 'Signing in…' : 'Scan the code on your computer',
            size: TtySize.title,
            weight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 6),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: Tty.origin),
          child: TtyText(
            'On your Mac: Harness ▸ Add Phone…',
            color: tty.faint,
            size: TtySize.meta,
          ),
        ),
        const SizedBox(height: 16),
        Center(
          child: TtyTextButton(
            label: 'Use email instead',
            color: tty.faint,
            onPressed: widget.onUseEmail,
          ),
        ),
        const SizedBox(height: 12),
      ],
    );
  }
}
