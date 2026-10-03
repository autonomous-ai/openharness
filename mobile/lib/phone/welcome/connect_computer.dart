import '../approve_sign_in.dart';
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import '../tty.dart';
import '../tty_controls.dart';
import 'scan_to_connect.dart';
import 'set_up_computer.dart';

/// Setting up a computer, for a phone that is signed in — the same page as the first screen's "Not
/// yet" ([SetUpComputerPage]: the website's download menu, sent to the computer), and the one thing
/// only a signed-in phone can do on it: watch for the computer to appear (every few seconds, since
/// nothing tells the phone) and pair with it by the code its Harness ▸ Add Phone… shows.
///
/// ```
/// Get Harness for
/// your computer
/// [| Signed in as ada@… Waiting for your computer…]
///
/// Send it to your computer:   (the download menu)
/// …
/// Then open it, and scan the code it shows.
/// Scan to connect ›
/// See how it works ▶
/// Try the sample while you wait
/// ```
///
/// It replaces a page of its own — an email of the steps, a Terminal/Mac tab, four commands to
/// copy — that told a newcomer the same thing a second way, with `harness login` and a phone
/// password the QR has since made unnecessary.
class ConnectComputerPage extends StatefulWidget {
  const ConnectComputerPage({
    super.key,
    required this.notifier,
    this.signedIn = true,
    this.onBack,
    this.onTrySample,
    this.scanCamera,
    this.loadDownloads,
  });

  final AppNotifier notifier;

  /// Watch for the computer and say whose account it must be signed in to.
  final bool signedIn;

  /// Shown as `‹ Back` when set.
  final VoidCallback? onBack;

  /// Opens the sample; see `PhoneWelcome.onTrySample`.
  final Future<Object?> Function(BuildContext context)? onTrySample;

  /// Stand-ins for the camera and the release manifest, in tests.
  final Widget? scanCamera;
  final DesktopDownloadsLoader? loadDownloads;

  @override
  State<ConnectComputerPage> createState() => _ConnectComputerPageState();
}

class _ConnectComputerPageState extends State<ConnectComputerPage> {
  Timer? _watch;

  /// What the last scan came to, while it is worth saying: pairing, or why it did not.
  String? _scanned;
  bool _scanFailed = false;

  @override
  void initState() {
    super.initState();
    if (widget.signedIn) {
      // Nothing pushes a new machine to the phone: ask again every few seconds while this is up.
      _watch = Timer.periodic(const Duration(seconds: 5), (_) {
        if (mounted) unawaited(widget.notifier.refreshMachines());
      });
    }
  }

  @override
  void dispose() {
    _watch?.cancel();
    super.dispose();
  }

  void _say(String? message, {bool failed = false}) => setState(() {
    _scanned = message;
    _scanFailed = failed;
  });

  /// The code the new computer's Add Phone shows: the phone pairs with it there and then. The
  /// computer is asked for first — it may have joined the account a moment ago, too recently for
  /// the list the phone holds.
  Future<void> _scanToPair() async {
    final code = await scanForCode(
      context,
      fallbackLabel: 'Not now',
      camera: widget.scanCamera,
      // The computer may be showing its sign-in QR instead: approving that signs it in, which is
      // what setting it up needs anyway.
      onSignInCode: (code) => unawaited(approveComputerSignIn(context, widget.notifier, code)),
    );
    if (!mounted || code == null) return;
    final machineId = code.machineId, pairCode = code.pairCode;
    if (machineId == null || pairCode == null) {
      _say(
        "That code can't pair a computer. Scan the one in Harness ▸ Add Phone….",
        failed: true,
      );
      return;
    }
    _say('Pairing…');
    if (!widget.notifier.machineStates.containsKey(machineId)) {
      // Bounded: a slow network is a reason to say so, not to leave "Pairing…" up for good.
      try {
        await widget.notifier.refreshMachines().timeout(
          const Duration(seconds: 5),
          onTimeout: () {},
        );
      } catch (_) {
        // ⚠️ A list that could not be read says nothing about whether the computer is on the
        // account, so it is not "isn't on your account" — and thrown on from here, it left
        // "Pairing…" up for good.
        if (!mounted) return;
        _say(
          "Couldn't reach your account. Check your connection and scan again.",
          failed: true,
        );
        return;
      }
    }
    if (!mounted) return;
    if (!widget.notifier.machineStates.containsKey(machineId)) {
      _say(
        "That computer isn't on your account. Sign in to Harness on it "
        'with ${widget.notifier.currentUser?.email ?? 'this account'}.',
        failed: true,
      );
      return;
    }
    final error = await widget.notifier.connectWithCode(machineId, pairCode);
    if (!mounted) return;
    if (error == null) {
      HapticFeedback.mediumImpact();
      _say(null);
      // From Computers, the list it came from has the computer now; at home, the shell moves on
      // by itself once a computer is ready.
      if (widget.onBack case final back?) back();
    } else {
      HapticFeedback.heavyImpact();
      _say(error, failed: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final email = widget.notifier.currentUser?.email;
    final scanned = _scanned;
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        child: SetUpComputerPage(
          onBack: widget.onBack,
          onScan: () => unawaited(_scanToPair()),
          loadDownloads: widget.loadDownloads,
          status: widget.signedIn || scanned != null
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (widget.signedIn) _Watching(account: email),
                    if (scanned != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 10),
                        child: Text(
                          _scanFailed ? '✗ $scanned' : scanned,
                          key: const ValueKey('connect-scan-status'),
                          style: tty.style(
                            size: TtySize.meta,
                            color: _scanFailed ? tty.red : tty.faint,
                          ),
                        ),
                      ),
                  ],
                )
              : null,
          onTrySample: widget.onTrySample == null
              ? null
              : () => unawaited(widget.onTrySample!(context)),
        ),
      ),
    );
  }
}

/// `Looking for your computer…` with a terminal spinner — the page is watching.
class _Watching extends StatefulWidget {
  const _Watching({this.account});

  /// Whose computer it is waiting for.
  final String? account;

  @override
  State<_Watching> createState() => _WatchingState();
}

class _WatchingState extends State<_Watching> {
  // The terminal's oldest spinner — every monospace face has these four.
  static const _frames = ['|', '/', '-', r'\'];
  int _frame = 0;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(milliseconds: 150), (_) {
      if (mounted) setState(() => _frame = (_frame + 1) % _frames.length);
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: ttyRaised(tty),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        children: [
          TtyText(_frames[_frame], color: tty.green, size: TtySize.row),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              widget.account == null
                  ? 'Waiting for your computer…'
                  : 'Signed in as ${widget.account}. Waiting for your '
                        'computer…',
              style: tty.style(size: TtySize.meta, color: tty.text),
            ),
          ),
        ],
      ),
    );
  }
}
