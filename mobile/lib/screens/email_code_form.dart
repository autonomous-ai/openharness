import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../theme/app_theme.dart' show AppColors;
import 'login_text_field.dart';

/// A phone's sign-in: an email, then the code sent to it — both in the app.
///
/// Replaces the "Sign in" button that handed a phone to the browser, which could not always bring
/// it back (Google Play review: "127.0.0.1 took too long to respond") — see
/// `viewer/email_code_api.dart`. One field at a time, in the login card, so the step the person is
/// on is the only thing asking for input.
class EmailCodeForm extends StatefulWidget {
  const EmailCodeForm({
    super.key,
    required this.sendCode,
    required this.signIn,
  });

  /// Emails a code to the address given — `AppNotifier.sendLoginCode`.
  final Future<void> Function(String email) sendCode;

  /// Trades the code for a session and goes in — `AppNotifier.signInWithCode`.
  /// Both throw a reason fit to show under the field.
  final Future<void> Function(String email, String code) signIn;

  /// How long before the same address can be sent another code — long enough
  /// that a slow inbox is not answered with a second email, short enough that
  /// a lost one is not a wait.
  static const resendAfter = Duration(seconds: 30);

  /// The account API's codes are four digits (the companion app's pin field).
  static const codeLength = 4;

  @override
  State<EmailCodeForm> createState() => _EmailCodeFormState();
}

class _EmailCodeFormState extends State<EmailCodeForm> {
  final _email = TextEditingController();
  final _code = TextEditingController();

  /// The address the code went to; null while the email is still being asked.
  String? _sentTo;
  bool _busy = false;
  String? _error;
  int _resendIn = 0;
  Timer? _resendTimer;

  @override
  void dispose() {
    _resendTimer?.cancel();
    _email.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _sendCode() async {
    final email = _email.text.trim();
    if (!email.contains('@')) {
      setState(() => _error = 'Enter the email of your Autonomous account.');
      return;
    }
    await _run(
      () => widget.sendCode(email),
      onDone: () {
        _sentTo = email;
        _code.clear();
        _startResendCountdown();
      },
    );
  }

  Future<void> _signIn() async {
    final email = _sentTo, code = _code.text.trim();
    if (email == null) return;
    if (code.isEmpty) {
      setState(() => _error = 'Enter the code from the email.');
      return;
    }
    await _run(() => widget.signIn(email, code));
  }

  /// One request at a time, its failure shown under the field in the
  /// service's own words.
  Future<void> _run(
    Future<void> Function() request, {
    VoidCallback? onDone,
  }) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    String? error;
    try {
      await request();
    } catch (e) {
      error = e.toString();
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
      if (error == null) onDone?.call();
    });
  }

  void _startResendCountdown() {
    _resendTimer?.cancel();
    _resendIn = EmailCodeForm.resendAfter.inSeconds;
    _resendTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) return timer.cancel();
      setState(() => _resendIn--);
      if (_resendIn <= 0) timer.cancel();
    });
  }

  void _changeEmail() => setState(() {
    _resendTimer?.cancel();
    _sentTo = null;
    _error = null;
    _code.clear();
  });

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final sentTo = _sentTo;
    final text = Theme.of(context).textTheme;
    return AutofillGroup(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (sentTo == null) ...[
            Text(
              'Sign in with the email of your Autonomous account.',
              textAlign: TextAlign.center,
              style: text.bodySmall,
            ),
            const SizedBox(height: 12),
            LoginTextField(
              key: const Key('login-email'),
              controller: _email,
              hint: 'you@example.com',
              keyboard: TextInputType.emailAddress,
              autofill: AutofillHints.email,
              enabled: !_busy,
              onSubmitted: _sendCode,
            ),
          ] else ...[
            Text(
              'We emailed a sign-in code to $sentTo.',
              textAlign: TextAlign.center,
              style: text.bodySmall,
            ),
            const SizedBox(height: 12),
            LoginTextField(
              key: const Key('login-code'),
              controller: _code,
              hint: 'Sign-in code',
              keyboard: TextInputType.number,
              autofill: AutofillHints.oneTimeCode,
              enabled: !_busy,
              onSubmitted: _signIn,
              maxDigits: EmailCodeForm.codeLength,
            ),
          ],
          if (_error case final error?) ...[
            const SizedBox(height: 8),
            Semantics(
              liveRegion: true,
              child: Text(
                error,
                textAlign: TextAlign.center,
                style: text.bodySmall?.copyWith(color: AppColors.danger),
              ),
            ),
          ],
          const SizedBox(height: 12),
          FilledButton(
            onPressed: _busy ? null : (sentTo == null ? _sendCode : _signIn),
            child: _busy
                ? const SizedBox.square(
                    dimension: grid.AppControl.iconSize,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text(sentTo == null ? 'Email me a code' : 'Sign in'),
          ),
          if (sentTo != null) _codeActions(),
        ],
      ),
    );
  }

  Widget _codeActions() => Wrap(
    alignment: WrapAlignment.center,
    children: [
      TextButton(
        onPressed: _busy || _resendIn > 0
            ? null
            : () => _run(
                () => widget.sendCode(_sentTo!),
                onDone: _startResendCountdown,
              ),
        child: Text(_resendIn > 0 ? 'Resend in ${_resendIn}s' : 'Resend code'),
      ),
      TextButton(
        onPressed: _busy ? null : _changeEmail,
        child: const Text('Use a different email'),
      ),
    ],
  );
}
