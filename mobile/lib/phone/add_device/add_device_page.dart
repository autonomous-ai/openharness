import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/api/api_client.dart' show describeApiError;
import 'package:harness_mobile/core/models.dart' show Machine;
import 'package:harness_mobile/shared/widgets/app_icon_button.dart';
import 'package:harness_mobile/state/app_state.dart';

import '../machines_tab.dart';
import '../phone_navigation.dart' show phoneRoute;
import '../settings_row.dart';
import '../tty.dart';
import '../tty_controls.dart';
import 'setup_hotspot.dart';

/// Settings ▸ Set up a device: a Harness with no screen (a box, a mini PC) put on the person's
/// Wi-Fi and signed in to this phone's account, through the device's own setup hotspot.
///
///   ticket (while this phone still has the Internet) → pick `Harness-XXXX` from the Wi-Fi list
///   → the Wi-Fi the device sees → password → the device leaves its hotspot for that Wi-Fi
///   → it shows up in this account's computers.
///
/// When the Wi-Fi fails (wrong password, out of reach, no Internet) the device brings its hotspot
/// back with the reason; joining it again shows that reason above the list.
class AddDevicePage extends StatefulWidget {
  const AddDevicePage({super.key, required this.notifier, this.hotspot});

  final AppNotifier notifier;
  final SetupHotspot? hotspot;

  @override
  State<AddDevicePage> createState() => _AddDevicePageState();
}

enum _Step { start, join, networks, password, waiting, done }

/// Joining the device's hotspot, shown as it goes: the person picking it, the phone on it and
/// asking the device, then reading its Wi-Fi list.
enum _Progress { choosing, talking, reading }

/// One line of [_Progress]: a check when done, a spinner while it is going on.
class _Line extends StatelessWidget {
  const _Line({required this.done, required this.text});

  final bool done;
  final String text;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          SizedBox(
            width: 18,
            height: 18,
            child: done
                ? Icon(LucideIcons.check300, size: 18, color: tty.green)
                : CircularProgressIndicator(strokeWidth: 2, color: tty.dim),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              text,
              style: tty.style(color: done ? tty.text : tty.dim),
            ),
          ),
        ],
      ),
    );
  }
}

class _AddDevicePageState extends State<AddDevicePage> {
  late final SetupHotspot _hotspot = widget.hotspot ?? SetupHotspot();
  final _ssid = TextEditingController();
  final _password = TextEditingController();
  final _name = TextEditingController();

  _Step _step = _Step.start;
  bool _busy = false;
  String _error = '';
  String _ticket = '';
  Map<String, dynamic> _device = const {};
  List<SetupNetwork> _networks = const [];
  SetupNetwork? _chosen;

  /// The Wi-Fi password shown as typed, by the eye at the field's end.
  bool _reveal = false;

  /// Back to the hotspot right after sending a Wi-Fi: the device may still be trying it.
  bool _retrying = false;

  _Progress _progress = _Progress.choosing;

  /// The address the device's hotspot gave this phone, once Android says it is on it.
  String? _address;

  /// The device's last failed Wi-Fi and why, read when the phone joined its hotspot again.
  ({String ssid, String why})? _failed;
  bool _alreadyHere = false;

  /// The device read `running` in the account when its Wi-Fi was sent.
  bool _wasRunning = false;
  Timer? _poll;

  /// How long the device gets to join the Wi-Fi, sign in and show up in the account.
  static const _comeOnline = Duration(seconds: 75);

  AppNotifier get _app => widget.notifier;

