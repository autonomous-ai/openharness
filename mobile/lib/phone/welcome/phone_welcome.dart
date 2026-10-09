import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/auth/sign_in_provider.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import '../exit_app.dart';
import '../phone_sheet.dart' show phoneSheetRoute;
import '../tty.dart';
import '../tty_controls.dart';
import 'connect_code.dart';
import 'scan_to_connect.dart';
import 'set_up_computer.dart';
import 'sign_in_provider_button.dart';

/// The phone's first screen, signed out: Connect your computer ([SetUpComputerPage]) — one button,
/// Pair computer, and Get it for somebody with no Harness on the computer yet ([GetHarnessPage]).
///
/// ```
/// harness▌
///           Connect your computer
///          [ ⊞  Pair computer ]       → the camera → Can’t scan? Sign in another way (a sheet)
/// HOW IT WORKS  1 Open Add Phone…  2 Scan its code  3 You’re connected
///        No Harness yet? Get it ›     → Get it → Installed? Pair computer ›
///                                              Try the sample while you wait
/// ```
///
/// **Pair computer** scans the code the desktop app shows ([ScanToConnectPage]), and the scan signs
/// the phone in: the QR carries a one-time code the computer's own sign-in minted
/// ([AppNotifier.signInWithScan]). A QR without one — an older computer — or one that has expired
/// names the account instead: the email is filled in and its code sent, so signing in is the four
/// digits (`viewer/email_code_api.dart`, no browser).
///
/// The accounts — Google, Apple, an emailed code — are in a sheet behind the camera's "Can’t scan?"
/// ([_OtherWaysSheet]): the way in for a computer with only the command line, which shows no code,
/// or a phone that cannot scan — found out there, at the camera, not from a gear on the first screen
/// that read as Settings (owner, 2026-10-09). ⚠️ They used to share the first screen with "Is
/// Harness on your computer? Yes / Not yet": six ways on before anything was explained (owner,
/// 2026-10-08).
class PhoneWelcome extends StatefulWidget {
  const PhoneWelcome({
    super.key,
    required this.notifier,
    this.onTrySample,
    this.sendCode,
    this.signIn,
    this.signInWithScan,
    this.scanCamera,
  });

  /// Stands in for the camera on the scan page, in tests and renders. Null opens the real one.
  final Widget? scanCamera;

  final AppNotifier notifier;

  /// Stand-ins for the account service, for tests and renders. Null uses [notifier]'s.
  final Future<void> Function(String email)? sendCode;
  final Future<void> Function(String email, String code)? signIn;
  final Future<void> Function(String code)? signInWithScan;

  /// Opens the offline sample; completes when it is left, with `'set-up'` when it was left to set
  /// up a real computer. Null leaves the way out.
  final Future<Object?> Function(BuildContext context)? onTrySample;

  @override
  State<PhoneWelcome> createState() => _PhoneWelcomeState();
}

/// [getIt]: Harness onto the computer ([GetHarnessPage]). [signInFirst]: a computer's own sign-in
/// QR was scanned — see [_SignInPage].
enum _Step { hello, getIt, scan, signInFirst, email, code }

class _PhoneWelcomeState extends State<PhoneWelcome> {
  _Step _step = _Step.hello;
  final _email = TextEditingController();
  final _code = TextEditingController();
  final _emailFocus = FocusNode();
  final _codeFocus = FocusNode();
  String? _sentTo;
  bool _busy = false;

  /// Between a scan and the session it signs in: the scan page says so.
  bool _signingInWithScan = false;

  /// Where the camera was opened from — Pair computer on the first screen, or on Get it — and so
  /// where back from it goes ([_backFrom]).
  _Step _scanFrom = _Step.hello;

  /// Where the email was chosen from — the other ways' sheet over the first screen or the camera,
  /// or a scan that could not sign in by itself — and so where back from it goes.
  _Step _emailFrom = _Step.hello;

  /// The other ways to sign in, while their sheet is up — see [_openOtherWays].
  ModalBottomSheetRoute<void>? _otherWays;

  String? _error;
  int _resendIn = 0;
  Timer? _resendTimer;

  static const _codeLength = 4;
  static const _resendAfter = 30;

