import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../api/api_client.dart' show MachineSignInRequest;
import '../viewer/connect_code.dart';
import '../viewer/direct_link.dart' show sameFingerprint;
import '../viewer/qr_scanner.dart';
import 'box_chrome.dart';
import 'terminal_text_action.dart';

/// **Add this machine?** — a machine's QR (`harness link qr`, or Add Phone), opened in this browser
/// by the phone's camera or scanned in the app: what the code is for, then the one-time-code pairing
/// and the trust group once the person approves. Viewer builds (web) only.
///
/// ```
/// Add this machine?
/// machine-remote-2 · online
/// fingerprint  5F80·61C4·6142·ADCF   ← check it matches the machine's screen
/// account      dee@autonomous.ai
///                                   Approve   Cancel
/// ```
Future<void> showAddMachineDialog(
  BuildContext context,
  AppNotifier notifier,
  ConnectCode code, {
  bool expired = false,
  bool wrongMachine = false,
}) => showAppDialog<void>(
  context: context,
  builder: (context) => Dialog(
    alignment: Alignment.topCenter,
    backgroundColor: Colors.transparent,
    elevation: 0,
    insetPadding: const EdgeInsets.fromLTRB(16, 56, 16, 18),
    child: AddMachineDialog(
      notifier: notifier,
      code: code,
      expired: expired,
      wrongMachine: wrongMachine,
      onClose: () => Navigator.of(context).pop(),
    ),
  ),
);

/// The in-app camera (`viewer/qr_scanner.dart`), then **Add this machine?** for what it read.
/// [machineId], from a locked machine's own row, refuses a code for a different machine.
Future<void> scanToAddMachine(
  BuildContext context,
  AppNotifier notifier, {
  String? machineId,
}) async {
  final raw = await scanQrCode(
    context,
    accept: (text) => ConnectCode.parse(text) != null,
  );
  if (raw == null || !context.mounted) return;
  final code = ConnectCode.parse(raw)!;
  await showAddMachineDialog(
    context,
    notifier,
    code,
    wrongMachine: machineId != null && code.machineId != machineId,
  );
}

/// Why a code cannot add a machine for this browser, or null when it can be asked about.
String? addMachineRefusal(ConnectCode code, String? signedInEmail) {
  if (code.pairCode == null || (code.machineId == null && !code.isSignIn)) {
    return "That code can't add a machine. On the machine, run "
        '`harness link qr` (or Add Phone in the desktop app) and scan that.';
  }
  final me = signedInEmail?.trim();
  if (me != null &&
      me.contains('@') &&
      code.email.isNotEmpty &&
      code.email.toLowerCase() != me.toLowerCase()) {
    return 'Signed in as $me, but this code is for ${code.email}. '
        'Sign in as ${code.email} to add it.';
  }
  return null;
}

/// `5F8061C46142ADCF` as the machine prints it: `5F80·61C4·6142·ADCF`.
String spacedFingerprint(String fingerprint) {
  final plain = fingerprint.toUpperCase().replaceAll(RegExp('[^0-9A-Z]'), '');
  return [
    for (var i = 0; i < plain.length; i += 4)
      plain.substring(i, i + 4 > plain.length ? plain.length : i + 4),
  ].join('·');
}

enum _Phase { confirm, finding, lookingUp, approving, linking, done, failed }

class AddMachineDialog extends StatefulWidget {
  const AddMachineDialog({
    super.key,
    required this.notifier,
    required this.code,
    required this.onClose,
    this.expired = false,
    this.wrongMachine = false,
  });

  final AppNotifier notifier;
  final ConnectCode code;
  final VoidCallback onClose;

  /// The code waited too long (a sign-in, say): nothing to approve, scan the QR again.
  final bool expired;

  /// Scanned from a locked machine's row, but the code names another machine.
  final bool wrongMachine;

  @override
  State<AddMachineDialog> createState() => _AddMachineDialogState();
}

class _AddMachineDialogState extends State<AddMachineDialog> {
  _Phase _phase = _Phase.confirm;
  String? _message;

  AppNotifier get _app => widget.notifier;

  /// The machine's id: the code's own, or — a machine asking to be signed in — what approving bound.
  String? _approvedMachineId;
  String get _machineId => widget.code.machineId ?? _approvedMachineId ?? '';

  /// A machine asking to be signed in (`harness login`'s QR), and what the server says it is.
  bool get _signIn => widget.code.isSignIn;
  MachineSignInRequest? _request;

  /// A BROWSER asking to be signed in (the web sign-in page's QR, `k=v`), rather than a machine.
  bool get _browser => widget.code.isViewerSignIn;

  /// After a sign-in's approval: how many machines it will reach.
  int? _reaches;

