import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../auth/phone_sign_in.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/qr_code_view.dart';

/// A sign-in another device approves, while it waits: the QR a phone scans or the code typed on a
/// phone or a computer, where to go there, when a new one comes ([refreshAt]), and then whose account
/// approved it ([confirmEmail]) — nothing is signed in until the person here says yes.
///
/// One panel for every sign-in page that offers these ways in: the first-run page in place of its
/// buttons (`sign_in_step.dart`), and the web page's (`login_screen.dart`).
class ApprovalSignInPanel extends StatelessWidget {
  const ApprovalSignInPanel({
    super.key,
    required this.method,
    required this.onConfirm,
    required this.onCancel,
    this.qrLink,
    this.code,
    this.refreshAt,
    this.confirmEmail,
    this.previousEmail,
    this.answered = false,
  });

  final ApprovalSignIn method;

  /// What the phone scans ([ApprovalSignIn.phone]); null until the CLI has made it.
  final String? qrLink;

  /// What the other device types ([ApprovalSignIn.code]); null until the CLI has made it.
  final String? code;

  /// When a new QR or code takes this one's place; null when none is coming.
  final DateTime? refreshAt;

  /// The account that approved it, waiting on the person's answer.
  final String? confirmEmail;

  /// Who was signed in here before, so the question can say when the account changes.
  final String? previousEmail;

  /// The person said yes: the session is being claimed, and the QR or code is spent.
  final bool answered;

  final ValueChanged<bool> onConfirm;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final small = Theme.of(context).textTheme.bodySmall;
    if (confirmEmail case final email?) {
      final changed =
          previousEmail != null &&
          previousEmail!.toLowerCase() != email.toLowerCase();
      return Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'Sign in as $email?',
            key: const Key('login-phone-confirm'),
            textAlign: TextAlign.center,
            style: grid.AppType.heading(),
          ),
          const SizedBox(height: 8),
          Text(
            changed
                ? 'This computer was signed in as $previousEmail. Continue only if $email is yours.'
                : 'Continue only if this is your account.',
            textAlign: TextAlign.center,
            style: small?.copyWith(
              color: changed ? grid.AppPalette.warn : null,
            ),
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 8,
            alignment: WrapAlignment.center,
            children: [
              FilledButton(
                key: const Key('login-phone-continue'),
                autofocus: true,
                onPressed: () => onConfirm(true),
                child: const Text('Continue'),
              ),
              TextButton(
                key: const Key('login-phone-refuse'),
                onPressed: () => onConfirm(false),
                child: const Text('Cancel'),
              ),
            ],
          ),
        ],
      );
    }

    final shown = answered
        ? null
        : switch (method) {
            ApprovalSignIn.phone => qrLink,
            ApprovalSignIn.code => code,
          };
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (shown == null)
          _Getting(
            label: answered
                ? 'Signing in…'
                : method == ApprovalSignIn.phone
                ? 'Getting a QR code…'
                : 'Getting a code…',
          )
        else if (method == ApprovalSignIn.phone) ...[
          QrCodeView(
            key: const Key('login-phone-qr'),
            data: shown,
            side: 200,
            semanticLabel: 'QR code to sign in with your phone',
          ),
          const SizedBox(height: 12),
          Text(
            'On your phone: Harness ▸ Settings ▸ Sign in a computer',
            textAlign: TextAlign.center,
            style: small,
          ),
        ] else
          _Code(code: shown),
        if (shown != null && refreshAt != null) ...[
          const SizedBox(height: 10),
          _NewCodeIn(refreshAt: refreshAt!),
        ],
        const SizedBox(height: 12),
        TextButton(
          key: const Key('approval-sign-in-cancel'),
          onPressed: onCancel,
          style: TextButton.styleFrom(
            foregroundColor: grid.AppPalette.textSecondary,
          ),
          child: const Text('Cancel'),
        ),
      ],
    );
  }
}

