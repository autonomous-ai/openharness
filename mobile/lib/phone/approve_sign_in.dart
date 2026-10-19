import 'dart:async';

import 'package:dio/dio.dart' show DioException, DioExceptionType;
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/api/api_client.dart'
    show ApiException, describeApiError;
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/app_dialog.dart'
    show appDialogButtonStyle, kDialogControlRadius, showAppDialog;
import 'package:harness_mobile/state/app_state.dart';

import 'tty.dart';
import 'welcome/connect_code.dart';
import 'welcome/scan_to_connect.dart';

/// Settings ▸ Sign in a computer: scan the QR a computer shows (`harness login --qr`, or the web
/// app's "Scan with your phone") and approve its sign-in with this phone's account.
///
/// Approving hands that computer the account's terminals — signing in is what makes the account's
/// devices trust it — so the prompt says what is asking and from where, and makes a computer on
/// another network take a deliberate hold rather than a tap. The computer then asks its own person
/// whose account it is joining; nothing is created until it says yes.
///
/// A device with no screen — a lamp (#1410), `harness login --code` — says eight digits aloud instead
/// of showing a QR: "Type a code instead" under the camera takes them, and they go on to the same
/// approval. The device still asks its own person whose account it is joining.
Future<void> signInAComputer(BuildContext context, AppNotifier notifier, {Widget? camera}) async {
  var typeCode = false;
  final scanned = await scanForSignIn(context, camera: camera, onTypeCode: () => typeCode = true);
  if (!context.mounted) return;
  final code = scanned ?? (typeCode ? await typeSignInCode(context) : null);
  if (code == null || !context.mounted) return;
  await approveComputerSignIn(context, notifier, code);
}

/// The eight digits a device with no screen says aloud. Null when the person dropped it.
Future<SignInCode?> typeSignInCode(BuildContext context) =>
    showAppDialog<SignInCode>(context: context, builder: (_) => const _TypeCodeDialog());

/// Owns its controller, so nothing rebuilds over a disposed one while the dialog animates out.
class _TypeCodeDialog extends StatefulWidget {
  const _TypeCodeDialog();

  @override
  State<_TypeCodeDialog> createState() => _TypeCodeDialogState();
}

class _TypeCodeDialogState extends State<_TypeCodeDialog> {
  final _controller = TextEditingController();

  /// The digits typed, whatever spacing the person used to keep their place.
  String get _digits => _controller.text.replaceAll(RegExp(r'\D'), '');
  bool get _complete => _digits.length == 8;

