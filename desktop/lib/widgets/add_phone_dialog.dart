import 'dart:async';
import 'dart:io' show SocketException;
import 'dart:math' as math;

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:qr/qr.dart';
import 'package:xterm/xterm.dart' show TerminalTheme;

import '../api/api_client.dart';
import '../core/local_hostname.dart';
import '../e2ee/keys.dart' show fingerprint;
import '../e2ee/pair_code.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
import '../state/app_state.dart';
import '../ws/ws_conn.dart' show WsRequestFailure, WsRequestTimeout;
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'box_chrome.dart';
import 'terminal_prompt.dart';
import 'terminal_text_action.dart';

// The pairing code moved beside the rest of the E2EE code; its callers still find it here.
export '../e2ee/pair_code.dart';

/// Harness ▸ Add Phone… — a QR the phone scans to sign in to this account AND
/// pair with this computer, end to end encrypted, with no password typed.
///
/// Three parts, and the QR is only one of them:
///
/// 1. **The QR** ([phonePairLink]) tells the phone who to sign in as, which
///    machine to pair with, and the one-time pairing code.
/// 2. **The sign-in code** ([PhoneSignInCodeCall]), which the QR also carries:
///    the phone redeems it for a session of its own, so the scan signs it in
///    with no emailed code. Renewed every minute while the dialog is open —
///    see [_AddPhoneDialogState._renewSignIn].
/// 3. **Arming the daemon.** The phone, once signed in, sends this machine an
///    `e2e_pair_intent`; the daemon runs the handshake only when somebody on
///    THIS computer hands it the same code (`POST /api/pair`, the call
///    `harness pair <code>` makes). So while this dialog is open it keeps
///    handing it over — see [_AddPhoneDialogState._loop] — and the code is
///    live exactly as long as the QR is on screen.
///
/// [pair] and [signInCode] are the transport, injectable so a test needs no
/// daemon; by default they are this app's own loopback client
/// ([phonePairOverDaemon], [ApiClient.phoneSignInCode]).
Future<void> showAddPhoneDialog(
  BuildContext context,
  AppNotifier app, {
  AppKeymap? keymap,
  PhonePairCall? pair,
  PhoneSignInCodeCall? signInCode,
  VoidCallback? onConnectMachine,
  PairedDevicesCall? listDevices,
  RemovePairedDeviceCall? removeDevice,
  MachineFingerprintCall? machineFingerprint,
  GroupMachinesCall? groupMachines,
}) => showTerminalPrompt<void>(
  context,
  keymap: keymap,
  builder: (_) => AddPhoneDialog(
    app: app,
    pair: pair,
    signInCode: signInCode ?? app.api.phoneSignInCode,
    onConnectMachine: onConnectMachine,
    listDevices: listDevices ?? app.api.pairedDevices,
    removeDevice: removeDevice ?? app.api.removePairedDevice,
    machineFingerprint: machineFingerprint,
    groupMachines: groupMachines,
  ),
);

/// The other machines in this computer's trust group (`GET /api/group`), or null when it cannot
/// say. After a phone links, the dialog watches this settle to say which machines now reach it.
typedef GroupMachinesCall =
    Future<List<({String machineId, String label})>?> Function();

/// The fingerprint of the machine a phone is being paired with: this computer's
/// daemon's, or — [remoteMachineId], from a viewer — the key pinned for it.
typedef MachineFingerprintCall = Future<String?> Function(
  String? remoteMachineId,
);

Future<String?> machineFingerprintOf(
  AppNotifier app,
  String? remoteMachineId,
) async {
  if (remoteMachineId == null) return app.api.machineFingerprint();
  final peer = await app.viewer?.keys.peer(remoteMachineId);
  return peer == null ? null : fingerprint(peer.pub);
}

/// Where the QR points. The phone's `ConnectCode` (mobile
/// `lib/phone/welcome/connect_code.dart`) parses exactly this.
const kPhonePairHost = 'harness.autonomous.ai';
const kPhonePairPath = '/pair';

