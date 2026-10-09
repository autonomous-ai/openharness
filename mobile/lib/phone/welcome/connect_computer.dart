import '../approve_sign_in.dart';

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import '../phone_navigation.dart' show phoneRoute;
import '../settings_page.dart' show PhoneSettingsButton, confirmSignOut;
import '../tty.dart';
import '../tty_controls.dart';
import 'scan_to_connect.dart';
import 'set_up_computer.dart';

/// Connecting a computer, for a phone that is signed in — the same page as the first screen
/// ([SetUpComputerPage], Connect your computer, with Get it behind it), and the one thing only a
/// signed-in phone can do on it: watch for the computer to appear (every few seconds, since nothing
/// tells the phone) and pair with it by the code its Add Phone shows.
///
/// ```
/// harness▌                                      ⚙
///           Connect your computer
///   Drive Claude Code and Codex from your phone.
/// [| Signed in as ada@… Waiting for your computer…]
/// Not you? Sign out
///          [ ⊞  Pair computer ]
/// HOW IT WORKS
/// [1] Sign in on your computer
///     With the same account.
/// [2] Not showing up? Scan its code
///     Mac: Harness menu · Linux: Ctrl+Shift+P, “add phone”
/// [3] You’re connected
///        No Harness yet? Get it ›     (and the sample, while it installs)
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
  });

  final AppNotifier notifier;

  /// Watch for the computer and say whose account it must be signed in to.
  final bool signedIn;

  /// Shown as `‹ Back` when set.
  final VoidCallback? onBack;

  /// Opens the sample, from Get it; see `PhoneWelcome.onTrySample`.
  final Future<Object?> Function(BuildContext context)? onTrySample;

  /// Stands in for the camera, in tests.
  final Widget? scanCamera;

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
      // A request that fails (offline for a moment) is simply asked again on the next tick — and
      // caught here, where it used to reach the zone as an unhandled error every 5 seconds.
      _watch = Timer.periodic(const Duration(seconds: 5), (_) {
        if (!mounted) return;
        unawaited(widget.notifier.refreshMachines().catchError((Object _) {}));
      });
    }
  }

  /// Get it, while it is up over this page — see [_openGetIt].
  Route<void>? _getIt;

  @override
  void dispose() {
    _watch?.cancel();
    // ⚠️ At home this page goes when the computer turns up — the 5-second watch — and Get it, pushed
    // over it, stayed up over the agents. Taken away after this frame: a navigator is not to be
    // changed while the tree is being torn down.
    final getIt = _getIt;
    if (getIt != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final navigator = getIt.navigator;
        if (navigator != null && navigator.mounted && getIt.isActive) {
          navigator.removeRoute(getIt);
        }
      });
    }
    super.dispose();
  }

  /// "No Harness on your computer yet? Get it ›": the download sent to the computer, over this
  /// page, and its "Pair computer ›" back to this page's scan. One at a time.
  void _openGetIt() {
    if (_getIt != null) return;
    final route = phoneRoute(
      (page) => Scaffold(
        backgroundColor: Tty.of(page).ground,
        body: SafeArea(
          child: GetHarnessPage(
            onBack: () => Navigator.of(page).maybePop(),
            onPair: () {
              // ⚠️ `pop`, not `maybePop`: that one waits a microtask, sees the camera pushed over
              // Get it meanwhile, and drops the pop — Get it stayed under the camera, and the scan's
              // answer (or Computers' back on success) landed on it instead of this page.
              Navigator.of(page).pop();
              if (mounted) unawaited(_scanToPair());
            },
            // Over Get it, which its end card's "set up" comes back to.
            onTrySample: widget.onTrySample == null
                ? null
                : () => unawaited(widget.onTrySample!(page)),
          ),
        ),
      ),
    );
    _getIt = route;
    unawaited(
      Navigator.of(context).push(route).whenComplete(() => _getIt = null),
    );
  }

  void _say(String? message, {bool failed = false}) => setState(() {
    _scanned = message;
    _scanFailed = failed;
  });

  /// A scan under way, from the camera to its answer: a second press of "Scan to connect" while
  /// one is still being looked up or paired is not a second pairing by the same one-time code.
  bool _scanning = false;

  /// How long the account gets to say whether it has the scanned computer before the page says it
  /// is still looking — and goes on looking ([_lookUp]).
  static const _lookUpPatience = Duration(seconds: 5);

  Future<void> _scanToPair() async {
    if (_scanning) return;
    _scanning = true;
    try {
      await _scanAndPair();
    } finally {
      _scanning = false;
    }
  }

  /// The code the new computer's Add Phone shows: the phone pairs with it. The computer is asked
  /// for first — it may have joined the account a moment ago, too recently for the list the phone
  /// holds.
  ///
  /// ⚠️ **At home, the home screen pairs, not this page.** Here this page is up only while the
  /// account has no computer, so the computer the code is for turning up — in the 5-second watch
  /// while the camera was open, or in the look-up below, which is what most often brings it —
  /// takes the page away. A page still pairing then lost its answer: a code that failed showed
  /// nothing, and "Scan its code" on the screen that replaced it started a second pairing while the
  /// first ran (PAIRING_BUSY). So the code goes to the home screen ([AppNotifier.holdPendingPairing])
  /// the moment the computer is known, and its pairing page pairs by it and says how it went —
  /// the way a code scanned at sign-in is paired. Pushed from Computers, which nothing takes away,
  /// the page pairs itself, and goes back on success. Gone either way, it hands the code over.
  Future<void> _scanAndPair() async {
    // Read before the camera: once this page is gone, its widget is not to be reached through.
    final notifier = widget.notifier;
    final atHome = widget.onBack == null;
    // ⚠️ Where an approval is asked from if this page is gone by the time the camera hands back a
    // computer's sign-in code — taken away under it, at home, by a computer turning up. Its own
    // context then reads as unmounted (it threw, and the approval was dropped); the root
    // navigator's outlives any one page, and the approval's dialog stands on it anyway.
    final approveFrom = Navigator.of(context, rootNavigator: true).context;
    final code = await scanForCode(
      context,
      fallbackLabel: 'Not now',
      camera: widget.scanCamera,
      // The computer may be showing its sign-in QR instead: approving that signs it in, which is
      // what setting it up needs anyway.
      onSignInCode: (code) => unawaited(
        approveComputerSignIn(mounted ? context : approveFrom, notifier, code),
      ),
    );
    if (code == null) return;
    final machineId = code.machineId, pairCode = code.pairCode;
    if (machineId == null || pairCode == null) {
      if (!mounted) return;
      _say('That’s not the Add Phone code.', failed: true);
      return;
    }
    if (mounted) _say('Pairing…');
    final lookup = await _lookUp(notifier, machineId);
    if (lookup == _Lookup.missing) {
      // The account answered, and the computer is not on it: no code to hold for it.
      if (!mounted) return;
      _say(
        "That computer isn't on your account. Sign in to Harness on it "
        'with ${notifier.currentUser?.email ?? 'this account'}.',
        failed: true,
      );
      return;
    }
    if (lookup == _Lookup.unreachable && mounted) {
      _say(
        "Couldn't reach your account. Check your connection and scan again.",
        failed: true,
      );
      return;
    }
    // Known — or, with this page gone, not known either way: a list that answers without the
    // computer lets a held code go by itself (`AppNotifier._refreshMachines`).
    if (atHome || !mounted) {
      notifier.holdPendingPairing(machineId, pairCode);
      return;
    }
    final error = await notifier.connectWithCode(machineId, pairCode);
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

  /// Whether the account has [machineId], asked of the account when the list held here does not
  /// have it yet.
  ///
  /// ⚠️ **Slow is not "no".** The look used to be cut at 5 seconds and the list read as it stood:
  /// a slow `/api/machines` came back as "That computer isn't on your account" — right under "Not
  /// you? Sign out", about a computer that was on it — and the answer landing a moment later took
  /// the page away with the scanned code. Past [_lookUpPatience] the page says it is still looking,
  /// and waits for the account's actual answer.
  Future<_Lookup> _lookUp(AppNotifier notifier, String machineId) async {
    if (notifier.machineStates.containsKey(machineId)) return _Lookup.found;
    final refresh = notifier.refreshMachines();
    try {
      final answered = await refresh
          .then((_) => true)
          .timeout(_lookUpPatience, onTimeout: () => false);
      if (!answered) {
        if (mounted) _say('Still looking for that computer on your account…');
        await refresh;
      }
    } catch (_) {
      // A list that could not be read says nothing about whether the computer is on the account —
      // unless it already has it.
      return notifier.machineStates.containsKey(machineId)
          ? _Lookup.found
          : _Lookup.unreachable;
    }
    return notifier.machineStates.containsKey(machineId)
        ? _Lookup.found
        : _Lookup.missing;
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
          onGetIt: _openGetIt,
          // The computer has to join this account, so the steps name it — from Computers too
          // ("Set up another computer", which does not watch), where a second computer signed in
          // to another account is likeliest.
          account: email,
          // At home the account is watched, and the computer turns up here by itself.
          watching: widget.signedIn,
          // At home there is no back, and this page is where a phone signed in to an account with
          // no computer stays: Settings — and Sign out — has to be reachable from it.
          topTrailing: widget.onBack == null
              ? PhoneSettingsButton(notifier: widget.notifier)
              : null,
          // Under the button that started it ([SetUpComputerPage.scanStatus]), not up here.
          scanStatus: scanned == null
              ? null
              : Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Text(
                    _scanFailed ? '✗ $scanned' : scanned,
                    key: const ValueKey('connect-scan-status'),
                    style: tty.style(
                      size: TtySize.meta,
                      color: _scanFailed ? tty.red : tty.faint,
                    ),
                  ),
                ),
          status: widget.signedIn
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (widget.signedIn) const _Watching(),
                    // The account, said once, right under the watch: the wrong one is the
                    // likeliest reason this page never moves on — Continue with Google, and
                    // another of the person's Google accounts.
                    if (widget.signedIn && email != null)
                      _AccountLine(
                        email: email,
                        onSignOut: () =>
                            unawaited(confirmSignOut(context, widget.notifier)),
                      ),
                  ],
                )
              : null,
        ),
      ),
    );
  }
}

