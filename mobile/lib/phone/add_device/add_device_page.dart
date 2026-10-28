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

/// Settings ▸ Set up Intern 3: a Harness with no screen (a box, a mini PC) put on the person's
/// Wi-Fi and signed in to this phone's account, through the device's own setup hotspot.
///
///   ticket (while this phone still has the Internet) → pick `Harness-XXXX` from the Wi-Fi list
///   → the Wi-Fi the device sees → password → the device leaves its hotspot for that Wi-Fi
///   → it shows up in this account's computers.
///
/// When the Wi-Fi fails (wrong password, out of reach, no Internet) the device brings its hotspot
/// back with the reason; joining it again shows that reason above the list.
///
/// A device whose disk is locked as it starts hosts the same hotspot before anything else and asks
/// for the computer's password first; opened, it starts, and its hotspot comes back for the rest.
/// One on a cable is online already: it is only signed in, with no Wi-Fi to choose.
class AddDevicePage extends StatefulWidget {
  const AddDevicePage({super.key, required this.notifier, this.hotspot});

  final AppNotifier notifier;
  final SetupHotspot? hotspot;

  @override
  State<AddDevicePage> createState() => _AddDevicePageState();
}

enum _Step { start, join, unlock, networks, password, waiting, done, back }

/// Joining the device's hotspot, shown as it goes: the person picking it, the phone on it and
/// asking the device, then reading its Wi-Fi list.
enum _Progress { choosing, talking, reading }

/// One line of [_Progress]: a check when done, a spinner while it is going on.
/// The setup's steps, in order, with where the person is: done ✓, here ▸, to come ·. On the first
/// page each says what it asks of them, before anything is looked for.
class _Steps extends StatelessWidget {
  const _Steps({required this.current, this.details = false});

  /// The step the person is on; past the last, every step is done.
  final int current;
  final bool details;