  @override
  void dispose() {
    // ⚠️ **The sheet can outlive the page.** Signed in from it, the app swaps this page for home,
    // and the sheet — the root navigator's — stayed up over the agents. Taken away after this frame:
    // a navigator is not to be changed while the tree is being torn down.
    final sheet = _otherWays;
    if (sheet != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final navigator = sheet.navigator;
        if (navigator != null && navigator.mounted && sheet.isActive) {
          navigator.removeRoute(sheet);
        }
      });
    }
    _resendTimer?.cancel();
    _email.dispose();
    _code.dispose();
    _emailFocus.dispose();
    _codeFocus.dispose();
    super.dispose();
  }

  /// The offline sample, offered on Get it while the computer installs. Its end card leads back.
  Future<void> _trySample() async {
    final result = await widget.onTrySample!(context);
    if (!mounted || result != 'set-up') return;
    _go(_Step.getIt);
  }

  /// A code the desktop app showed. Its pairing code is held until its computer shows up, when the
  /// phone pairs with it instead of asking for a password (`AppNotifier.pendingPairing`). Its
  /// sign-in code signs the phone in there and then; without one, or when it has expired, the
  /// account's email is filled in and a code sent, so signing in is the four digits.
  ///
  /// ⚠️ **Read under the other ways' sheet too.** The camera runs on beneath it, so a computer in
  /// frame is read while Google's page may be waited on: the scan wins — the sheet goes, the account's
  /// page is let go of and waited out ([_signInFree]) — or [AppNotifier.signInWithScan], which does
  /// nothing while another sign-in is under way, dropped the code without a word, and the camera,
  /// which reads one code, read nothing more.
  Future<void> _onScanned(ConnectCode code) async {
    _closeOtherWays();
    final machineId = code.machineId, pairCode = code.pairCode;
    if (machineId != null && pairCode != null) {
      widget.notifier.pendingPairing = (machineId: machineId, code: pairCode);
    }
    _email.text = code.email;
    // Past the account's page and its exchange, that sign-in is going in: the code's computer is held
    // for it ([AppNotifier.pendingPairing]), and that is all there is left to do with the scan.
    if (_entering) return;
    final signIn = code.signIn;
    if (signIn != null) {
      setState(() => _signingInWithScan = true);
      try {
        if (!await _signInFree()) {
          throw StateError('Another sign-in is under way');
        }
        if (!mounted) return;
        await (widget.signInWithScan ?? widget.notifier.signInWithScan)(signIn);
        return;
      } catch (_) {
        // Expired, spent, or a backend that predates it: the email is the way on.
      } finally {
        if (mounted) setState(() => _signingInWithScan = false);
      }
      if (!mounted) return;
    }
    unawaited(_emailCodeFromScan());
  }

  /// The scan could not sign the phone in by itself — an older computer's QR has no sign-in code,
  /// and one that has may be spent or expired — so the email in it is sent a code instead.
  ///
  /// The code step says only where the code went (owner, 2026-10-08: little text). And when even the
  /// email cannot go — the address in the QR does not pass, the network is down — the email step
  /// takes over, with the reason under its field and the address there to correct. ⚠️ Left on the scan page, as it used
  /// to be, the failure was said nowhere (that page shows no errors) and its camera, which stops
  /// reading after one code, read nothing more: a screen that looked alive and did nothing.
  Future<void> _emailCodeFromScan() async {
    // Gone from the camera while the scan's own sign-in was tried: the person chose another way.
    if (_step != _Step.scan) return;
    // The scan page goes on saying "Signing in…" while the code is sent — it is the same sign-in,
    // and the page's own title back for that second read as the scan having been dropped.
    setState(() => _signingInWithScan = true);
    final sent = await _sendCode();
    if (!mounted) return;
    setState(() => _signingInWithScan = false);
    // Left meanwhile for another way in: its failure is not the screen's to take over.
    if (sent || _step != _Step.scan) return;
    _go(_Step.email, error: _error);
  }

  /// "Continue with Google / Apple": the account's own sign-in page, in the app. Its failure is
  /// said here, under the buttons; a cancel says nothing ([AppNotifier.signInWithProvider]).
  Future<void> _signInWith(SignInProvider provider) async {
    if (widget.notifier.signingIn) return;
    setState(() => _error = null);
    try {
      await widget.notifier.signInWithProvider(provider);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = _plain(e.toString()));
    }
  }

  /// To [step], with nothing said on it unless [error] is: a step's failure belongs to the step
  /// it happened on.
  void _go(_Step step, {String? error}) {
    // Leaving for another way in takes the account's page with it: whatever it came back with
    // would sign the phone in behind the step the person chose instead. Any step that is left — the
    // accounts are offered over the first screen and the camera ([_OtherWaysSheet]) and on
    // [_SignInPage].
    if (step != _step) widget.notifier.cancelProviderSignIn();
    // A computer's sign-in code is held only on the way to the sign-in it asked for — its own step,
    // and the email and code it may send the person to. Back at the start, at Get it or at the
    // camera, it is let go: a sign-in from there must not end in a computer to approve.
    if (step == _Step.hello || step == _Step.getIt || step == _Step.scan) {
      widget.notifier.pendingComputerSignIn = null;
    }
    // Where the camera and the email were opened from is where back from them goes. Back from the
    // computer's own sign-in step ([_SignInPage]) returns to the camera, which still goes back where
    // it was first opened from.
    if (step == _Step.scan && (_step == _Step.hello || _step == _Step.getIt)) {
      _scanFrom = _step;
    }
    if (step == _Step.email && (_step == _Step.hello || _step == _Step.scan)) {
      _emailFrom = _step;
    }
    setState(() {
      _step = step;
      _error = error;
    });
    if (step == _Step.email) _emailFocus.requestFocus();
    if (step == _Step.code) _codeFocus.requestFocus();
    if (step == _Step.hello) FocusManager.instance.primaryFocus?.unfocus();
  }

  /// Emails a code to the address in the field and moves on to it. False when it did not go, with
  /// the reason in [_error].
  Future<bool> _sendCode() async {
    final email = _email.text.trim();
    if (!email.contains('@') || !email.contains('.')) {
      setState(() => _error = 'That doesn’t look like an email address.');
      return false;
    }
    final from = _step;
    final ok = await _run(
      () => (widget.sendCode ?? widget.notifier.sendLoginCode)(email),
    );
    if (!mounted) return false;
    if (!ok) {
      // Nor its failure, under a step that is not about the email.
      if (_step != from) setState(() => _error = null);
      return false;
    }
    _sentTo = email;
    _code.clear();
    _startResend();
    // ⚠️ On from the step it was sent from only. Back pressed while it went — from the scan page's
    // "Signing in…", say — had the first screen jump to "Check your email" a second later, under
    // somebody who had just left the email way behind.
    if (_step == from) _go(_Step.code);
    return true;
  }

  Future<void> _signIn() async {
    final email = _sentTo, code = _code.text.trim();
    if (email == null) return;
    if (code.length < _codeLength) {
      setState(() => _error = 'Enter the $_codeLength digits from the email.');
      return;
    }
    await _run(
      () => widget.signIn != null
          ? widget.signIn!(email, code)
          : widget.notifier.signInWithCode(email: email, code: code),
    );
  }

  Future<bool> _run(Future<void> Function() request) async {
    if (_busy) return false;
    setState(() {
      _busy = true;
      _error = null;
    });
    String? error;
    try {
      await request();
    } catch (e) {
      error = _plain(e.toString());
    }
    if (!mounted) return false;
    setState(() {
      _busy = false;
      _error = error;
    });
    return error == null;
  }

  /// A service's reason, without the exception's type in front of it.
  static String _plain(String raw) =>
      raw.replaceFirst(RegExp(r'^(Exception|StateError|Bad state):\s*'), '');

  void _startResend() {
    _resendTimer?.cancel();
    _resendIn = _resendAfter;
    _resendTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) return timer.cancel();
      setState(() => _resendIn--);
      if (_resendIn <= 0) timer.cancel();
    });
  }

  /// Where back goes from [step] — the system's back and each page's own `‹ Back` alike.
  _Step _backFrom(_Step step) => switch (step) {
    _Step.code => _Step.email,
    _Step.email => _forComputer ? _Step.signInFirst : _emailFrom,
    _Step.signInFirst => _Step.scan,
    _Step.scan => _scanFrom,
    _ => _Step.hello,
  };

  /// A computer's sign-in code is waiting on this sign-in ([AppNotifier.pendingComputerSignIn]).
  bool get _forComputer => widget.notifier.pendingComputerSignIn != null;

  /// An account's sign-in is past its page and the exchange: the phone is going in, and there is
  /// nothing left to cancel.
  bool get _entering =>
      widget.notifier.signingIn &&
      widget.notifier.status == AppStatus.bootstrapping;

  /// Waits, briefly, for a sign-in already under way to let go — an account's page just cancelled —
  /// so the scan's own finds the way clear. False when it did not.
  Future<bool> _signInFree() async {
    final notifier = widget.notifier;
    if (!notifier.signingIn) return true;
    final free = Completer<void>();
    void check() {
      if (!notifier.signingIn && !free.isCompleted) free.complete();
    }

    notifier.addListener(check);
    try {
      await free.future.timeout(const Duration(seconds: 3));
      return true;
    } on TimeoutException {
      return false;
    } finally {
      notifier.removeListener(check);
    }
  }

  /// Takes the other ways' sheet down when a code read under it starts a sign-in of its own, and
  /// lets go of an account's page still waited on in it.
  void _closeOtherWays() {
    final sheet = _otherWays;
    if (sheet == null) return;
    final navigator = sheet.navigator;
    if (navigator != null && navigator.mounted && sheet.isActive) {
      if (sheet.isCurrent) {
        navigator.pop();
      } else {
        navigator.removeRoute(sheet);
      }
    }
    _otherWays = null;
    if (widget.notifier.signInProvider != null && !_entering) {
      widget.notifier.cancelProviderSignIn();
    }
  }

  /// The other ways to sign in — Google, Apple, an emailed code — in a sheet over the camera, from
  /// its "Can’t scan?". One at a time.
  Future<void> _openOtherWays() async {
    if (_otherWays != null) return;
    final notifier = widget.notifier;
    final sheet = phoneSheetRoute<void>(
      context,
      builder: (sheetContext) => SafeArea(
        child: _OtherWaysSheet(
          notifier: notifier,
          onEmail: () {
            Navigator.of(sheetContext).pop();
            _go(_Step.email);
          },
        ),
      ),
    );
    _otherWays = sheet;
    try {
      await Navigator.of(context, rootNavigator: true).push(sheet);
    } finally {
      // Only its own: taken down by [_closeOtherWays], a sheet opened since may be the one up now.
      if (identical(_otherWays, sheet)) _otherWays = null;
    }
    // Put away while an account's page was up: that sign-in goes with it, as it does when any
    // step is left ([_go]). Past the page, the phone is already going in and there is nothing to
    // cancel. Not when another sheet is up by now — its page is that one's.
    if (!mounted || _otherWays != null || notifier.signInProvider == null) {
      return;
    }
    if (!_entering) notifier.cancelProviderSignIn();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final signingIn = widget.notifier.signingIn;
    // Past the page and the exchange, the session is saved and the machines are on their way:
    // nothing is waited on in the browser any more, and nothing to cancel.
    final entering =
        signingIn && widget.notifier.status == AppStatus.bootstrapping;
    final onProvider = signingIn
        ? null
        : (SignInProvider provider) => unawaited(_signInWith(provider));
    return PopScope(
      // The first screen lets the press go to the system — except on Android, which asks before
      // the app is left ([confirmExitApp]) and so keeps it here too.
      canPop: !confirmsExitOnBack && _step == _Step.hello,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        if (_step == _Step.hello) {
          unawaited(confirmExitApp(context));
          return;
        }
        _go(_backFrom(_step));
      },
      child: Scaffold(
        backgroundColor: tty.ground,
        body: SafeArea(
          child: switch (_step) {
            _Step.hello => SetUpComputerPage(
              onScan: () => _go(_Step.scan),
              onGetIt: () => _go(_Step.getIt),
              status: switch (widget.notifier.signedOutReason) {
                final reason? => _SignedOutNotice(reason: reason),
                null => null,
              },
            ),
            _Step.getIt => GetHarnessPage(
              onBack: () => _go(_Step.hello),
              onPair: () => _go(_Step.scan),
              onTrySample: widget.onTrySample == null
                  ? null
                  : () => unawaited(_trySample()),
            ),
            _Step.scan => ScanToConnectPage(
              camera: widget.scanCamera,
              onCode: (code) => unawaited(_onScanned(code)),
              // Taken, not ignored: a phone pointed at a computer's sign-in QR has a person behind it
              // who chose "Scan with your phone" there — nothing happening was all they used to get.
              // Held for the sign-in this phone needs before it can approve that computer.
              onSignInCode: (code) {
                // Read under the other ways' sheet, it does not open its step beneath it.
                _closeOtherWays();
                widget.notifier.pendingComputerSignIn = code.code;
                _go(_Step.signInFirst);
              },
              signingIn: _signingInWithScan,
              // The way in without a camera, or for a computer with no code to show: the accounts.
              fallbackLabel: 'Can’t scan? Sign in another way',
              onUseEmail: () => unawaited(_openOtherWays()),
              onBack: () => _go(_backFrom(_Step.scan)),
            ),
            _Step.signInFirst => _SignInPage(
              titleKey: const ValueKey('welcome-sign-in-first'),
              onBack: () => _go(_backFrom(_Step.signInFirst)),
              title: 'Sign in on this phone first',
              lines: const ['Sign in here, then approve your computer.'],
              emailLabel: 'Use email instead',
              onProvider: onProvider,
              waitingOn: widget.notifier.signInProvider,
              entering: entering,
              onCancel: widget.notifier.cancelProviderSignIn,
              onUseEmail: () => _go(_Step.email),
              error: _error,
            ),
            _Step.email => _Form(
              onBack: () => _go(_backFrom(_Step.email)),
              title: 'Your email',
              lines: const ['We’ll send you a $_codeLength-digit code.'],
              field: TtyField(
                key: const Key('welcome-email'),
                controller: _email,
                focus: _emailFocus,
                hint: 'you@example.com',
                action: TextInputAction.go,
                onSubmitted: _sendCode,
                keyboardType: TextInputType.emailAddress,
                autofillHints: const [AutofillHints.email],
              ),
              error: _error,
              button: TtyPrimaryButton(
                label: 'Send code',
                busy: _busy,
                busyLabel: 'Sending…',
                onPressed: _sendCode,
              ),
            ),
            _Step.code => _Form(
              onBack: () => _go(_Step.email),
              title: 'Check your email',
              lines: [
                'We sent a $_codeLength-digit code to ${_sentTo ?? 'your email'}.',
              ],
              field: _CodeField(
                controller: _code,
                focus: _codeFocus,
                length: _codeLength,
                onFilled: _signIn,
              ),
              error: _error,
              button: ValueListenableBuilder<TextEditingValue>(
                valueListenable: _code,
                builder: (_, value, _) => TtyPrimaryButton(
                  label: 'Sign in',
                  busy: _busy || signingIn,
                  busyLabel: 'Signing in…',
                  onPressed: value.text.trim().length == _codeLength
                      ? _signIn
                      : null,
                ),
              ),
              footer: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Flexible(
                    child: TtyTextButton(
                      label: _resendIn > 0
                          ? 'Resend in ${_resendIn}s'
                          : 'Resend code',
                      onPressed: _resendIn > 0 || _busy ? null : _sendCode,
                    ),
                  ),
                  Flexible(
                    child: TtyTextButton(
                      label: 'Change email',
                      onPressed: _busy ? null : () => _go(_Step.email),
                    ),
                  ),
                ],
              ),
            ),
          },
        ),
      ),
    );
  }
}

