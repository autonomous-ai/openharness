import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import '../settings_page.dart' show PhoneSettingsButton;
import '../tty.dart';
import '../tty_controls.dart';
import 'scan_to_connect.dart';

/// The moment after signing in from a scanned "Add phone" QR: the phone pairs with the computer by
/// the QR's one-time code ([AppNotifier.connectWithCode]) — no password — while this says so.
///
/// ```
/// Connecting to MacBook Pro…
/// Keep “Add Phone” open on MacBook Pro.
/// ```
///
/// On success the computer unlocks and the home screen moves on by itself. On failure the reason is
/// shown, and the way on is the one it names: **Scan again** — Add Phone shows a new code after
/// one that did not match, and keeps its code up after a phone that went quiet. The computer's
/// password is under it, for a computer whose Add Phone is not to hand.
class PairingWithCode extends StatefulWidget {
  const PairingWithCode({
    super.key,
    required this.notifier,
    required this.machineId,
    required this.code,
  });

  final AppNotifier notifier;
  final String machineId;
  final String code;

  @override
  State<PairingWithCode> createState() => _PairingWithCodeState();
}

class _PairingWithCodeState extends State<PairingWithCode> {
  String? _error;

  /// The camera is up for [_scanAgain]: a second tap does not open another.
  bool _scanning = false;

  @override
  void initState() {
    super.initState();
    unawaited(_pair(widget.code));
  }

  /// Through [AppNotifier.pairPendingCode], which joins a pairing by this code already under way
  /// rather than spending the one-time code twice, and lets the code go on success itself.
  Future<void> _pair(String code) async {
    final error = await widget.notifier.pairPendingCode(widget.machineId, code);
    if (!mounted) return;
    if (error == null) {
      HapticFeedback.mediumImpact();
      return;
    }
    setState(() => _error = error);
  }

  /// What every one of these errors tells the person to do — "Scan the new one", "scan again" —
  /// and which this screen used to offer no button for: only the password, which somebody adding
  /// their first phone has never set.
  ///
  /// Only a code of THIS computer is taken: the screen is its, and the home screen moves on by
  /// itself once it is unlocked. Back from the camera with nothing leaves the error as it was.
  Future<void> _scanAgain(String name) async {
    if (_scanning) return;
    setState(() => _scanning = true);
    final scanned = await scanForCode(context, fallbackLabel: 'Not now');
    if (!mounted) return;
    setState(() => _scanning = false);
    if (scanned == null) return;
    final pairCode = scanned.pairCode;
    if (scanned.machineId == null || pairCode == null) {
      setState(
        () => _error =
            'That isn’t an Add Phone code. Open Add Phone… on $name and scan '
            'its code.',
      );
      return;
    }
    if (scanned.machineId != widget.machineId) {
      setState(
        () => _error =
            'That code is for another computer. Scan the one on $name.',
      );
      return;
    }
    // Held as the code this phone is pairing by, as the first one was, so nothing that reads it
    // meanwhile finds the spent one.
    widget.notifier.pendingPairing = (
      machineId: widget.machineId,
      code: pairCode,
    );
    setState(() => _error = null);
    await _pair(pairCode);
  }

  /// The code is spent either way: the computer's password form is what is left.
  void _usePassword() => widget.notifier.dropPendingPairing();

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final name =
        widget.notifier.machineStates[widget.machineId]?.machine.displayName ??
        'your computer';
    final error = _error;
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // This page is the home screen while it is up: Settings, and Sign out, from here too.
            // Its row stands where the title's top margin was, so the title has not moved.
            Align(
              alignment: Alignment.centerRight,
              child: PhoneSettingsButton(notifier: widget.notifier),
            ),
            Expanded(child: _body(tty, name, error)),
          ],
        ),
      ),
    );
  }

  Widget _body(Tty tty, String name, String? error) => Padding(
    padding: const EdgeInsets.fromLTRB(Tty.origin, 4, Tty.origin, 24),
    // Scrolls when it does not fit — a long computer name at a large text size is more lines
    // than a small phone has, and the button was pushed off the foot of an overflowing column.
    child: LayoutBuilder(
      builder: (context, box) => SingleChildScrollView(
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: box.maxHeight),
          child: IntrinsicHeight(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  error == null ? 'Connecting to\n$name…' : 'Couldn’t connect',
                  style: tty
                      .style(size: TtySize.display, weight: FontWeight.w600)
                      .copyWith(height: 34 / 28, letterSpacing: -0.6),
                ),
                const SizedBox(height: 12),
                // A Text that wraps, not a one-line TtyText: the error here is a sentence, and
                // cut at the screen's edge it lost the half that says what to do. Named for the
                // computer, not "your Mac" — Add Phone is on Linux too.
                Text(
                  error ?? 'Keep “Add Phone” open on $name.',
                  style: tty.style(
                    size: TtySize.row,
                    color: error == null ? tty.faint : tty.red,
                  ),
                ),
                const Spacer(),
                if (error != null) ...[
                  TtyPrimaryButton(
                    key: const ValueKey('pairing-scan-again'),
                    label: 'Scan again',
                    onPressed: _scanning
                        ? null
                        : () => unawaited(_scanAgain(name)),
                  ),
                  const SizedBox(height: 4),
                  Center(
                    child: TtyTextButton(
                      label: 'Use its password instead',
                      color: tty.faint,
                      onPressed: _scanning ? null : _usePassword,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    ),
  );
}