  @override
  void initState() {
    super.initState();
    final refusal = widget.expired
        ? "This code expired. Scan the machine's QR again — it shows a fresh one."
        : widget.wrongMachine
        ? "That code is for another machine. Scan the one on this machine's screen."
        : addMachineRefusal(widget.code, _app.currentUser?.email);
    if (refusal != null) {
      _phase = _Phase.failed;
      _message = refusal;
    } else if (_signIn) {
      _phase = _Phase.lookingUp;
      unawaited(_lookUp());
    } else if (_app.stateOf(_machineId) == null) {
      // Signed in a moment ago, or the machine joined the account a moment ago: ask for the list
      // once before saying it isn't there.
      _phase = _Phase.finding;
      unawaited(_find());
    }
  }

  Future<void> _find() async {
    try {
      await _app.refreshMachines().timeout(const Duration(seconds: 6));
    } catch (_) {}
    if (!mounted) return;
    setState(() {
      if (_app.stateOf(_machineId) == null) {
        _phase = _Phase.failed;
        _message =
            "That machine isn't on your account. Sign in to Harness on it "
            'with ${_app.currentUser?.email ?? 'this account'}.';
      } else {
        _phase = _Phase.confirm;
      }
    });
  }

  Future<void> _lookUp() async {
    MachineSignInRequest? request;
    String? problem;
    try {
      request = await _app.api.lookupMachineSignIn(widget.code.signInRequest!);
      final qr = widget.code.fingerprint, server = request.fingerprint;
      // The server's copy must be the QR's: otherwise the code on screen is not the request here.
      if (qr != null && server != null && !sameFingerprint(qr, server)) {
        problem = "That code doesn't match the machine's sign-in request. Nothing was approved.";
      }
    } catch (_) {
      problem =
          "That code expired or was already used. Scan the machine's new one.";
    }
    if (!mounted) return;
    setState(() {
      _request = request;
      _phase = problem == null ? _Phase.confirm : _Phase.failed;
      _message = problem;
    });
  }

  /// A sign-in QR — a browser's or a machine's: sign it in and bring it into this device's group.
  /// The two exchange keys in the approval itself; neither dials the other ([AppNotifier.approveSignInByQr]).
  Future<void> _approveByQr() async {
    final pub = _request?.pub;
    if (pub == null) {
      setState(() {
        _phase = _Phase.failed;
        _message = _browser
            ? "That browser's sign-in page is too old to be added. Reload it and scan again."
            : 'That machine runs an older Harness. Update it (harness update) and scan again.';
      });
      return;
    }
    setState(() => _phase = _Phase.approving);
    final out = await _app.approveSignInByQr(
      userCode: widget.code.signInRequest!,
      code: widget.code.pairCode!,
      pub: pub,
      label:
          _request?.label ??
          widget.code.hostname ??
          (_browser ? 'browser' : 'computer'),
      qrFingerprint: widget.code.fingerprint,
      machine: !_browser,
    );
    if (!mounted) return;
    setState(() {
      if (out.error == null) {
        _phase = _Phase.done;
        _reaches = out.machines;
        _approvedMachineId = out.machineId;
      } else {
        _phase = _Phase.failed;
        _message = out.error == 'FINGERPRINT'
            ? "Its key doesn't match its code. Nothing was approved."
            : "Couldn't approve it — the code may have expired. Scan the new one.";
      }
    });
  }

  Future<void> _notMe() async {
    try {
      await _app.api.denyMachineSignIn(widget.code.signInRequest!);
    } catch (_) {
      // It dies in minutes anyway.
    }
    if (!mounted) return;
    setState(() {
      _phase = _Phase.failed;
      _message = _browser
          ? 'Declined. That browser was not signed in.'
          : 'Declined. That machine was not signed in.';
    });
  }

  Future<void> _approve() async {
    if (_signIn) return _approveByQr();
    setState(() => _phase = _Phase.linking);
    final error = await _app.connectWithCode(
      _machineId,
      widget.code.pairCode!,
      expectedFingerprint: widget.code.fingerprint,
    );
    if (!mounted) return;
    setState(() {
      _phase = error == null ? _Phase.done : _Phase.failed;
      _message = error;
    });
  }

