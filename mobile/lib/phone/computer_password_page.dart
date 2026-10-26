import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/widgets/app_icon_button.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'tty.dart';
import 'tty_controls.dart';

/// Computers ▸ a Harness OS computer ▸ Change password: its one password — the disk's, asked at
/// every start where it is encrypted (and what Unlock sends), and its account's, for SSH, sudo and
/// the lock screen — changed together, as the installer set them (CLI osDevice.ts `password`,
/// os/setup.py `change_password`). The current one is checked there first.
class ComputerPasswordPage extends StatefulWidget {
  const ComputerPasswordPage({
    super.key,
    required this.notifier,
    required this.machineId,
  });

  final AppNotifier notifier;
  final String machineId;

  @override
  State<ComputerPasswordPage> createState() => _ComputerPasswordPageState();
}

class _ComputerPasswordPageState extends State<ComputerPasswordPage> {
  final _current = TextEditingController();
  final _new = TextEditingController();
  final _repeat = TextEditingController();
  bool _busy = false;
  bool _reveal = false;
  String _error = '';

  AppNotifier get _app => widget.notifier;
  String get _name =>
      _app.stateOf(widget.machineId)?.machine.displayName ?? 'The computer';

  @override
  void dispose() {
    _current.dispose();
    _new.dispose();
    _repeat.dispose();
    super.dispose();
  }

  Future<void> _change() async {
    final current = _current.text, next = _new.text;
    String why = '';
    if (current.isEmpty) {
      why = 'Enter the current password.';
    } else if (next.isEmpty) {
      why = 'Enter a new password.';
    } else if (next != _repeat.text) {
      why = 'The new passwords are not the same.';
    } else if (next == current) {
      why = 'That is the password already.';
    }
    if (why.isNotEmpty) {
      setState(() => _error = why);
      return;
    }
    setState(() {
      _busy = true;
      _error = '';
    });
    final reply = await _app.osDevice(widget.machineId, {
      'action': 'password',
      'current': current,
      'next': next,
    }, timeout: const Duration(seconds: 100));
    if (!mounted) return;
    if (reply['ok'] == true) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(
          content: Text(
            reply['disk'] == true
                ? 'Password changed. Use the new one to unlock $_name when it starts.'
                : 'Password changed.',
          ),
        ),
      );
      Navigator.of(context).maybePop();
      return;
    }
    setState(() {
      _busy = false;
      _error =
          reply['message'] as String? ??
          (reply['error'] == 'UNAVAILABLE'
              ? 'Could not reach $_name. Try again.'
              : 'The password did not change. Try again.');
    });
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    Text say(String text) => Text(text, style: tty.style(color: tty.dim));
    final encrypted = _app.harnessOsComputers[widget.machineId]?.encrypted;
    Widget eye() => AppIconButton(
      icon: _reveal ? LucideIcons.eyeOff300 : LucideIcons.eye300,
      size: 20,
      tooltip: _reveal ? 'Hide passwords' : 'Show passwords',
      color: tty.dim,
      onPressed: () => setState(() => _reveal = !_reveal),
    );
    TtyField field(
      Key key,
      TextEditingController controller,
      String hint, {
      bool focus = false,
      VoidCallback? submit,
    }) => TtyField(
      key: key,
      controller: controller,
      hint: hint,
      autofocus: focus,
      keyboardType: TextInputType.visiblePassword,
      obscure: !_reveal,
      maxLength: 128,
      onSubmitted: _busy ? null : submit,
      trailing: [eye()],
    );
    return Scaffold(
      backgroundColor: tty.ground,
      resizeToAvoidBottomInset: false,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: TtyBackButton(
                onPressed: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: ListView(
                padding: EdgeInsets.fromLTRB(
                  Tty.origin,
                  8,
                  Tty.origin,
                  MediaQuery.paddingOf(context).bottom +
                      MediaQuery.viewInsetsOf(context).bottom +
                      24,
                ),
                children: [
                  const TtyText(
                    'Change password',
                    size: TtySize.display,
                    weight: FontWeight.w600,
                  ),
                  const SizedBox(height: 8),
                  say(
                    '$_name has one password, and this changes it everywhere at once: '
                    '${encrypted == false ? '' : 'unlocking it when it starts (Unlock on this phone, or its screen), '}'
                    'SSH, sudo and its lock screen.',
                  ),
                  const SizedBox(height: 16),
                  field(
                    const Key('password-current'),
                    _current,
                    'Current password',
                    focus: true,
                  ),
                  const SizedBox(height: 12),
                  field(const Key('password-new'), _new, 'New password'),
                  const SizedBox(height: 12),
                  field(
                    const Key('password-repeat'),
                    _repeat,
                    'New password again',
                    submit: () => unawaited(_change()),
                  ),
                  if (_error.isNotEmpty) ...[
                    const SizedBox(height: 12),
                    Text(
                      _error,
                      key: const Key('password-error'),
                      style: tty.style(color: tty.red),
                    ),
                  ],
                  const SizedBox(height: 20),
                  TtyPrimaryButton(
                    key: const Key('password-change'),
                    label: 'Change password',
                    busy: _busy,
                    busyLabel: 'Changing… (a few seconds)',
                    onPressed: () => unawaited(_change()),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
