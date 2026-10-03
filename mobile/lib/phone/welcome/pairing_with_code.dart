import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import '../tty.dart';
import '../tty_controls.dart';

/// The moment after signing in from a scanned "Add phone" QR: the phone pairs with the computer by
/// the QR's one-time code ([AppNotifier.connectWithCode]) — no password — while this says so.
///
/// ```
/// Connecting to MacBook Pro…
/// Keep “Add phone” open on your Mac.
/// ```
///
/// On success the computer unlocks and the home screen moves on by itself. On failure the code is
/// spent: the reason is shown, with the computer's password as the way on.
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

  @override
  void initState() {
    super.initState();
    unawaited(_pair());
  }

  Future<void> _pair() async {
    final error = await widget.notifier.connectWithCode(
      widget.machineId,
      widget.code,
    );
    if (!mounted) return;
    if (error == null) {
      HapticFeedback.mediumImpact();
      widget.notifier.pendingPairing = null;
      return;
    }
    setState(() => _error = error);
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
        child: Padding(
          padding: const EdgeInsets.fromLTRB(Tty.origin, 48, Tty.origin, 24),
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
                        error == null
                            ? 'Connecting to\n$name…'
                            : 'Couldn’t connect',
                        style: tty
                            .style(
                              size: TtySize.display,
                              weight: FontWeight.w600,
                            )
                            .copyWith(height: 34 / 28, letterSpacing: -0.6),
                      ),
                      const SizedBox(height: 12),
                      TtyText(
                        error ?? 'Keep “Add phone” open on your Mac.',
                        color: error == null ? tty.faint : tty.red,
                        size: TtySize.row,
                      ),
                      const Spacer(),
                      if (error != null)
                        TtyPrimaryButton(
                          label: 'Use its password instead',
                          onPressed: _usePassword,
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
