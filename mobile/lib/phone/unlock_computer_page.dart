import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/widgets/app_icon_button.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'add_device/add_device_page.dart';
import 'add_device/setup_hotspot.dart';
import 'phone_navigation.dart';
import 'settings_row.dart';
import 'tty.dart';
import 'tty_controls.dart';

/// Computers ▸ an encrypted Harness OS computer that was switched off and on ▸ Unlock: as it starts
/// it waits for its password and opens its own Wi-Fi, `Harness-XXXX` (os/root/usr/lib/harness-os/
/// unlock). This phone joins it, checks the password there, and opens the disk:
///
///   Unlock — the password alone; it goes back on the Wi-Fi it knows, signed in as it was.
///   Unlock and change Wi-Fi — its startup's list, a password, sent with the unlock (os/setup.py
///   `set_up_as_unlocked`, no sign-in: it is signed in already).
///
/// Then it shows up online in the account, where this page waits for it.
class UnlockComputerPage extends StatefulWidget {
  const UnlockComputerPage({
    super.key,
    required this.notifier,
    required this.machineId,
    required this.hotspotName,
    this.hotspot,
  });

  final AppNotifier notifier;
  final String machineId;

  /// The Wi-Fi it opens while locked, as its last status said.
  final String hotspotName;
  final SetupHotspot? hotspot;

  @override
  State<UnlockComputerPage> createState() => _UnlockComputerPageState();
}

enum _Step {
  start,
  finding,
  password,
  choice,
  networks,
  wifiPassword,
  starting,
  done,
}

class _UnlockComputerPageState extends State<UnlockComputerPage> {
  late final SetupHotspot _hotspot = widget.hotspot ?? SetupHotspot();
  final _secret = TextEditingController();
  final _password = TextEditingController();

  _Step _step = _Step.start;
  bool _busy = false;
  bool _reveal = false;
  String _error = '';
  Timer? _poll;

  /// The computer's password once its startup said it is the right one, for the unlock that follows.
  String? _checked;
  List<SetupNetwork> _networks = const [];
  SetupNetwork? _chosen;

  /// The Wi-Fi sent with the unlock, or null for the one it knows.
  String? _newWifi;

  /// How long it gets to start, join its Wi-Fi and show up online in the account.
  static const _comeOnline = Duration(minutes: 3);

  AppNotifier get _app => widget.notifier;
  String get _name =>
      _app.stateOf(widget.machineId)?.machine.displayName ?? 'The computer';