  KeyEventResult _key(FocusNode _, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    if (event.logicalKey == LogicalKeyboardKey.escape) {
      widget.onClose();
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.enter &&
        _phase == _Phase.confirm) {
      unawaited(_approve());
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    final state = _app.stateOf(_machineId);
    final name = _browser
        ? (_request?.label ?? widget.code.hostname ?? 'A browser')
        : state?.machine.displayName ??
              widget.code.hostname ??
              _request?.label ??
              'This machine';
    final host = widget.code.hostname;
    final online = state?.nodeOnline;
    final others = _app.machineStates.values
        .where((s) => s.machine.machineId != _machineId && !s.needsLink)
        .length;
    final fp = widget.code.fingerprint;
    return Focus(
      autofocus: true,
      onKeyEvent: _key,
      child: SizedBox(
        width: 460,
        child: TerminalBox(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  switch (_phase) {
                    _Phase.done when _browser => 'Browser signed in',
                    _Phase.failed when _browser =>
                      'Couldn’t sign in the browser',
                    _ when _browser => 'Sign in this browser?',
                    _Phase.done => 'Machine added',
                    _Phase.failed => 'Couldn’t add the machine',
                    _ when _signIn => 'Sign in & add machine?',
                    _ => 'Add this machine?',
                  },
                  key: const Key('add-machine-title'),
                  style: boxMonoStyle(color: kBoxFaint),
                ),
                const SizedBox(height: 12),
                Text(name, style: boxMonoStyle(weight: FontWeight.w600)),
                if (host != null && host != name && !_browser)
                  Text(host, style: boxMonoStyle(color: kBoxFaint)),
                if (_phase != _Phase.failed && state != null)
                  Text(
                    switch (online) {
                      true => 'online',
                      false => 'offline — start Harness on it',
                      null => 'status unknown',
                    },
                    style: boxMonoStyle(
                      color: online == true ? Colors.greenAccent : kBoxFaint,
                    ),
                  ),
                if (fp != null && _phase != _Phase.failed) ...[
                  const SizedBox(height: 12),
                  Text(
                    'fingerprint  ${spacedFingerprint(fp)}',
                    key: const Key('add-machine-fingerprint'),
                    style: boxMonoStyle(),
                  ),
                  Text(
                    _browser
                        ? "Check it matches the browser's screen."
                        : "Check it matches the machine's screen.",
                    style: boxMonoStyle(color: kBoxFaint),
                  ),
                ],
                if (_app.currentUser?.email case final email?
                    when _phase == _Phase.confirm) ...[
                  const SizedBox(height: 8),
                  Text(
                    _signIn ? 'signs in as  $email' : 'account      $email',
                    style: boxMonoStyle(),
                  ),
                ],
                if (_signIn && _phase == _Phase.confirm) ...[
                  if (_request?.country case final country?)
                    Text(
                      'requested from $country',
                      style: boxMonoStyle(color: kBoxFaint),
                    ),
                  const SizedBox(height: 6),
                  Text(
                    _browser
                        ? 'Only approve a browser you are using right now — '
                              'it gets your account and your machines.'
                        : 'Only approve a machine you are setting up right now.',
                    key: const Key('add-machine-warning'),
                    style: boxMonoStyle(color: Colors.amberAccent),
                  ),
                ],
                const SizedBox(height: 12),
                Text(
                  switch (_phase) {
                    _Phase.confirm when _browser => 'It joins your devices and reaches your machines — no password.',
                    _Phase.approving when _browser =>
                      'Signing it in and adding it to your devices…',
                    _Phase.done when _browser =>
                      _reaches == 0
                          ? '$name is signed in. Machines you link later reach it too.'
                          : '$name is signed in and reaches your $_reaches '
                                'machine${_reaches == 1 ? '' : 's'}.',
                    _Phase.confirm =>
                      others == 0
                          ? 'This browser will reach it without a password.'
                          : 'It will reach, and be reached by, your $others other '
                                'machine${others == 1 ? '' : 's'} — no password.',
                    _Phase.finding => 'Looking for it on your account…',
                    _Phase.lookingUp => 'Reading the code…',
                    _Phase.approving =>
                      'Signing it in and adding it to your devices…',
                    _Phase.linking => 'Linking · adding it to your devices…',
                    _Phase.done when _signIn && (_reaches ?? 0) == 0 =>
                      '$name is signed in. Machines you link later reach it too.',
                    _Phase.done when _signIn =>
                      '$name is signed in and reaches your $_reaches '
                          'machine${_reaches == 1 ? '' : 's'}, and they reach it.',
                    _Phase.done =>
                      '$name reaches your other machines, and they reach it.',
                    _Phase.failed => _message ?? 'Try scanning its code again.',
                  },
                  key: const Key('add-machine-status'),
                  style: boxMonoStyle(
                    color: _phase == _Phase.failed
                        ? Colors.redAccent
                        : Colors.white70,
                  ),
                ),
                const SizedBox(height: 14),
                // Wraps on a phone-width screen rather than overflowing: three actions for a
                // sign-in (Not me, Approve, Cancel) do not fit a narrow line in a mono face.
                Wrap(
                  alignment: WrapAlignment.end,
                  spacing: 12,
                  runSpacing: 8,
                  children: [
                    if (_phase == _Phase.confirm) ...[
                      if (_signIn) ...[
                        TerminalTextAction(
                          key: const Key('add-machine-not-me'),
                          label: 'Not me',
                          onPressed: () => unawaited(_notMe()),
                        ),
                      ],
                      TerminalTextAction(
                        key: const Key('add-machine-approve'),
                        label: 'Approve',
                        onPressed: () => unawaited(_approve()),
                      ),
                    ],
                    TerminalTextAction(
                      key: const Key('add-machine-close'),
                      label: switch (_phase) {
                        _Phase.done => 'Done',
                        _Phase.linking || _Phase.approving => 'Hide',
                        _ => 'Cancel',
                      },
                      onPressed: widget.onClose,
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