  void _submit() {
    if (_complete) Navigator.of(context).pop(SignInCode(_digits));
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final accent = AppPalette.accentOnSurface;
    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: Tty.origin, vertical: 24),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 360),
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Type the code',
                style: TextStyle(color: AppPalette.textPrimary, fontSize: 17, fontWeight: AppFont.semibold, height: 1.3),
              ),
              const SizedBox(height: 10),
              Text(
                'The eight digits the device says aloud.',
                style: TextStyle(color: AppPalette.textSecondary, fontSize: 15, height: 1.45),
              ),
              const SizedBox(height: 6),
              Text(
                'Never type a code someone sent you — only one a device in front of you is saying.',
                style: TextStyle(color: AppPalette.textSecondary, fontSize: 13, height: 1.4),
              ),
              const SizedBox(height: 16),
              TextField(
                key: const Key('sign-in-code-field'),
                controller: _controller,
                autofocus: true,
                keyboardType: TextInputType.number,
                textAlign: TextAlign.center,
                style: TextStyle(color: AppPalette.textPrimary, fontSize: 24, letterSpacing: 4),
                inputFormatters: [
                  FilteringTextInputFormatter.allow(RegExp(r'[0-9 ]')),
                  LengthLimitingTextInputFormatter(9),
                ],
                decoration: const InputDecoration(hintText: '1234 5678'),
                onChanged: (_) => setState(() {}),
                onSubmitted: (_) => _submit(),
              ),
              const SizedBox(height: 22),
              Row(
                children: [
                  Expanded(
                    child: FilledButton(
                      key: const Key('sign-in-code-cancel'),
                      style: appDialogButtonStyle(background: AppSurface.recess, foreground: AppPalette.textPrimary),
                      onPressed: () => Navigator.of(context).pop(),
                      child: const Text('Cancel'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton(
                      key: const Key('sign-in-code-continue'),
                      style: appDialogButtonStyle(background: accent, foreground: Colors.white),
                      onPressed: _complete ? _submit : null,
                      child: const Text('Continue'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The prompt and the answer for one scanned [code].
///
/// [scanAgain], when given, follows the reason a code could not be read: where to scan a fresh one.
/// For a code scanned a while before it is answered — on the welcome screen, before the sign-in this
/// phone needed first — when the camera that read it is long gone.
Future<void> approveComputerSignIn(
  BuildContext context,
  AppNotifier notifier,
  SignInCode code, {
  String? scanAgain,
}) async {
  final Map<String, dynamic> asking;
  try {
    asking = await notifier.api.signInLookup(code.code);
  } catch (error) {
    if (context.mounted) {
      final reason = _reason(error);
      await _tell(context, "Couldn't read that code", scanAgain == null ? reason : '$reason $scanAgain');
    }
    return;
  }
  if (!context.mounted) return;
  if (asking['status'] != 'pending') {
    await _tell(
      context,
      'Already answered',
      // A typed code was heard, and could have been heard by someone else: the device's own
      // "Sign in as …?" is then all that stands in their way, so say so while it can be answered.
      _typed(code)
          ? "Someone else already answered this code. If the device asks to sign in with an account that isn't yours, say no."
          : scanAgain == null
          ? 'That code was already answered. Scan the new one.'
          : 'That code was already answered. $scanAgain',
    );
    return;
  }
  final label = asking['label'] is String ? (asking['label'] as String).trim() : '';
  final answer = await showAppDialog<_Answer>(
    context: context,
    builder: (_) => _ApproveDialog(
      label: label.isEmpty ? null : label,
      computer: asking['kind'] == 'computer',
      sameNetwork: asking['sameNetwork'] == true,
      where: [
        if (asking['country'] is String) asking['country'] as String,
        if (asking['ipHint'] is String) asking['ipHint'] as String,
      ].join(' · '),
    ),
  );
  if (answer == null || !context.mounted) return;
  try {
    if (answer == _Answer.approve) {
      await notifier.api.approveSignIn(code.code);
      HapticFeedback.mediumImpact();
      if (context.mounted) {
        await _tell(context, 'Approved', 'Confirm the account on the computer to finish signing it in.');
      }
    } else {
      await notifier.api.denySignIn(code.code);
    }
  } catch (error) {
    if (context.mounted) await _tell(context, "Couldn't answer", _reason(error));
  }
}

/// A code typed from a device's voice (eight digits) rather than read from a QR.
bool _typed(SignInCode code) => RegExp(r'^\d{8}$').hasMatch(code.code);

/// Why a request failed, as a sentence for the person.
///
/// ⚠️ **Never the exception's own text.** `'$error'` put "DioException [connection error]: The
/// connection errored: Failed host lookup: …" in the snackbar for a phone that was merely offline.
/// The backend's own message ([ApiException]) is said as it is — "That code has expired" — and a
/// failure to reach it in [describeApiError]'s words; anything else, in plain ones.
String _reason(Object error) {
  if (error is ApiException) return _sentence(error.message);
  if (error is DioException) {
    return switch (error.type) {
      DioExceptionType.connectionError ||
      DioExceptionType.connectionTimeout ||
      DioExceptionType.sendTimeout ||
      DioExceptionType.receiveTimeout ||
      DioExceptionType.badResponse => _sentence(describeApiError(error)),
      DioExceptionType.badCertificate ||
      DioExceptionType.cancel ||
      DioExceptionType.transformTimeout ||
      DioExceptionType.unknown =>
        'Couldn’t reach Harness. Check your connection and try again.',
    };
  }
  return 'Something went wrong. Try again.';
}

/// [describeApiError] words its reasons to follow a colon ("could not reach Harness. …"); here
/// they start a sentence.
String _sentence(String text) {
  final trimmed = text.trim();
  if (trimmed.isEmpty) return 'Something went wrong. Try again.';
  return '${trimmed[0].toUpperCase()}${trimmed.substring(1)}';
}

/// One line of news where the person is: the answer went through, or why it did not.
Future<void> _tell(BuildContext context, String title, String message) async {
  ScaffoldMessenger.maybeOf(context)?.showSnackBar(
    SnackBar(
      key: const Key('approve-sign-in-news'),
      content: Text('$title. $message'),
      behavior: SnackBarBehavior.floating,
    ),
  );
}

enum _Answer { approve, deny }

class _ApproveDialog extends StatelessWidget {
  const _ApproveDialog({
    required this.label,
    required this.computer,
    required this.sameNetwork,
    required this.where,
  });

  /// The name it gave itself; null when it gave none.
  final String? label;
  final bool computer;
  final bool sameNetwork;
  final String where;

  /// Its name when it gave one, else what it is: a name-shaped "A computer" made "Sign in A
  /// computer?", and said "computer" of an app too.
  String get _title => switch (label) {
    final label? => 'Sign in $label?',
    null => computer ? 'Sign in a computer?' : 'Sign in an app?',
  };

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final warn = Theme.of(context).colorScheme.error;
    final accent = AppPalette.accentOnSurface;
    final text = TextStyle(color: AppPalette.textSecondary, fontSize: 15, height: 1.45);
    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: Tty.origin, vertical: 24),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 360),
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      color: (sameNetwork ? accent : warn).withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(kDialogControlRadius),
                    ),
                    child: Icon(
                      computer ? LucideIcons.laptop300 : LucideIcons.appWindow300,
                      size: 20,
                      color: sameNetwork ? accent : warn,
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Text(
                      _title,
                      key: const Key('approve-sign-in-title'),
                      style: TextStyle(
                        color: AppPalette.textPrimary,
                        fontSize: 17,
                        fontWeight: AppFont.semibold,
                        height: 1.3,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              Text(
                computer
                    ? 'A computer, to your account — it will run your agents and reach your other computers.'
                    : 'An app, to your account — it will reach your computers.',
                style: text,
              ),
              const SizedBox(height: 10),
              Text(
                sameNetwork
                    ? '✓ On the same network as this phone.'
                    : '⚠ On another network${where.isEmpty ? '' : ' ($where)'}. Only approve a computer you can see.',
                key: const Key('approve-sign-in-network'),
                style: text.copyWith(color: sameNetwork ? AppPalette.textSecondary : warn),
              ),
              const SizedBox(height: 22),
              Row(
                children: [
                  Expanded(
                    child: FilledButton(
                      key: const Key('approve-sign-in-deny'),
                      style: appDialogButtonStyle(background: AppSurface.recess, foreground: AppPalette.textPrimary),
                      onPressed: () => Navigator.of(context).pop(_Answer.deny),
                      child: Text(sameNetwork ? 'Deny' : 'Not me'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: sameNetwork
                        ? FilledButton(
                            key: const Key('approve-sign-in-approve'),
                            style: appDialogButtonStyle(background: accent, foreground: Colors.white),
                            onPressed: () => Navigator.of(context).pop(_Answer.approve),
                            child: const Text('Approve'),
                          )
                        : _HoldToApprove(onApproved: () => Navigator.of(context).pop(_Answer.approve)),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Approve for a computer on another network: a two-second hold, so a prompt tapped through by
/// habit does not hand a stranger the account's terminals.
class _HoldToApprove extends StatefulWidget {
  const _HoldToApprove({required this.onApproved});

  final VoidCallback onApproved;

  static const hold = Duration(seconds: 2);

  @override
  State<_HoldToApprove> createState() => _HoldToApproveState();
}

class _HoldToApproveState extends State<_HoldToApprove> with SingleTickerProviderStateMixin {
  late final AnimationController _progress = AnimationController(vsync: this, duration: _HoldToApprove.hold);

  @override
  void dispose() {
    _progress.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final warn = Theme.of(context).colorScheme.error;
    return RawGestureDetector(
      key: const Key('approve-sign-in-hold'),
      gestures: {
        LongPressGestureRecognizer: GestureRecognizerFactoryWithHandlers<LongPressGestureRecognizer>(
          () => LongPressGestureRecognizer(duration: _HoldToApprove.hold),
          (r) {
            r.onLongPressDown = (_) {
              unawaited(_progress.forward(from: 0));
            };
            r.onLongPressCancel = () {
              _progress.reset();
            };
            r.onLongPress = () {
              HapticFeedback.heavyImpact();
              widget.onApproved();
            };
          },
        ),
      },
      child: AnimatedBuilder(
        animation: _progress,
        builder: (context, _) => ClipRRect(
          borderRadius: BorderRadius.circular(kDialogControlRadius),
          child: Stack(
            alignment: Alignment.center,
            children: [
              Container(height: 44, color: AppSurface.recess),
              Positioned.fill(
                child: FractionallySizedBox(
                  alignment: Alignment.centerLeft,
                  widthFactor: _progress.value,
                  child: Container(color: warn.withValues(alpha: 0.7)),
                ),
              ),
              Text(
                'Hold to approve',
                style: TextStyle(color: AppPalette.textPrimary, fontWeight: AppFont.semibold),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
