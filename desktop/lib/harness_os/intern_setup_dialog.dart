import 'dart:async';

import 'package:flutter/material.dart';

import '../agent_messages/update_harness.dart';
import '../api/api_client.dart'
    show HarnessTooOldException, describeApiError, isTransientApiError;
import '../core/models.dart' show Machine;
import '../state/app_state.dart';
import 'intern_dialog.dart';
import 'setup_hotspot.dart';

/// Set up Intern 3: a Harness with no screen put on the person's Wi-Fi and signed in to this
/// account, through its own setup hotspot (the phone's `AddDevicePage`, as a dialog).
///
///   ticket (while this computer still has the Internet) → the person joins `Harness-XXXX` in this
///   computer's Wi-Fi menu → the Wi-Fi the device sees → password → the device leaves its hotspot
///   for that Wi-Fi → it shows up in this account's computers.
///
/// A device whose disk is locked as it starts asks for its password first (protocol 1: it opens,
/// starts, and its hotspot comes back; 2: the Wi-Fi, then the password with everything; 3: the
/// password checked, then the Wi-Fi, then both in one unlock). One on a cable is only signed in.
///
/// The ticket comes through this computer's Harness, which gives it over its own socket only
/// (CLI gateway/accountRoutes.ts): an older one does not know the route, and is updated first.
Future<void> showInternSetup(
  BuildContext context,
  AppNotifier app, {
  SetupHotspot? hotspot,
}) => showInternDialog<void>(
  context,
  (_) => InternSetupDialog(app: app, hotspot: hotspot),
);

/// Why Set up waits for this computer's Harness to be updated, from its version (null when it did
/// not say).
String internTooOldLine(String? current) {
  if (current == null) {
    return 'Update Harness on this computer to set up Intern 3.';
  }
  if (isDevelopmentBuild(current)) {
    return "This computer runs a development build of Harness ($current), which doesn't update itself.";
  }
  return 'This computer runs Harness $current. Update it to set up Intern 3.';
}

class InternSetupDialog extends StatefulWidget {
  const InternSetupDialog({super.key, required this.app, this.hotspot});

  final AppNotifier app;

  /// The device's page; one is made (and closed with the dialog) when none is given.
  final SetupHotspot? hotspot;

  /// How often the device's page is asked once the person says this computer joined its hotspot,
  /// and for how long: macOS takes a few seconds to get an address there.
  @visibleForTesting
  static Duration findEvery = const Duration(seconds: 2);
  @visibleForTesting
  static Duration findFor = const Duration(seconds: 30);

  /// How often the account is read while the device comes online, and how long it gets (twice
  /// that for a locked one, which starts first).
  @visibleForTesting
  static Duration waitEvery = const Duration(seconds: 3);
  @visibleForTesting
  static Duration comeOnline = const Duration(seconds: 75);

  /// Between tries for a new ticket: this computer may still be finding its way back to its Wi-Fi.
  @visibleForTesting
  static Duration ticketRetry = const Duration(seconds: 3);

  @override
  State<InternSetupDialog> createState() => _InternSetupDialogState();
}

enum _Step { start, finding, unlock, networks, password, waiting, done, back }

class _InternSetupDialogState extends State<InternSetupDialog> {
  late final SetupHotspot _hotspot = widget.hotspot ?? SetupHotspot();
  final _ssid = TextEditingController();
  final _password = TextEditingController();
  final _name = TextEditingController();

  /// The computer's own password, for a device still locked as it starts.
  final _secret = TextEditingController();

  _Step _step = _Step.start;
  bool _busy = false;
  String _error = '';

  /// What is going on while [_busy], in the status line.
  String _status = '';

  String _ticket = '';

  /// This computer's Harness predates the ticket's route: it is updated before anything else.
  bool _tooOld = false;

  /// A ticket handed to the device already.
  bool _ticketSent = false;

  /// When [_ticket] was had: it lives 30 minutes (backend `BOX_TICKET_TTL_SEC`).
  DateTime? _ticketAt;

  /// The device tried its sign-in with it, which may have spent it: its last try got past the Wi-Fi.
  bool _ticketSpent = false;