/// `https://harness.autonomous.ai/pair#e=<email>&m=<machineId>&c=<code>&h=<sign-in code>`.
///
/// ⚠️ EVERYTHING rides in the FRAGMENT, never the query. The code is the
/// out-of-band secret end-to-end encryption rests on, and a browser never
/// sends a fragment to the server — so a link opened in Safari (no app
/// installed yet, a desktop camera, a curious person) still keeps the code
/// off our servers and out of every access log between here and there. The
/// email and machine id go with it: nothing in this link is the server's
/// business.
///
/// Encoded as a query string inside the fragment, with
/// [Uri.encodeQueryComponent], because the phone reads it back with
/// [Uri.splitQueryString] — a `+` in an address has to arrive as a `+`.
///
/// [signIn] (`h`) is the one-time code that signs the phone in; without it —
/// or on a phone app that predates it — the phone signs in with an emailed
/// code, as before. It is the account's credential for its minute, which is
/// one more reason all of this rides in the fragment.
///
/// [fingerprint] (`f`) is the machine's identity fingerprint, separators
/// dropped: a phone that knows the field refuses a machine proving a different
/// key. [hostname] (`n`) is for its confirm screen only.
Uri phonePairLink({
  required String email,
  required String machineId,
  required String code,
  String? signIn,
  String? fingerprint,
  String? hostname,
}) => Uri(
  scheme: 'https',
  host: kPhonePairHost,
  path: kPhonePairPath,
  fragment:
      'e=${Uri.encodeQueryComponent(email)}'
      '&m=${Uri.encodeQueryComponent(machineId)}'
      '&c=$code'
      '${signIn != null ? '&h=${Uri.encodeQueryComponent(signIn)}' : ''}'
      '${fingerprint != null ? '&f=${fingerprint.toUpperCase().replaceAll(RegExp('[^0-9A-Z]'), '')}' : ''}'
      '${hostname != null ? '&n=${Uri.encodeQueryComponent(hostname)}' : ''}',
);

/// What one `POST /api/pair` came to, as far as this dialog cares.
@immutable
class PhonePairAnswer {
  /// The phone is paired; [label] is its own name for itself.
  const PhonePairAnswer.paired(String this.label) : error = null;

  /// The daemon's error code (`NO_INTENT`, `CODE_MISMATCH`, …), or
  /// [unavailable] for a daemon that cannot pair at all.
  const PhonePairAnswer.failed(String this.error) : label = null;

  final String? label;
  final String? error;

  /// The daemon has no pairing to offer: it said so (a build without E2EE),
  /// it predates `/api/pair` (404), or nobody is listening. Asking again will
  /// not change that.
  static const unavailable = 'PAIRING_UNAVAILABLE';

  @override
  String toString() =>
      label != null ? 'PhonePairAnswer.paired($label)' : 'failed($error)';
}

/// Hand the daemon [code] once. [cancel] is cancelled when the dialog closes:
/// the transport should give up waiting on its long poll then.
typedef PhonePairCall = Future<PhonePairAnswer> Function(
  String code,
  CancelToken cancel,
);

/// [PhonePairCall] over this app's own loopback client — the daemon's Unix
/// socket, or its port (see [ApiClient]).
PhonePairCall phonePairOverDaemon(ApiClient api) => (code, cancel) async {
  try {
    final (:status, :body) = await api.pair(code, cancelToken: cancel);
    final error = body['error'];
    if (status >= 200 && status < 300 && error == null) {
      final label = body['label'];
      return PhonePairAnswer.paired(
        label is String && label.trim().isNotEmpty ? label.trim() : 'phone',
      );
    }
    // A daemon from before `/api/pair` answers its catch-all 404, which is
    // `{error: 'not found'}` — a code, but not one of the pairing's.
    if (status == 404) {
      return const PhonePairAnswer.failed(PhonePairAnswer.unavailable);
    }
    return PhonePairAnswer.failed(
      error is String && error.isNotEmpty ? error : 'HTTP_$status',
    );
  } on DioException catch (error) {
    return PhonePairAnswer.failed(switch (error.type) {
      // Nobody on the port or the socket.
      DioExceptionType.connectionError => PhonePairAnswer.unavailable,
      DioExceptionType.unknown when error.error is SocketException =>
        PhonePairAnswer.unavailable,
      // Our own 60 s ran out on a handshake: the phone went quiet.
      DioExceptionType.receiveTimeout ||
      DioExceptionType.sendTimeout ||
      DioExceptionType.connectionTimeout => 'TIMEOUT',
      _ => 'UNREACHABLE',
    });
  }
};