  @override
  void dispose() {
    _poll?.cancel();
    unawaited(_hotspot.leave());
    _ssid.dispose();
    _password.dispose();
    _name.dispose();
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

  @override
  void initState() {
    super.initState();
    unawaited(_start());
  }

  // -- 1. a ticket while the Internet is still here --

  Future<void> _start() async {
    _show(_Step.start);
    setState(() => _busy = true);
    try {
      final ticket = await _app.api.boxTicket();
      _ticket = ticket['ticket'] as String? ?? '';
    } catch (e) {
      _show(_Step.start, error: describeApiError(e));
      return;
    }
    if (_ticket.isEmpty) {
      _show(_Step.start, error: 'Could not prepare the sign-in. Try again.');
      return;
    }
    await _join();
  }

  // -- 2. onto the device's hotspot, picked from the Wi-Fi list --

  Future<void> _join() async {
    _show(_Step.join);
    setState(() {
      _busy = true;
      _progress = _Progress.choosing;
      _address = null;
    });
    if (SetupHotspot.joinsByItself) {
      final joined = await _hotspot.join();
      if (!mounted) return;
      if (joined.state == 'joined') {
        setState(() {
          _progress = _Progress.talking;
          _address = joined.address;
        });
      }
      if (joined.state == 'unavailable') {
        _show(
          _Step.join,
          error: 'No device was chosen. Check it is plugged in and nearby: its Wi-Fi is named "Harness-…".',
        );
        return;
      }
    }
    // Joined by Android, or by the person in Settings: wait for the page to answer.
    _poll?.cancel();
    _poll = Timer.periodic(
      const Duration(seconds: 2),
      (_) => unawaited(_reach()),
    );
    unawaited(_reach());
  }

  bool _reaching = false;

  Future<void> _reach() async {
    if (_reaching || _step != _Step.join) return;
    _reaching = true;
    try {
      final info = await _hotspot.info();
      if (info == null || !mounted || _step != _Step.join) return;
      _poll?.cancel();
      _device = info;
      _retrying = false;
      setState(() => _progress = _Progress.reading);
      final networks = await _hotspot.networks();
      if (!mounted) return;
      // A failed try before this one: the device says why, once the phone is back on its hotspot.
      final last = info['result'];
      final why = last is Map && last['state'] == 'failed'
          ? last['message'] as String? ?? ''
          : '';
      setState(() {
        _networks = networks;
        _step = _Step.networks;
        _error = why;
        _failed = why.isEmpty
            ? null
            : (ssid: last['ssid'] as String? ?? '', why: why);
        _busy = false;
      });
    } on SetupException catch (e) {
      _show(_Step.join, error: e.message);
    } finally {
      _reaching = false;
    }
  }

  // -- 3. the person's Wi-Fi --

  void _choose(SetupNetwork? network) {
    _chosen = network;
    _ssid.text = network?.ssid ?? '';
    _password.clear();
    // The same Wi-Fi again after it failed: why, over the password being typed again.
    final failed = _failed;
    _show(
      _Step.password,
      error: failed != null && network != null && failed.ssid == network.ssid
          ? failed.why
          : '',
    );
  }

  Future<void> _send() async {
    final ssid = _ssid.text.trim();
    final password = _password.text;
    final secure = _chosen?.secure ?? password.isNotEmpty;
    if (ssid.isEmpty) {
      _show(_Step.password, error: 'Enter the Wi-Fi name.');
      return;
    }
    if (secure && (password.length < 8 || password.length > 63)) {
      _show(_Step.password, error: 'A Wi-Fi password has 8 to 63 characters.');
      return;
    }
    setState(() => _busy = true);
    // Signed in already: only its Wi-Fi changes, so it keeps its name and is not new. One signed out
    // is set up afresh, even if its old record is still in the account.
    _alreadyHere = _device['signedIn'] == true;
    _wasRunning = _machine?.status == 'running';
    try {
      await _hotspot.connect(
        ssid: ssid,
        password: secure ? password : '',
        ticket: _ticket,
      );
    } on SetupException catch (e) {
      _show(_Step.password, error: e.message);
      return;
    }
    await _hotspot.leave();
    _wait(ssid);
  }

  /// The device's computer id as the backend keeps it (`normalizeComputerId`): its file has
  /// dashes, the account's record has none.
  String get _computerId => _bare(_device['computerId'] as String? ?? '');

  static String _bare(String id) =>
      id.toLowerCase().replaceAll(RegExp('[^a-z0-9]'), '');

  // -- 4. the device on the Internet, in this account --

  Machine? get _machine {
    if (_computerId.isEmpty) return null;
    for (final machine in _app.machines) {
      if (_bare(machine.computerId ?? '') == _computerId) return machine;
    }
    return null;
  }

  // -- 5. its name, then Computers with it marked new --

  Future<void> _finish() async {
    final machine = _machine;
    final name = _name.text.trim();
    if (machine != null) {
      if (name.isNotEmpty && name != machine.displayName) {
        setState(() => _busy = true);
        final failed = await _app.renameMachine(machine.machineId, name);
        if (!mounted) return;
        if (failed != null) {
          _show(_Step.done, error: failed);
          return;
        }
      }
      if (!_alreadyHere) _app.markMachineNew(machine.machineId);
    }
    if (!mounted) return;
    await Navigator.of(context).pushReplacement(
      phoneRoute(
        // Its row reads "new", with Start on it.
        (_) => MachinesTab(notifier: _app, large: false),
      ),
    );
  }

  void _wait(String ssid) {
    _show(_Step.waiting);
    final deadline = DateTime.now().add(_comeOnline);
    _poll?.cancel();
    _poll = Timer.periodic(const Duration(seconds: 3), (_) async {
      if (!mounted || _step != _Step.waiting) return;
      try {
        await _app.refreshMachines();
      } catch (_) {
        // The phone may still be finding its way back to its own Wi-Fi.
      }
      if (!mounted || _step != _Step.waiting) return;
      // Done the moment it is online: `running` in the account (the backend sees its daemon). It
      // was offline while it hosted its hotspot, so a `running` now is this Wi-Fi working. Only one
      // that somehow read running all along is given time instead.
      final online = _machine?.status == 'running';
      final settled = _wasRunning
          ? DateTime.now().isAfter(
              deadline.subtract(const Duration(seconds: 45)),
            )
          : online;
      if (settled) {
        _poll?.cancel();
        // Named after its Wi-Fi, `Harness-XXXX`, the name the person just picked it by; a device
        // that was here already keeps its own.
        final machine = _machine;
        _name.text = _alreadyHere && machine != null
            ? machine.displayName
            : _device['hotspot'] as String? ?? machine?.displayName ?? '';
        _show(_Step.done);
        return;
      }
      if (DateTime.now().isAfter(deadline)) {
        _poll?.cancel();
        // Not online by now: the Wi-Fi most likely failed and the device is back on its hotspot with
        // the reason. Android goes back to it by itself; elsewhere the person rejoins it.
        if (SetupHotspot.joinsByItself) {
          _retrying = true;
          unawaited(_join());
          return;
        }
        _show(
          _Step.waiting,
          error:
              'The device did not come online on "$ssid". If its hotspot is back, it tells why: '
              'join it again.',
        );
      }
    });
  }

  // -- the page --

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
                  const TtyText(
                    'Set up a device',
                    size: TtySize.display,
                    weight: FontWeight.w600,
                  ),
                  const SizedBox(height: 8),
                  // Above the step, not under it: under a list of twenty Wi-Fi it was off screen.
                  if (_error.isNotEmpty) ...[
                    Text(
                      _error,
                      key: const Key('add-device-error'),
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
    final name = _device['hotspot'] as String? ?? 'Harness-…';
    switch (_step) {
      case _Step.start:
        return [
          say(
            'For a Harness with no screen. Plug it in and wait a minute: it opens a Wi-Fi named '
            '"Harness-…".',
          ),
        ];
      case _Step.join:
        return [
          if (SetupHotspot.joinsByItself)
            say(
              'Choose the device, "Harness-…", from the Wi-Fi list. Then wait here.',
            )
          else
            say(
              'Open Settings ▸ Wi-Fi on this phone and choose "Harness-…". Then come back here.',
            ),
          if (_retrying) ...[
            const SizedBox(height: 12),
            say(
              'The device is still trying the Wi-Fi. Its hotspot comes back within a minute.',
            ),
          ],
          const SizedBox(height: 16),
          // Where it is, as a Wi-Fi settings page shows joining: what is done, and what is going on.
          _Line(
            done: _progress.index > _Progress.choosing.index,
            text: _progress.index > _Progress.choosing.index
                ? 'Joined the device\'s Wi-Fi${_address == null ? '' : ' · address $_address'}'
                : SetupHotspot.joinsByItself
                ? 'Choose "Harness-…" from the list…'
                : 'Waiting for this phone to join "Harness-…"…',
          ),
          if (_progress.index >= _Progress.talking.index)
            _Line(
              done: _progress.index > _Progress.talking.index,
              text: _progress.index > _Progress.talking.index
                  ? 'The device answered'
                  : 'Talking to the device…',
            ),
          if (_progress == _Progress.reading)
            const _Line(
              done: false,
              text: 'Reading the Wi-Fi the device sees…',
            ),
        ];
      case _Step.networks:
        return [
          say(
            'Choose the Wi-Fi for the device. It is the list the device sees.',
          ),
          const SizedBox(height: 12),
          SettingsGroup(
            children: [
              for (final network in _networks)
                SettingsRow(
                  key: ValueKey('add-device-wifi-${network.ssid}'),
                  title: network.ssid,
                  value: network.secure ? 'Locked' : 'Open',
                  detail: _bars(network.signal),
                  onTap: () => _choose(network),
                ),
              SettingsRow(
                key: const Key('add-device-wifi-other'),
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
              key: const Key('add-device-ssid'),
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
              key: const Key('add-device-password'),
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
                  key: const Key('add-device-reveal'),
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
      case _Step.waiting:
        return [
          say(
            _error.isEmpty
                ? '$name is joining "${_ssid.text.trim()}" and signing in to your account. '
                      'This phone goes back to its own Wi-Fi meanwhile.'
                : '',
          ),
        ];
      case _Step.done:
        return [
          say(
            _alreadyHere
                ? '$name is moving to "${_ssid.text.trim()}". It shows in Computers once it is online.'
                : '$name is ready. Give it a name.',
          ),
          const SizedBox(height: 12),
          TtyField(
            key: const Key('add-device-name'),
            controller: _name,
            hint: 'Name',
            autofocus: true,
            maxLength: AppNotifier.machineNameMaxLength,
            onSubmitted: _busy ? null : () => unawaited(_finish()),
          ),
        ];
    }
  }

  List<Widget> _actions() {
    switch (_step) {
      case _Step.start:
        return [
          TtyPrimaryButton(
            key: const Key('add-device-continue'),
            label: 'Try again',
            busy: _busy,
            busyLabel: 'Preparing…',
            onPressed: () => unawaited(_start()),
          ),
        ];
      case _Step.join:
        return [
          if (_error.isNotEmpty || !SetupHotspot.joinsByItself)
            TtyPrimaryButton(
              key: const Key('add-device-retry-join'),
              label: SetupHotspot.joinsByItself ? 'Try again' : 'I joined it',
              onPressed: () =>
                  unawaited(SetupHotspot.joinsByItself ? _join() : _reach()),
            ),
        ];
      case _Step.networks:
        return [
          TtyTextButton(
            label: 'Look again',
            onPressed: () {
              _show(_Step.join);
              unawaited(_reach());
            },
          ),
        ];
      case _Step.password:
        return [
          TtyPrimaryButton(
            key: const Key('add-device-connect'),
            label: 'Connect',
            busy: _busy,
            busyLabel: 'Sending…',
            onPressed: () => unawaited(_send()),
          ),
          TtyTextButton(
            label: 'Choose another Wi-Fi',
            onPressed: () => _show(_Step.networks),
          ),
        ];
      case _Step.waiting:
        return [
          if (_error.isNotEmpty)
            TtyPrimaryButton(
              key: const Key('add-device-rejoin'),
              label: 'Join the device again',
              onPressed: () => unawaited(_join()),
            )
          else ...[
            const Center(child: CircularProgressIndicator(strokeWidth: 2)),
            const SizedBox(height: 20),
            // Not waiting out the whole wait: back to the device now. Once it has given up on the
            // Wi-Fi (in under a minute) its hotspot is back, and its Wi-Fi list comes up with why.
            TtyTextButton(
              key: const Key('add-device-retype'),
              label: 'Choose Wi-Fi again',
              onPressed: () {
                _poll?.cancel();
                _retrying = true;
                unawaited(_join());
              },
            ),
          ],
        ];
      case _Step.done:
        return [
          TtyPrimaryButton(
            key: const Key('add-device-done'),
            label: 'OK',
            busy: _busy,
            busyLabel: 'Saving…',
            onPressed: () => unawaited(_finish()),
          ),
        ];
    }
  }

  static String _bars(int signal) => signal >= 70
      ? 'Strong signal'
      : signal >= 40
      ? 'Good signal'
      : 'Weak signal';
}