  @override
  void dispose() {
    _poll?.cancel();
    unawaited(_hotspot.leave());
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
    });
  }

  // -- onto its hotspot --

  Future<void> _find() async {
    _show(_Step.finding);
    setState(() => _busy = true);
    if (SetupHotspot.joinsByItself) {
      final joined = await _hotspot.join(name: widget.hotspotName);
      if (!mounted) return;
      if (joined.state == 'unavailable') {
        _show(
          _Step.start,
          error:
              '"${widget.hotspotName}" was not found. Check $_name is on and nearby, '
              'and give it a minute to start.',
        );
        return;
      }
    }
    // Joined by Android, or by the person in Settings: wait for its page to answer.
    final deadline = DateTime.now().add(const Duration(minutes: 2));
    _poll?.cancel();
    var asking = false;
    _poll = Timer.periodic(const Duration(seconds: 2), (_) async {
      if (asking || !mounted || _step != _Step.finding) return;
      asking = true;
      try {
        final info = await _hotspot.info();
        if (!mounted || _step != _Step.finding) return;
        if (info == null) {
          if (DateTime.now().isAfter(deadline)) {
            _poll?.cancel();
            _show(
              _Step.start,
              error: SetupHotspot.joinsByItself
                  ? 'Could not reach $_name on its Wi-Fi. Try again.'
                  : 'Join "${widget.hotspotName}" in Settings ▸ Wi-Fi, then come back here.',
            );
          }
          return;
        }
        _poll?.cancel();
        if (info['locked'] != true) {
          // Its own setup page: started already, not waiting for a password.
          unawaited(_hotspot.leave());
          _show(
            _Step.start,
            error: '$_name is not locked: it is starting or unlocked already.',
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
      _show(_Step.password, error: 'Enter the computer\'s password.');
      return;
    }
    setState(() => _busy = true);
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
    setState(() => _busy = true);
    try {
      final networks = await _hotspot.networks(rescan: rescan);
      if (!mounted) return;
      setState(() {
        _networks = networks;
        _busy = false;
      });
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
    setState(() => _busy = true);
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
    if (why != null) {
      _show(failedAt, error: why);
      return;
    }
    _checked = null;
    _newWifi = wifi?.ssid;
    await _hotspot.leave();
    _waitOnline();
  }

  /// Back on the phone's own Wi-Fi: the computer starts, joins its Wi-Fi and comes online.
  void _waitOnline() {
    _show(_Step.starting);
    final deadline = DateTime.now().add(_comeOnline);
    var asking = false;
    _poll?.cancel();
    _poll = Timer.periodic(const Duration(seconds: 4), (_) async {
      if (asking || !mounted || _step != _Step.starting) return;
      asking = true;
      try {
        await _app.refreshMachines();
      } catch (_) {
        // The phone may still be finding its way back to its own Wi-Fi.
      } finally {
        asking = false;
      }
      if (!mounted || _step != _Step.starting) return;
      final machine = _app.machines
          .where((m) => m.machineId == widget.machineId)
          .firstOrNull;
      if (machine?.status == 'running') {
        _poll?.cancel();
        unawaited(_app.refreshOsStatus(widget.machineId, force: true));
        // Nothing left to do here: back where the person came from, told it is online. The page
        // that opened this one goes on from there (Version finishes its update).
        ScaffoldMessenger.maybeOf(context)
            ?.showSnackBar(SnackBar(content: Text('$_name is online.')));
        Navigator.of(context).maybePop();
        return;
      }
      if (DateTime.now().isAfter(deadline)) {
        _poll?.cancel();
        _show(
          _Step.starting,
          // Unlocked and still not online: signed out (a sign-out keeps it on the account's list,
          // offline), or off its Wi-Fi. Either way its hotspot is back for Set up a device.
          error:
              '$_name is unlocked but has not come online'
              '${_newWifi == null ? '' : ' on "$_newWifi"'}. If it was signed out, or its Wi-Fi is '
              'wrong, it is waiting on "${widget.hotspotName}" to be set up: use Set up a device.',
        );
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
                  TtyText(
                    'Unlock $_name',
                    size: TtySize.display,
                    weight: FontWeight.w600,
                  ),
                  const SizedBox(height: 8),
                  if (_error.isNotEmpty) ...[
                    Text(
                      _error,
                      key: const Key('unlock-error'),
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
          ],
        ),
      ),
    );
  }

  List<Widget> _body(Tty tty) {
    Text say(String text) => Text(text, style: tty.style(color: tty.dim));
    switch (_step) {
      case _Step.start:
        return [
          say(
            'After a restart $_name waits for its password and opens a Wi-Fi named '
            '"${widget.hotspotName}". Stay near it: this phone joins that Wi-Fi to unlock it.',
          ),
        ];
      case _Step.finding:
        return [
          say(
            SetupHotspot.joinsByItself
                ? 'Looking for "${widget.hotspotName}"…'
                : 'Join "${widget.hotspotName}" in Settings ▸ Wi-Fi, then come back here.',
          ),
          const SizedBox(height: 16),
          const Center(child: CircularProgressIndicator(strokeWidth: 2)),
        ];
      case _Step.password:
        return [
          say('$_name\'s password, the one set when it was installed.'),
          const SizedBox(height: 8),
          TtyField(
            key: const Key('unlock-password'),
            controller: _secret,
            hint: 'Computer password',
            autofocus: true,
            keyboardType: TextInputType.visiblePassword,
            obscure: !_reveal,
            onSubmitted: _busy ? null : () => unawaited(_check()),
            trailing: [_eye(tty)],
          ),
        ];
      case _Step.choice:
        return [
          say(
            'That is its password. Unlock it on the Wi-Fi it knows, or give it another Wi-Fi now.',
          ),
        ];
      case _Step.networks:
        return [
          say('The Wi-Fi $_name sees.'),
          const SizedBox(height: 12),
          if (_busy)
            const Center(child: CircularProgressIndicator(strokeWidth: 2))
          else
            SettingsGroup(
              children: [
                for (final network in _networks)
                  SettingsRow(
                    key: ValueKey('unlock-wifi-${network.ssid}'),
                    title: network.ssid,
                    value: network.secure ? 'Locked' : 'Open',
                    detail: network.signal >= 70
                        ? 'Strong signal'
                        : network.signal >= 40
                        ? 'Good signal'
                        : 'Weak signal',
                    onTap: () => _choose(network),
                  ),
              ],
            ),
        ];
      case _Step.wifiPassword:
        return [
          say('The password for "${_chosen?.ssid}". It is case-sensitive.'),
          const SizedBox(height: 8),
          TtyField(
            key: const Key('unlock-wifi-password'),
            controller: _password,
            hint: 'Wi-Fi password',
            autofocus: true,
            keyboardType: TextInputType.visiblePassword,
            obscure: !_reveal,
            maxLength: 63,
            onSubmitted: _busy ? null : () => unawaited(_unlock(wifi: _chosen)),
            trailing: [_eye(tty)],
          ),
        ];
      case _Step.starting:
        return [
          if (_error.isEmpty) ...[
            say(
              _newWifi == null
                  ? 'Unlocked. $_name is starting and going back on its Wi-Fi.'
                  : 'Unlocked. $_name is starting and joining "$_newWifi".',
            ),
            const SizedBox(height: 16),
            const Center(child: CircularProgressIndicator(strokeWidth: 2)),
          ],
        ];
      case _Step.done:
        return [say('$_name is online.')];
    }
  }

  Widget _eye(Tty tty) => AppIconButton(
    icon: _reveal ? LucideIcons.eyeOff300 : LucideIcons.eye300,
    size: 20,
    tooltip: _reveal ? 'Hide password' : 'Show password',
    color: tty.dim,
    onPressed: () => setState(() => _reveal = !_reveal),
  );

  List<Widget> _actions() {
    switch (_step) {
      case _Step.start:
        return [
          TtyPrimaryButton(
            key: const Key('unlock-find'),
            label: 'Find ${widget.hotspotName}',
            onPressed: () => unawaited(_find()),
          ),
        ];
      case _Step.finding:
        return const [];
      case _Step.password:
        return [
          TtyPrimaryButton(
            key: const Key('unlock-check'),
            label: 'Continue',
            busy: _busy,
            busyLabel: 'Checking…',
            onPressed: () => unawaited(_check()),
          ),
        ];
      case _Step.choice:
        return [
          TtyPrimaryButton(
            key: const Key('unlock-go'),
            label: 'Unlock',
            busy: _busy,
            busyLabel: 'Unlocking…',
            onPressed: () => unawaited(_unlock()),
          ),
          TtyTextButton(
            key: const Key('unlock-change-wifi'),
            label: 'Unlock and change Wi-Fi…',
            onPressed: _busy ? null : () => unawaited(_listNetworks()),
          ),
        ];
      case _Step.networks:
        return [
          TtyTextButton(
            key: const Key('unlock-look-again'),
            label: 'Look again',
            onPressed: _busy
                ? null
                : () => unawaited(_listNetworks(rescan: true)),
          ),
          TtyTextButton(
            label: 'Keep its Wi-Fi',
            onPressed: _busy ? null : () => _show(_Step.choice),
          ),
        ];
      case _Step.wifiPassword:
        return [
          TtyPrimaryButton(
            key: const Key('unlock-with-wifi'),
            label: 'Unlock',
            busy: _busy,
            busyLabel: 'Unlocking…',
            onPressed: () => unawaited(_unlock(wifi: _chosen)),
          ),
          TtyTextButton(
            label: 'Choose another Wi-Fi',
            onPressed: _busy ? null : () => _show(_Step.networks),
          ),
        ];
      case _Step.starting:
        return [
          if (_error.isNotEmpty) ...[
            TtyPrimaryButton(
              key: const Key('unlock-set-up'),
              label: 'Set up a device',
              onPressed: () => Navigator.of(context).pushReplacement(
                phoneRoute((_) => AddDevicePage(notifier: _app)),
              ),
            ),
            TtyTextButton(
              label: 'Unlock again',
              onPressed: () => _show(_Step.start),
            ),
          ],
        ];
      case _Step.done:
        return [
          TtyPrimaryButton(
            key: const Key('unlock-done'),
            label: 'Done',
            onPressed: () => Navigator.of(context).maybePop(),
          ),
        ];
    }
  }
}