/// The browser already holds the machine's trusted identity. Arm that machine over its encrypted
/// connection; the account service never receives the QR's pairing secret.
PhonePairCall phonePairOverRelay(AppNotifier app, String machineId) =>
    (code, cancel) async {
      if (cancel.isCancelled) return const PhonePairAnswer.failed('CANCELLED');
      try {
        final answer = await Future.any([
          app.pairPhone(machineId, code),
          cancel.whenCancel.then(
            (_) => <String, dynamic>{'error': 'CANCELLED'},
          ),
        ]);
        if (answer['ok'] == true) {
          final label = answer['label'];
          return PhonePairAnswer.paired(
            label is String && label.trim().isNotEmpty ? label.trim() : 'phone',
          );
        }
        final error = answer['error'];
        return PhonePairAnswer.failed(
          error == 'UNSUPPORTED' ? PhonePairAnswer.unavailable : '$error',
        );
      } on WsRequestTimeout {
        return const PhonePairAnswer.failed(PhonePairAnswer.unavailable);
      } on WsRequestFailure catch (failure) {
        return PhonePairAnswer.failed(
          failure.code == 'UNSUPPORTED'
              ? PhonePairAnswer.unavailable
              : failure.code,
        );
      } catch (_) {
        return const PhonePairAnswer.failed('BACKEND_DOWN');
      }
    };

/// A fresh one-time sign-in code for the QR and how long it stays good, or
/// null when there is none to be had (see [ApiClient.phoneSignInCode]).
typedef PhoneSignInCodeCall = Future<({String code, Duration ttl})?> Function();

/// The devices paired with this computer, or null when the daemon cannot say
/// (see [ApiClient.pairedDevices]).
typedef PairedDevicesCall = Future<List<PairedDevice>?> Function();

/// Unpair one device by its fingerprint; true when it is done.
typedef RemovePairedDeviceCall = Future<bool> Function(String fingerprint);

class AddPhoneDialog extends StatefulWidget {
  const AddPhoneDialog({
    super.key,
    required this.app,
    this.pair,
    required this.signInCode,
    this.onConnectMachine,
    this.listDevices,
    this.removeDevice,
    this.machineFingerprint,
    this.groupMachines,
  });

  final AppNotifier app;
  final PhonePairCall? pair;
  final PhoneSignInCodeCall signInCode;
  final VoidCallback? onConnectMachine;

  /// The list under the QR — who can already reach this computer — with a way
  /// to take a device's access back. Null shows no list.
  final PairedDevicesCall? listDevices;
  final RemovePairedDeviceCall? removeDevice;

  /// Null (tests): the QR carries no fingerprint.
  final MachineFingerprintCall? machineFingerprint;

  /// Null (tests, a viewer): the dialog closes on "Connected" rather than waiting to report the
  /// trust group the phone brought.
  final GroupMachinesCall? groupMachines;

  @override
  State<AddPhoneDialog> createState() => _AddPhoneDialogState();
}

class _AddPhoneDialogState extends State<AddPhoneDialog> {
  /// With no phone waiting the daemon answers at once, so this is the whole
  /// cadence of the loop: how soon after the phone's intent lands the
  /// handshake starts. ⚠️ `NO_INTENT`, `EXPIRED` and `BUSY` are answered
  /// BEFORE any handshake runs, and only a handshake that ran and failed
  /// counts against the daemon's three-per-five-minutes limit (manager.ts
  /// `failPair`) — so asking this often costs the person nothing.
  static const _poll = Duration(milliseconds: 1500);
  static const _rateLimited = Duration(seconds: 60);
  static const _unexpected = Duration(seconds: 5);

  /// How long "Connected" stays up before the dialog closes itself.
  static const _connectedHold = Duration(milliseconds: 1500);

  /// After a link, how the group is watched: the phone pushes this computer to its other machines
  /// and they answer, so the list grows for a few seconds. Reported once it has not grown for
  /// [_groupSettle] — sooner when there is nobody else to wait for — and never later than
  /// [_groupWait]. Whoever is offline catches up on their own. Shorter than the CLI's (qrLink.ts):
  /// somebody is looking at this.
  static const _groupSettle = Duration(seconds: 6);
  static const _groupEmpty = Duration(seconds: 12);
  static const _groupWait = Duration(seconds: 30);

  /// How often the QR gets a new sign-in code. Shorter than the code's own
  /// life (90 s at the backend), so the one on screen always has at least
  /// half a minute left in it when a phone reads it.
  static const _signInRenew = Duration(seconds: 60);

  AppNotifier get app => widget.app;

