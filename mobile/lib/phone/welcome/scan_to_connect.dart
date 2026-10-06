import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'package:harness_mobile/core/app_settings.dart';
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
/// in frame does nothing. A camera refused says where to turn it on, with a link to this app's
/// Settings, and the camera comes up on the way back; no camera at all says so. Either way the
/// button under the square is the way in without one.
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
    this.note,
  });

  final ValueChanged<ConnectCode> onCode;

  /// A computer's sign-in QR ([SignInCode]) was read — offered only where the page takes one.
  final ValueChanged<SignInCode>? onSignInCode;

  /// A line or two under the hint, in words that wrap: what to do when the computer cannot show the
  /// code yet.
  final String? note;

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

class _ScanToConnectPageState extends State<ScanToConnectPage>
    with WidgetsBindingObserver {
  /// Set once a code of ours is read: the camera keeps reporting it every frame.
  bool _done = false;

  /// The camera, held here rather than left to [MobileScanner] — null when [ScanToConnectPage.camera]
  /// stands in for it.
  ///
  /// ⚠️ **Held so that a refused camera can be asked again.** The widget's own controller follows
  /// the app's lifecycle only while it HAS the permission (`_MobileScannerState
  /// .didChangeAppLifecycleState`), so someone who turned the camera on in Settings came back to the
  /// same "access is off" and had to leave the page and return. A start on this same controller
  /// retries instead, and a start that succeeds clears the error it replaces.
  ///
  /// Holding it makes the lifecycle this page's to follow — see [didChangeAppLifecycleState].
  MobileScannerController? _scanner;

  /// "Open Settings" took the person out of the app: the camera is asked again when they return.
  ///
  /// ⚠️ **Only then, never on every return.** A start on Android asks for the permission again if
  /// the OS still lets it, and the first refusal's own dialog brings the app back to the foreground
  /// — a retry on that would put the dialog straight back in front of someone who just said no.
  bool _awaitingSettings = false;

  /// The camera was running when the app went inactive, and was stopped for it.
  bool _stoppedForLifecycle = false;

  @override
  void initState() {
    super.initState();
    if (widget.camera == null) {
      _scanner = MobileScannerController();
      WidgetsBinding.instance.addObserver(this);
    }
  }

  @override
  void dispose() {
    if (_scanner case final scanner?) {
      WidgetsBinding.instance.removeObserver(this);
      unawaited(scanner.dispose());
    }
    super.dispose();
  }

  /// What [MobileScanner] does for a controller of its own: stop while the app is not in front,
  /// start again when it is — and here, also after a trip to Settings.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final scanner = _scanner;
    if (scanner == null) return;
    switch (state) {
      case AppLifecycleState.inactive:
        if (!scanner.value.isRunning) return;
        _stoppedForLifecycle = true;
        unawaited(scanner.stop());
      case AppLifecycleState.resumed:
        if (!_stoppedForLifecycle && !_awaitingSettings) return;
        _stoppedForLifecycle = false;
        _awaitingSettings = false;
        unawaited(_start(scanner));
      case AppLifecycleState.detached:
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
        return;
    }
  }

  Future<void> _start(MobileScannerController scanner) async {
    // Still starting — the permission prompt is up — or already running: nothing to ask.
    if (scanner.value.isStarting || scanner.value.isRunning) return;
    try {
      await scanner.start();
    } on MobileScannerException {
      // A start that fails on the camera itself lands in the controller's state, and the error
      // below draws it; this is a start refused before reaching the camera (disposed, not attached)
      // — the page is going away.
    }
  }

  /// Raised BEFORE Settings opens, not on its answer: iOS may answer only once the app is back in
  /// front, after the return this flag exists to catch.
  Future<void> _openSettings() async {
    _awaitingSettings = true;
    if (!await openAppSettings()) _awaitingSettings = false;
  }

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
                          controller: _scanner,
                          onDetect: _onDetect,
                          errorBuilder: (context, error) => _CameraProblem(
                            code: error.errorCode,
                            onOpenSettings: () => unawaited(_openSettings()),
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
        if (widget.note case final note?) ...[
          const SizedBox(height: 12),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: Tty.origin),
            // Wraps, unlike the hint above it: a sentence of what to do, not a label.
            child: Text(
              note,
              key: const ValueKey('scan-note'),
              style: tty.style(size: TtySize.meta, color: tty.faint),
            ),
          ),
        ],
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

/// What stands in the camera's square when it cannot run: what happened, and what fixes it.
///
/// ⚠️ **A refused permission and a missing camera are told apart**, because only one of them is
/// fixed in Settings: a link to Settings on a simulator or a camera-less tablet leads nowhere. The
/// way round either — email, the computer's password, "Not now" — is the page's own button under
/// the square, so none of these names it: the same square stands on all three pages.
class _CameraProblem extends StatelessWidget {
  const _CameraProblem({required this.code, required this.onOpenSettings});

  final MobileScannerErrorCode code;
  final VoidCallback onOpenSettings;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final refused = code == MobileScannerErrorCode.permissionDenied;
    final (title, detail) = switch (code) {
      MobileScannerErrorCode.permissionDenied => (
        'Camera access is off',
        // Where the switch is, in each OS's words: iOS opens straight onto it; Android opens App
        // info, one screen short of it.
        Platform.isAndroid
            ? 'Allow Camera for Harness in Settings, under Permissions › Camera.'
            : 'Turn on Camera for Harness in Settings to scan the code.',
      ),
      MobileScannerErrorCode.unsupported => (
        'No camera on this device',
        'Scanning needs a camera. Use the option below instead.',
      ),
      _ => (
        'The camera didn’t start',
        'Go back and try again, or use the option below.',
      ),
    };
    // Scrolls rather than overflows: the square shrinks with a small phone, the words grow with the
    // UI size.
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(LucideIcons.cameraOff300, size: 28, color: tty.faint),
            const SizedBox(height: 14),
            Text(
              title,
              textAlign: TextAlign.center,
              style: tty.style(size: TtySize.row, weight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            Text(
              detail,
              textAlign: TextAlign.center,
              style: tty
                  .style(size: TtySize.meta, color: tty.faint)
                  .copyWith(height: 1.5),
            ),
            if (refused) ...[
              const SizedBox(height: 6),
              TtyTextButton(
                label: 'Open Settings ›',
                color: tty.green,
                weight: FontWeight.w600,
                onPressed: onOpenSettings,
              ),
            ],
          ],
        ),
      ),
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
