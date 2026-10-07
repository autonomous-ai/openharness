import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/state/app_state.dart';

import '../devices_page.dart';
import '../phone_navigation.dart' show phoneRoute;
import '../tty.dart';
import '../tty_controls.dart';
import 'scan_to_connect.dart';

/// Unlocking a computer from this phone — the page behind a locked computer's row. The way the
/// first computer was added comes first: scan the QR its Harness ▸ Add Phone… shows, no password.
/// A computer with no desktop app (a server over SSH) has no QR to show, so its phone password
/// stays, right under it.
///
/// ```
/// Unlock M2
/// On M2, open Harness ▸ Add Phone…, then scan the QR code.
/// [          Scan its code           ]
///
/// or enter its Harness phone password
/// [ ••••••••                          Show ]
///                                   Unlock
///
/// Forgot it, or never set one? On M2, run
/// $ harness remote-password set          Copy
/// ```
///
/// What the link is doing while it works is said in words ("Checking the password…"), never as the
/// CLI's stage names.
class UnlockComputer extends StatefulWidget {
  const UnlockComputer({
    super.key,
    required this.notifier,
    required this.machineState,
    this.onUnlocked,
    this.scanCamera,
  });

  final AppNotifier notifier;
  final MachineState machineState;

  /// Stands in for the camera on the scan page, in tests. Null opens the real one.
  final Widget? scanCamera;

  /// Called once the computer is unlocked.
  final VoidCallback? onUnlocked;

  @override
  State<UnlockComputer> createState() => _UnlockComputerState();
}

class _UnlockComputerState extends State<UnlockComputer> {
  final _password = TextEditingController();
  final _focus = FocusNode();
  bool _obscure = true;
  bool _busy = false;

  /// Pairing by a scanned code — the scan button's own busy state, apart from the password's.
  bool _pairing = false;
  String? _error;
  String? _stage;
  bool _copied = false;

  // ⚠️ No autofocus on the password: it is the second way in now, and a keyboard raised on
  // arrival covered the scan button — the first.

  @override
  void dispose() {
    _password.dispose();
    _focus.dispose();
    super.dispose();
  }

  static String _say(String stage) => switch (stage) {
    'connecting' => 'Reaching the computer…',
    'deriving_key' => 'Checking the password…',
    'exchanging' => 'Making a secure link…',
    'verifying' => 'Almost there…',
    _ => 'Unlocking…',
  };