  // Freeze the destination while a QR is visible, even if focus or inventory changes.
  late final String? _remoteMachineId = app.viewer == null
      ? null
      : app.ownedActionMachine?.machine.machineId;

  late final PhonePairCall _pair =
      widget.pair ??
      (_remoteMachineId != null
          ? phonePairOverRelay(app, _remoteMachineId)
          : phonePairOverDaemon(app.api));

  /// A fresh code each time the dialog opens, and a fresh one again after a
  /// scan that did not match — see [_loop].
  late String _code = newPhonePairCode();

  /// ONE token for the dialog's whole life: cancelling it is closing.
  final _cancel = CancelToken();
  bool _closed = false;
  bool _running = false;
  Timer? _timer;
  Completer<bool>? _sleeping;

  /// The sign-in code in the QR, once asked for. Null after asking is a QR
  /// without one: the phone then asks for an emailed code.
  String? _signIn;
  bool _signInAsked = false;

  /// The machine's identity fingerprint for the QR (`f`), asked once on open:
  /// from this computer's daemon, or — pairing a phone to a remote machine —
  /// the key this viewer pinned for it. The QR waits for the answer (or its
  /// absence), so it does not change under a phone mid-scan.
  String? _fingerprint;
  bool _fingerprintAsked = false;
  Timer? _signInTimer;

  /// The devices paired with this computer, newest first; null until the
  /// daemon answers, or when it cannot.
  List<PairedDevice>? _devices;
  bool _allDevices = false;
  final _removing = <String>{};

  /// How many devices show before "+ N more": the dialog is the QR and a
  /// line, and the list must not outweigh it.
  static const _devicesShown = 3;

  /// No pairing to be had from this daemon — asking stopped for good.
  bool _stopped = false;
  String? _connected;

  /// Watching the trust group after a link ([_watchGroup]).
  bool _syncing = false;

  /// The machines this computer reaches once the group settled, by name; null before.
  List<String>? _reaches;
  String? _message;

  /// A message that is an instruction to the person ("scan the new code"),
  /// which the next "no phone yet" must not wipe before they have read it.
  /// Everything else describes a condition, and goes when it does.
  bool _sticky = false;

  @override
  void initState() {
    super.initState();
    app.addListener(_appChanged);
    _syncLoop();
    unawaited(_renewSignIn());
    unawaited(_loadDevices());
    unawaited(_loadFingerprint());
  }

  Future<void> _loadFingerprint() async {
    String? found;
    try {
      found = await widget.machineFingerprint?.call(_remoteMachineId);
    } catch (_) {
      // Without it the QR still pairs; the phone just cannot cross-check the key.
    }
    if (!mounted) return;
    setState(() {
      _fingerprint = found;
      _fingerprintAsked = true;
    });
  }

  @override
  void dispose() {
    _closed = true;
    app.removeListener(_appChanged);
    _timer?.cancel();
    _signInTimer?.cancel();
    if (_sleeping case final sleeping? when !sleeping.isCompleted) {
      sleeping.complete(false);
    }
    // ⚠️ This only stops WAITING. A handshake the daemon has already started
    // runs to its end whatever happens here, and a phone that finishes it is
    // paired: the person scanned the code, which is the consent. What closing
    // does guarantee is that nothing arms the daemon again — the code dies
    // with the QR.
    _cancel.cancel('Add Phone closed');
    super.dispose();
  }

  void _appChanged() {
    if (_closed) return;
    setState(() {});
    _syncLoop();
  }

  /// Who and what the QR is for, or null while there is nothing to show yet.
  ///
  /// The machine is the one the phone will see in its own list: this
  /// computer's row, whose id is the backend's once someone is signed in (the
  /// daemon serves this computer under the account's `machineId` then — see
  /// `AppNotifier._followLocalMachineId`).
  ({String email, String machineId})? get _target {
    if (app.isGuest) return null;
    final email = app.currentUser?.email.trim();
    final machineId = app.viewer == null
        ? app.localMachineState?.machine.machineId
        : _remoteMachineId;
    // `CurrentUserProfile.local()` says "local terminal": not an address.
    if (email == null || !email.contains('@')) return null;
    if (machineId == null || machineId.isEmpty) return null;
    return (email: email, machineId: machineId);
  }

  bool get _asking => !_closed && !_stopped && _connected == null;