  /// A new ticket is needed before the device is handed one again. One handed over is spent only
  /// once the device is on the Wi-Fi and signs in (os/setup.py `connect`): a try that failed at
  /// the Wi-Fi leaves it as it was, and the retry stays on the hotspot instead of a trip back to
  /// this computer's Wi-Fi for a new one (a test MSI, 2026-11-20: Change Wi-Fi seemed to do
  /// nothing while it asked for one with no Internet).
  bool get _needsTicket =>
      _ticketSent &&
      (_ticketSpent ||
          _ticketAt == null ||
          DateTime.now().difference(_ticketAt!) > const Duration(minutes: 25));

  Map<String, dynamic> _device = const {};
  List<SetupNetwork> _networks = const [];
  SetupNetwork? _chosen;

  /// The device's last failed Wi-Fi and why, read when this computer joined its hotspot again.
  ({String ssid, String why})? _failed;

  /// Unlocked from here (protocol 1): it is starting, and its hotspot comes back under the same name.
  bool _unlocked = false;

  /// A locked device that takes the whole setup with its password (protocol 2 and later).
  bool _lockedSetup = false;

  /// A locked device that checks the password on its own first (protocol 3).
  bool _checkFirst = false;

  /// Look again on a locked device's list: scanned again beside its hotspot.
  bool _rescan = false;

  /// The password once the device said it is right: in memory only, for the unlock that follows.
  String? _checked;

  /// Back to the hotspot after a Wi-Fi was sent: the device says why it failed there.
  bool _retrying = false;

  /// Signed in already: only its Wi-Fi changes, so it keeps its name.
  bool _alreadyHere = false;

  /// The device read `running` in the account when its Wi-Fi was sent.
  bool _wasRunning = false;

  /// After a locked setup the device gave no computer id: it is told apart in the account instead,
  /// as the one online now that was not when the password went ([_sentAt]).
  Machine? _found;
  Map<String, String>? _sentAt;

  /// The account's computers online as Set up started, read then while this computer still had
  /// the Internet. On the hotspot the list is only as new as this computer's last read: a device
  /// that went off to wait at its password read `running` there still, and was never told apart
  /// once it came back (a test MSI, 2026-11-20, stuck at Online).
  Set<String> _runningAtStart = const {};

  /// Every computer read offline while this one waits for the device: back online, it is the one.
  final _seenDown = <String>{};

  /// How long this wait for the device gets, for its bar, and which wait it is: a new one starts
  /// the bar again.
  Duration _waitSpan = Duration.zero;
  int _waits = 0;

  /// This computer, or another of its own: offline too while it was on the hotspot, and back
  /// online with it, so never the device (a test MSI, 2026-11-20: a wrong Wi-Fi password, and
  /// Set up offered to name this Mac).
  bool _isHere(Machine machine) =>
      _app.machineStates[machine.machineId]?.isLocalMachine == true;

  /// The run the device was handed its Wi-Fi in (`/setup/connect`'s answer): a result of it, or a
  /// later one, is about this try. 0 after a locked setup, whose page did not say.
  int _sentRun = 0;

  bool _wasOnline(Machine? machine) =>
      machine != null &&
      machine.status == 'running' &&
      _runningAtStart.contains(machine.machineId);

  /// After a protocol 1 unlock: the account's computers offline then. One of them online now is the
  /// one just unlocked, set up before, on its own Wi-Fi with no hotspot to come back ([_Step.back]).
  Set<String> _offlineAtUnlock = const {};
  Machine? _backOnline;

  Timer? _poll, _backWatch;
  bool _reaching = false;
  int _findTries = 0;

  /// The person ticked that this computer is on the device's Wi-Fi: Connect asks its page.
  bool _joined = false;

  /// Connect pressed: its page is asked until it answers or [InternSetupDialog.findFor] runs out.
  bool _looking = false;

  AppNotifier get _app => widget.app;

  String get _hotspotName => _device['hotspot'] as String? ?? 'Harness-…';
  String get _deviceName => _device['hotspot'] as String? ?? 'Intern 3';

