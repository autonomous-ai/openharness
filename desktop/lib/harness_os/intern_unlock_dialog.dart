import 'dart:async';

import 'package:flutter/material.dart';

import '../state/app_state.dart';
import 'intern_dialog.dart';
import 'intern_setup_dialog.dart';
import 'setup_hotspot.dart';

/// Unlock: an encrypted Intern 3 that was switched off and on waits at its disk's password and
/// opens its own Wi-Fi, `Harness-XXXX` (os/root/usr/lib/harness-os/unlock). The person joins it in
/// this computer's Wi-Fi menu; the password is checked there, then the disk opens:
///
///   Unlock — the password alone; it goes back on the Wi-Fi it knows, signed in as it was.
///   Change Wi-Fi — its startup's list and a password, sent with the unlock (os/setup.py
///   `set_up_as_unlocked`, no sign-in: it is signed in already).
///
/// Then it shows up online in the account, where the dialog waits for it (the phone's
/// `UnlockComputerPage`).
Future<void> showInternUnlock(
  BuildContext context,
  AppNotifier app,
  String machineId, {
  SetupHotspot? hotspot,
}) async {
  final setUp = await showInternDialog<bool>(
    context,
    (_) => InternUnlockDialog(app: app, machineId: machineId, hotspot: hotspot),
  );
  // Unlocked but not online: signed out, or off its Wi-Fi. Its hotspot is back for a setup.
  if (setUp == true && context.mounted) await showInternSetup(context, app);
}

class InternUnlockDialog extends StatefulWidget {
  const InternUnlockDialog({
    super.key,
    required this.app,
    required this.machineId,
    this.hotspot,
  });

  final AppNotifier app;
  final String machineId;

  /// The device's page; one is made (and closed with the dialog) when none is given.
  final SetupHotspot? hotspot;

  /// How often its page is asked once the person says this computer joined its hotspot, and for
  /// how long: macOS takes a few seconds to get an address there.
  @visibleForTesting
  static Duration findEvery = const Duration(seconds: 2);
  @visibleForTesting
  static Duration findFor = const Duration(seconds: 30);

  /// How often the account is read once it is unlocked, and how long it gets to come online.
  @visibleForTesting
  static Duration waitEvery = const Duration(seconds: 4);
  @visibleForTesting
  static Duration comeOnline = const Duration(minutes: 3);

  @override
  State<InternUnlockDialog> createState() => _InternUnlockDialogState();
}

enum _Step { finding, password, choice, networks, wifiPassword, starting, done }

class _InternUnlockDialogState extends State<InternUnlockDialog> {
  late final SetupHotspot _hotspot = widget.hotspot ?? SetupHotspot();
  final _secret = TextEditingController();
  final _password = TextEditingController();

  _Step _step = _Step.finding;

  /// Which wait to come online this is: a new one starts its bar again.
  int _waits = 0;

  /// The person ticked that this computer is on its Wi-Fi: Connect asks its page.
  bool _joined = false;

  /// Connect pressed: its page is asked until it answers or [InternUnlockDialog.findFor] runs out.
  bool _looking = false;
  bool _busy = false;
  String _error = '';
  String _status = '';
  Timer? _poll;

  /// The password once its startup said it is the right one, for the unlock that follows.
  String? _checked;
  List<SetupNetwork> _networks = const [];
  SetupNetwork? _chosen;

  /// The Wi-Fi sent with the unlock, or null for the one it knows.
  String? _newWifi;

  AppNotifier get _app => widget.app;
  String get _id => widget.machineId;
  String get _name =>
      _app.machineStates[_id]?.machine.displayName ?? 'Intern 3';
  String get _hotspotName => _app.harnessOs.hotspot(_id) ?? 'Harness-…';

  @override
  void initState() {
    super.initState();
    _find();
  }

  @override
  void dispose() {
    _poll?.cancel();
    if (widget.hotspot == null) _hotspot.close();
    _secret.dispose();
    _password.dispose();
    super.dispose();
  }

  void _show(_Step step, {String error = ''}) {
    if (!mounted) return;
    setState(() {
      _step = step;
      _error = error;
      _busy = false;
      _status = '';
    });
  }

  void _working(String status) => setState(() {
    _busy = true;
    _error = '';
    _status = status;
  });

  // -- onto its hotspot, joined by the person --

  void _find() {
    _poll?.cancel();
    _step = _Step.finding;
    _error = '';
    _busy = false;
    _status = '';
    _joined = false;
    _looking = false;
    if (mounted) setState(() {});
  }