  /// Starts the loop when there is a QR worth arming and nothing is asking
  /// yet. Called again whenever the app changes, so a profile that loads
  /// after the dialog opened arms it then.
  void _syncLoop() {
    if (_running || !_asking || _target == null) return;
    _running = true;
    unawaited(_loop().whenComplete(() => _running = false));
  }

  Future<void> _loop() async {
    while (_asking && _target != null) {
      final code = _code;
      PhonePairAnswer answer;
      try {
        answer = await _pair(code, _cancel);
      } catch (error) {
        answer = PhonePairAnswer.failed('$error');
      }
      // A long poll can come back long after the dialog went — a handshake
      // that finished (or failed) behind a closed window must not touch it.
      if (_closed) return;
      if (answer.label case final label?) {
        setState(() {
          _connected = label;
          _message = null;
        });
        // The phone that just joined is on the list now.
        unawaited(_loadDevices());
        if (widget.groupMachines case final group?) {
          await _watchGroup(group);
          return; // Stays up to be read; Esc or Done closes it.
        }
        if (await _sleep(_connectedHold) && mounted) {
          Navigator.of(context).pop();
        }
        return;
      }
      final Duration wait;
      switch (answer.error) {
        // No phone yet, one whose minute ran out, or one mid-handshake with
        // somebody else. Ask again.
        case 'NO_INTENT' || 'EXPIRED' || 'BUSY':
          if (!_sticky && _message != null) setState(() => _message = null);
          wait = _poll;
        case 'CODE_MISMATCH':
          // The phone holds the old code and the daemon has spent it. A new
          // one — and a new QR — is the only way forward.
          _say("That didn't match. Scan the new code.", sticky: true);
          setState(() => _code = newPhonePairCode());
          wait = _poll;
        case 'RATE_LIMITED':
          _say('Too many tries. Wait a minute.');
          wait = _rateLimited;
        case 'BACKEND_DOWN':
          _say(
            app.viewer == null
                ? "This ${_thisComputer()} can't reach Harness right now."
                : 'The computer is offline. Reconnect it to add your phone.',
          );
          wait = _poll;
        // The phone started and went quiet, or said no. The QR is still
        // good: scanning it again starts over.
        case 'TIMEOUT':
          _say('Your phone stopped answering. Scan again.', sticky: true);
          wait = _poll;
        case 'CANCELLED':
          _say('Cancelled on your phone. Scan again.', sticky: true);
          wait = _poll;
        case PhonePairAnswer.unavailable:
          _say(
            app.viewer == null
                ? 'Update Harness on this ${_thisComputer()} to add a phone.'
                : 'Update Harness on the computer to add a phone.',
          );
          setState(() => _stopped = true);
          return;
        case final other:
          _say('Could not pair ($other). Trying again.');
          wait = _unexpected;
      }
      if (!await _sleep(wait)) return;
    }
  }

  /// Watches the trust group settle after a phone linked, then says which machines this computer
  /// now reaches — the other half of what the scan did.
  Future<void> _watchGroup(GroupMachinesCall group) async {
    setState(() => _syncing = true);
    // Time is counted in polls, not read off the clock: the waits are the polls.
    var elapsed = Duration.zero;
    var steady = Duration.zero;
    var machines = <({String machineId, String label})>[];
    while (true) {
      List<({String machineId, String label})>? next;
      try {
        next = await group();
      } catch (_) {
        next = null;
      }
      if (_closed) return;
      if (next != null && next.length != machines.length) {
        machines = next;
        steady = Duration.zero;
      }
      if (machines.isNotEmpty && steady >= _groupSettle) break;
      if (machines.isEmpty && elapsed >= _groupEmpty) break;
      if (elapsed >= _groupWait) break;
      if (!await _sleep(_poll)) return;
      elapsed += _poll;
      steady += _poll;
    }
    setState(() {
      _syncing = false;
      _reaches = [
        for (final m in machines)
          app.stateOf(m.machineId)?.machine.displayName ??
              (m.label.isNotEmpty ? m.label : m.machineId.substring(0, 8)),
      ];
    });
  }

