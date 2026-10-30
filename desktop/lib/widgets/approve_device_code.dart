import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/api_client.dart' show ApiException, describeApiError;
import '../core/viewer_mode.dart' show kViewerMode;
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';

/// Machines ▸ Approve a device: sign in a device with no screen — a lamp (#1410), `harness login --code`
/// — that says eight digits aloud instead of showing a QR. The same approval the phone gives
/// (backend routes/qrSignIn.ts), made with this computer's session or, in a browser, the page's.
///
/// Approving hands that device the account's terminals, so the prompt says what is asking and from
/// where before anything is sent, and the device then asks its own person whose account it is joining.
Future<void> approveDeviceByCode(BuildContext context, AppNotifier notifier) async {
  final code = await showAppDialog<String>(
    context: context,
    builder: (_) => const _TypeCodeDialog(),
  );
  if (code == null || !context.mounted) return;
  final Map<String, dynamic> asking;
  try {
    asking = await notifier.api.signInLookup(code);
  } catch (error) {
    if (!context.mounted) return;
    // A daemon from before this route answers its own bare 404, not the backend's sentence.
    final oldDaemon = !kViewerMode && error is ApiException && error.status == 404 && error.message.startsWith('Request failed');
    await _tell(
      context,
      "Couldn't find that code",
      oldDaemon ? 'Update Harness on this computer to approve devices from here.' : _sentence(describeApiError(error)),
    );
    return;
  }
  if (!context.mounted) return;
  if (asking['status'] != 'pending') {
    // The device's own "Sign in as …?" is all that stands between a stranger who heard the code and
    // the account: say so while the person can still answer it.
    await _tell(
      context,
      'Already answered',
      "Someone else already answered this code. If the device asks to sign in with an account that isn't yours, say no.",
    );
    return;
  }
  final label = asking['label'] is String ? (asking['label'] as String).trim() : '';
  final approve = await showAppDialog<bool>(
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
  if (approve == null || !context.mounted) return;
  try {
    if (approve) {
      await notifier.api.approveSignIn(code);
      if (context.mounted) {
        await _tell(context, 'Approved', 'Confirm the account on the device to finish signing it in.');
      }
    } else {
      await notifier.api.denySignIn(code);
    }
  } catch (error) {
    if (context.mounted) await _tell(context, "Couldn't answer", _sentence(describeApiError(error)));
  }
}

/// [describeApiError] words its reasons to follow a colon; here they start a sentence.
String _sentence(String text) {
  final trimmed = text.trim();
  if (trimmed.isEmpty) return 'Something went wrong. Try again.';
  return '${trimmed[0].toUpperCase()}${trimmed.substring(1)}';
}

Future<void> _tell(BuildContext context, String title, String message) => showAppDialog<void>(
  context: context,
  builder: (context) => AlertDialog(
    title: Text(title),
    content: SizedBox(width: 360, child: Text(message, style: grid.AppType.body(height: 1.4))),
    actions: [
      FilledButton(
        key: const Key('approve-sign-in-ok'),
        onPressed: () => Navigator.pop(context),
        child: const Text('OK'),
      ),
    ],
  ),
);

/// The eight digits, typed with any spacing. Owns its controller, so nothing rebuilds over a disposed
/// one while the dialog animates out.
class _TypeCodeDialog extends StatefulWidget {
  const _TypeCodeDialog();

  @override
  State<_TypeCodeDialog> createState() => _TypeCodeDialogState();
}

class _TypeCodeDialogState extends State<_TypeCodeDialog> {
  final _controller = TextEditingController();

  String get _digits => _controller.text.replaceAll(RegExp(r'\D'), '');
  bool get _complete => _digits.length == 8;

  void _submit() {
    if (_complete) Navigator.pop(context, _digits);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return AlertDialog(
      title: const Text('Approve a device'),
      content: SizedBox(
        width: 360,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Type the eight digits the device says aloud.',
              style: grid.AppType.body(height: 1.4),
            ),
            const SizedBox(height: 6),
            Text(
              'Never type a code someone sent you — only one a device in front of you is saying.',
              style: grid.AppType.body(height: 1.4, color: grid.AppPalette.textSecondary),
            ),
            const SizedBox(height: 14),
            TextField(
              key: const Key('sign-in-code-field'),
              controller: _controller,
              autofocus: true,
              keyboardType: TextInputType.number,
              textAlign: TextAlign.center,
              style: grid.AppType.mono(letterSpacing: 4).copyWith(fontSize: 22),
              inputFormatters: [
                FilteringTextInputFormatter.allow(RegExp(r'[0-9 ]')),
                LengthLimitingTextInputFormatter(9),
              ],
              decoration: const InputDecoration(hintText: '1234 5678'),
              onChanged: (_) => setState(() {}),
              onSubmitted: (_) => _submit(),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          key: const Key('sign-in-code-cancel'),
          onPressed: () => Navigator.pop(context),
          style: TextButton.styleFrom(
            foregroundColor: grid.AppPalette.textSecondary,
            overlayColor: grid.AppSurface.hoverFill,
          ),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const Key('sign-in-code-continue'),
          onPressed: _complete ? _submit : null,
          child: const Text('Continue'),
        ),
      ],
    );
  }
}

