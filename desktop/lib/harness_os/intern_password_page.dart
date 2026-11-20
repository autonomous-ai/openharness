import 'dart:async';

import 'package:flutter/material.dart';

import 'intern_dialog.dart';
import 'intern_page.dart';

/// Manage Intern 3 ▸ Password: its one password — the disk's, asked at every start where it is
/// encrypted (and what Unlock sends), and its account's, for SSH, sudo and the lock screen —
/// changed together (CLI osDevice.ts `password`, os/setup.py `change_password`). The current one is
/// checked there first. The phone's Change password (mobile computer_password_page.dart).
class InternPasswordPage extends InternPage {
  const InternPasswordPage({
    super.key,
    required super.app,
    required super.machineId,
    required super.onBack,
  });

  @override
  State<InternPasswordPage> createState() => _InternPasswordPageState();
}

class _InternPasswordPageState extends State<InternPasswordPage> {
  final _current = TextEditingController();
  final _new = TextEditingController();
  final _repeat = TextEditingController();
  bool _busy = false;
  String _error = '';

  /// Changed: what to say, in place of the fields.
  String? _done;

  String get _name => widget.name;

  @override
  void dispose() {
    _current.dispose();
    _new.dispose();
    _repeat.dispose();
    super.dispose();
  }

  Future<void> _change() async {
    final current = _current.text, next = _new.text;
    final why = current.isEmpty
        ? 'Enter the current password.'
        : next.isEmpty
        ? 'Enter a new password.'
        : next != _repeat.text
        ? 'The new passwords are not the same.'
        : next == current
        ? 'That is the password already.'
        : '';
    if (why.isNotEmpty) {
      setState(() => _error = why);
      return;
    }
    setState(() {
      _busy = true;
      _error = '';
    });
    final reply = await widget.app.osDevice(widget.machineId, {
      'action': 'password',
      'current': current,
      'next': next,
    }, timeout: const Duration(seconds: 100));
    if (!mounted) return;
    if (reply['ok'] == true) {
      setState(() {
        _busy = false;
        _done = reply['disk'] == true
            ? 'Password changed. It unlocks $_name\'s disk too: use the new one when it starts.'
            : 'Password changed.';
      });
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
    final done = _done;
    if (done != null) {
      return InternDialogFrame(
        title: 'Password',
        actions: [
          internButton(
            'Done',
            widget.onBack,
            key: const Key('intern-password-done'),
            primary: true,
          ),
        ],
        children: [InternText(done, muted: false)],
      );
    }
    final encrypted =
        widget.app.harnessOs.computers[widget.machineId]?.encrypted;
    InternField field(
      Key key,
      String label,
      TextEditingController controller, {
      bool focus = false,
      bool submit = false,
    }) => InternField(
      label: label,
      controller: controller,
      fieldKey: key,
      password: true,
      autofocus: focus,
      enabled: !_busy,
      maxLength: 128,
      onSubmitted: submit
          ? (_) {
              if (!_busy) unawaited(_change());
            }
          : null,
    );
    return InternDialogFrame(
      title: 'Password',
      message: _error.isEmpty
          ? (_busy ? 'Changing… (a few seconds)' : null)
          : _error,
      error: _error.isNotEmpty,
      actions: [
        internButton(
          'Back',
          _busy ? null : widget.onBack,
          key: const Key('intern-back'),
        ),
        internButton(
          _busy ? 'Changing…' : 'Change',
          _busy ? null : () => unawaited(_change()),
          key: const Key('intern-password-change'),
          primary: true,
        ),
      ],
      children: [
        InternText(
          '$_name has one password, and this changes it everywhere at once: '
          '${encrypted == false ? '' : 'unlocking it when it starts, '}'
          'SSH, sudo and its lock screen.',
        ),
        field(
          const Key('intern-password-current'),
          'Current password',
          _current,
          focus: true,
        ),
        field(const Key('intern-password-new'), 'New password', _new),
        field(
          const Key('intern-password-repeat'),
          'Repeat new password',
          _repeat,
          submit: true,
        ),
      ],
    );
  }
}