  @override
  void dispose() {
    _poll?.cancel();
    _backWatch?.cancel();
    if (widget.hotspot == null) _hotspot.close();
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
      _status = '';
    });
  }

  void _working(String status) => setState(() {
    _busy = true;
    _error = '';
    _status = status;
  });

  // -- 1. a ticket while the Internet is still here --

  Future<void> _start() async {
    _working('Getting ready…');
    try {
      _ticket = await _app.api.boxTicket();
      _ticketSent = false;
      _ticketAt = DateTime.now();
      _ticketSpent = false;
      _tooOld = false;
    } catch (e) {
      _tooOld = e is HarnessTooOldException;
      _show(_Step.start, error: _tooOld ? '' : _ticketError(e));
      return;
    }
    try {
      await _app.refreshMachines();
    } catch (_) {
      // Read again while it waits; a device online all along is then only given time.
    }
    if (!mounted) return;
    _runningAtStart = {
      for (final machine in _app.machines)
        if (machine.status == 'running') machine.machineId,
    };
    await _find();
  }

  /// A new ticket, tried for a while: this computer may still be finding its way back to its Wi-Fi.
  Future<bool> _freshTicket() async {
    _working('Getting ready…');
    Object? failure;
    // Up to half a minute: macOS takes a while to rejoin its own Wi-Fi once the hotspot goes.
    for (var attempt = 0; attempt < 10; attempt++) {
      try {
        _ticket = await _app.api.boxTicket();
        _ticketSent = false;
        _ticketAt = DateTime.now();
        _ticketSpent = false;
        return mounted;
      } catch (e) {
        failure = e;
      }
      await Future<void>.delayed(InternSetupDialog.ticketRetry);
      if (!mounted) return false;
    }
    _show(_Step.start, error: _ticketError(failure!));
    return false;
  }

  /// Why no ticket came. Most often this computer is still on the device's hotspot, which has no
  /// Internet: its Harness cannot reach the account (the gateway's 502), so it says where to go.
  static String _ticketError(Object error) {
    return isTransientApiError(error)
        ? 'This computer is not online. Switch it back to your Wi-Fi, then Retry.'
        : describeApiError(error);
  }

  // -- 2. onto the device's hotspot, joined by the person --

  Future<void> _find() async {
    _poll?.cancel();
    // Back after it was handed a ticket: that one is spent, so a new one now, while this computer
    // is on its own Wi-Fi again.
    if (_needsTicket && !await _freshTicket()) return;
    if (!mounted) return;
    _joined = false;
    _looking = false;
    _show(_Step.finding);
  }

  /// The person says this computer joined the hotspot: its page is asked for a while.
  void _connect() {
    _poll?.cancel();
    setState(() {
      _looking = true;
      _error = '';
    });
    _findTries = 0;
    _poll = Timer.periodic(
      InternSetupDialog.findEvery,
      (_) => unawaited(_reach()),
    );
    unawaited(_reach());
  }

  Future<void> _reach() async {
    if (_reaching || _step != _Step.finding) return;
    _reaching = true;
    try {
      final info = await _hotspot.info();
      if (!mounted || _step != _Step.finding) return;
      // Not joined yet, or still the locked one just unlocked from here: it has not started.
      if (info == null || (_unlocked && info['locked'] == true)) {
        _findTries++;
        if (InternSetupDialog.findEvery * _findTries >=
            InternSetupDialog.findFor) {
          _poll?.cancel();
          _looking = false;
          _show(
            _Step.finding,
            error:
                'Intern 3 did not answer. Check this computer is on “$_hotspotName”.',
          );
        }
        return;
      }
      _poll?.cancel();
      _looking = false;
      _device = info;
      _retrying = false;
      if (info['locked'] == true) {
        _secret.clear();
        final protocol = (info['protocol'] as num?)?.toInt() ?? 1;
        if (protocol >= 2) {
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
      _backWatch?.cancel();
      // Started: the page setup.py hosts, which says its computer id and why a try failed.
      _lockedSetup = false;
      _checkFirst = false;
      _found = null;
      final last = info['result'];
      final why =
          last is Map && (last['state'] == 'failed' || last['error'] != null)
          ? last['message'] as String? ?? ''
          : '';
      // Past the Wi-Fi, its sign-in was tried: that ticket may be spent.
      if (last is Map &&
          (last['error'] == 'SIGN_IN' || last['state'] == 'done')) {
        _ticketSpent = true;
      }
      // On a cable: online already, so it is only signed in. Not again after that failed: the
      // person sees why, and may give it a Wi-Fi instead.
      if (info['online'] == true && info['signedIn'] != true && why.isEmpty) {
        await _sendWired();
        return;
      }
      _working('Reading its Wi-Fi…');
      final networks = await _hotspot.networks();
      if (!mounted) return;
      _networks = networks;
      _failed = why.isEmpty
          ? null
          : (ssid: (last as Map)['ssid'] as String? ?? '', why: why);
      _show(_Step.networks, error: why);
    } on SetupException catch (e) {
      _show(_Step.finding, error: e.message);
    } finally {
      _reaching = false;
    }
  }

  /// A locked device's Wi-Fi: the list its startup scanned, or scanned again beside its hotspot.
  Future<void> _lockedNetworks() async {
    _working('Reading its Wi-Fi…');
    final rescan = _rescan;
    _rescan = false;
    final networks = await _hotspot.networks(rescan: rescan);
    if (!mounted) return;
    _networks = networks;
    _show(_Step.networks);
  }

  void _lookAgain() {
    // A locked device scans again beside its hotspot; a started one rescans anyway.
    _rescan = _lockedSetup;
    unawaited(_find());
  }

  // -- 2b. a device locked as it starts: the computer's password --

  Future<void> _unlock() async {
    final secret = _secret.text;
    if (secret.isEmpty) {
      _show(_Step.unlock, error: 'Enter Intern 3’s password.');
      return;
    }
    if (_checkFirst) {
      // Only checked: right, then the Wi-Fi; wrong, said now, before any Wi-Fi is chosen.
      _working('Checking…');
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
        _show(_Step.finding, error: e.message);
      }
      return;
    }
    await _unlockWith(secret);
  }

  /// The disk opened with [secret] and, for a locked setup, the Wi-Fi and the sign-in with it.
  Future<void> _unlockWith(String secret) async {
    if (_lockedSetup && _needsTicket && !await _freshTicket()) return;
    if (!mounted) return;
    // With the setup it unlocks, joins the Wi-Fi and signs in: to the person, it connects.
    _working(_lockedSetup ? 'Connecting…' : 'Unlocking…');
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
    _sentAt = {
      for (final m in _app.machines)
        m.machineId: _wasOnline(m) ? 'running' : 'offline',
    };
    // Checked first: a failure now is said beside the Wi-Fi password, where the button was.
    final failedAt = _checkFirst ? _Step.password : _Step.unlock;
    final String? why;
    try {
      why = await _hotspot.unlock(secret, setup: setup);
    } on SetupException catch (e) {
      _show(failedAt, error: e.message);
      return;
    }
    if (!mounted) return;
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
      _sentRun = 0;
      _wait(ssid);
      return;
    }
    // It starts now. Its hotspot goes, and comes back under the same name for the rest of the
    // setup, unless it was set up before: then it goes on to its own Wi-Fi.
    _unlocked = true;
    _watchBack();
    await _find();
  }

  /// While the person waits for its hotspot again: a computer set up before goes on to its own
  /// Wi-Fi and signs in as it was, and no hotspot comes. The account says so: one offline at the
  /// unlock is online.
  void _watchBack() {
    _offlineAtUnlock = {
      for (final machine in _app.machines)
        if (!_wasOnline(machine)) machine.machineId,
    };
    _backWatch?.cancel();
    if (_offlineAtUnlock.isEmpty) return;
    var waited = Duration.zero;
    var asking = false;
    _backWatch = Timer.periodic(InternSetupDialog.waitEvery, (_) async {
      if (asking) return;
      waited += InternSetupDialog.waitEvery;
      if (!mounted || !_unlocked || waited > const Duration(minutes: 3)) {
        _backWatch?.cancel();
        return;
      }
      asking = true;
      try {
        await _app.refreshMachines();
      } catch (_) {
        // This computer may still be on the device's Wi-Fi, or finding its way back to its own.
      } finally {
        asking = false;
      }
      if (!mounted || !_unlocked) return;
      final back = _app.machines
          .where(
            (m) =>
                _offlineAtUnlock.contains(m.machineId) && m.status == 'running',
          )
          .toList();
      if (back.isEmpty) return;
      final hotspot = _device['hotspot'] as String?;
      _backOnline =
          back.where((m) => m.displayName == hotspot).firstOrNull ?? back.first;
      _backWatch?.cancel();
      _poll?.cancel();
      _unlocked = false;
      _show(_Step.back);
    });
  }

  // -- 2c. on a cable: only the sign-in --

  Future<void> _sendWired() async {
    _alreadyHere = false;
    _wasRunning = _wasOnline(_machine);
    _ssid.clear();
    _chosen = null;
    _working('Sending…');
    try {
      _sentRun = await _hotspot.connect(
        ssid: '',
        password: '',
        ticket: _ticket,
      );
      _ticketSent = true;
    } on SetupException catch (e) {
      _show(_Step.finding, error: e.message);
      return;
    }
    _wait('');
  }

  // -- 3. the person's Wi-Fi --

  void _choose(SetupNetwork? network) {
    _chosen = network;
    _ssid.text = network?.ssid ?? '';
    _password.clear();
    // The same Wi-Fi again after it failed: why, over the password being typed again.
    final failed = _failed;
    final again =
        failed != null && network != null && failed.ssid == network.ssid;
    _show(_Step.password, error: again ? failed.why : '');
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
    // Spent by the last try, or too old: a new one, which needs this computer on its own Wi-Fi.
    if (_needsTicket && !await _freshTicket()) return;
    if (!mounted) return;
    _working('Sending…');
    // Signed in already: only its Wi-Fi changes. One signed out is set up afresh.
    _alreadyHere = _device['signedIn'] == true;
    _wasRunning = _wasOnline(_machine);
    try {
      _sentRun = await _hotspot.connect(
        ssid: ssid,
        password: secure ? password : '',
        ticket: _ticket,
      );
      _ticketSent = true;
    } on SetupException catch (e) {
      _show(_Step.password, error: e.message);
      return;
    }
    _wait(ssid);
  }

  // -- 4. the device on the Internet, in this account --

  /// The device's computer id as the backend keeps it (`normalizeComputerId`): its file has
  /// dashes, the account's record has none.
  String get _computerId => _bare(_device['computerId'] as String? ?? '');

  static String _bare(String id) =>
      id.toLowerCase().replaceAll(RegExp('[^a-z0-9]'), '');

  Machine? get _machine {
    if (_computerId.isEmpty) return _lockedSetup ? _foundOnline() : null;
    for (final machine in _app.machines) {
      if (_bare(machine.computerId ?? '') == _computerId) return machine;
    }
    return null;
  }

  /// After a locked setup: the computer online now that was not when the password went. The one
  /// named after the hotspot first, when there are more. Kept once found.
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
        if (m.status == 'running' &&
            !_isHere(m) &&
            (before[m.machineId] != 'running' ||
                _seenDown.contains(m.machineId)))
          m,
    ];
    if (back.isEmpty) return null;
    final hotspot = _device['hotspot'] as String?;
    final machine =
        back.where((m) => m.displayName == hotspot).firstOrNull ?? back.first;
    // One the account had before: set up before, so it keeps its name.
    _alreadyHere = before.containsKey(machine.machineId);
    return _found = machine;
  }

  void _wait(String ssid) {
    final span = _lockedSetup
        ? InternSetupDialog.comeOnline * 2
        : InternSetupDialog.comeOnline;
    _waitSpan = span;
    _waits++;
    _show(_Step.waiting);
    var waited = Duration.zero;
    var asking = false;
    _poll?.cancel();
    _poll = Timer.periodic(InternSetupDialog.waitEvery, (_) async {
      if (asking || !mounted || _step != _Step.waiting) return;
      asking = true;
      waited += InternSetupDialog.waitEvery;
      Map<String, dynamic>? page;
      try {
        await _app.refreshMachines();
        // Still on its hotspot, or back on it: a device that could not join the Wi-Fi opens it
        // again, with why. Then the Wi-Fi is chosen again at once, instead of a wait it all out.
        page = await _hotspot.info();
      } catch (_) {
        // This computer may still be finding its way back to its own Wi-Fi.
      } finally {
        asking = false;
      }
      for (final machine in _app.machines) {
        if (machine.status != 'running') _seenDown.add(machine.machineId);
      }
      if (!mounted || _step != _Step.waiting) return;
      final result = page?['result'];
      if (page != null &&
          page['locked'] != true &&
          result is Map &&
          result['state'] == 'failed' &&
          ((result['run'] as num?)?.toInt() ?? 0) >= _sentRun) {
        _poll?.cancel();
        _retrying = true;
        _joined = true;
        _show(_Step.finding);
        _connect();
        return;
      }
      // Done the moment it is online: it was offline while it hosted its hotspot, so `running` now
      // is this Wi-Fi working. Only one that read running all along is given time instead.
      final online = _machine?.status == 'running';
      final settled = _wasRunning
          ? waited >= span - const Duration(seconds: 45)
          : online;
      if (settled) {
        _poll?.cancel();
        // Named after its Wi-Fi, `Harness-XXXX`, the name the person just picked it by; one that
        // was here already keeps its own.
        final machine = _machine;
        _name.text = _alreadyHere && machine != null
            ? machine.displayName
            : _device['hotspot'] as String? ?? machine?.displayName ?? '';
        _show(_Step.done);
        return;
      }
      if (waited >= span) {
        _poll?.cancel();
        // Not online by now: most likely the Wi-Fi failed and the device is back on its hotspot
        // with the reason, which it shows once this computer joins it again.
        _show(
          _Step.waiting,
          error: ssid.isEmpty
              ? 'Intern 3 did not come online. Join “$_hotspotName” again to see why.'
              : 'Intern 3 did not come online on “$ssid”. Join “$_hotspotName” again to see why.',
        );
      }
    });
  }

  void _again() {
    _poll?.cancel();
    _retrying = true;
    unawaited(_find());
  }

  // -- 5. its name --

  Future<void> _finish() async {
    final machine = _machine;
    final name = _name.text.trim();
    if (machine != null && name.isNotEmpty && name != machine.displayName) {
      _working('Saving…');
      final failed = await _app.renameMachine(machine.machineId, name);
      if (!mounted) return;
      if (failed != null) {
        _show(_Step.done, error: failed);
        return;
      }
    }
    if (mounted) Navigator.of(context).pop();
  }

  void _close() => Navigator.of(context).pop();

  /// Return in a field takes the step's primary action, unless one is running.
  void _submit(Future<void> Function() action) {
    if (!_busy) unawaited(action());
  }

  // -- the dialog --

  String? get _message {
    if (_error.isNotEmpty) return _error;
    if (_status.isNotEmpty) return _status;
    return switch (_step) {
      _Step.finding when _looking => 'Looking for Intern 3…',
      _Step.waiting => 'Waiting for Intern 3…',
      _ => null,
    };
  }

  static const _steps = [
    (
      'Turn Intern 3 on',
      'Plug it in and switch it on. In about a minute it opens a Wi-Fi named “Harness-…”.',
    ),
    ('Join its Wi-Fi', 'Pick “Harness-…” in this computer’s Wi-Fi menu.'),
    (
      'Its password',
      'If it asks: Intern 3’s password, the one set when it was installed.',
    ),
    ('Its Wi-Fi', 'Choose the Wi-Fi Intern 3 should use, and its password.'),
    (
      'Online',
      'It joins that Wi-Fi and signs in to your account. Then it shows in Machines.',
    ),
  ];

  /// Where [_step] is among [_steps].
  int get _stage => switch (_step) {
    _Step.start => 0,
    _Step.finding => 1,
    _Step.unlock => 2,
    _Step.networks || _Step.password => 3,
    _Step.waiting => 4,
    _Step.done || _Step.back => 5,
  };

  @override
  Widget build(BuildContext context) => InternDialogFrame(
    key: const Key('intern-setup'),
    title: 'Set up Intern 3',
    message: _message,
    error: _error.isNotEmpty,
    actions: _actions(),
    children: [
      // Where the person is, on every step: the steps, with what each asks before it starts.
      InternSteps(
        key: const Key('intern-setup-steps'),
        steps: _steps,
        current: _stage,
        details: _step == _Step.start,
      ),
      ..._body(),
    ],
  );

  List<Widget> _body() {
    final ssid = _ssid.text.trim();
    switch (_step) {
      case _Step.start:
        return [
          const InternText(
            'Press Start while this computer is online.',
            muted: false,
          ),
          if (_tooOld)
            UpdateHarnessLine(
              _app,
              key: const Key('intern-setup-update-harness'),
              tooOld: internTooOldLine,
              onUpdated: () => unawaited(_start()),
            ),
        ];
      case _Step.finding:
        return [
          if (_unlocked)
            InternText(
              'Unlocked. Intern 3 is starting, and “$_hotspotName” comes back in about a minute. '
              'Set up before? Then it goes back on its own Wi-Fi.',
            ),
          InternText(
            'Join “$_hotspotName” in this computer’s Wi-Fi menu. Not there? Check Intern 3 is on.',
            muted: false,
          ),
          InternCheck(
            key: const Key('intern-setup-joined'),
            label: 'This computer is on “$_hotspotName”',
            value: _joined,
            onChanged: _looking
                ? null
                : (joined) => setState(() => _joined = joined),
          ),
          if (_retrying)
            const InternText(
              'If a try failed, Intern 3 says why once you join it.',
            ),
        ];
      case _Step.unlock:
        return [
          InternText(
            _checkFirst
                ? '$_deviceName is locked. Enter Intern 3’s password, the one set when it was installed.'
                : _lockedSetup
                ? 'Last, Intern 3’s password. It starts, joins “$ssid” and signs in to your account.'
                : '$_deviceName is locked. Enter Intern 3’s password to start it.',
          ),
          InternField(
            label: 'Intern 3 password',
            controller: _secret,
            fieldKey: const Key('intern-setup-secret'),
            password: true,
            autofocus: true,
            enabled: !_busy,
            onSubmitted: (_) => _submit(_unlock),
          ),
        ];
      case _Step.networks:
        return [
          const InternText('Choose the Wi-Fi for Intern 3.'),
          InternNetworkList(networks: _networks, onChoose: _choose),
          Align(
            alignment: Alignment.centerLeft,
            child: internButton(
              'Other network…',
              () => _choose(null),
              key: const Key('intern-setup-other'),
            ),
          ),
        ];
      case _Step.password:
        final chosen = _chosen;
        return [
          if (chosen == null) ...[
            InternField(
              label: 'Wi-Fi name',
              controller: _ssid,
              fieldKey: const Key('intern-setup-ssid'),
              autofocus: true,
              maxLength: 32,
              enabled: !_busy,
            ),
            InternField(
              label: 'Password',
              hint: 'Empty for an open Wi-Fi',
              controller: _password,
              fieldKey: const Key('intern-setup-password'),
              password: true,
              maxLength: 63,
              enabled: !_busy,
              onSubmitted: (_) => _submit(_send),
            ),
          ] else if (chosen.secure) ...[
            InternText('The password for “${chosen.ssid}”.'),
            InternField(
              label: 'Wi-Fi password',
              controller: _password,
              fieldKey: const Key('intern-setup-password'),
              password: true,
              autofocus: true,
              maxLength: 63,
              enabled: !_busy,
              onSubmitted: (_) => _submit(_send),
            ),
          ] else
            InternText('“${chosen.ssid}” has no password.'),
        ];
      case _Step.waiting:
        return [
          if (_error.isEmpty) ...[
            InternWaitBar(
              key: ValueKey('intern-wait:$_waits'),
              span: _waitSpan,
            ),
            InternText(
              ssid.isEmpty
                  ? '$_deviceName is on a cable. It is signing in to your account.'
                  : '$_deviceName is joining “$ssid” and signing in to your account.',
            ),
            const InternText(
              'Switch this computer back to your Wi-Fi if it does not do so by itself.',
              muted: false,
            ),
            InternText(
              'Wrong password? Intern 3 opens “$_hotspotName” again. Join it to choose the Wi-Fi again.',
            ),
          ],
        ];
      case _Step.done:
        return [
          InternText(
            _alreadyHere
                ? '$_deviceName is online.'
                : '$_deviceName is online. Give it a name.',
          ),
          InternField(
            label: 'Name',
            controller: _name,
            fieldKey: const Key('intern-setup-name'),
            autofocus: true,
            enabled: !_busy,
            onSubmitted: (_) => _submit(_finish),
          ),
        ];
      case _Step.back:
        return [
          InternText(
            '${_backOnline?.displayName ?? _deviceName} is unlocked and online on its own Wi-Fi. '
            'Nothing else to set up.',
          ),
        ];
    }
  }

  List<Widget> _actions() {
    final close = internButton(
      'Close',
      _close,
      key: const Key('intern-setup-close'),
    );
    final busy = _busy;
    switch (_step) {
      case _Step.start:
        return [
          close,
          internButton(
            _error.isEmpty && !_tooOld ? 'Start' : 'Retry',
            busy ? null : () => unawaited(_start()),
            key: const Key('intern-setup-start'),
            primary: true,
          ),
        ];
      case _Step.finding:
        return [
          close,
          internButton(
            _error.isEmpty ? 'Connect' : 'Retry',
            busy || _looking || !_joined ? null : _connect,
            key: const Key('intern-setup-connect-hotspot'),
            primary: true,
          ),
        ];
      case _Step.unlock:
        return [
          close,
          if (_lockedSetup && !_checkFirst)
            internButton(
              'Back',
              busy ? null : () => _show(_Step.networks),
              key: const Key('intern-setup-back'),
            ),
          internButton(
            _checkFirst ? 'Next' : 'Unlock',
            busy ? null : () => unawaited(_unlock()),
            key: const Key('intern-setup-unlock'),
            primary: true,
          ),
        ];
      case _Step.networks:
        return [
          close,
          internButton(
            'Look again',
            busy ? null : _lookAgain,
            key: const Key('intern-setup-look-again'),
          ),
          if (_device['online'] == true && !_lockedSetup)
            internButton(
              'Use cable',
              busy ? null : () => unawaited(_sendWired()),
              key: const Key('intern-setup-cable'),
            ),
        ];
      case _Step.password:
        return [
          close,
          internButton(
            'Back',
            busy ? null : () => _show(_Step.networks),
            key: const Key('intern-setup-back'),
          ),
          internButton(
            // Its password was checked already: this sends the Wi-Fi, and the unlock goes with it.
            _checkFirst
                ? 'Connect'
                : _lockedSetup
                ? 'Next'
                : 'Connect',
            busy ? null : () => unawaited(_send()),
            key: const Key('intern-setup-connect'),
            primary: true,
          ),
        ];
      case _Step.waiting:
        return [
          close,
          // No way back while it tries: one pressed then went back to a device not there yet
          // (a test MSI, 2026-11-20). Its hotspot back, with why, is noticed by itself.
          if (_error.isNotEmpty)
            internButton(
              'Try again',
              busy ? null : _again,
              key: const Key('intern-setup-again'),
              primary: true,
            ),
        ];
      case _Step.done:
        return [
          internButton(
            'Done',
            busy ? null : () => unawaited(_finish()),
            key: const Key('intern-setup-done'),
            primary: true,
          ),
        ];
      case _Step.back:
        return [
          internButton(
            'Done',
            _close,
            key: const Key('intern-setup-done'),
            primary: true,
          ),
        ];
    }
  }
}
