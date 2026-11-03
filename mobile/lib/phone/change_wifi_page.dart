import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/widgets/app_icon_button.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'settings_row.dart';
import 'tty.dart';
import 'tty_controls.dart';

/// Computers ▸ a Harness OS computer ▸ Change Wi-Fi: the Wi-Fi the COMPUTER sees, picked from here
/// wherever this phone is (CLI services/osDevice.ts through the relay, os/setup.py `join` on it).
///
///   its list → password → it leaves its Wi-Fi for that one → back online there, or, when that one
///   fails (wrong password, out of reach, no Internet), back on the one it was on, with the reason.
///
/// It is unreachable while it moves; the result waits on it (`wifi_result`) for when it is back.
class ChangeWifiPage extends StatefulWidget {
  const ChangeWifiPage({
    super.key,
    required this.notifier,
    required this.machineId,
  });

  final AppNotifier notifier;
  final String machineId;

  @override
  State<ChangeWifiPage> createState() => _ChangeWifiPageState();
}

enum _Step { list, password, moving, done }

class _Network {
  const _Network(this.ssid, this.signal, this.secure, this.active);

  final String ssid;
  final int signal;
  final bool secure;
  final bool active;
}

class _ChangeWifiPageState extends State<ChangeWifiPage> {
  final _ssid = TextEditingController();
  final _password = TextEditingController();

  _Step _step = _Step.list;
  bool _busy = true;
  bool _reveal = false;
  String _error = '';
  List<_Network> _networks = const [];
  _Network? _chosen;
  Timer? _poll;

  /// How long the computer gets to try the Wi-Fi and be back, on it or on its old one.
  static const _moveFor = Duration(minutes: 2);

  AppNotifier get _app => widget.notifier;
  String get _name =>
      _app.stateOf(widget.machineId)?.machine.displayName ?? 'The computer';

  @override
  void initState() {
    super.initState();
    unawaited(_scan());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _ssid.dispose();
    _password.dispose();
    super.dispose();
  }

  void _show(_Step step, {String error = ''}) {
    if (!mounted) return;
    setState(() {
      _step = step;
      _error = error;
      _busy = false;
    });
  }

  Future<void> _scan({String error = ''}) async {
    setState(() {
      _step = _Step.list;
      _busy = true;
      _error = error;
    });
    final reply = await _app.osDevice(widget.machineId, {
      'action': 'wifi_scan',
    }, timeout: const Duration(seconds: 35));
    if (!mounted) return;
    final list = reply['networks'];
    if (list is! List) {
      _show(
        _Step.list,
        error: error.isNotEmpty
            ? error
            : 'Could not read the Wi-Fi $_name sees. Pull down to try again.',
      );
      return;
    }
    setState(() {
      _networks = [
        for (final row in list)
          if (row is Map && row['ssid'] is String)
            _Network(
              row['ssid'] as String,
              (row['signal'] as num?)?.toInt() ?? 0,
              (row['security'] as String? ?? '').isNotEmpty,
              row['active'] == true,
            ),
      ];
      _busy = false;
    });
  }

  void _choose(_Network? network) {
    _chosen = network;
    _ssid.text = network?.ssid ?? '';
    _password.clear();
    _show(_Step.password);
  }

  Future<void> _send() async {
    final ssid = _ssid.text.trim();
    final secure = _chosen?.secure ?? _password.text.isNotEmpty;
    final password = secure ? _password.text : '';
    if (ssid.isEmpty) {
      _show(_Step.password, error: 'Enter the Wi-Fi name.');
      return;
    }
    if (secure && (password.length < 8 || password.length > 63)) {
      _show(_Step.password, error: 'A Wi-Fi password has 8 to 63 characters.');
      return;
    }
    setState(() => _busy = true);
    // The run before this one: a result from an earlier change is not this one's.
    final before = await _app.osDevice(widget.machineId, {
      'action': 'wifi_result',
    });
    final last = before['result'];
    final run = last is Map ? (last['run'] as num?)?.toInt() ?? 0 : 0;
    final reply = await _app.osDevice(widget.machineId, {
      'action': 'wifi_join',
      'ssid': ssid,
      'password': password,
    });
    if (!mounted) return;
    if (reply['started'] != true) {
      _show(
        _Step.password,
        error:
            reply['message'] as String? ?? 'Could not reach $_name. Try again.',
      );
      return;
    }
    _wait(ssid, run);
  }

