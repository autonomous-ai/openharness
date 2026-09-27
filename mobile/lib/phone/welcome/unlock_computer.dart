import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/state/app_state.dart';

import '../tty.dart';
import '../tty_controls.dart';

/// Unlocking a computer from this phone: its phone password, once — the page behind a locked
/// computer's row.
///
/// ```
/// Unlock M2
/// Enter the phone password you set on M2.
/// [ ••••••••                          Show ]
/// [               Unlock               ]
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
  });

  final AppNotifier notifier;
  final MachineState machineState;

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
  String? _error;
  String? _stage;
  bool _copied = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focus.requestFocus();
    });
  }

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
          'Enter the phone password you set on $name.',
          style: tty.style(size: TtySize.row, color: tty.faint),
        ),
        const SizedBox(height: 18),
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
        const SizedBox(height: 16),
        TtyPrimaryButton(
          label: 'Unlock',
          busy: _busy,
          busyLabel: _stage == null ? 'Unlocking…' : _say(_stage!),
          onPressed: _unlock,
        ),
        const SizedBox(height: 32),
        Text(
          'Forgot it, or never set one? On $name, run',
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
        const SizedBox(height: 8),
        Text(
          'or, in the Harness app on $name: Machines → $name → Set password.',
          style: tty.style(size: TtySize.meta, color: tty.faint),
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
                hintStyle: tty.style(size: TtySize.title, color: tty.faint),
              ),
            ),
          ),
          TtyTextButton(label: obscure ? 'Show' : 'Hide', onPressed: onToggle),
        ],
      ),
    );
  }
}
