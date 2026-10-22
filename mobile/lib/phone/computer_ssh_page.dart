import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/state/app_state.dart';

import 'settings_row.dart';
import 'tty.dart';
import 'tty_controls.dart';

/// Computers ▸ a Harness OS computer ▸ SSH: on or off (off as installed), and the private addresses
/// it answers on, for `ssh me@<address>` from a computer on the same network (CLI osDevice.ts `ssh`,
/// os/setup.py `ssh`).
class ComputerSshPage extends StatefulWidget {
  const ComputerSshPage({
    super.key,
    required this.notifier,
    required this.machineId,
  });

  final AppNotifier notifier;
  final String machineId;

  @override
  State<ComputerSshPage> createState() => _ComputerSshPageState();
}

class _ComputerSshPageState extends State<ComputerSshPage> {
  Map<String, dynamic>? _state;
  bool _busy = true;
  String _error = '';

  AppNotifier get _app => widget.notifier;
  String get _name =>
      _app.stateOf(widget.machineId)?.machine.displayName ?? 'The computer';

  @override
  void initState() {
    super.initState();
    unawaited(_ask('status'));
  }

  Future<void> _ask(String state) async {
    setState(() {
      _busy = true;
      _error = '';
    });
    final reply = await _app.osDevice(widget.machineId, {
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
            reply['message'] as String? ??
            'Could not reach $_name. Pull down to try again.';
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    Text say(String text, {Color? color}) =>
        Text(text, style: tty.style(color: color ?? tty.dim));
    final on = _state?['enabled'] == true || _state?['active'] == true;
    final user = _state?['user'] as String? ?? 'me';
    final addresses = [
      for (final row in (_state?['addresses'] as List?) ?? const [])
        if (row is Map && row['address'] is String) row,
    ];
    return Scaffold(
      backgroundColor: tty.ground,
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
              child: RefreshIndicator(
                onRefresh: () => _ask('status'),
                child: ListView(
                  padding: EdgeInsets.fromLTRB(
                    Tty.origin,
                    8,
                    Tty.origin,
                    MediaQuery.paddingOf(context).bottom + 24,
                  ),
                  children: [
                    const TtyText(
                      'SSH',
                      size: TtySize.display,
                      weight: FontWeight.w600,
                    ),
                    const SizedBox(height: 8),
                    if (_error.isNotEmpty)
                      say(_error, color: tty.red)
                    else if (_state == null)
                      const Center(
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    else ...[
                      say(
                        on
                            ? 'SSH is on. Anyone on the same network who has $_name\'s password can sign in to it.'
                            : 'SSH is off. Turn it on to reach $_name from another computer on the same network.',
                      ),
                      const SizedBox(height: 12),
                      SettingsGroup(
                        children: [
                          SettingsRow(
                            key: const Key('ssh-state'),
                            title: 'SSH',
                            value: on ? 'On' : 'Off',
                          ),
                          for (final row in addresses)
                            SettingsRow(
                              key: ValueKey('ssh-address-${row['address']}'),
                              title: row['address'] as String,
                              detail: on
                                  ? 'ssh $user@${row['address']} · tap to copy'
                                  : row['interface'] as String?,
                              onTap: on
                                  ? () {
                                      unawaited(
                                        Clipboard.setData(
                                          ClipboardData(
                                            text: 'ssh $user@${row['address']}',
                                          ),
                                        ),
                                      );
                                      ScaffoldMessenger.maybeOf(context)
                                          ?.showSnackBar(
                                            const SnackBar(
                                              content: Text('Copied.'),
                                            ),
                                          );
                                    }
                                  : null,
                            ),
                          if (addresses.isEmpty)
                            const SettingsRow(
                              title: 'No address',
                              detail: 'It is not on a network right now.',
                            ),
                        ],
                      ),
                      const SizedBox(height: 20),
                      TtyPrimaryButton(
                        key: const Key('ssh-toggle'),
                        label: on ? 'Turn SSH off' : 'Turn SSH on',
                        busy: _busy,
                        busyLabel: on ? 'Turning off…' : 'Turning on…',
                        onPressed: () => unawaited(_ask(on ? 'off' : 'on')),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