  /// The person says this computer joined the hotspot: its page is asked for a while.
  void _connect() {
    setState(() {
      _looking = true;
      _error = '';
    });
    var waited = Duration.zero;
    var asking = false;
    _poll?.cancel();
    _poll = Timer.periodic(InternUnlockDialog.findEvery, (_) async {
      if (asking || !mounted || _step != _Step.finding) return;
      asking = true;
      waited += InternUnlockDialog.findEvery;
      try {
        final info = await _hotspot.info();
        if (!mounted || _step != _Step.finding) return;
        if (info == null) {
          if (waited >= InternUnlockDialog.findFor) {
            _poll?.cancel();
            _looking = false;
            _show(
              _Step.finding,
              error:
                  '$_name did not answer. Check this computer is on “$_hotspotName”.',
            );
          }
          return;
        }
        _poll?.cancel();
        _looking = false;
        if (info['locked'] != true) {
          // Its own setup page: started already, not waiting for a password.
          _show(
            _Step.finding,
            error:
                '$_name is not locked. It is starting, or waits to be set up.',
          );
          return;
        }
        _secret.clear();
        _show(_Step.password);
      } finally {
        asking = false;
      }
    });
  }

  // -- its password, checked; nothing opens yet --

  Future<void> _check() async {
    final secret = _secret.text;
    if (secret.isEmpty) {
      _show(_Step.password, error: 'Enter its password.');
      return;
    }
    _working('Checking…');
    final String? why;
    try {
      why = await _hotspot.check(secret);
    } on SetupException catch (e) {
      _show(_Step.password, error: e.message);
      return;
    }
    if (why != null) {
      _show(_Step.password, error: why);
      return;
    }
    _checked = secret;
    _secret.clear();
    _show(_Step.choice);
  }

  // -- another Wi-Fi, from its startup's list --

  Future<void> _listNetworks({bool rescan = false}) async {
    _show(_Step.networks);
    _working('Reading its Wi-Fi…');
    try {
      final networks = await _hotspot.networks(rescan: rescan);
      if (!mounted) return;
      _networks = networks;
      _show(_Step.networks);
    } on SetupException catch (e) {
      _show(_Step.networks, error: e.message);
    }
  }

  void _choose(SetupNetwork network) {
    _chosen = network;
    _password.clear();
    if (!network.secure) {
      unawaited(_unlock(wifi: network));
      return;
    }
    _show(_Step.wifiPassword);
  }

  // -- the unlock --

  Future<void> _unlock({SetupNetwork? wifi}) async {
    final secret = _checked;
    if (secret == null) {
      _show(_Step.password);
      return;
    }
    final password = _password.text;
    if (wifi != null &&
        wifi.secure &&
        (password.length < 8 || password.length > 63)) {
      _show(
        _Step.wifiPassword,
        error: 'A Wi-Fi password has 8 to 63 characters.',
      );
      return;
    }
    final failedAt = wifi == null ? _Step.choice : _Step.wifiPassword;
    _working('Unlocking…');
    final String? why;
    try {
      why = await _hotspot.unlock(
        secret,
        setup: wifi == null
            ? null
            : {
                'ssid': wifi.ssid,
                if (wifi.secure) 'password': password,
                'security': wifi.security,
              },
      );
    } on SetupException catch (e) {
      _show(failedAt, error: e.message);
      return;
    }
    if (!mounted) return;
    if (why != null) {
      _show(failedAt, error: why);
      return;
    }
    _checked = null;
    _newWifi = wifi?.ssid;
    _waitOnline();
  }

  /// Back on this computer's own Wi-Fi: the computer starts, joins its Wi-Fi and comes online.
  void _waitOnline() {
    _waits++;
    _show(_Step.starting);
    var waited = Duration.zero;
    var asking = false;
    _poll?.cancel();
    _poll = Timer.periodic(InternUnlockDialog.waitEvery, (_) async {
      if (asking || !mounted || _step != _Step.starting) return;
      asking = true;
      waited += InternUnlockDialog.waitEvery;
      try {
        await _app.refreshMachines();
      } catch (_) {
        // This computer may still be finding its way back to its own Wi-Fi.
      } finally {
        asking = false;
      }
      if (!mounted || _step != _Step.starting) return;
      final state = _app.machineStates[_id];
      if (state?.machine.status == 'running' || state?.nodeOnline == true) {
        _poll?.cancel();
        unawaited(_app.harnessOs.refresh(_id, force: true));
        _show(_Step.done);
        return;
      }
      if (waited >= InternUnlockDialog.comeOnline) {
        _poll?.cancel();
        // Unlocked and still not online: signed out, or off its Wi-Fi. Either way its hotspot is
        // back for Set up Intern 3.
        _show(
          _Step.starting,
          error: _newWifi == null
              ? '$_name is unlocked but not online. If it was signed out or lost its Wi-Fi, set it up again.'
              : '$_name is unlocked but not online on “$_newWifi”. Set it up again.',
        );
      }
    });
  }

  void _close() => Navigator.of(context).pop();

  void _submit(Future<void> Function() action) {
    if (!_busy) unawaited(action());
  }

  // -- the dialog --

  String? get _message {
    if (_error.isNotEmpty) return _error;
    if (_status.isNotEmpty) return _status;
    return switch (_step) {
      _Step.finding when _looking => 'Looking for $_name…',
      _Step.starting => 'Waiting for $_name…',
      _ => null,
    };
  }

