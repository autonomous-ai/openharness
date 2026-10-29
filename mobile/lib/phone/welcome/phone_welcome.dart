import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/auth/sign_in_provider.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/swarm/swarm_home_cache.dart';

import '../exit_app.dart';
import '../tty.dart';
import '../tty_controls.dart';
import 'connect_code.dart';
import 'email_sign_in.dart';
import 'onboarding_copy.dart';
import 'onboarding_frame.dart';
import 'onboarding_picture.dart';
import 'scan_to_connect.dart';
import 'set_up_computer.dart' show ComputerSteps;
import 'sign_in_provider_button.dart';

/// The phone's first screen, signed out: ① Welcome — the promise, and signing in right there.
///
/// ```
///
///   Manage all your agents on all
///   your computers from your phone.
///
///        ┌─────────────────────┐
///        │  three computers,   │      everything lit: agents typing, packets running to the phone
///        │  all lit, a phone   │
///        └─────────────────────┘
///
///   [ G  Continue with Google     ]
///   [    Continue with Apple      ]
///    ✉ Continue with email · ⊞ QR code      words, not boxes
///                                           (Cancel in their place while an account's page is up)
///
///   Continue with email → Your email → Check your email.
///   QR code → the camera ([ScanToConnectPage]); back for the others.
/// ```
///
/// Signing in is all there is to do here, and it moves on by itself: signed in, the app swaps this
/// for home, which says "On your computer, go to" when the account has no computer yet and opens
/// the computer's session when it has one (`docs/research/2026-10-11-phone-onboarding`, agreed with
/// the owner 2026-10-12).
///
/// ⚠️ **Four ways in, nothing else** (owner, 2026-10-14; it was the scan first, then Google and
/// Apple, on 2026-10-12): **Google** and **Apple**, the only buttons, then the lesser ways in as
/// one line of words — **Continue with email**, an emailed code, also where a scan without a
/// sign-in code ends up; **QR code**: its camera reads the code a signed-in computer's Add Phone
/// shows ([ConnectCode]): its sign-in code signs this phone in to that computer's account with
/// nothing to type, and its pairing code is held for that computer ([AppNotifier.pendingPairing]).
/// No sample, no "Is Harness on your computer?", no tips.
///
/// ⚠️ **The foot never changes height.** While an account's page is up, the line of lesser ways in
/// under the buttons becomes Cancel; why it did not finish is said in the headline's place — so the
/// picture, in the same place on every onboarding screen ([OnboardingFrame]), never moves for it.
///
/// ⚠️ **A message takes the headline's place** (owner, 2026-10-14): why the phone was signed out,
/// why a sign-in did not finish, what to do next. Pressing any way in — Google, Apple, Continue
/// with email, QR code — lets it go, and the headline comes back.
class PhoneWelcome extends StatefulWidget {
  const PhoneWelcome({
    super.key,
    required this.notifier,
    this.sendCode,
    this.signIn,
    this.scanCamera,
    this.swarmHome,
  });

  final AppNotifier notifier;

  /// Stand-ins for the account service, for tests and renders. Null uses [notifier]'s.
  final Future<void> Function(String email)? sendCode;
  final Future<void> Function(String email, String code)? signIn;

  /// Stands in for the camera on Scan QR from computer's page, in tests and renders. Null opens the
  /// real one.
  final Widget? scanCamera;

  /// The Swarm Home kept on this phone ([SwarmHomeCache.device] when null).
  final SwarmHomeCache? swarmHome;

  @override
  State<PhoneWelcome> createState() => _PhoneWelcomeState();
}

enum _Step { hello, scan, email, code }

class _PhoneWelcomeState extends State<PhoneWelcome> {
  _Step _step = _Step.hello;
  final _email = TextEditingController();
  final _code = TextEditingController();
  final _emailFocus = FocusNode();
  final _codeFocus = FocusNode();
  String? _sentTo;
  bool _busy = false;

  /// Between a scan and the session it signs in: the camera's page says so.
  bool _signingInWithScan = false;

  String? _error;

  /// A line in the headline's place that is neither a failure nor a sign-out: what to do next.
  String? _notice;

  /// A way in was pressed: the sign-out's reason has been read, and gives the headline back for
  /// good. Kept here, not cleared on the notifier, which says why the phone was signed out.
  bool _reasonRead = false;