class _Getting extends StatelessWidget {
  const _Getting({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 16),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        const SizedBox.square(
          dimension: 16,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
        const SizedBox(width: 10),
        Flexible(child: Text(label, style: grid.AppType.body())),
      ],
    ),
  );
}

/// The code in two halves, as the CLI says it, with Copy beside it and where to type it under it.
class _Code extends StatefulWidget {
  const _Code({required this.code});

  final String code;

  @override
  State<_Code> createState() => _CodeState();
}

class _CodeState extends State<_Code> {
  /// The code the last Copy put on the clipboard: "Copied" speaks for that code only.
  String? _copied;
  bool _copying = false;

  Future<void> _copy() async {
    final code = widget.code;
    if (_copying) return;
    setState(() => _copying = true);
    var copied = false;
    try {
      await Clipboard.setData(ClipboardData(text: code));
      copied = true;
    } catch (_) {
      // The clipboard can be unavailable; the code is still on screen to type.
    }
    if (!mounted) return;
    setState(() {
      _copying = false;
      _copied = copied ? code : null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final code = widget.code;
    final spoken = code.length == 8
        ? '${code.substring(0, 4)} ${code.substring(4)}'
        : code;
    final small = Theme.of(context).textTheme.bodySmall;
    final copied = _copied == code;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Wrap(
          alignment: WrapAlignment.center,
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 12,
          runSpacing: 8,
          children: [
            SelectableText(
              spoken,
              key: const Key('sign-in-code'),
              // The app's own face with even-width digits, not the terminal's: a code
              // read across a room must not change shape with a font setting.
              style: grid.AppType.display(color: grid.AppPalette.textPrimary)
                  .copyWith(
                    fontSize: 36,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 3,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
            ),
            OutlinedButton.icon(
              key: const Key('sign-in-code-copy'),
              onPressed: _copying ? null : () => unawaited(_copy()),
              icon: Icon(copied ? AppIcons.check : AppIcons.copy, size: 14),
              label: Text(copied ? 'Copied' : 'Copy'),
            ),
          ],
        ),
        const SizedBox(height: 14),
        Text(
          'Type this code on a device that is signed in:',
          textAlign: TextAlign.center,
          style: grid.AppType.body(color: grid.AppPalette.textPrimary),
        ),
        const SizedBox(height: 8),
        _Path(
          icon: AppIcons.smartphone,
          where: 'Phone',
          path: 'Harness ▸ Settings ▸ Sign in a computer ▸ Type a code instead',
          style: small,
        ),
        const SizedBox(height: 6),
        _Path(
          icon: AppIcons.laptop,
          where: 'Computer',
          path: 'Machines ▸ Approve a device',
          style: small,
        ),
      ],
    );
  }
}

class _Path extends StatelessWidget {
  const _Path({
    required this.icon,
    required this.where,
    required this.path,
    required this.style,
  });

  final IconData icon;
  final String where;
  final String path;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Padding(
        padding: const EdgeInsets.only(top: 1),
        child: ExcludeSemantics(
          child: Icon(icon, size: 14, color: grid.AppPalette.textSecondary),
        ),
      ),
      const SizedBox(width: 8),
      Text('$where: ', style: style?.copyWith(fontWeight: FontWeight.w600)),
      Expanded(child: Text(path, style: style)),
    ],
  );
}

/// "New code in 0:45": quiet, ticking each second, so a person typing knows how long they have.
class _NewCodeIn extends StatefulWidget {
  const _NewCodeIn({required this.refreshAt});

  final DateTime refreshAt;

  @override
  State<_NewCodeIn> createState() => _NewCodeInState();
}

class _NewCodeInState extends State<_NewCodeIn> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final left = widget.refreshAt.difference(clock.now());
    final seconds = (left.inMilliseconds / 1000).ceil();
    final line = seconds <= 0
        ? 'Getting a new code…'
        : 'New code in ${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
    return Text(
      line,
      key: const Key('approval-new-code-in'),
      style: Theme.of(context).textTheme.bodySmall
          ?.copyWith(color: grid.AppPalette.textFaint),
    );
  }
}