  Future<void> _unlock() async {
    if (_busy) return;
    if (_password.text.isEmpty) {
      setState(() => _error = 'Enter the password first.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _stage = null;
    });
    final error = await widget.notifier.connectWithPassword(
      widget.machineState.machine.machineId,
      _password.text,
      onProgress: (stage) {
        if (mounted) setState(() => _stage = stage);
      },
    );
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
      _stage = null;
    });
    if (error == null) {
      _password.clear();
      HapticFeedback.mediumImpact();
      widget.onUnlocked?.call();
    } else {
      HapticFeedback.heavyImpact();
    }
  }

  /// The camera, over this page; a code of this computer's pairs the phone with it, the way the
  /// first one was added — its one-time code, armed by its Add Phone dialog, and no password.
  Future<void> _scan() async {
    if (_busy || _pairing) return;
    final code = await scanForCode(
      context,
      fallbackLabel: 'Use its password instead',
      camera: widget.scanCamera,
    );
    if (!mounted || code == null) return;
    final machine = widget.machineState.machine;
    final pairCode = code.pairCode;
    if (code.machineId == null || pairCode == null) {
      setState(
        () => _error = "That code can't unlock a computer. Scan the one in Harness ▸ Add Phone….",
      );
      return;
    }
    if (code.machineId != machine.machineId) {
      setState(
        () => _error =
            'That code is for another computer. Scan the one on ${machine.displayName}.',
      );
      return;
    }
    setState(() {
      _pairing = true;
      _error = null;
    });
    final error = await widget.notifier.connectWithCode(
      machine.machineId,
      pairCode,
    );
    if (!mounted) return;
    setState(() {
      _pairing = false;
      _error = error;
    });
    if (error == null) {
      HapticFeedback.mediumImpact();
      widget.onUnlocked?.call();
    } else {
      HapticFeedback.heavyImpact();
    }
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final name = widget.machineState.machine.displayName;
    return ListView(
      padding: const EdgeInsets.fromLTRB(Tty.origin, 12, Tty.origin, 24),
      children: [
        TtyText('Unlock $name', size: 24, weight: FontWeight.w600),
        const SizedBox(height: 12),
        Text(
          'On $name, open Harness ▸ Add Phone…, then scan the QR code.',
          style: tty.style(size: TtySize.row, color: tty.faint),
        ),
        // This phone's copy of the device list is frozen, so it pins no computer from it — or the
        // account has too many devices to let this phone in: the list is the other way in, beside the
        // code and the password.
        ListenableBuilder(
          listenable: widget.notifier,
          builder: (context, _) =>
              !widget.notifier.deviceListNeedsReview &&
                  !widget.notifier.deviceListTooMany
              ? const SizedBox.shrink()
              : Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          [
                            if (widget.notifier.deviceListNeedsReview)
                              'Your device list needs a review.',
                            if (widget.notifier.deviceListTooMany)
                              'This device couldn’t join: your account has too many devices. '
                                  'Remove ones you no longer use.',
                          ].join('\n'),
                          style: tty.style(
                            size: TtySize.meta,
                            color: tty.yellow,
                          ),
                        ),
                      ),
                      TtyTextButton(
                        key: const ValueKey('device-list-review'),
                        label: 'Your devices',
                        onPressed: () => unawaited(
                          Navigator.of(context).push(
                            phoneRoute(
                              (_) => DevicesPage(notifier: widget.notifier),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
        ),
        const SizedBox(height: 18),
        TtyPrimaryButton(
          key: const ValueKey('unlock-scan'),
          label: 'Scan its code',
          busy: _pairing,
          busyLabel: 'Pairing with $name…',
          onPressed: _busy ? null : () => unawaited(_scan()),
        ),
        const SizedBox(height: 28),
        Text(
          'or enter its Harness phone password',
          style: tty.style(size: TtySize.meta, color: tty.faint),
        ),
        const SizedBox(height: 8),
        _PasswordField(
          controller: _password,
          focus: _focus,
          obscure: _obscure,
          onToggle: () => setState(() => _obscure = !_obscure),
          onSubmitted: _unlock,
        ),
        if (_error case final error?)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Text(
              '✗ $error',
              style: tty.style(size: TtySize.meta, color: tty.red),
            ),
          ),
        const SizedBox(height: 4),
        Align(
          alignment: Alignment.centerRight,
          child: TtyTextButton(
            label: _busy
                ? (_stage == null ? 'Unlocking…' : _say(_stage!))
                : 'Unlock',
            onPressed: _busy || _pairing ? null : _unlock,
          ),
        ),
        const SizedBox(height: 32),
        Text(
          'Forgot it? In Harness on $name, choose Machines ▸ $name ▸ Set password.',
          style: tty.style(size: TtySize.meta, color: tty.faint),
        ),
        const SizedBox(height: 8),
        Text(
          'Using the CLI? Run this on $name:',
          style: tty.style(size: TtySize.meta, color: tty.faint),
        ),
        const SizedBox(height: 8),
        Container(
          decoration: BoxDecoration(
            color: ttyRaised(tty),
            borderRadius: BorderRadius.circular(6),
          ),
          padding: const EdgeInsets.only(left: 12),
          child: Row(
            children: [
              Expanded(
                child: Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(
                        text: r'$ ',
                        style: tty.style(color: tty.green, size: TtySize.meta),
                      ),
                      TextSpan(
                        text: 'harness remote-password set',
                        style: tty.style(size: TtySize.meta),
                      ),
                    ],
                  ),
                ),
              ),
              TtyTextButton(
                label: _copied ? 'Copied' : 'Copy',
                color: _copied ? tty.green : null,
                onPressed: () {
                  unawaited(
                    Clipboard.setData(
                      const ClipboardData(text: 'harness remote-password set'),
                    ),
                  );
                  setState(() => _copied = true);
                },
              ),
            ],
          ),
        ),
        const SizedBox(height: 28),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Icon(LucideIcons.lock300, size: 13, color: tty.faint),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                'The password makes an end-to-end encrypted link between this '
                'phone and $name. It never leaves your devices.',
                style: tty.style(size: TtySize.meta, color: tty.faint),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _PasswordField extends StatelessWidget {
  const _PasswordField({
    required this.controller,
    required this.focus,
    required this.obscure,
    required this.onToggle,
    required this.onSubmitted,
  });

  final TextEditingController controller;
  final FocusNode focus;
  final bool obscure;
  final VoidCallback onToggle;
  final VoidCallback onSubmitted;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Container(
      height: 48,
      decoration: BoxDecoration(
        color: ttyRaised(tty),
        borderRadius: BorderRadius.circular(6),
      ),
      padding: const EdgeInsets.only(left: 12),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              key: const Key('remote-password-connect-field'),
              controller: controller,
              focusNode: focus,
              obscureText: obscure,
              autocorrect: false,
              enableSuggestions: false,
              autofillHints: const [AutofillHints.password],
              textInputAction: TextInputAction.go,
              onSubmitted: (_) => onSubmitted(),
              cursorColor: tty.green,
              style: tty.style(size: TtySize.title),
              decoration: InputDecoration(
                isCollapsed: true,
                filled: false,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                hintText: 'Phone password',
                hintStyle: tty.style(
                  size: TtySize.title,
                  color: tty.placeholder,
                ),
              ),
            ),
          ),
          TtyTextButton(label: obscure ? 'Show' : 'Hide', onPressed: onToggle),
        ],
      ),
    );
  }
}
