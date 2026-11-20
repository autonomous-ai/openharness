import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/widgets/setting_row.dart';
import 'intern_dialog.dart';
import 'intern_page.dart';

/// Manage Intern 3 ▸ SSH: on or off (off as installed), and the private addresses it answers on,
/// for `ssh me@<address>` from a computer on the same network (CLI osDevice.ts `ssh`, os/setup.py
/// `ssh`). The phone's SSH page (mobile computer_ssh_page.dart).
class InternSshPage extends InternPage {
  const InternSshPage({
    super.key,
    required super.app,
    required super.machineId,
    required super.onBack,
  });

  @override
  State<InternSshPage> createState() => _InternSshPageState();
}

class _InternSshPageState extends State<InternSshPage> {
  Map<String, dynamic>? _state;
  bool _busy = true;
  String _error = '';

  /// What a click did, said beside the actions.
  String? _note;

  String get _name => widget.name;

  @override
  void initState() {
    super.initState();
    unawaited(_ask('status'));
  }

  Future<void> _ask(String state) async {
    setState(() {
      _busy = true;
      _error = '';
      _note = null;
    });
    final reply = await widget.app.osDevice(widget.machineId, {
      'action': 'ssh',
      'state': state,
    }, timeout: const Duration(seconds: 40));
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (reply.containsKey('enabled')) {
        _state = reply;
      } else {
        _error =
            reply['message'] as String? ?? 'Could not reach $_name. Try again.';
      }
    });
  }

  Future<void> _copy(String command) async {
    await Clipboard.setData(ClipboardData(text: command));
    if (mounted) setState(() => _note = 'Copied.');
  }

  @override
  Widget build(BuildContext context) {
    final state = _state;
    final on = state?['enabled'] == true || state?['active'] == true;
    final user = state?['user'] as String? ?? 'me';
    final addresses = [
      for (final row in (state?['addresses'] as List?) ?? const [])
        if (row is Map && row['address'] is String) row,
    ];
    return InternDialogFrame(
      title: 'SSH',
      message: _error.isNotEmpty
          ? _error
          : _busy && state != null
          ? (on ? 'Turning off…' : 'Turning on…')
          : _note,
      error: _error.isNotEmpty,
      actions: [
        internButton('Back', widget.onBack, key: const Key('intern-back')),
        if (_error.isNotEmpty)
          internButton(
            'Retry',
            () => unawaited(_ask('status')),
            key: const Key('intern-ssh-retry'),
          ),
      ],
      children: [
        if (state == null && _error.isEmpty)
          InternText('Asking $_name…')
        else if (state != null) ...[
          SettingRow(
            title: 'SSH',
            detail: on
                ? 'Anyone on the same network who has $_name\'s password can sign in to it.'
                : 'Turn it on to reach $_name from another computer on the same network.',
            controlSemanticLabel: 'SSH',
            inlineControl: true,
            control: Switch(
              key: const Key('intern-ssh-switch'),
              value: on,
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              onChanged: _busy
                  ? null
                  : (value) => unawaited(_ask(value ? 'on' : 'off')),
            ),
          ),
          const SizedBox(height: 8),
          for (final row in addresses)
            InternRow(
              key: Key('intern-ssh-address:${row['address']}'),
              title: on
                  ? 'ssh $user@${row['address']}'
                  : row['address'] as String,
              value: on ? 'Copy' : row['interface'] as String?,
              chevron: false,
              onTap: on
                  ? () => unawaited(_copy('ssh $user@${row['address']}'))
                  : null,
            ),
        ],
      ],
    );
  }
}
