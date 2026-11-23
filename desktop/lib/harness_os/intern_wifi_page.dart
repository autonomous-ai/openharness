import 'dart:async';

import 'package:flutter/material.dart';

import 'intern_dialog.dart';
import 'intern_page.dart';
import 'setup_hotspot.dart';

/// Manage Intern 3 ▸ Wi-Fi: the Wi-Fi the COMPUTER sees, picked from here wherever this one is (CLI
/// osDevice.ts through the relay, os/setup.py `join` on it). The phone's Change Wi-Fi (mobile
/// change_wifi_page.dart).
///
///   its list → password → it leaves its Wi-Fi for that one → back online there, or, when that one
///   fails (wrong password, out of reach, no Internet), back on the one it was on, with the reason.
///
/// It is unreachable while it moves; the result waits on it (`wifi_result`) for when it is back.
class InternWifiPage extends InternPage {
  const InternWifiPage({
    super.key,
    required super.app,
    required super.machineId,
    required super.onBack,
  });

  /// How often the move is asked after.
  @visibleForTesting
  static Duration pollEvery = const Duration(seconds: 3);

  /// How long the computer gets to try the Wi-Fi and be back, on it or on its old one.
  static const moveFor = Duration(minutes: 2);

  @override
  State<InternWifiPage> createState() => _InternWifiPageState();
}

enum _Step { list, password, moving, done }

class _InternWifiPageState extends State<InternWifiPage> {
  final _ssid = TextEditingController();
  final _password = TextEditingController();

  _Step _step = _Step.list;
  bool _busy = true;
  String _error = '';
  List<SetupNetwork> _networks = const [];
  String? _active;

  /// Null: a network typed by name (Other network).
  SetupNetwork? _chosen;
  Timer? _poll;

  String get _id => widget.machineId;
  String get _name => widget.name;

  @override
  void initState() {
    super.initState();
    _active = widget.app.harnessOs.wifi(_id);
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
    final reply = await widget.app.osDevice(_id, {
      'action': 'wifi_scan',
    }, timeout: const Duration(seconds: 35));
    if (!mounted) return;
    final list = reply['networks'];
    if (list is! List) {
      _show(
        _Step.list,
        error: error.isNotEmpty
            ? error
            : 'Could not read the Wi-Fi $_name sees. Try again.',
      );
      return;
    }
    setState(() {
      _networks = [
        for (final row in list)
          if (row is Map && row['ssid'] is String)
            SetupNetwork(
              ssid: row['ssid'] as String,
              signal: (row['signal'] as num?)?.toInt() ?? 0,
              security: row['security'] as String? ?? '',
            ),
      ];
      for (final row in list) {
        if (row is Map && row['active'] == true && row['ssid'] is String) {
          _active = row['ssid'] as String;
        }
      }
      _busy = false;
    });
  }

  void _choose(SetupNetwork? network) {
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
    setState(() {
      _busy = true;
      _error = '';
    });
    // The run before this one: a result from an earlier change is not this one's.
    final before = await widget.app.osDevice(_id, {'action': 'wifi_result'});
    final last = before['result'];
    final run = last is Map ? (last['run'] as num?)?.toInt() ?? 0 : 0;
    final reply = await widget.app.osDevice(_id, {
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
    var left =
        (InternWifiPage.moveFor.inMilliseconds /
                InternWifiPage.pollEvery.inMilliseconds)
            .ceil();
    var asking = false;
    _poll?.cancel();
    _poll = Timer.periodic(InternWifiPage.pollEvery, (_) async {
      if (asking || !mounted || _step != _Step.moving) return;
      asking = true;
      try {
        final reply = await widget.app.osDevice(_id, {
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
            _active = ssid;
            unawaited(widget.app.harnessOs.refresh(_id, force: true));
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
        if (--left <= 0) {
          _poll?.cancel();
          _show(
            _Step.moving,
            error:
                '$_name has not come back. If it lost its Wi-Fi, it opens its own "Harness-…" '
                'Wi-Fi in a few minutes: then set it up again near it.',
          );
        }
      } finally {
        asking = false;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final error = _error.isEmpty ? null : _error;
    final ssid = _ssid.text.trim();
    final back = internButton(
      'Back',
      widget.onBack,
      key: const Key('intern-back'),
    );
    switch (_step) {
      case _Step.list:
        return InternDialogFrame(
          title: 'Wi-Fi',
          message: error ?? (_busy ? 'Looking for Wi-Fi…' : null),
          error: error != null,
          actions: [
            back,
            internButton(
              'Other network',
              _busy ? null : () => _choose(null),
              key: const Key('intern-wifi-other'),
            ),
            internButton(
              'Refresh',
              _busy ? null : () => unawaited(_scan()),
              key: const Key('intern-wifi-refresh'),
            ),
          ],
          children: [
            InternText(
              'The Wi-Fi $_name sees. If the new one fails, it goes back to the one it is on.',
            ),
            if (!_busy)
              InternNetworkList(
                networks: _networks,
                active: _active,
                onChoose: _choose,
              ),
          ],
        );
      case _Step.password:
        final chosen = _chosen;
        return InternDialogFrame(
          title: chosen == null ? 'Other network' : chosen.ssid,
          message: error,
          error: error != null,
          actions: [
            internButton(
              'Back',
              _busy ? null : () => _show(_Step.list),
              key: const Key('intern-back'),
            ),
            internButton(
              _busy ? 'Sending…' : 'Connect',
              _busy ? null : () => unawaited(_send()),
              key: const Key('intern-wifi-connect'),
              primary: true,
            ),
          ],
          children: [
            if (chosen == null)
              InternField(
                label: 'Wi-Fi name',
                controller: _ssid,
                fieldKey: const Key('intern-wifi-ssid'),
                autofocus: true,
                maxLength: 32,
                enabled: !_busy,
              )
            else
              InternText(
                chosen.secure
                    ? 'The password for "${chosen.ssid}". It is case-sensitive.'
                    : '"${chosen.ssid}" is open: no password.',
              ),
            if (chosen?.secure ?? true)
              InternField(
                label: 'Password',
                controller: _password,
                fieldKey: const Key('intern-wifi-password'),
                hint: chosen == null ? 'Empty for an open Wi-Fi' : null,
                password: true,
                autofocus: chosen != null,
                maxLength: 63,
                enabled: !_busy,
                onSubmitted: (_) {
                  if (!_busy) unawaited(_send());
                },
              ),
          ],
        );
      case _Step.moving:
        return InternDialogFrame(
          title: 'Wi-Fi',
          message: error ?? 'Moving to "$ssid"…',
          error: error != null,
          actions: [back],
          children: [
            InternText(
              '$_name is moving to "$ssid". It is out of reach for a moment.',
            ),
          ],
        );
      case _Step.done:
        return InternDialogFrame(
          title: 'Wi-Fi',
          actions: [
            internButton(
              'Done',
              widget.onBack,
              key: const Key('intern-wifi-done'),
              primary: true,
            ),
          ],
          children: [InternText('$_name is on "$ssid" now.', muted: false)],
        );
    }
  }
}