/// The two accounts the desktop and web sign in with ([SignInProviderButton]), and what goes with
/// them while one is waited on: its button saying so, Cancel under it, and why the last one did not
/// finish. On both [_SignInPage]s.
class _ProviderSignIn extends StatelessWidget {
  const _ProviderSignIn({
    required this.onProvider,
    required this.onCancel,
    this.waitingOn,
    this.entering = false,
    this.error,
  });

  /// "Continue with …" pressed. Null while any sign-in is in flight, which both buttons wait out.
  final ValueChanged<SignInProvider>? onProvider;

  /// The account whose page is up — its button says so, and [onCancel] is offered under it.
  final SignInProvider? waitingOn;

  /// The page is done with and the phone is going in: the button says so, and there is nothing
  /// left to cancel.
  final bool entering;
  final VoidCallback onCancel;

  /// Why the last account's sign-in did not finish.
  final String? error;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final provider in SignInProvider.values) ...[
          if (provider != SignInProvider.values.first)
            const SizedBox(height: 10),
          SignInProviderButton(
            provider: provider,
            onPressed: onProvider == null ? null : () => onProvider!(provider),
            busyLabel: provider == waitingOn
                ? (entering ? 'Signing in…' : 'Waiting for ${provider.label}…')
                : null,
          ),
        ],
        if (error case final error?)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Text(
              '✗ $error',
              style: tty.style(size: TtySize.meta, color: tty.red),
            ),
          ),
        if (waitingOn != null && !entering) ...[
          const SizedBox(height: 4),
          Center(
            child: TtyTextButton(label: 'Cancel', onPressed: onCancel),
          ),
        ],
      ],
    );
  }
}

