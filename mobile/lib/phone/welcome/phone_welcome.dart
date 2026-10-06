import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/auth/sign_in_provider.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import '../exit_app.dart';
import '../tty.dart';
import '../tty_controls.dart';
import 'connect_code.dart';
import 'scan_to_connect.dart';
import 'set_up_computer.dart';
import 'sign_in_provider_button.dart';

/// The phone's first screen, signed out: what Harness is in one breath, one question anyone can
/// answer — is Harness on your computer? — and the account, for whoever would rather start there.
///
/// ```
/// harness▌
///
/// Claude Code and Codex
/// run on your computer.
/// Drive them from here.
///
/// Is Harness on your computer?
/// ┌──────────────────────────────┐
/// │ Yes — scan to connect      › │
/// └──────────────────────────────┘
/// ┌──────────────────────────────┐
/// │ Not yet — set it up        › │
/// └──────────────────────────────┘
/// ──────── or sign in with ────────
/// ┌──────────────────────────────┐
/// │ G  Continue with Google      │
/// └──────────────────────────────┘
/// ┌──────────────────────────────┐
/// │   Continue with Apple       │
/// └──────────────────────────────┘
/// ```
///
/// **Yes** scans the code the desktop app shows ([ScanToConnectPage]), and the scan signs the phone
/// in: the QR carries a one-time code the computer's own sign-in minted
/// ([AppNotifier.signInWithScan]). A QR without one — an older computer — or one that has expired
/// names the account instead: the email is filled in and its code sent, so signing in is the four
/// digits (`viewer/email_code_api.dart`, no browser). **Not yet** gets Harness onto the computer ([SetUpComputerPage]). Both
/// buttons weigh the same: the question decides, not us.
///
/// Under them, the two accounts the desktop and web sign in with ([SignInProviderButton]): the
/// SSO page opens in the app on that account ([AppNotifier.signInWithProvider]). Nothing else is
/// on the screen — no pretend agents, no diagram — for someone who has never seen Harness.
class PhoneWelcome extends StatefulWidget {
  const PhoneWelcome({
    super.key,
    required this.notifier,
    this.onTrySample,
    this.sendCode,
    this.signIn,
    this.signInWithScan,
    this.scanCamera,
    this.loadDownloads,
  });

  /// Stands in for the desktop release manifest on the set-up page, in tests and renders.
  final DesktopDownloadsLoader? loadDownloads;

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

/// [signInFirst]: a computer's own sign-in QR was scanned — see [_SignInFirst].
enum _Step { hello, setUp, scan, signInFirst, email, code }

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

  /// Under the scan page's hint. A desktop app opens signed out (its guest mode), and its Add Phone
  /// then shows no code, only "Sign in to add your phone." — with no way to sign in from there.
  static const _signInThereFirst =
      'Does it say “Sign in to add your phone”? Sign in on the computer first '
      '(Settings ▸ Account, with Google or Apple), then open Add Phone… again.';

  String? _error;
  int _resendIn = 0;
  Timer? _resendTimer;

  static const _codeLength = 4;
  static const _resendAfter = 30;

  @override
  void dispose() {
    _resendTimer?.cancel();
    _email.dispose();
    _code.dispose();
    _emailFocus.dispose();
    _codeFocus.dispose();
    super.dispose();
  }

  /// The offline sample, offered on welcome and setup. Its end card can lead to setup.
  Future<void> _trySample() async {
    final result = await widget.onTrySample!(context);
    if (!mounted || result != 'set-up') return;
    _go(_Step.setUp);
  }