  @override
  Widget build(BuildContext context) => InternDialogFrame(
    key: const Key('intern-unlock'),
    title: 'Unlock $_name',
    message: _message,
    error: _error.isNotEmpty,
    actions: _actions(),
    children: _body(),
  );

  List<Widget> _body() {
    switch (_step) {
      case _Step.finding:
        return [
          InternText(
            'After a restart $_name waits for its password on its own Wi-Fi.',
          ),
          InternText(
            'Join “$_hotspotName” in this computer’s Wi-Fi menu.',
            muted: false,
          ),
          InternCheck(
            key: const Key('intern-unlock-joined'),
            label: 'This computer is on “$_hotspotName”',
            value: _joined,
            onChanged: _looking
                ? null
                : (joined) => setState(() => _joined = joined),
          ),
        ];
      case _Step.password:
        return [
          InternText('$_name’s password, the one set when it was installed.'),
          InternField(
            label: 'Password',
            controller: _secret,
            fieldKey: const Key('intern-unlock-secret'),
            password: true,
            autofocus: true,
            enabled: !_busy,
            onSubmitted: (_) => _submit(_check),
          ),
        ];
      case _Step.choice:
        return const [
          InternText(
            'That is its password. Unlock it on the Wi-Fi it knows, or give it another one.',
          ),
        ];
      case _Step.networks:
        return [
          InternText('The Wi-Fi $_name sees.'),
          InternNetworkList(
            networks: _networks,
            onChoose: _choose,
            active: _app.harnessOs.wifi(_id),
          ),
        ];
      case _Step.wifiPassword:
        return [
          InternText('The password for “${_chosen?.ssid}”.'),
          InternField(
            label: 'Wi-Fi password',
            controller: _password,
            fieldKey: const Key('intern-unlock-wifi-password'),
            password: true,
            autofocus: true,
            maxLength: 63,
            enabled: !_busy,
            onSubmitted: (_) => _submit(() => _unlock(wifi: _chosen)),
          ),
        ];
      case _Step.starting:
        return [
          if (_error.isEmpty) ...[
            InternWaitBar(
              key: ValueKey('intern-wait:$_waits'),
              span: InternUnlockDialog.comeOnline,
            ),
            InternText(
              _newWifi == null
                  ? 'Unlocked. $_name is starting and going back on its Wi-Fi.'
                  : 'Unlocked. $_name is starting and joining “$_newWifi”.',
            ),
            const InternText(
              'Switch this computer back to your Wi-Fi if it does not do so by itself.',
              muted: false,
            ),
          ],
        ];
      case _Step.done:
        return [InternText('$_name is online.')];
    }
  }

  List<Widget> _actions() {
    final close = internButton(
      'Close',
      _close,
      key: const Key('intern-unlock-close'),
    );
    final busy = _busy;
    // Not reached, or unlocked and not online: set it up again, or try once more.
    final failed = [
      close,
      internButton(
        'Set up',
        () => Navigator.of(context).pop(true),
        key: const Key('intern-unlock-set-up'),
      ),
      internButton(
        'Retry',
        _find,
        key: const Key('intern-unlock-retry'),
        primary: true,
      ),
    ];
    switch (_step) {
      case _Step.finding:
        final connect = internButton(
          _error.isEmpty ? 'Connect' : 'Retry',
          _looking || !_joined ? null : _connect,
          key: const Key('intern-unlock-connect'),
          primary: true,
        );
        return _error.isEmpty
            ? [close, connect]
            : [failed[0], failed[1], connect];
      case _Step.password:
        return [
          close,
          internButton(
            'Next',
            busy ? null : () => unawaited(_check()),
            key: const Key('intern-unlock-next'),
            primary: true,
          ),
        ];
      case _Step.choice:
        return [
          close,
          internButton(
            'Change Wi-Fi',
            busy ? null : () => unawaited(_listNetworks()),
            key: const Key('intern-unlock-change-wifi'),
          ),
          internButton(
            'Unlock',
            busy ? null : () => unawaited(_unlock()),
            key: const Key('intern-unlock-go'),
            primary: true,
          ),
        ];
      case _Step.networks:
        return [
          close,
          internButton(
            'Back',
            busy ? null : () => _show(_Step.choice),
            key: const Key('intern-unlock-back'),
          ),
          internButton(
            'Look again',
            busy ? null : () => unawaited(_listNetworks(rescan: true)),
            key: const Key('intern-unlock-look-again'),
          ),
        ];
      case _Step.wifiPassword:
        return [
          close,
          internButton(
            'Back',
            busy ? null : () => _show(_Step.networks),
            key: const Key('intern-unlock-back'),
          ),
          internButton(
            'Unlock',
            busy ? null : () => unawaited(_unlock(wifi: _chosen)),
            key: const Key('intern-unlock-with-wifi'),
            primary: true,
          ),
        ];
      case _Step.starting:
        return _error.isEmpty ? [close] : failed;
      case _Step.done:
        return [
          internButton(
            'Done',
            _close,
            key: const Key('intern-unlock-done'),
            primary: true,
          ),
        ];
    }
  }
}