/// A page of the accounts — Google, Apple ([_ProviderSignIn]) and an emailed code under them — with
/// back, a title and a line or two of why: **Sign in on this phone first** ([_Step.signInFirst]),
/// for a computer's own sign-in QR read by a phone that is not signed in — "Scan with your phone" on
/// the desktop app's sign-in sheet. Only a signed-in phone can approve that code, so this one signs
/// in first. The code is held meanwhile ([AppNotifier.pendingComputerSignIn]); once in, the phone
/// asks to approve the computer (`phone_shell.dart`), and the computer then asks its person to
/// confirm the account — this one.
///
/// ```
/// ‹ Back
/// Sign in on this phone first
/// Sign in here, then approve your computer.
///
/// [G  Continue with Google]
/// [   Continue with Apple ]
///         Use email instead
/// ```
class _SignInPage extends StatelessWidget {
  const _SignInPage({
    required this.onBack,
    required this.title,
    required this.lines,
    required this.emailLabel,
    required this.onProvider,
    required this.onCancel,
    required this.onUseEmail,
    this.titleKey,
    this.waitingOn,
    this.entering = false,
    this.error,
  });

  final VoidCallback onBack;
  final String title;
  final Key? titleKey;
  final List<String> lines;

  /// The emailed code's way in, under the accounts.
  final String emailLabel;
  final ValueChanged<SignInProvider>? onProvider;
  final VoidCallback onCancel;
  final VoidCallback onUseEmail;
  final SignInProvider? waitingOn;
  final bool entering;
  final String? error;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final faint = tty.style(size: TtySize.row, color: tty.faint);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: TtyBackButton(onPressed: onBack),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(Tty.origin, 12, Tty.origin, 16),
            children: [
              // A Text and not a TtyText: at a large size the title wraps rather than being cut off.
              Text(
                title,
                key: titleKey,
                style: tty.style(size: 24, weight: FontWeight.w600),
              ),
              for (final (index, line) in lines.indexed) ...[
                SizedBox(height: index == 0 ? 12 : 6),
                Text(line, style: faint),
              ],
              const SizedBox(height: 24),
              _ProviderSignIn(
                onProvider: onProvider,
                waitingOn: waitingOn,
                entering: entering,
                onCancel: onCancel,
                error: error,
              ),
              const SizedBox(height: 8),
              Center(
                child: TtyTextButton(
                  label: emailLabel,
                  color: tty.faint,
                  // Not while an account's page is up: the email would sign in behind it.
                  onPressed: onProvider == null ? null : onUseEmail,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// **Sign in another way**, in a sheet: Google, Apple ([_ProviderSignIn]) and an emailed code — for a
/// computer with only the command line, which shows no code, or a phone that cannot scan. Its own
/// sign-in, said in it: the account's page, waited on with Cancel, and why it did not finish.
///
/// ```
/// Sign in another way
/// Use the same account as your computer.
/// [G  Continue with Google]
/// [   Continue with Apple ]
///        Continue with email
/// ```
class _OtherWaysSheet extends StatefulWidget {
  const _OtherWaysSheet({required this.notifier, required this.onEmail});

  final AppNotifier notifier;

  /// "Continue with email": the sheet goes, and the email step comes.
  final VoidCallback onEmail;

  @override
  State<_OtherWaysSheet> createState() => _OtherWaysSheetState();
}

class _OtherWaysSheetState extends State<_OtherWaysSheet> {
  /// Why the last account's sign-in did not finish; a cancel says nothing.
  String? _error;

  Future<void> _signIn(SignInProvider provider) async {
    final notifier = widget.notifier;
    if (notifier.signingIn) return;
    setState(() => _error = null);
    try {
      await notifier.signInWithProvider(provider);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = _PhoneWelcomeState._plain(e.toString()));
    }
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return ListenableBuilder(
      listenable: widget.notifier,
      builder: (context, _) {
        final notifier = widget.notifier;
        final signingIn = notifier.signingIn;
        // Past the page and the exchange, the phone is going in: nothing to cancel any more.
        final entering =
            signingIn && notifier.status == AppStatus.bootstrapping;
        return SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(Tty.origin, 18, Tty.origin, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Sign in another way',
                key: const ValueKey('welcome-other-ways-title'),
                style: tty.style(size: TtySize.title, weight: FontWeight.w600),
              ),
              const SizedBox(height: 6),
              Text(
                'Use the same account as your computer.',
                style: tty
                    .style(color: tty.faint, size: TtySize.meta)
                    .copyWith(height: 1.5),
              ),
              const SizedBox(height: 16),
              _ProviderSignIn(
                onProvider: signingIn
                    ? null
                    : (provider) => unawaited(_signIn(provider)),
                waitingOn: notifier.signInProvider,
                entering: entering,
                onCancel: notifier.cancelProviderSignIn,
                error: _error,
              ),
              const SizedBox(height: 4),
              Center(
                child: TtyTextButton(
                  label: 'Continue with email',
                  // Not while an account's page is up: the email would sign in behind it.
                  onPressed: signingIn ? null : widget.onEmail,
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// Why a phone that was signed in is back on the welcome: a raised block under the title, the
/// sign-out mark in the terminal's yellow beside the sentence. Not the red of a sign-in's error — the
/// person did nothing wrong, and signing in again is the whole of what to do.
class _SignedOutNotice extends StatelessWidget {
  const _SignedOutNotice({required this.reason});

  final String reason;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      liveRegion: true,
      child: Container(
        key: const ValueKey('welcome-signed-out'),
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
        decoration: BoxDecoration(
          color: ttyRaised(tty),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 1),
              child: Icon(LucideIcons.logOut300, size: 16, color: tty.yellow),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(reason, style: tty.style(size: TtySize.row)),
            ),
          ],
        ),
      ),
    );
  }
}

/// One step of signing in: back, a title, a line or two, a field, the button.
class _Form extends StatelessWidget {
  const _Form({
    required this.onBack,
    required this.title,
    required this.lines,
    required this.field,
    required this.button,
    this.error,
    this.footer,
  });

  final VoidCallback onBack;
  final String title;
  final List<String> lines;
  final Widget field;
  final Widget button;
  final String? error;
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: TtyBackButton(onPressed: onBack),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(Tty.origin, 12, Tty.origin, 16),
            children: [
              // A title that wraps: "Check your email" at 24pt is more than a 320pt phone holds at
              // the largest text size, and a one-line TtyText cut it there.
              Text(title, style: tty.style(size: 24, weight: FontWeight.w600)),
              const SizedBox(height: 12),
              for (final line in lines)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Text(
                    line,
                    style: tty.style(size: TtySize.row, color: tty.faint),
                  ),
                ),
              const SizedBox(height: 18),
              AutofillGroup(child: field),
              if (error case final error?)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text(
                    '✗ $error',
                    style: tty.style(size: TtySize.meta, color: tty.red),
                  ),
                ),
              const SizedBox(height: 16),
              button,
              ?footer,
            ],
          ),
        ),
      ],
    );
  }
}