  /// Ask for a sign-in code, put it in the QR, and ask again before it runs
  /// out — for as long as the QR is on screen. A failure is not retried
  /// sooner: the QR works without one, and the next renewal tries again.
  Future<void> _renewSignIn() async {
    ({String code, Duration ttl})? next;
    try {
      next = await widget.signInCode();
    } catch (_) {
      next = null;
    }
    if (_closed || !mounted) return;
    setState(() {
      _signIn = next?.code;
      _signInAsked = true;
    });
    if (_connected != null || _stopped) return;
    final ttl = next?.ttl;
    final wait = ttl != null && ttl - const Duration(seconds: 30) < _signInRenew
        ? ttl - const Duration(seconds: 30)
        : _signInRenew;
    _signInTimer = Timer(
      wait > Duration.zero ? wait : _signInRenew,
      () => unawaited(_renewSignIn()),
    );
  }

  Future<void> _loadDevices() async {
    final list = widget.listDevices;
    if (list == null) return;
    List<PairedDevice>? devices;
    try {
      devices = await list();
    } catch (_) {
      devices = null;
    }
    if (_closed || !mounted) return;
    setState(() => _devices = devices);
  }

  /// Takes [device]'s access away. One click, no confirmation: undoing it is
  /// scanning the QR above again, and a device that is not yours should be
  /// gone in one move.
  Future<void> _remove(PairedDevice device) async {
    final remove = widget.removeDevice;
    if (remove == null || _removing.contains(device.fingerprint)) return;
    setState(() => _removing.add(device.fingerprint));
    bool removed;
    try {
      removed = await remove(device.fingerprint);
    } catch (_) {
      removed = false;
    }
    if (_closed || !mounted) return;
    setState(() {
      _removing.remove(device.fingerprint);
      if (removed) {
        _devices = [
          for (final kept in _devices ?? const <PairedDevice>[])
            if (kept.fingerprint != device.fingerprint) kept,
        ];
      }
    });
    if (!removed) _say("Couldn't remove ${device.name}. Try again.");
  }

  void _say(String message, {bool sticky = false}) => setState(() {
    _message = message;
    _sticky = sticky;
  });

  /// A wait the dialog can cut short: true when it ran out, false when the
  /// dialog closed. `Future.delayed` cannot be cancelled, and a timer left
  /// behind by a closed dialog is one more wake-up for nothing.
  Future<bool> _sleep(Duration duration) {
    final done = Completer<bool>();
    _sleeping = done;
    _timer = Timer(duration, () {
      if (!done.isCompleted) done.complete(!_closed);
    });
    return done.future;
  }

  void _close() => Navigator.of(context).maybePop();

