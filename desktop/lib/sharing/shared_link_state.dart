import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/empty_state.dart';

/// Why a shared harness link (`/s/…`) shows a page instead of the harness.
enum SharedLinkProblem {
  /// The link lost its owner key: copied short, or cut off in a message.
  incomplete,

  /// A private link, and nobody is signed in.
  private,

  /// Signed in, and the server refused: expired, turned off, or shared with
  /// another email. It answers all three alike, so the page does too.
  refused,

  /// The owner's computer is offline; the page reads again by itself.
  offline,

  /// The server names another owner key than the link pins.
  changed,

  /// No answer, or one that is not about access.
  failed,

  /// The reader closed the harness.
  paused,
}

/// One state of a shared link as the app's empty state: an icon, a title, one
/// sentence and a way forward. Never Sign in to someone already signed in, so
/// a refused link cannot send anyone round the sign-in again, and never
/// "try again" where trying again cannot help.
class SharedLinkState extends StatelessWidget {
  const SharedLinkState({
    super.key,
    required this.problem,
    required this.onSignIn,
    required this.onSwitchAccount,
    required this.onRetry,
    required this.onOpenHarness,
    this.email,
    this.signingIn = false,
    this.signInError,
  });

  final SharedLinkProblem problem;

  /// The signed-in reader's email, named when a link was refused to it.
  final String? email;
  final bool signingIn;

  /// Why the last sign-in failed, under the way forward.
  final String? signInError;
  final VoidCallback onSignIn, onSwitchAccount, onRetry, onOpenHarness;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final (icon, title, message) = _words;
    final (primary, secondary) = _actions;
    final error = signInError;
    return SingleChildScrollView(
      child: Semantics(
        liveRegion: true,
        child: EmptyState(
          icon: icon,
          title: title,
          message: message,
          action: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              primary,
              if (secondary != null) ...[const SizedBox(height: 4), secondary],
              if (error != null) ...[
                const SizedBox(height: 12),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 320),
                  child: Text(
                    error,
                    textAlign: TextAlign.center,
                    style: grid.AppType.body(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  (IconData, String, String) get _words => switch (problem) {
    SharedLinkProblem.incomplete => (
      AppIcons.unlink,
      'This shared link is incomplete',
      'Ask the owner to copy the whole link again.',
    ),
    SharedLinkProblem.private => (
      AppIcons.lock,
      'This shared harness is private',
      'Sign in with the email it was shared with.',
    ),
    SharedLinkProblem.refused => (
      AppIcons.lock,
      'You can’t open this shared harness',
      'It may have expired or been turned off, or it was shared with '
          '${email == null ? 'another email' : 'an email other than $email'}.',
    ),
    SharedLinkProblem.offline => (
      AppIcons.cloudOff,
      'The owner’s computer is offline',
      'This page opens the harness by itself when it is back.',
    ),
    SharedLinkProblem.changed => (
      AppIcons.shieldOff,
      'This link no longer matches its owner',
      'It will not open, to keep you safe. Ask the owner for a new link.',
    ),
    SharedLinkProblem.failed => (
      AppIcons.cloudOff,
      'Couldn’t open this shared harness',
      'Check your connection and try again.',
    ),
    SharedLinkProblem.paused => (
      AppIcons.eye,
      'Viewing paused',
      'The harness keeps running for its owner.',
    ),
  };

  (Widget, Widget?) get _actions {
    final openHarness = _quiet('Open Harness', onOpenHarness);
    return switch (problem) {
      SharedLinkProblem.incomplete || SharedLinkProblem.changed => (
        _filled('Open Harness', onOpenHarness),
        null,
      ),
      SharedLinkProblem.private => (
        _filled(
          signingIn ? 'Signing in…' : 'Sign in',
          signingIn ? null : onSignIn,
        ),
        null,
      ),
      SharedLinkProblem.refused => (
        _filled('Switch account', onSwitchAccount),
        openHarness,
      ),
      SharedLinkProblem.offline => (_filled('Check now', onRetry), null),
      SharedLinkProblem.failed => (_filled('Try again', onRetry), null),
      SharedLinkProblem.paused => (_filled('Watch again', onRetry), null),
    };
  }

  // Padded: a thumb's target on a phone, whatever the button draws.
  static const _padded = ButtonStyle(
    tapTargetSize: MaterialTapTargetSize.padded,
  );

  static Widget _filled(String label, VoidCallback? onPressed) =>
      FilledButton(style: _padded, onPressed: onPressed, child: Text(label));

  static Widget _quiet(String label, VoidCallback onPressed) =>
      TextButton(style: _padded, onPressed: onPressed, child: Text(label));
}