/// `Waiting for your computer…` with a terminal spinner — the page is watching.
class _Watching extends StatefulWidget {
  const _Watching();

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
              'Waiting for your computer…',
              style: tty.style(size: TtySize.meta, color: tty.text),
            ),
          ),
        ],
      ),
    );
  }
}

/// `ada@gmail.com · Not you? Sign out` — the account this phone is signed in to, and the way out of
/// it, on one line that wraps. The whole line signs out (after asking, [confirmSignOut]).
class _AccountLine extends StatelessWidget {
  const _AccountLine({required this.email, required this.onSignOut});

  final String email;
  final VoidCallback onSignOut;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: 'Signed in as $email. Not you? Sign out',
      excludeSemantics: true,
      child: GestureDetector(
        key: const ValueKey('connect-sign-out'),
        behavior: HitTestBehavior.opaque,
        onTap: () {
          HapticFeedback.selectionClick();
          onSignOut();
        },
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Text.rich(
              TextSpan(
                children: [
                  TextSpan(text: '$email · '),
                  TextSpan(
                    text: 'Not you? Sign out',
                    style: tty.style(color: tty.text, size: TtySize.meta),
                  ),
                ],
              ),
              textAlign: TextAlign.center,
              style: tty.style(color: tty.faint, size: TtySize.meta),
            ),
          ),
        ),
      ),
    );
  }
}

/// What the account said of a scanned computer ([_ConnectComputerPageState._lookUp]).
enum _Lookup {
  /// On the account.
  found,

  /// The account answered without it.
  missing,

  /// The account could not be asked.
  unreachable,
}