  /// Unreachable while it moves; asked again every few seconds until its result is in.
  void _wait(String ssid, int run) {
    _show(_Step.moving);
    final deadline = DateTime.now().add(_moveFor);
    var asking = false;
    _poll?.cancel();
    _poll = Timer.periodic(const Duration(seconds: 3), (_) async {
      if (asking || !mounted || _step != _Step.moving) return;
      asking = true;
      try {
        final reply = await _app.osDevice(widget.machineId, {
          'action': 'wifi_result',
        }, timeout: const Duration(seconds: 6));
        if (!mounted || _step != _Step.moving) return;
        final result = reply['result'];
        final settled =
            result is Map &&
            ((result['run'] as num?)?.toInt() ?? 0) > run &&
            result['state'] != 'connecting';
        if (settled) {
          _poll?.cancel();
          if (result['state'] == 'done') {
            unawaited(_app.refreshOsStatus(widget.machineId, force: true));
            _show(_Step.done);
          } else {
            final why =
                result['message'] as String? ?? 'Could not join "$ssid".';
            final back = result['restored'] == true
                ? ' $_name is back on its Wi-Fi.'
                : '';
            unawaited(_scan(error: '$why$back'));
          }
          return;
        }
        if (DateTime.now().isAfter(deadline)) {
          _poll?.cancel();
          _show(
            _Step.moving,
            error:
                '$_name has not come back. If it lost its Wi-Fi, it opens its own "Harness-…" '
                'Wi-Fi in a few minutes: then use Settings ▸ Set up Intern 3 near it.',
          );
        }
      } finally {
        asking = false;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
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
              child: RefreshIndicator(
                onRefresh: () =>
                    _step == _Step.list ? _scan() : Future<void>.value(),
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
                      'Change Wi-Fi',
                      size: TtySize.display,
                      weight: FontWeight.w600,
                    ),
                    const SizedBox(height: 8),
                    if (_error.isNotEmpty) ...[
                      Text(
                        _error,
                        key: const Key('change-wifi-error'),
                        style: tty.style(color: tty.red),
                      ),
                      const SizedBox(height: 12),
                    ],
                    ..._body(tty),
                    const SizedBox(height: 20),
                    ..._actions(),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _body(Tty tty) {
    Text say(String text) => Text(text, style: tty.style(color: tty.dim));
    switch (_step) {
      case _Step.list:
        return [
          say(
            'The Wi-Fi $_name sees. If the new one fails, it goes back to the one it is on.',
          ),
          const SizedBox(height: 12),
          if (_busy)
            const Center(child: CircularProgressIndicator(strokeWidth: 2))
          else
            SettingsGroup(
              children: [
                for (final network in _networks)
                  SettingsRow(
                    key: ValueKey('change-wifi-${network.ssid}'),
                    title: network.ssid,
                    value: network.active
                        ? 'Connected'
                        : network.secure
                        ? 'Locked'
                        : 'Open',
                    detail: network.signal >= 70
                        ? 'Strong signal'
                        : network.signal >= 40
                        ? 'Good signal'
                        : 'Weak signal',
                    onTap: () => _choose(network),
                  ),
                SettingsRow(
                  key: const Key('change-wifi-other'),
                  title: 'Other network…',
                  onTap: () => _choose(null),
                ),
              ],
            ),
        ];
      case _Step.password:
        return [
          if (_chosen == null) ...[
            say('The Wi-Fi name, as it is written.'),
            const SizedBox(height: 8),
            TtyField(
              key: const Key('change-wifi-ssid'),
              controller: _ssid,
              hint: 'Wi-Fi name',
              action: TextInputAction.next,
              maxLength: 32,
            ),
            const SizedBox(height: 12),
          ] else
            say('The password for "${_chosen!.ssid}". It is case-sensitive.'),
          if (_chosen?.secure ?? true) ...[
            const SizedBox(height: 8),
            TtyField(
              key: const Key('change-wifi-password'),
              controller: _password,
              hint: _chosen == null
                  ? 'Password (empty for an open Wi-Fi)'
                  : 'Wi-Fi password',
              autofocus: _chosen != null,
              keyboardType: TextInputType.visiblePassword,
              obscure: !_reveal,
              maxLength: 63,
              onSubmitted: _busy ? null : () => unawaited(_send()),
              trailing: [
                AppIconButton(
                  icon: _reveal ? LucideIcons.eyeOff300 : LucideIcons.eye300,
                  size: 20,
                  tooltip: _reveal ? 'Hide password' : 'Show password',
                  color: tty.dim,
                  onPressed: () => setState(() => _reveal = !_reveal),
                ),
              ],
            ),
          ],
        ];
      case _Step.moving:
        return [
          if (_error.isEmpty)
            say(
              '$_name is moving to "${_ssid.text.trim()}". It is out of reach for a moment.',
            ),
        ];
      case _Step.done:
        return [say('$_name is on "${_ssid.text.trim()}" now.')];
    }
  }

  List<Widget> _actions() {
    switch (_step) {
      case _Step.list:
        return const [];
      case _Step.password:
        return [
          TtyPrimaryButton(
            key: const Key('change-wifi-connect'),
            label: 'Connect',
            busy: _busy,
            busyLabel: 'Sending…',
            onPressed: () => unawaited(_send()),
          ),
          TtyTextButton(
            label: 'Choose another Wi-Fi',
            onPressed: () => _show(_Step.list),
          ),
        ];
      case _Step.moving:
        return [
          if (_error.isEmpty)
            const Center(child: CircularProgressIndicator(strokeWidth: 2)),
        ];
      case _Step.done:
        return [
          TtyPrimaryButton(
            key: const Key('change-wifi-done'),
            label: 'Done',
            onPressed: () => Navigator.of(context).maybePop(),
          ),
        ];
    }
  }
}