  int _resendIn = 0;
  Timer? _resendTimer;

  static const _codeLength = 4;
  static const _resendAfter = 30;

  @override
  void initState() {
    super.initState();
    // Signed out, so the last Swarm Home goes: a session that ended while the app was not running
    // never had a signed-in shell to clear it ([SwarmHost]).
    unawaited((widget.swarmHome ?? SwarmHomeCache.device()).clear());
  }

  @override
  void dispose() {
    _resendTimer?.cancel();
    _email.dispose();
    _code.dispose();
    _emailFocus.dispose();
    _codeFocus.dispose();
    super.dispose();
  }

  /// "Continue with Google / Apple": the account's own sign-in page, in the app. Its failure is
  /// said in the headline's place; a cancel says nothing ([AppNotifier.signInWithProvider]).
  Future<void> _signInWith(SignInProvider provider) async {
    if (widget.notifier.signingIn) return;
    // A way in pressed: whatever was said lets the headline back.
    setState(() {
      _error = null;
      _notice = null;
      _reasonRead = true;
    });
    try {
      await widget.notifier.signInWithProvider(provider);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = _plain(e.toString()));
    }
  }

  /// A code a signed-in computer's Add Phone showed. Its pairing code is held until that computer
  /// shows up ([AppNotifier.pendingPairing]); its sign-in code signs the phone in there and then.
  /// Without one — an older computer's code — or when it has expired, the account's email is
  /// filled in and a code sent, so signing in is the four digits.
  Future<void> _onScanned(ConnectCode code) async {
    final notifier = widget.notifier;
    final machineId = code.machineId, pairCode = code.pairCode;
    if (machineId != null && pairCode != null) {
      notifier.pendingPairing = (machineId: machineId, code: pairCode);
    }
    _email.text = code.email;
    final signIn = code.signIn;
    if (signIn != null) {
      setState(() => _signingInWithScan = true);
      try {
        // ⚠️ [AppNotifier.signInWithScan] does nothing while another sign-in is under way — an
        // account's page let go of on the way here — so that one is waited out first, or the scan
        // would be dropped without a word under a camera that reads one code only.
        if (!await _signInFree()) throw StateError('Another sign-in is under way');
        if (!mounted || _step != _Step.scan) return;
        await notifier.signInWithScan(signIn);
        // In, or going in: the app swaps this screen for home. Still out and nothing under way is
        // a scan that was dropped all the same, and the email is the way on.
        if (!mounted ||
            notifier.signingIn ||
            notifier.status != AppStatus.unauthenticated) {
          return;
        }
      } catch (_) {
        // Expired, spent, or a backend that predates it: the emailed code is the way on.
      } finally {
        if (mounted) setState(() => _signingInWithScan = false);
      }
      if (!mounted) return;
    }
    unawaited(_emailCodeFromScan());
  }

  /// The scan could not sign the phone in by itself, so the email in it is sent a code instead.
  /// When even that cannot go — the address does not pass, the network is down — the email step
  /// takes over with the reason under its field: the camera's page shows no errors, and its camera
  /// reads nothing more after one code.
  Future<void> _emailCodeFromScan() async {
    // Gone from the camera meanwhile: the person chose another way.
    if (_step != _Step.scan) return;
    setState(() => _signingInWithScan = true);
    final sent = await _sendCode();
    if (!mounted) return;
    setState(() => _signingInWithScan = false);
    if (sent || _step != _Step.scan) return;
    _go(_Step.email, error: _error);
  }

  /// A computer's own sign-in code — its `harness login --qr` — read before this phone has an
  /// account to approve it with. Held for the sign-in this phone does first
  /// ([AppNotifier.pendingComputerSignIn]); the home screen asks for the approval once it is in.
  void _onComputerSignInCode(SignInCode code) {
    widget.notifier.pendingComputerSignIn = code.code;
    _go(_Step.hello, notice: OnboardingCopy.signInFirst);
  }

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

  /// To [step], with nothing said on it unless [error] or [notice] is: a step's failure belongs to
  /// the step it happened on.
  void _go(_Step step, {String? error, String? notice}) {
    // Leaving for another way in takes the account's page with it: whatever it came back with
    // would sign the phone in behind the step the person chose instead.
    if (step != _step) widget.notifier.cancelProviderSignIn();
    // Back at the camera, a computer's sign-in code read there before is let go: the next code
    // read is the one the person means.
    if (step == _Step.scan) widget.notifier.pendingComputerSignIn = null;
    setState(() {
      _step = step;
      _error = error;
      _notice = notice;
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
    // ⚠️ On from the step it was sent from only: back pressed while it went must not have the
    // first screen jump to "Check your email" a second later.
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
    _ => _Step.hello,
  };

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final notifier = widget.notifier;
    final signingIn = notifier.signingIn;
    // Past the page and the exchange, the session is saved and the machines are on their way:
    // nothing is waited on in the browser any more, and nothing to cancel.
    final entering = signingIn && notifier.status == AppStatus.bootstrapping;
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
            _Step.hello => OnboardingFrame(
              headline: OnboardingCopy.welcome,
              headlineKey: const ValueKey('welcome-headline'),
              picture: const OnboardingPicture(scene: OnboardingScene.welcome),
              status: switch ((_error, _notice, notifier.signedOutReason)) {
                (final error?, _, _) => _Said(error, error: true),
                (null, final notice?, _) => _Said(
                  notice,
                  key: const ValueKey('welcome-notice'),
                  icon: LucideIcons.monitorSmartphone300,
                ),
                (null, null, final reason?) when !_reasonRead => _Said(reason),
                _ => null,
              },
              actions: _Accounts(
                onProvider: signingIn
                    ? null
                    : (provider) => unawaited(_signInWith(provider)),
                waitingOn: notifier.signInProvider,
                entering: entering,
                onCancel: notifier.cancelProviderSignIn,
                // Either way in lets the message go, as the accounts do: back here, the headline.
                onEmail: () {
                  _reasonRead = true;
                  _go(_Step.email);
                },
                onScan: () {
                  _reasonRead = true;
                  _go(_Step.scan);
                },
              ),
            ),
            _Step.scan => ScanToConnectPage(
              camera: widget.scanCamera,
              onCode: (code) => unawaited(_onScanned(code)),
              // Taken, not ignored: a phone pointed at a computer's own sign-in QR has a person
              // behind it, and a camera that did nothing was all they used to get.
              onSignInCode: _onComputerSignInCode,
              signingIn: _signingInWithScan,
              // Where the code is on the computer — the same steps as the camera on Computers.
              steps: const ComputerSteps(account: null),
              // No "Use email instead" under it (owner, 2026-10-14): Continue with email sits
              // beside QR code, one back away.
              onBack: () => _go(_Step.hello),
            ),
            _Step.email => SignInForm(
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
            _Step.code => SignInForm(
              onBack: () => _go(_Step.email),
              title: 'Check your email',
              lines: [
                'We sent a $_codeLength-digit code to ${_sentTo ?? 'your email'}.',
              ],
              field: SignInCodeField(
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

/// The welcome's foot: Google and Apple ([SignInProviderButton]), and under them one line — the
/// lesser ways in as words ([_WayLink]), or Cancel in their place while an account's page is up —
/// so the foot is the same height whatever it holds.
class _Accounts extends StatelessWidget {
  const _Accounts({
    required this.onProvider,
    required this.onCancel,
    required this.onEmail,
    required this.onScan,
    this.waitingOn,
    this.entering = false,
  });

  /// "Continue with …" pressed. Null while any sign-in is in flight, which both buttons wait out.
  final ValueChanged<SignInProvider>? onProvider;

  /// The account whose page is up — its button says so, and Cancel takes the quiet line.
  final SignInProvider? waitingOn;

  /// The page is done with and the phone is going in: the button says so, and there is nothing
  /// left to cancel.
  final bool entering;
  final VoidCallback onCancel;

  /// "Continue with email": the emailed code's step.
  final VoidCallback onEmail;

  /// "Scan QR from computer": the camera.
  final VoidCallback onScan;

  @override
  Widget build(BuildContext context) {
    final waiting = waitingOn != null && !entering;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (i, provider) in SignInProvider.values.indexed) ...[
          if (i > 0) const SizedBox(height: 10),
          SignInProviderButton(
            provider: provider,
            onPressed: onProvider == null ? null : () => onProvider!(provider),
            busyLabel: provider == waitingOn
                ? (entering ? 'Signing in…' : 'Waiting for ${provider.label}…')
                : null,
          ),
        ],
        const SizedBox(height: 10),
        // The lesser ways in, as words; Cancel in their place while an account's page is up — they
        // could not be pressed then anyway — so the foot holds no empty room for it.
        if (waiting)
          Center(
            child: TtyTextButton(
              key: const ValueKey('welcome-cancel'),
              label: 'Cancel',
              size: TtySize.meta,
              onPressed: onCancel,
            ),
          )
        else
          // Wider than the phone — a large text size — it shrinks to fit, on one line.
          Center(
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Not while an account's page is up, or past it — neither the email nor the
                  // scan: either would sign in behind it.
                  _WayLink(
                    key: const ValueKey('welcome-continue-email'),
                    icon: LucideIcons.mail300,
                    label: OnboardingCopy.continueWithEmail,
                    onPressed: onProvider == null ? null : onEmail,
                  ),
                  const _Dot(),
                  _WayLink(
                    key: const ValueKey('welcome-scan'),
                    icon: LucideIcons.qrCode300,
                    label: OnboardingCopy.qrCode,
                    semanticLabel: OnboardingCopy.scanQrCode,
                    onPressed: onProvider == null ? null : onScan,
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

/// One of the welcome's lesser ways in, under the accounts: its icon and words in the quiet line's
/// face — Continue with email, QR code. Words, not a box: only the accounts are buttons. Pressed,
/// it brightens on the finger's way DOWN.
class _WayLink extends StatefulWidget {
  const _WayLink({
    super.key,
    required this.icon,
    required this.label,
    required this.onPressed,
    this.semanticLabel,
  });

  final IconData icon;
  final String label;

  /// Null while a sign-in is in flight.
  final VoidCallback? onPressed;

  /// What a screen reader hears, where [label] is the short form. Null is [label].
  final String? semanticLabel;

  @override
  State<_WayLink> createState() => _WayLinkState();
}

class _WayLinkState extends State<_WayLink> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final enabled = widget.onPressed != null;
    final ink = !enabled
        ? tty.dim
        : _down
        ? tty.text
        : tty.faint;
    return Semantics(
      button: true,
      enabled: enabled,
      label: widget.semanticLabel ?? widget.label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: enabled ? (_) => setState(() => _down = true) : null,
        onTapCancel: enabled ? () => setState(() => _down = false) : null,
        onTapUp: enabled ? (_) => setState(() => _down = false) : null,
        onTap: enabled
            ? () {
                HapticFeedback.selectionClick();
                widget.onPressed!();
              }
            : null,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(widget.icon, size: 15, color: ink),
                const SizedBox(width: 7),
                TtyText(
                  widget.label,
                  color: ink,
                  size: OnboardingFrame.quietSize,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The `·` between the lesser ways in.
class _Dot extends StatelessWidget {
  const _Dot();

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return ExcludeSemantics(
      child: TtyText('·', color: tty.dim, size: OnboardingFrame.quietSize),
    );
  }
}

/// A line in the headline's place, until a way in is pressed: why an account's sign-in did not
/// finish (the terminal's red ✗), why a phone that was signed in is back here (the sign-out mark in
/// its yellow — not red: the person did nothing wrong, and signing in again is the whole of what to
/// do), or what to do next ([icon] in place of the sign-out mark).
class _Said extends StatelessWidget {
  const _Said(
    this.text, {
    super.key,
    this.error = false,
    this.icon = LucideIcons.logOut300,
  });

  final String text;
  final bool error;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final style = tty.style(size: OnboardingFrame.quietSize);
    return Semantics(
      liveRegion: true,
      child: Text.rich(
        key: key == null
            ? ValueKey(error ? 'welcome-error' : 'welcome-signed-out')
            : null,
        TextSpan(
          children: [
            if (error)
              const TextSpan(text: '✗ ')
            else
              WidgetSpan(
                alignment: PlaceholderAlignment.middle,
                child: Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: Icon(icon, size: 14, color: tty.yellow),
                ),
              ),
            TextSpan(text: text),
          ],
        ),
        // Left, on the headline's edge, where the headline was.
        textAlign: TextAlign.start,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: style.copyWith(color: error ? tty.red : tty.text),
      ),
    );
  }
}