  static const steps = [
    (
      'Turn the computer on',
      'Plug it in and switch it on. In about a minute it opens a Wi-Fi named "Harness-…".',
    ),
    (
      'Find it',
      'This phone looks for that Wi-Fi and joins it. Stay close to the computer.',
    ),
    (
      'Its password',
      'If it asks: the computer\'s password, the one set when it was installed.',
    ),
    (
      'Its Wi-Fi',
      'Choose the Wi-Fi the computer should use, and type its password.',
    ),
    (
      'Online',
      'It joins that Wi-Fi and signs in to your account. Then it shows in Computers.',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Column(
      key: const Key('add-device-steps'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < steps.length; i++)
          Padding(
            padding: EdgeInsets.symmetric(vertical: details ? 6 : 2),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 22,
                  child: Text(
                    i < current
                        ? '✓'
                        : i == current
                        ? '▸'
                        : '·',
                    style: tty.style(
                      color: i < current
                          ? tty.green
                          : i == current
                          ? tty.text
                          : tty.faint,
                      weight: FontWeight.w600,
                    ),
                  ),
                ),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${i + 1}. ${steps[i].$1}',
                        style: tty.style(
                          color: i == current
                              ? tty.text
                              : i < current
                              ? tty.dim
                              : tty.faint,
                          weight: i == current
                              ? FontWeight.w600
                              : FontWeight.w400,
                        ),
                      ),
                      if (details)
                        Text(
                          steps[i].$2,
                          style: tty.style(color: tty.dim, size: TtySize.meta),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

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

  /// The computer's own password, for a device still locked as it starts.
  final _secret = TextEditingController();

  /// Unlocked from here: it is starting, and its hotspot comes back under the same name.
  bool _unlocked = false;

  /// A device still locked that takes the whole setup with its password (protocol 2): its Wi-Fi is
  /// chosen from the list its startup scanned, then the computer's password sends it all in one stay
  /// on its hotspot — set up before or not, and whatever account it was on.
  bool _lockedSetup = false;

  /// Asked for by Look again on a locked device's list: scanned again beside its hotspot.
  bool _rescan = false;

  /// A locked device that checks the computer's password on its own (protocol 3): the password is
  /// asked first and checked — nothing opens — then the Wi-Fi, then both go in one unlock.
  bool _checkFirst = false;

  /// The computer's password once the device said it is the right one: kept in memory only, for the
  /// unlock that follows the Wi-Fi.
  String? _checked;

  /// The device found online after a locked setup: it said no computer id while locked, so it is told
  /// apart in the account instead — new there, or offline when the password was sent ([_sentAt]).
  Machine? _found;
  Map<String, String>? _sentAt;

  /// After an unlock: the account's computers that were not online then. One of them online now is
  /// the one just unlocked, set up before — on its own Wi-Fi, signed in, with no hotspot to come
  /// back ([_Step.back]).
  Set<String> _offlineAtUnlock = const {};
  Timer? _backWatch;
  Machine? _backOnline;

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
    _backWatch?.cancel();
    unawaited(_hotspot.leave());
    _ssid.dispose();
    _password.dispose();
    _name.dispose();
    _secret.dispose();
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

  /// Find the device was pressed: the steps are being followed. Before it, the first page only says
  /// what is to come — nothing is looked for until the person is ready.
  bool _begun = false;

  /// Where [_step] is among [_Steps.steps].
  int get _stage => switch (_step) {
    _Step.start => _begun ? 1 : 0,
    _Step.join => 1,
    _Step.unlock => 2,
    _Step.networks || _Step.password => 3,
    _Step.waiting => 4,
    _Step.done || _Step.back => 5,
  };

  // -- 1. a ticket while the Internet is still here --

  Future<void> _start() async {
    _begun = true;
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

  /// A ticket handed to the device already: the next try needs a new one.
  bool _ticketSent = false;

  /// A new ticket, tried for a while: the phone may still be finding its way back to its own Wi-Fi.
  Future<bool> _freshTicket() async {
    Object? failure;
    for (var attempt = 0; attempt < 5; attempt++) {
      try {
        final ticket = await _app.api.boxTicket();
        final value = ticket['ticket'] as String? ?? '';
        if (value.isNotEmpty) {
          _ticket = value;
          _ticketSent = false;
          return true;
        }
      } catch (e) {
        failure = e;
      }
      await Future<void>.delayed(const Duration(seconds: 3));
      if (!mounted) return false;
    }
    _show(
      _Step.join,
      error: failure == null
          ? 'Could not prepare the sign-in. Try again.'
          : describeApiError(failure),
    );
    return false;
  }

  // -- 2. onto the device's hotspot, picked from the Wi-Fi list --

  Future<void> _join() async {
    _show(_Step.join);
    setState(() {
      _busy = true;
      _progress = _Progress.choosing;
      _address = null;
    });
    // Back to the device after it was handed a ticket: that one is spent (or will be, by a sign-in
    // that failed), so a new one now, while this phone is on its own Wi-Fi again. Sent again, the old
    // one came back "This ticket was already used or has expired".
    if (_ticketSent && !await _freshTicket()) return;
    if (SetupHotspot.joinsByItself) {
      // The same device again once it has started: only its own name in Android's list.
      final joined = await _hotspot.join(
        // Back after a locked setup that did not come online: the same device, on setup.py's
        // hotspot now, with why.
        name: _unlocked || _lockedSetup ? _device['hotspot'] as String? : null,
      );
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
      // Still the locked one, just unlocked from here: it has not started yet.
      if (_unlocked && info['locked'] == true) return;
      _poll?.cancel();
      _device = info;
      _retrying = false;
      if (info['locked'] == true) {
        _secret.clear();
        final protocol = (info['protocol'] as num?)?.toInt() ?? 1;
        if (protocol >= 2) {
          // The whole setup while it is locked. Protocol 3: the computer's password first, checked,
          // then its Wi-Fi; protocol 2: its Wi-Fi first.
          _lockedSetup = true;
          _checkFirst = protocol >= 3;
          if (_checkFirst && _checked == null) {
            _show(_Step.unlock);
            return;
          }
          await _lockedNetworks();
          return;
        }
        _show(_Step.unlock);
        return;
      }
      _unlocked = false;
      // Started: the page setup.py hosts, which says what it is (its computer id) and why a try failed.
      _lockedSetup = false;
      _found = null;
      // A failed try before this one: the device says why, once the phone is back on its hotspot.
      final last = info['result'];
      final why =
          last is Map && (last['state'] == 'failed' || last['error'] != null)
          ? last['message'] as String? ?? ''
          : '';
      // On a cable: online already, so it is only signed in. Not again after that failed: the
      // person sees why, and may give it a Wi-Fi instead.
      if (info['online'] == true && info['signedIn'] != true && why.isEmpty) {
        await _sendWired();
        return;
      }
      setState(() => _progress = _Progress.reading);
      final networks = await _hotspot.networks();
      if (!mounted) return;
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

  /// A locked device's Wi-Fi: the list its startup scanned, or scanned again beside its hotspot.
  Future<void> _lockedNetworks() async {
    setState(() => _progress = _Progress.reading);
    final rescan = _rescan;
    _rescan = false;
    final networks = await _hotspot.networks(rescan: rescan);
    if (!mounted) return;
    setState(() {
      _networks = networks;
      _step = _Step.networks;
      _error = '';
      _busy = false;
    });
  }

  // -- 2b. a device locked as it starts: the computer's password --

  Future<void> _unlock() async {
    final secret = _secret.text;
    if (secret.isEmpty) {
      _show(_Step.unlock, error: 'Enter the computer\'s password.');
      return;
    }
    setState(() => _busy = true);
    if (_checkFirst) {
      // Only checked: right, then the Wi-Fi; wrong, said now — before any Wi-Fi is chosen.
      final String? why;
      try {
        why = await _hotspot.check(secret);
      } on SetupException catch (e) {
        _show(_Step.unlock, error: e.message);
        return;
      }
      if (why != null) {
        _show(_Step.unlock, error: why);
        return;
      }
      _checked = secret;
      _secret.clear();
      try {
        await _lockedNetworks();
      } on SetupException catch (e) {
        _show(_Step.join, error: e.message);
      }
      return;
    }
    await _unlockWith(secret);
  }

  /// The disk opened with [secret] — and, for a locked setup, the Wi-Fi and the sign-in sent with it.
  Future<void> _unlockWith(String secret) async {
    setState(() => _busy = true);
    // The whole setup with it: a new ticket for a try after one that was handed over already.
    if (_lockedSetup && _ticketSent && !await _freshTicket()) return;
    final ssid = _ssid.text.trim();
    final secure = _chosen?.secure ?? _password.text.isNotEmpty;
    final Map<String, Object?>? setup = _lockedSetup
        ? {
            'ssid': ssid,
            if (secure) 'password': _password.text,
            if (_chosen != null) 'security': _chosen!.security,
            'ticket': _ticket,
            'account': ?_app.currentUser?.id,
          }
        : null;
    // The account as it is now: the device is told apart in it once online, having given no id.
    _sentAt = {for (final m in _app.machines) m.machineId: m.status ?? ''};
    // Checked first: a failure now is said beside the Wi-Fi password, where the button was.
    final failedAt = _checkFirst ? _Step.password : _Step.unlock;
    final String? why;
    try {
      why = await _hotspot.unlock(secret, setup: setup);
    } on SetupException catch (e) {
      _show(failedAt, error: e.message);
      return;
    }
    _secret.clear();
    if (why != null) {
      _show(failedAt, error: why);
      return;
    }
    _checked = null;
    if (_lockedSetup) {
      // Opened, with its Wi-Fi and ticket: it joins and signs in as it starts. No second hotspot.
      _ticketSent = true;
      _alreadyHere = false;
      _wasRunning = false;
      await _hotspot.leave();
      _wait(ssid);
      return;
    }
    // It starts now. Its hotspot goes, and comes back under the same name for the rest of the
    // setup — unless it was set up before: then it goes on to its own Wi-Fi.
    _unlocked = true;
    _watchBack();
    await _hotspot.leave();
    _show(_Step.join);
    setState(() {
      _busy = true;
      _progress = _Progress.choosing;
    });
    await Future<void>.delayed(const Duration(seconds: 15));
    if (!mounted || _step != _Step.join) return;
    await _join();
  }

  /// While the phone looks for its hotspot again: a computer set up before goes on to its own Wi-Fi
  /// and signs in as it was, and no hotspot comes. The account says so — one that was offline at the
  /// unlock is online — and the search stops there, done. For a few minutes; a computer not set up
  /// yet comes back on its hotspot instead and the setup goes on as before.
  void _watchBack() {
    _offlineAtUnlock = {
      for (final machine in _app.machines)
        if (machine.status != 'running') machine.machineId,
    };
    _backWatch?.cancel();
    if (_offlineAtUnlock.isEmpty) return;
    final deadline = DateTime.now().add(const Duration(minutes: 3));
    _backWatch = Timer.periodic(const Duration(seconds: 3), (_) async {
      if (!mounted || !_unlocked || DateTime.now().isAfter(deadline)) {
        _backWatch?.cancel();
        return;
      }
      try {
        await _app.refreshMachines();
      } catch (_) {
        // The phone may still be on the device's Wi-Fi, or finding its way back to its own.
      }
      if (!mounted || !_unlocked) return;
      final back = _app.machines
          .where(
            (m) =>
                _offlineAtUnlock.contains(m.machineId) && m.status == 'running',
          )
          .toList();
      if (back.isEmpty) return;
      // The one named after this hotspot, when there are several; else the first back.
      final hotspot = _device['hotspot'] as String?;
      _backOnline =
          back.where((m) => m.displayName == hotspot).firstOrNull ?? back.first;
      _backWatch?.cancel();
      _poll?.cancel();
      _unlocked = false;
      unawaited(_hotspot.leave());
      _show(_Step.back);
    });
  }

  // -- 2c. on a cable: only the sign-in --

  Future<void> _sendWired() async {
    _alreadyHere = false;
    _wasRunning = _machine?.status == 'running';
    _ssid.clear();
    try {
      await _hotspot.connect(ssid: '', password: '', ticket: _ticket);
      _ticketSent = true;
    } on SetupException catch (e) {
      _show(_Step.join, error: e.message);
      return;
    }
    await _hotspot.leave();
    _wait('');
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
    if (_lockedSetup) {
      // Its password checked already: unlocked now, the Wi-Fi with it. Not yet (protocol 2): the
      // computer's password next.
      final checked = _checked;
      if (_checkFirst && checked != null) {
        await _unlockWith(checked);
        return;
      }
      _secret.clear();
      _show(_Step.unlock);
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
      _ticketSent = true;
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
    if (_computerId.isEmpty) return _lockedSetup ? _foundOnline() : null;
    for (final machine in _app.machines) {
      if (_bare(machine.computerId ?? '') == _computerId) return machine;
    }
    return null;
  }

  /// After a locked setup: the computer online in the account now that was not when the password
  /// went — new there, or offline then. The one named after the hotspot first, when there are more.
  /// Kept once found, for its name and Start.
  Machine? _foundOnline() {
    final found = _found;
    if (found != null) {
      return _app.machines
              .where((m) => m.machineId == found.machineId)
              .firstOrNull ??
          found;
    }
    final before = _sentAt;
    if (before == null) return null;
    final back = [
      for (final m in _app.machines)
        if (m.status == 'running' && before[m.machineId] != 'running') m,
    ];
    if (back.isEmpty) return null;
    final hotspot = _device['hotspot'] as String?;
    final machine =
        back.where((m) => m.displayName == hotspot).firstOrNull ?? back.first;
    // One the account had before: set up before, so it keeps its name and is not new.
    _alreadyHere = before.containsKey(machine.machineId);
    return _found = machine;
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
    // A locked one starts first: its disk opens, then the system, then the Wi-Fi and the sign-in.
    final deadline = DateTime.now().add(
      _lockedSetup ? _comeOnline * 2 : _comeOnline,
    );
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
                    'Set up Intern 3',
                    size: TtySize.display,
                    weight: FontWeight.w600,
                  ),
                  const SizedBox(height: 12),
                  // Where the person is, on every page: the steps, with their words on the first.
                  _Steps(current: _stage, details: !_begun),
                  const SizedBox(height: 16),
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
          if (_begun)
            say('Getting ready to sign the computer in…')
          else
            say(
              'When the computer is on and its Wi-Fi "Harness-…" is up, tap Find the device.',
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
          if (_unlocked) ...[
            const SizedBox(height: 12),
            say(
              '$name is unlocked and starting. Its Wi-Fi comes back within a minute for the rest '
              'of the setup. Set up before? Then it joins its own Wi-Fi instead, and you are done.',
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
      case _Step.unlock:
        return [
          say(
            _checkFirst
                ? '$name is locked. Enter the computer\'s password — the one set when it was '
                      'installed. It is checked first; then you choose its Wi-Fi.'
                : _lockedSetup
                ? 'Last, the computer\'s password — the one set when it was installed. $name '
                      'starts with it, joins "${_ssid.text.trim()}" and signs in to your account.'
                : '$name is locked. Enter the computer\'s password — the one set when it was '
                      'installed — to start it.',
          ),
          const SizedBox(height: 8),
          TtyField(
            key: const Key('add-device-unlock-password'),
            controller: _secret,
            hint: 'Computer password',
            autofocus: true,
            keyboardType: TextInputType.visiblePassword,
            obscure: !_reveal,
            onSubmitted: _busy ? null : () => unawaited(_unlock()),
            trailing: [
              AppIconButton(
                key: const Key('add-device-unlock-reveal'),
                icon: _reveal ? LucideIcons.eyeOff300 : LucideIcons.eye300,
                size: 20,
                tooltip: _reveal ? 'Hide password' : 'Show password',
                color: tty.dim,
                onPressed: () => setState(() => _reveal = !_reveal),
              ),
            ],
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
              if (_device['online'] == true)
                SettingsRow(
                  key: const Key('add-device-cable'),
                  title: 'Use its cable',
                  value: 'Online',
                  onTap: () => unawaited(_sendWired()),
                ),
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
            _error.isNotEmpty
                ? ''
                : _ssid.text.trim().isEmpty
                ? '$name is on a cable: it is signing in to your account. '
                      'This phone goes back to its own Wi-Fi meanwhile.'
                : '$name is joining "${_ssid.text.trim()}" and signing in to your account. '
                      'This phone goes back to its own Wi-Fi meanwhile.',
          ),
        ];
      case _Step.back:
        return [
          say(
            '${_backOnline?.displayName ?? name} is unlocked and online again, on its own Wi-Fi '
            'and signed in as before. Nothing else to set up.',
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
            label: _begun ? 'Try again' : 'Find the device',
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
          if (_unlocked)
            TtyTextButton(
              key: const Key('add-device-unlocked-done'),
              label: 'It was set up before: done',
              onPressed: () => Navigator.of(context).maybePop(),
            ),
        ];
      case _Step.unlock:
        return [
          TtyPrimaryButton(
            key: const Key('add-device-unlock'),
            label: _checkFirst
                ? 'Next'
                : _lockedSetup
                ? 'Unlock and set up'
                : 'Unlock',
            busy: _busy,
            busyLabel: _checkFirst ? 'Checking…' : 'Unlocking…',
            onPressed: () => unawaited(_unlock()),
          ),
          if (_lockedSetup && !_checkFirst)
            TtyTextButton(
              key: const Key('add-device-unlock-back'),
              label: 'Choose another Wi-Fi',
              onPressed: () => _show(_Step.networks),
            ),
        ];
      case _Step.networks:
        return [
          TtyTextButton(
            label: 'Look again',
            onPressed: () {
              // A locked device scans again beside its hotspot; a started one rescans anyway.
              _rescan = _lockedSetup;
              _show(_Step.join);
              unawaited(_reach());
            },
          ),
        ];
      case _Step.password:
        return [
          TtyPrimaryButton(
            key: const Key('add-device-connect'),
            label: _checkFirst
                ? 'Unlock and set up'
                : _lockedSetup
                ? 'Next'
                : 'Connect',
            busy: _busy,
            busyLabel: _checkFirst ? 'Unlocking…' : 'Sending…',
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
      case _Step.back:
        return [
          TtyPrimaryButton(
            key: const Key('add-device-back-done'),
            label: 'Done',
            onPressed: () => Navigator.of(context).maybePop(),
          ),
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