  TerminalTheme get _theme =>
      terminalThemeFor(grid.AppTheme.palette.value, terminalThemeStore.value);
  Color get _faint => _theme.foreground.withValues(alpha: .54);
  TextStyle _ink([Color? color]) =>
      terminalContentStyle(color: color ?? _theme.foreground);

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    // Live font and colour changes reach an open dialog too — see the dialog
    // guide, design/terminal-dialogs.md.
    return ListenableBuilder(
      listenable: Listenable.merge([
        terminalFontStore,
        terminalThemeStore,
        grid.AppTheme.palette,
      ]),
      builder: (context, _) => _dialog(context),
    );
  }

  Widget _dialog(BuildContext context) {
    // The grid: margins in whole character columns, spacing in whole rows.
    final cell = terminalCellSizeOf(context);
    final margin = cell.width * 2;
    final row = cell.height;
    // The window is the QR and one line: 240 points — a phone camera reads that
    // from across a desk — in a whole number of rows, so the line under it stays
    // on the grid, and the window just wider than the code.
    final qrSide = (240 / row).ceil() * row;
    final width = math.min(
      qrSide + margin * 4,
      MediaQuery.sizeOf(context).width - 32,
    );
    return TerminalPromptKeys(
      cancel: _close,
      child: Dialog(
        insetPadding: const EdgeInsets.all(16),
        elevation: 0,
        backgroundColor: Colors.transparent,
        child: SizedBox(
          width: width,
          child: Material(
            elevation: 0,
            color: _theme.background,
            surfaceTintColor: Colors.transparent,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(kTerminalCornerRadius),
              side: terminalPaneBorder(focused: true),
            ),
            clipBehavior: Clip.antiAlias,
            child: DefaultTextStyle.merge(
              style: _ink(),
              child: SingleChildScrollView(
                padding: EdgeInsets.fromLTRB(margin, row, margin, row),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      'Add your phone',
                      textAlign: TextAlign.center,
                      style: _ink(),
                    ),
                    SizedBox(height: row),
                    ..._body(qrSide, row),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _body(double qrSide, double row) {
    if (app.isGuest) {
      return [Text('Sign in to add your phone.', style: _ink())];
    }
    final target = _target;
    if (target == null) {
      if (app.viewer != null && app.currentUser?.email.contains('@') == true) {
        return [
          Text('Connect a computer to add your phone.', style: _ink()),
          if (widget.onConnectMachine case final connect?) ...[
            SizedBox(height: row),
            TerminalTextAction(
              label: 'Connect a machine',
              onPressed: () {
                Navigator.of(context).pop();
                connect();
              },
            ),
          ],
        ];
      }
      return [
        Text(
          app.currentUser?.email.contains('@') == true
              ? 'Waiting for Harness on this ${_thisComputer()}…'
              : 'Waiting for your account…',
          style: _ink(_faint),
        ),
      ];
    }
    // A moment's wait for the sign-in code, in the QR's own space: a QR that
    // changed right after it appeared would be one scanned without it.
    if (!_signInAsked || !_fingerprintAsked) {
      return [SizedBox(height: qrSide + row * 2)];
    }
    final link = phonePairLink(
      email: target.email,
      machineId: target.machineId,
      code: _code,
      signIn: _signIn,
      fingerprint: _fingerprint,
      // Beside the fingerprint, and only where the app asks for one: the
      // phone's confirm screen names the machine by it.
      hostname: widget.machineFingerprint == null
          ? null
          : _remoteMachineId != null
          ? app.stateOf(_remoteMachineId)?.machine.hostname
          : localHostnameOrNull(),
    ).toString();
    return [
      Center(
        // Dimmed once it has done its job, so nobody scans a spent code.
        child: Opacity(
          opacity: _connected == null && !_stopped ? 1 : .25,
          child: PhonePairQr(data: link, side: qrSide),
        ),
      ),
      SizedBox(height: row),
      if (_remoteMachineId case final machineId?) ...[
        Text(
          app.stateOf(machineId)?.machine.displayName ?? 'Computer',
          textAlign: TextAlign.center,
          style: _ink(_faint),
        ),
        SizedBox(height: row),
      ],
      // One line, and it is the status too: what to do, then that it worked.
      // The phone's own screen says the rest (Yes — scan to connect).
      _status(),
      ..._groupLines(row),
      ..._devicesList(row),
    ];
  }

  /// Under "Connected": the trust group the phone brought — being added to it, then who this
  /// computer reaches — and a way out once there is nothing left to wait for.
  List<Widget> _groupLines(double row) {
    if (_connected == null || widget.groupMachines == null) return const [];
    final reaches = _reaches;
    final String text;
    if (_syncing || reaches == null) {
      text = 'Adding this ${_thisComputer()} to your devices…';
    } else if (reaches.isEmpty) {
      text = 'Computers you link later reach it too.';
    } else {
      text =
          'Reaches ${reaches.length} '
          '${reaches.length == 1 ? 'machine' : 'machines'}: ${reaches.join(' · ')}';
    }
    return [
      Semantics(
        liveRegion: true,
        child: Text(
          text,
          key: const ValueKey('add-phone-group'),
          textAlign: TextAlign.center,
          style: _ink(reaches == null ? _faint : null),
        ),
      ),
      if (reaches != null) ...[
        SizedBox(height: row),
        Center(
          child: TerminalTextAction(
            key: const ValueKey('add-phone-done'),
            label: 'Done',
            onPressed: _close,
          ),
        ),
      ],
    ];
  }

  /// Who can already reach this computer, with a way to take it back: the
  /// safety net for a QR somebody else scanned.
  List<Widget> _devicesList(double row) {
    final devices = _devices;
    if (devices == null || devices.isEmpty) return const [];
    final shown = _allDevices ? devices : devices.take(_devicesShown).toList();
    final more = devices.length - shown.length;
    return [
      SizedBox(height: row),
      Text(
        'Paired with this ${_thisComputer()}',
        key: const ValueKey('add-phone-devices'),
        style: _ink(_faint),
      ),
      for (final device in shown) _deviceRow(device),
      if (more > 0)
        Align(
          alignment: Alignment.centerLeft,
          child: TerminalTextAction(
            key: const ValueKey('add-phone-more-devices'),
            label: '+ $more more',
            padding: EdgeInsets.zero,
            onPressed: () => setState(() => _allDevices = true),
          ),
        ),
    ];
  }

  Widget _deviceRow(PairedDevice device) {
    final removing = _removing.contains(device.fingerprint);
    return Row(
      key: ValueKey('add-phone-device-${device.fingerprint}'),
      children: [
        Expanded(
          child: Text(
            device.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: _ink(),
          ),
        ),
        Text(
          device.online ? 'online' : _pairedAgo(device.pairedAt),
          style: _ink(device.online ? _theme.green : _faint),
        ),
        TerminalTextAction(
          label: removing ? 'removing…' : 'remove',
          onPressed: removing || widget.removeDevice == null
              ? null
              : () => unawaited(_remove(device)),
        ),
      ],
    );
  }

  Widget _status() {
    final connected = _connected;
    final (text, color) = connected != null
        ? ('✓ Connected $connected', _theme.green)
        : _message != null
        ? (_message!, _theme.red)
        : ('Scan with Harness on your iPhone', _faint);
    return Semantics(
      liveRegion: true,
      child: Text(
        text,
        key: const ValueKey('add-phone-status'),
        textAlign: TextAlign.center,
        style: _ink(color),
      ),
    );
  }
}

/// How long ago [at] was, in one short word: `now`, `5m`, `3h`, `2d`, `6w`.
String _pairedAgo(DateTime at) {
  final ago = DateTime.now().difference(at);
  if (ago.inMinutes < 1) return 'now';
  if (ago.inHours < 1) return '${ago.inMinutes}m';
  if (ago.inDays < 1) return '${ago.inHours}h';
  if (ago.inDays < 14) return '${ago.inDays}d';
  return '${ago.inDays ~/ 7}w';
}

/// "Mac" where the menu says Harness ▸ Add Phone…; the command palette also
/// reaches this dialog on Linux, where "this Mac" would be wrong.
String _thisComputer() =>
    defaultTargetPlatform == TargetPlatform.macOS ? 'Mac' : 'computer';

/// [data] as a QR code: dark modules on a white square with its quiet zone.
///
/// ⚠️ White and black whatever the theme. A dark-mode QR — light modules on a
/// dark field — is one many phone cameras will not read, and the four-module
/// white margin (the "quiet zone") is part of the code, not decoration: it is
/// how a scanner finds the edges. So the white square stays, on every palette.
class PhonePairQr extends StatelessWidget {
  const PhonePairQr({super.key, required this.data, required this.side});

  /// What the code says — the whole link, secret included.
  final String data;
  final double side;

  static const _quietModules = 4;

  // One entry: the dialog rebuilds on every font or palette change, and
  // choosing the best of eight mask patterns is not free.
  static (String, QrImage)? _cached;

  static QrImage _imageOf(String data) {
    if (_cached case (final cachedData, final image) when cachedData == data) {
      return image;
    }
    final image = QrImage(
      QrCode.fromData(data: data, errorCorrectLevel: QrErrorCorrectLevel.M),
    );
    _cached = (data, image);
    return image;
  }

  @override
  Widget build(BuildContext context) {
    final image = _imageOf(data);
    final module = side / (image.moduleCount + _quietModules * 2);
    return Semantics(
      image: true,
      label: 'QR code to add your phone',
      child: Container(
        width: side,
        height: side,
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(module * 2),
        ),
        child: CustomPaint(painter: _QrPainter(image, data)),
      ),
    );
  }
}

class _QrPainter extends CustomPainter {
  _QrPainter(this.image, this.data);

  final QrImage image;
  final String data;

  @override
  void paint(Canvas canvas, Size size) {
    final count = image.moduleCount;
    final total = count + PhonePairQr._quietModules * 2;
    // Snapped to half a point — a whole device pixel on a Retina screen — so
    // neighbouring modules meet exactly instead of leaving hairline seams.
    final module = (size.shortestSide / total * 2).floorToDouble() / 2;
    final origin = Offset(
      (size.width - module * count) / 2,
      (size.height - module * count) / 2,
    );
    final path = Path();
    for (var y = 0; y < count; y++) {
      for (var x = 0; x < count; x++) {
        if (!image.isDark(y, x)) continue;
        path.addRect(
          Rect.fromLTWH(
            origin.dx + x * module,
            origin.dy + y * module,
            module,
            module,
          ),
        );
      }
    }
    canvas.drawPath(
      path,
      Paint()
        ..color = Colors.black
        ..isAntiAlias = false,
    );
  }

  @override
  bool shouldRepaint(_QrPainter oldDelegate) => oldDelegate.data != data;
}
