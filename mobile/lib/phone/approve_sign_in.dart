import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/app_dialog.dart'
    show appDialogButtonStyle, kDialogControlRadius, showAppDialog;
import 'package:harness_mobile/state/app_state.dart';

import 'tty.dart';
import 'welcome/connect_code.dart';
import 'welcome/scan_to_connect.dart';

/// Settings ▸ Sign in a computer: scan the QR a computer shows (`harness login`, or the desktop
/// app's "Scan with your phone") and approve its sign-in with this phone's account.
///
/// Approving hands that computer the account's terminals — signing in is what makes the account's
/// devices trust it — so the prompt says what is asking and from where, and makes a computer on
/// another network take a deliberate hold rather than a tap. The computer then asks its own person
/// whose account it is joining; nothing is created until it says yes.
Future<void> signInAComputer(BuildContext context, AppNotifier notifier, {Widget? camera}) async {
  final code = await scanForSignIn(context, camera: camera);
  if (code == null || !context.mounted) return;
  await approveComputerSignIn(context, notifier, code);
}

/// The prompt and the answer for one scanned [code].
Future<void> approveComputerSignIn(BuildContext context, AppNotifier notifier, SignInCode code) async {
  final Map<String, dynamic> asking;
  try {
    asking = await notifier.api.signInLookup(code.code);
  } catch (error) {
    if (context.mounted) await _tell(context, "Couldn't read that code", '$error');
    return;
  }
  if (!context.mounted) return;
  if (asking['status'] != 'pending') {
    await _tell(context, 'Already answered', 'That code was already answered. Scan the new one.');
    return;
  }
  final answer = await showAppDialog<_Answer>(
    context: context,
    builder: (_) => _ApproveDialog(
      label: (asking['label'] as String?)?.trim().isNotEmpty == true ? asking['label'] as String : 'A computer',
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
    if (context.mounted) await _tell(context, "Couldn't answer", '$error');
  }
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

  final String label;
  final bool computer;
  final bool sameNetwork;
  final String where;

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
                      'Sign in $label?',
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
                    ? 'A computer, to your account — it will run your agents and reach your machines.'
                    : 'An app, to your account — it will reach your machines.',
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