/// The code, typed into one wide field in big mono digits — it submits itself on the last one.
class _CodeField extends StatelessWidget {
  const _CodeField({
    required this.controller,
    required this.focus,
    required this.length,
    required this.onFilled,
  });

  final TextEditingController controller;
  final FocusNode focus;
  final int length;
  final VoidCallback onFilled;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Container(
      height: 64,
      decoration: BoxDecoration(
        color: ttyRaised(tty),
        borderRadius: BorderRadius.circular(6),
      ),
      alignment: Alignment.center,
      child: TextField(
        key: const Key('welcome-code'),
        controller: controller,
        focusNode: focus,
        keyboardType: TextInputType.number,
        autofillHints: const [AutofillHints.oneTimeCode],
        textAlign: TextAlign.center,
        maxLength: length,
        inputFormatters: [FilteringTextInputFormatter.digitsOnly],
        cursorColor: tty.green,
        style: tty
            .style(size: 30, weight: FontWeight.w600)
            .copyWith(letterSpacing: 18),
        onChanged: (value) {
          if (value.length == length) onFilled();
        },
        decoration: InputDecoration(
          isCollapsed: true,
          counterText: '',
          filled: false,
          border: InputBorder.none,
          enabledBorder: InputBorder.none,
          focusedBorder: InputBorder.none,
          hintText: '•' * length,
          hintStyle: tty
              .style(size: 30, color: tty.dim)
              .copyWith(letterSpacing: 18),
        ),
      ),
    );
  }
}