  /// A code the desktop app showed. Its pairing code is held until its computer shows up, when the
  /// phone pairs with it instead of asking for a password (`AppNotifier.pendingPairing`). Its
  /// sign-in code signs the phone in there and then; without one, or when it has expired, the
  /// account's email is filled in and a code sent, so signing in is the four digits.
  Future<void> _onScanned(ConnectCode code) async {
    final machineId = code.machineId, pairCode = code.pairCode;
    if (machineId != null && pairCode != null) {
      widget.notifier.pendingPairing = (machineId: machineId, code: pairCode);
    }
    _email.text = code.email;
    final signIn = code.signIn;
    if (signIn != null) {
      setState(() => _signingInWithScan = true);
      try {
        await (widget.signInWithScan ?? widget.notifier.signInWithScan)(signIn);
        return;
      } catch (_) {
        // Expired, spent, or a backend that predates it: the email is the way on.
      } finally {
        if (mounted) setState(() => _signingInWithScan = false);
      }
      if (!mounted) return;
    }
    unawaited(_sendCode());
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

  void _go(_Step step) {
    // Leaving for another way in takes the account's page with it: whatever it came back with
    // would sign the phone in behind the step the person chose instead. Any step that is left — two
    // of them offer the accounts now, the first screen and [_SignInFirst].
    if (step != _step) widget.notifier.cancelProviderSignIn();
    // A computer's sign-in code is held only on the way to the sign-in it asked for — its own step,
    // and the email and code it may send the person to. Back at the start, at set-up or at the
    // camera, it is let go: a sign-in from there must not end in a computer to approve.
    if (step == _Step.hello || step == _Step.setUp || step == _Step.scan) {
      widget.notifier.pendingComputerSignIn = null;
    }
    setState(() {
      _step = step;
      _error = null;
    });
    if (step == _Step.email) _emailFocus.requestFocus();
    if (step == _Step.code) _codeFocus.requestFocus();
    if (step == _Step.hello) FocusManager.instance.primaryFocus?.unfocus();
  }

  Future<void> _sendCode() async {
    final email = _email.text.trim();
    if (!email.contains('@') || !email.contains('.')) {
      setState(() => _error = 'That doesn’t look like an email address.');
      return;
    }
    final ok = await _run(
      () => (widget.sendCode ?? widget.notifier.sendLoginCode)(email),
    );
    if (!ok || !mounted) return;
    _sentTo = email;
    _code.clear();
    _startResend();
    _go(_Step.code);
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
    _Step.email when _forComputer => _Step.signInFirst,
    _Step.signInFirst => _Step.scan,
    _ => _Step.hello,
  };

  /// A computer's sign-in code is waiting on this sign-in ([AppNotifier.pendingComputerSignIn]).
  bool get _forComputer => widget.notifier.pendingComputerSignIn != null;

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
            _Step.hello => _Hello(
              onScan: () => _go(_Step.scan),
              onSetUp: () => _go(_Step.setUp),
              onSample: widget.onTrySample == null
                  ? null
                  : () => unawaited(_trySample()),
              onProvider: onProvider,
              waitingOn: widget.notifier.signInProvider,
              signedOutReason: widget.notifier.signedOutReason,
              entering: entering,
              onCancel: widget.notifier.cancelProviderSignIn,
              error: _error,
            ),
            _Step.setUp => SetUpComputerPage(
              onScan: () => _go(_Step.scan),
              onBack: () => _go(_Step.hello),
              onTrySample: widget.onTrySample == null
                  ? null
                  : () => unawaited(_trySample()),
              loadDownloads: widget.loadDownloads,
            ),
            _Step.scan => ScanToConnectPage(
              camera: widget.scanCamera,
              onCode: (code) => unawaited(_onScanned(code)),
              // Taken, not ignored: a phone pointed at a computer's sign-in QR has a person behind it
              // who chose "Scan with your phone" there — nothing happening was all they used to get.
              // Held for the sign-in this phone needs before it can approve that computer.
              onSignInCode: (code) {
                widget.notifier.pendingComputerSignIn = code.code;
                _go(_Step.signInFirst);
              },
              note: _signInThereFirst,
              signingIn: _signingInWithScan,
              onUseEmail: () => _go(_Step.email),
              onBack: () => _go(_Step.hello),
            ),
            _Step.signInFirst => _SignInFirst(
              onBack: () => _go(_backFrom(_Step.signInFirst)),
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
              lines: [
                _forComputer
                    // The computer is not signed in yet: the account is chosen here, for both.
                    ? 'The account to sign this phone and your computer in with. We’ll send you a '
                          '4-digit code.'
                    : 'The one Harness on your computer is signed in with. We’ll send you a '
                          '4-digit code.',
              ],
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

/// The first thing anyone sees: the headline, the question and its two answers, and the two
/// accounts under them.
class _Hello extends StatelessWidget {
  const _Hello({
    required this.onScan,
    required this.onSetUp,
    required this.onProvider,
    required this.onCancel,
    this.onSample,
    this.waitingOn,
    this.entering = false,
    this.error,
    this.signedOutReason,
  });

  /// Why the phone is back here when it was signed in a moment ago ([AppNotifier.signedOutReason]):
  /// said above the question, or the welcome reads as a first run with no account behind it.
  final String? signedOutReason;

  final VoidCallback onScan;
  final VoidCallback onSetUp;

  /// Behind a long press on the wordmark — see `_PhoneWelcomeState._trySample`.
  final VoidCallback? onSample;

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
    final hero = tty
        .style(size: TtySize.display, weight: FontWeight.w600)
        .copyWith(height: 34 / 28, letterSpacing: -0.6);
    return Padding(
      padding: const EdgeInsets.fromLTRB(Tty.origin, 24, Tty.origin, 24),
      // ⚠️ **Scrolls when it does not fit.** The spacer holds the question at the foot where there
      // is room; on a small phone at a large text size the headline alone outgrew the screen, and
      // the column overflowed with both answers — the only ways on — pushed off its foot.
      child: LayoutBuilder(
        builder: (context, box) => SingleChildScrollView(
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: box.maxHeight),
            child: IntrinsicHeight(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  GestureDetector(
                    key: const ValueKey('welcome-wordmark'),
                    behavior: HitTestBehavior.opaque,
                    onLongPress: onSample,
                    child: Row(
                      children: [
                        TtyText(
                          'harness',
                          size: TtySize.title,
                          weight: FontWeight.w600,
                        ),
                        Container(
                          width: 9,
                          height: 18,
                          margin: const EdgeInsets.only(left: 2),
                          color: tty.green,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 48),
                  Text(
                    'Claude Code and Codex\nrun on your computer.\nDrive them from here.',
                    style: hero,
                  ),
                  const Spacer(),
                  if (signedOutReason case final reason?) ...[
                    _SignedOutNotice(reason: reason),
                    const SizedBox(height: 18),
                  ],
                  TtyText(
                    'Is Harness on your computer?',
                    color: tty.faint,
                    size: TtySize.row,
                  ),
                  const SizedBox(height: 12),
                  _Answer(label: 'Yes — scan to connect', onTap: onScan),
                  const SizedBox(height: 10),
                  _Answer(label: 'Not yet — set it up', onTap: onSetUp),
                  const SizedBox(height: 18),
                  const _OrDivider(label: 'or sign in with'),
                  const SizedBox(height: 14),
                  _ProviderSignIn(
                    onProvider: onProvider,
                    waitingOn: waitingOn,
                    entering: entering,
                    onCancel: onCancel,
                    error: error,
                  ),
                  if (onSample != null) ...[
                    const SizedBox(height: 8),
                    TtyTextButton(label: 'Try the sample', onPressed: onSample),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The two accounts the desktop and web sign in with ([SignInProviderButton]), and what goes with
/// them while one is waited on: its button saying so, Cancel under it, and why the last one did not
/// finish. On the first screen ([_Hello]) and on [_SignInFirst].
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

/// A computer's own sign-in QR, read by a phone that is not signed in: "Scan with your phone" on the
/// desktop app's sign-in sheet — the button someone adding a phone is most likely to press there,
/// and where a new desktop app's Add Phone sends them, since it opens signed out and its Add Phone
/// only says "Sign in to add your phone.".
///
/// Only a signed-in phone can approve that code, so this one signs in first. The code is held
/// meanwhile ([AppNotifier.pendingComputerSignIn]); once in, the phone asks to approve the computer
/// (`phone_shell.dart`), and the computer then asks its person to confirm the account — this one.
/// Both end up on one account, which is all it takes for them to trust each other.
///
/// ```
/// ‹ Back
/// Sign in on this phone first
/// That code lets a signed-in phone sign your computer in. …
///
/// [G  Continue with Google]
/// [   Continue with Apple ]
///         Use email instead
/// ```
class _SignInFirst extends StatelessWidget {
  const _SignInFirst({
    required this.onBack,
    required this.onProvider,
    required this.onCancel,
    required this.onUseEmail,
    this.waitingOn,
    this.entering = false,
    this.error,
  });

  final VoidCallback onBack;
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
                'Sign in on this phone first',
                key: const ValueKey('welcome-sign-in-first'),
                style: tty.style(size: 24, weight: FontWeight.w600),
              ),
              const SizedBox(height: 12),
              Text(
                'That code lets a signed-in phone sign your computer in. Sign in here, and the '
                'phone asks you to approve the computer next.',
                style: faint,
              ),
              const SizedBox(height: 6),
              Text(
                'Leave the code on the computer’s screen until then.',
                style: faint,
              ),
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
                  label: 'Use email instead',
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

/// One of the question's two answers: a raised row the width of the screen, its words and a `›`.
/// Equal weight — neither is the "primary" — because which one is right depends on the person.
class _Answer extends StatelessWidget {
  const _Answer({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () {
          HapticFeedback.selectionClick();
          onTap();
        },
        child: Container(
          height: 56,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          decoration: BoxDecoration(
            color: ttyRaised(tty),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Row(
            children: [
              Expanded(
                child: TtyText(
                  label,
                  size: TtySize.row,
                  weight: FontWeight.w600,
                ),
              ),
              Icon(LucideIcons.chevronRight300, size: 18, color: tty.faint),
            ],
          ),
        ),
      ),
    );
  }
}

/// Why a phone that was signed in is back on the welcome: a raised block over the question, the
/// sign-out mark in the terminal's yellow beside the sentence. Not the red of [_Hello.error] — the
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

/// The line between the question's answers and the accounts: a rule each side of a few faint
/// words, in the terminal's own furniture colour.
class _OrDivider extends StatelessWidget {
  const _OrDivider({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final rule = Expanded(child: Container(height: 1, color: tty.dim));
    return Row(
      children: [
        rule,
        // Its own width: at the app's largest text size (2x) it is still well inside a 375pt
        // phone, and the rules give way around it.
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: TtyText(label, color: tty.faint, size: TtySize.meta),
        ),
        rule,
      ],
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
              TtyText(title, size: 24, weight: FontWeight.w600),
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
