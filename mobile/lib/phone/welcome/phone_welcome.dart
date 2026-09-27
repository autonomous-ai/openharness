import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import '../tty.dart';
import '../tty_controls.dart';
import 'connect_code.dart';
import 'scan_to_connect.dart';
import 'set_up_computer.dart';

/// The phone's first screen, signed out: what Harness is in one breath, and one question anyone
/// can answer — is Harness on your computer?
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
/// ```
///
/// **Yes** scans the code the desktop app shows ([ScanToConnectPage]), and the scan signs the phone
/// in: the QR carries a one-time code the computer's own sign-in minted
/// ([AppNotifier.signInWithScan]). A QR without one — an older computer — or one that has expired
/// names the account instead: the email is filled in and its code sent, so signing in is the four
/// digits (`viewer/email_code_api.dart`, no browser). **Not yet** gets Harness onto the computer ([SetUpComputerPage]). Both
/// buttons weigh the same: the question decides, not us. Nothing else is on the screen — no
/// pretend agents, no diagram — for someone who has never seen Harness.
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

enum _Step { hello, setUp, scan, email, code }

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

  /// The offline sample — no longer offered on this screen (a video shows the app instead), but
  /// kept behind a long press on the wordmark for the simulator's screenshots. Left from its end
  /// card to set up a computer, it lands on the set-up page.
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

  void _go(_Step step) {
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

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final signingIn = widget.notifier.signingIn;
    return PopScope(
      canPop: _step == _Step.hello,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        _go(_step == _Step.code ? _Step.email : _Step.hello);
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
            ),
            _Step.setUp => SetUpComputerPage(
              onScan: () => _go(_Step.scan),
              onBack: () => _go(_Step.hello),
              loadDownloads: widget.loadDownloads,
            ),
            _Step.scan => ScanToConnectPage(
              camera: widget.scanCamera,
              onCode: (code) => unawaited(_onScanned(code)),
              signingIn: _signingInWithScan,
              onUseEmail: () => _go(_Step.email),
              onBack: () => _go(_Step.hello),
            ),
            _Step.email => _Form(
              onBack: () => _go(_Step.hello),
              title: 'Your email',
              lines: const [
                'The one Harness on your computer is signed in with. We’ll send you a 4-digit code.',
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
              button: TtyPrimaryButton(
                label: 'Sign in',
                busy: _busy || signingIn,
                busyLabel: 'Signing in…',
                onPressed: _signIn,
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

/// The first thing anyone sees: the headline, the question and its two answers.
class _Hello extends StatelessWidget {
  const _Hello({required this.onScan, required this.onSetUp, this.onSample});

  final VoidCallback onScan;
  final VoidCallback onSetUp;

  /// Behind a long press on the wordmark — see `_PhoneWelcomeState._trySample`.
  final VoidCallback? onSample;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final hero = tty
        .style(size: TtySize.display, weight: FontWeight.w600)
        .copyWith(height: 34 / 28, letterSpacing: -0.6);
    return Padding(
      padding: const EdgeInsets.fromLTRB(Tty.origin, 24, Tty.origin, 24),
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
          TtyText(
            'Is Harness on your computer?',
            color: tty.faint,
            size: TtySize.row,
          ),
          const SizedBox(height: 12),
          _Answer(label: 'Yes — scan to connect', onTap: onScan),
          const SizedBox(height: 10),
          _Answer(label: 'Not yet — set it up', onTap: onSetUp),
        ],
      ),
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