/// What is asking, and from where; true approves, false denies.
class _ApproveDialog extends StatelessWidget {
  const _ApproveDialog({
    required this.label,
    required this.computer,
    required this.sameNetwork,
    required this.where,
  });

  final String? label;
  final bool computer;
  final bool sameNetwork;
  final String where;

  String get _title => switch (label) {
    final label? => 'Sign in $label?',
    null => computer ? 'Sign in a device?' : 'Sign in an app?',
  };

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final body = grid.AppType.body(height: 1.4);
    return AlertDialog(
      title: Text(_title, key: const Key('approve-sign-in-title')),
      content: SizedBox(
        width: 360,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              computer
                  ? 'A device, to your account — it will run your agents and reach your other computers.'
                  : 'An app, to your account — it will reach your computers.',
              style: body,
            ),
            const SizedBox(height: 10),
            Text(
              sameNetwork
                  ? '✓ On the same network as this computer.'
                  : '⚠ On another network${where.isEmpty ? '' : ' ($where)'}. Only approve a device you can see.',
              key: const Key('approve-sign-in-network'),
              style: body.copyWith(color: sameNetwork ? grid.AppPalette.textSecondary : grid.AppPalette.dangerFill),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          key: const Key('approve-sign-in-deny'),
          onPressed: () => Navigator.pop(context, false),
          style: TextButton.styleFrom(
            foregroundColor: grid.AppPalette.textSecondary,
            overlayColor: grid.AppSurface.hoverFill,
          ),
          child: Text(sameNetwork ? 'Deny' : 'Not me'),
        ),
        if (sameNetwork)
          FilledButton(
            key: const Key('approve-sign-in-approve'),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Approve'),
          )
        else
          _HoldToApprove(
            key: const Key('approve-sign-in-approve'),
            onApproved: () => Navigator.pop(context, true),
          ),
      ],
    );
  }
}

/// Approve for a device on another network: a two-second hold, as on the phone. A code is easily read
/// out over a call or a chat, and a click given out of habit would hand that stranger the account.
class _HoldToApprove extends StatefulWidget {
  const _HoldToApprove({super.key, required this.onApproved});

  final VoidCallback onApproved;

  @override
  State<_HoldToApprove> createState() => _HoldToApproveState();
}

class _HoldToApproveState extends State<_HoldToApprove> with SingleTickerProviderStateMixin {
  late final _hold = AnimationController(vsync: this, duration: const Duration(seconds: 2))
    ..addStatusListener((status) {
      if (status == AnimationStatus.completed) widget.onApproved();
    });

  void _release() {
    if (!_hold.isCompleted) _hold.reverse();
  }

  @override
  void dispose() {
    _hold.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final fill = grid.AppPalette.dangerFill;
    return Listener(
      onPointerDown: (_) => _hold.forward(),
      onPointerUp: (_) => _release(),
      onPointerCancel: (_) => _release(),
      child: AnimatedBuilder(
        animation: _hold,
        builder: (context, _) => ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: Container(
            constraints: const BoxConstraints(minWidth: 150, minHeight: 36),
            decoration: BoxDecoration(color: fill.withValues(alpha: 0.18)),
            child: Stack(
              alignment: Alignment.center,
              children: [
                Positioned.fill(
                  child: FractionallySizedBox(
                    alignment: Alignment.centerLeft,
                    widthFactor: _hold.value,
                    child: ColoredBox(color: fill),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                  child: Text('Hold to approve', style: grid.AppType.body(color: grid.AppPalette.textPrimary)),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
