import 'dart:async';

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/services.dart';

import '../auth/sign_in_provider.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../widgets/approval_sign_in_panel.dart';
import '../widgets/finger_target.dart' show kFingerTarget;
import '../widgets/login_fleet_map.dart';
import '../widgets/login_relay_diagram.dart';
import '../widgets/or_divider.dart';
import '../widgets/quiet_link.dart';
import '../widgets/sign_in_provider_button.dart';
import '../widgets/sign_in_step.dart';
import '../widgets/web_download_button.dart';

/// Native sign-in uses the onboarding page. The browser keeps its full-page
/// introduction; both surfaces share the existing account lifecycle.
///
/// ⚠️ **The SSO page cannot be embedded, and that is not a preference.**
/// `auth.autonomous.ai`'s Google sign-in uses Google's popup-based Identity
/// Services flow — a real popup window that posts its result back to its
/// opener — which a single-window embedded webview cannot satisfy. The system
/// browser handles it natively, so `AppNotifier.login` launches it there and
/// this screen tracks the wait, returning on its own once
/// `harness login --force --json` reports success. (This note came from the screen
/// that used to own the waiting state; it is the reason the flow leaves the
/// app at all, so it outlives the widget it was written on.)
class LoginScreen extends StatelessWidget {
  final AppNotifier notifier;

  /// Optional dismissal for web callers. Native sign-in is required and has
  /// no close action; it uses the same page as onboarding.
  final VoidCallback? onClose;

  /// Why this sign-in, now — said in place of the pitch under the title. Null
  /// keeps the pitch. See [showSignInSheet].
  final String? reason;

  /// Offers Scan with your phone where this app can sign in that way. False
  /// where the person is here to add a phone: that way in needs a phone that
  /// is already signed in.
  final bool offerPhone;

  const LoginScreen({
    super.key,
    required this.notifier,
    this.onClose,
    this.reason,
    this.offerPhone = true,
  });

  static const _pitch =
      'At home, at the office, in the cloud — every machine you '
      'sign in to becomes part of one desk, here.';

  @override
  Widget build(BuildContext context) {
    // Every native entry uses the same page as onboarding, including expired sessions.
    if (!kIsWeb) return SignInStepScreen(app: notifier);
    grid.AppTheme.watch(context);
    return CallbackShortcuts(
      bindings: {
        if (notifier.canCancelLogin)
          const SingleActivator(
            LogicalKeyboardKey.escape,
            includeRepeats: false,
          ): notifier.cancelLogin,
      },
      child: Scaffold(
        backgroundColor: grid.AppPalette.panelBg,
        body: _webPage(
          context,
          waiting: notifier.signingIn || notifier.signingOut,
        ),
      ),
    );
  }

  Widget _webPage(BuildContext context, {required bool waiting}) => Stack(
    children: [
      const Positioned.fill(child: LoginAurora()),
      SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 16, 12, 8),
              child: Row(
                children: [
                  Image.asset('assets/app_icon.png', width: 28, height: 28),
                  if (MediaQuery.sizeOf(context).width >= 480) ...[
                    const SizedBox(width: 12),
                    Text('Harness', style: grid.AppType.heading()),
                  ],
                  const Spacer(),
                  if (!browserHasAppStore()) const WebDownloadButton(),
                ],
              ),
            ),
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final compact = constraints.maxHeight < 650;
                  final gap = compact ? 16.0 : 24.0;
                  return SingleChildScrollView(
                    padding: const EdgeInsets.all(24),
                    child: ConstrainedBox(
                      constraints: BoxConstraints(
                        minHeight: (constraints.maxHeight - 48).clamp(
                          0,
                          double.infinity,
                        ),
                      ),
                      child: Center(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 1000),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              ConstrainedBox(
                                constraints: const BoxConstraints(
                                  maxWidth: 820,
                                ),
                                child: Text(
                                  'Your agents, wherever they run',
                                  textAlign: TextAlign.center,
                                  style: grid.AppType.display().copyWith(
                                    fontSize:
                                        compact || constraints.maxWidth < 600
                                        ? 28
                                        : 44,
                                    height: 1.2,
                                  ),
                                ),
                              ),
                              const SizedBox(height: 16),
                              ConstrainedBox(
                                constraints: const BoxConstraints(
                                  maxWidth: 650,
                                ),
                                child: Text(
                                  reason ?? _pitch,
                                  textAlign: TextAlign.center,
                                  style: grid.AppType.body().copyWith(
                                    fontSize: 16,
                                    height: 1.5,
                                  ),
                                ),
                              ),
                              SizedBox(height: gap),
                              ConstrainedBox(
                                constraints: BoxConstraints(
                                  maxWidth: compact ? 560 : 960,
                                ),
                                child: LoginFleetMap(
                                  seamless: true,
                                  pinDetails:
                                      MediaQuery.sizeOf(context).width >= 480,
                                ),
                              ),
                              SizedBox(height: gap),
                              // Above the ways in, so a failed sign-in's reason
                              // and Try again land on screen (audit S15).
                              if (notifier.lastError != null &&
                                  !notifier.sessionExpired) ...[
                                ConstrainedBox(
                                  constraints: const BoxConstraints(
                                    maxWidth: 520,
                                  ),
                                  child: _ErrorTile(
                                    message: notifier.lastError!,
                                    onRetry: notifier.retryLogin,
                                  ),
                                ),
                                const SizedBox(height: 16),
                              ],
                              ConstrainedBox(
                                constraints: const BoxConstraints(
                                  maxWidth: 520,
                                ),
                                child: _Action(
                                  notifier: notifier,
                                  waiting: waiting,
                                  compact: compact,
                                  prominent: true,
                                  offerPhone: offerPhone,
                                ),
                              ),
                              SizedBox(height: gap),
                              const _Seal(divider: false),
                            ],
                          ),
                        ),
                      ),
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    ],
  );
}

/// The two buttons, and what they become while the browser is open.
///
/// One widget for both because they are one control in two states: the pressed
/// button's label changes, a spinner replaces its mark, the other steps back,
/// and Cancel appears below. Nothing moves position, so the wait reads as *this
/// button is working* rather than as a new screen.
class _Action extends StatefulWidget {
  const _Action({
    required this.notifier,
    required this.waiting,
    required this.compact,
    this.prominent = false,
    this.offerPhone = true,
  });

  final AppNotifier notifier;
  final bool waiting;

  /// A short window: the ways in close up, so the line under them — which is
  /// where an expired session and a failed sign-out are explained — stays on
  /// screen at the minimum window.
  final bool compact;
  final bool prominent;

  /// See [LoginScreen.offerPhone].
  final bool offerPhone;

  @override
  State<_Action> createState() => _ActionState();
}

class _ActionState extends State<_Action> {
  AppNotifier get notifier => widget.notifier;
  final _signInFocus = FocusNode(debugLabel: 'Sign in');
  String? _copiedUrl;
  String? _copyFailureUrl;
  bool _copying = false;

  @override
  void didUpdateWidget(covariant _Action oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.waiting && !widget.waiting) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && ModalRoute.of(context)?.isCurrent != false) {
          _signInFocus.requestFocus();
        }
      });
    }
  }

  @override
  void dispose() {
    _signInFocus.dispose();
    super.dispose();
  }

  Future<void> _copyLink() async {
    final url = notifier.pendingAuthorizeUrl;
    if (url == null || !notifier.signingIn || _copying) return;
    setState(() => _copying = true);
    var copied = false;
    try {
      await Clipboard.setData(ClipboardData(text: url));
      copied = true;
    } catch (_) {
      // Keep recovery in the same sign-in if the OS clipboard is unavailable.
    }
    if (!mounted) return;
    setState(() {
      _copying = false;
      if (notifier.signingIn && notifier.pendingAuthorizeUrl == url) {
        _copiedUrl = copied ? url : null;
        _copyFailureUrl = copied ? null : url;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final buttonStyle = widget.prominent
        ? FilledButton.styleFrom(
            minimumSize: const Size(248, 56),
            padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 18),
            textStyle: grid.AppType.heading(),
          )
        : null;

    if (!widget.waiting) {
      final signingOutFailed = notifier.signOutError != null;
      return Column(
        children: [
          if (signingOutFailed)
            FilledButton.icon(
              style: buttonStyle,
              focusNode: _signInFocus,
              autofocus: true,
              onPressed: notifier.logout,
              icon: const Icon(AppIcons.logOut, size: grid.AppControl.iconSize),
              label: const Text('Retry sign out'),
            )
          else
            _waysIn(
              otherWays: [
                // The other way in: a QR a phone already signed in scans and approves. Not on a
                // web page at phone width — that page IS the phone.
                if (widget.offerPhone &&
                    notifier.canSignInWithPhone &&
                    !(kIsWeb && MediaQuery.sizeOf(context).width < 720)) ...[
                  if (!widget.compact) const OrDivider(),
                  OutlinedButton.icon(
                    key: const Key('login-scan-with-phone'),
                    style: widget.compact
                        ? null
                        : OutlinedButton.styleFrom(
                            minimumSize: SignInProviderButton.minimumSize(
                              prominent: widget.prominent,
                            ),
                          ),
                    onPressed: notifier.loginWithPhone,
                    icon: const Icon(AppIcons.smartphone, size: 16),
                    label: const Text('Scan with your phone'),
                  ),
                ],
                // The quiet way in: the sign-in page's own chooser, which takes
                // an email and the code sent to it. Small on purpose — waiting
                // for a code is slower, and most people use Google or Apple
                // (owner, 2026-10-11). Not in a browser, whose page is as it
                // was; and not in a short window, where a row more would push
                // the line that explains an expired session off the screen.
                // Words, not a box, and not stretched to the buttons' width:
                // a text button here drew as one more of them.
                if (!kIsWeb && !widget.compact)
                  Center(
                    child: QuietLink(
                      key: const Key('login-continue-email'),
                      label: 'Continue with email',
                      onPressed: () => unawaited(notifier.login()),
                    ),
                  ),
              ],
            ),
          const SizedBox(height: 12),
          Semantics(
            liveRegion: signingOutFailed || notifier.sessionExpired,
            child: Text(
              notifier.signOutError ??
                  (notifier.sessionExpired ? notifier.lastError : null) ??
                  (kIsWeb
                      ? 'Sign in to open your workspace.'
                      : 'Sign in through your browser to continue.'),
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        ],
      );
    }

    // A phone scanning the QR, then whose account approved it: someone else's phone may have
    // scanned the code, and nothing is signed in until the person here says yes.
    if (notifier.approvalSignIn case final method?) {
      return _RevealOnShow(
        child: ApprovalSignInPanel(
          method: method,
          qrLink: notifier.pendingQrLink,
          code: notifier.pendingSignInCode,
          refreshAt: notifier.approvalRefreshAt,
          confirmEmail: notifier.pendingConfirmEmail,
          previousEmail: notifier.previousAccountEmail,
          answered: notifier.approvalAnswered,
          onConfirm: notifier.confirmPhoneSignIn,
          // Back to the ways in: that is where the browser's way in is chosen.
          onCancel: notifier.cancelLogin,
        ),
      );
    }

    final url = notifier.pendingAuthorizeUrl;
    final message =
        notifier.loginBrowserError ??
        // The CLI is waiting before it can even start: say on what.
        notifier.loginWaitingNote ??
        (url != null && _copyFailureUrl == url
            ? 'Couldn’t copy the link. Try opening your browser again.'
            : null);
    final working = notifier.signingOut
        ? 'Signing out…'
        : (url == null ? 'Signing in…' : 'Waiting for your browser');
    // The button the person pressed. A sign-out has none, and neither has a
    // sign-in started away from these buttons.
    final pressed = notifier.signingOut ? null : notifier.signInProvider;
    return Column(
      children: [
        // Disabled, not hidden: the control the user just pressed has to stay
        // where they left it, saying what it is doing.
        if (pressed != null)
          _waysIn(working: (provider: pressed, label: working))
        else
          FilledButton.icon(
            style: buttonStyle,
            onPressed: null,
            icon: const SizedBox(
              width: grid.AppControl.iconSize,
              height: grid.AppControl.iconSize,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            label: Text(working),
          ),
        const SizedBox(height: 12),
        Semantics(
          liveRegion: true,
          child: Text(
            notifier.signingOut
                ? 'Clearing your saved sign-in.'
                : message ??
                      (url == null
                          ? 'Your workspace will open when sign-in is complete.'
                          : 'Finish signing in in your browser, then return here.'),
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
        if (url != null || notifier.canCancelLogin) ...[
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            alignment: WrapAlignment.center,
            children: [
              if (url != null) ...[
                OutlinedButton.icon(
                  onPressed: notifier.openingLoginBrowser
                      ? null
                      : notifier.openLoginBrowser,
                  icon: const Icon(AppIcons.externalLink, size: 16),
                  label: Text(
                    notifier.openingLoginBrowser
                        ? 'Opening browser…'
                        : 'Open browser',
                  ),
                ),
                TextButton.icon(
                  onPressed: _copying ? null : _copyLink,
                  icon: Icon(
                    _copiedUrl == url ? AppIcons.check : AppIcons.copy,
                    size: 16,
                  ),
                  label: Semantics(
                    liveRegion: true,
                    child: Text(
                      _copiedUrl == url ? 'Link copied' : 'Copy link',
                    ),
                  ),
                ),
              ],
              if (notifier.canCancelLogin)
                TextButton(
                  autofocus: true,
                  onPressed: notifier.cancelLogin,
                  style: TextButton.styleFrom(
                    foregroundColor: grid.AppPalette.textSecondary,
                  ),
                  child: const Text('Cancel'),
                ),
            ],
          ),
        ],
      ],
    );
  }

  /// Continue with Google, Continue with Apple, then [otherWays] — all one
  /// column of rows the same width. [working] is the account whose sign-in is
  /// in flight and what it says meanwhile; neither can be pressed then.
  Widget _waysIn({
    ({SignInProvider provider, String label})? working,
    List<Widget> otherWays = const [],
  }) => IntrinsicWidth(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      spacing: 10,
      children: [
        for (final provider in SignInProvider.values)
          SignInProviderButton(
            provider: provider,
            prominent: widget.prominent,
            focusNode: provider == SignInProvider.values.first
                ? _signInFocus
                : null,
            autofocus: provider == SignInProvider.values.first,
            onPressed: working == null
                ? () => unawaited(notifier.login(provider))
                : null,
            busyLabel: provider == working?.provider ? working?.label : null,
          ),
        ...otherWays,
      ],
    ),
  );
}

/// A failure the user can act on.
///
/// The old screen printed the raw error in `Colors.red` with no container and
/// no way forward. Two things changed: the colour is a token that resolves per
/// theme, and there is a retry — the house rule is that every empty, loading
/// and error state offers a way on.
class _ErrorTile extends StatelessWidget {
  const _ErrorTile({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // Error INK on a surface, not `dangerFill`, which is tuned to carry white
    // lettering on top of it and is far too dark to read *as* text.
    final danger = grid.AppTheme.pick(
      const Color(0xFFB3261E),
      const Color(0xFFF2544B),
    );

    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: grid.AppCard.inset,
        // Radius 8 inside a 14 card — a child is never rounder than its parent.
        borderRadius: BorderRadius.circular(grid.AppCard.insetRadius),
      ),
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(AppIcons.circleAlert, size: 16, color: danger),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Could not sign in',
                  style: Theme.of(context).textTheme.labelMedium
                      ?.copyWith(color: danger),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          SelectableText(message, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerLeft,
            child: OutlinedButton(
              onPressed: onRetry,
              // A finger's size on a phone, as the buttons below it are; the
              // web's phone layout starts under 720 px.
              style: MediaQuery.sizeOf(context).width < 720
                  ? OutlinedButton.styleFrom(
                      minimumSize: const Size.square(kFingerTarget),
                    )
                  : null,
              child: const Text('Try again'),
            ),
          ),
        ],
      ),
    );
  }
}

/// The quiet line at the foot of the card.
///
/// It says the guarantee in words anyone has — the cipher names that used to
/// sit here (`Ed25519 · ChaCha20-Poly1305`) were true, and unreadable to almost
/// everyone who saw them; they belong on a security page, not on the one screen
/// standing between someone and their work.
class _Seal extends StatelessWidget {
  const _Seal({this.divider = true});
  final bool divider;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Column(
      children: [
        if (divider) ...[
          Divider(height: 1, color: grid.AppPalette.divider),
          const SizedBox(height: 16),
        ],
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(AppIcons.lock, size: 14, color: grid.AppPalette.teal),
            const SizedBox(width: 8),
            Text(
              'End-to-end encrypted',
              style: Theme.of(context).textTheme.labelSmall
                  ?.copyWith(color: grid.AppPalette.textSecondary),
            ),
          ],
        ),
      ],
    );
  }
}

/// Opens required sign-in over a caller that needs an account. Native uses the
/// onboarding page and stays until an account arrives. The saved workspace and
/// running harnesses remain intact underneath.
Future<bool> showSignInSheet(
  BuildContext context,
  AppNotifier notifier, {
  String? reason,
  bool offerPhone = true,
}) async {
  if (notifier.signedIn) return true;
  final completed = await Navigator.of(context).push<bool>(
    PageRouteBuilder<bool>(
      opaque: true,
      barrierDismissible: false,
      transitionDuration: Duration.zero,
      reverseTransitionDuration: Duration.zero,
      pageBuilder: (_, _, _) => _SignInSheet(
        notifier: notifier,
        reason: reason,
        offerPhone: offerPhone,
      ),
    ),
  );
  return completed ?? notifier.signedIn;
}

class _SignInSheet extends StatefulWidget {
  const _SignInSheet({
    required this.notifier,
    this.reason,
    this.offerPhone = true,
  });

  final AppNotifier notifier;
  final String? reason;
  final bool offerPhone;

  @override
  State<_SignInSheet> createState() => _SignInSheetState();
}

class _SignInSheetState extends State<_SignInSheet> {
  AppNotifier get notifier => widget.notifier;
  bool _popped = false;

  @override
  void initState() {
    super.initState();
    notifier.addListener(_onChange);
  }

  @override
  void dispose() {
    notifier.removeListener(_onChange);
    super.dispose();
  }

  /// The account arriving is what closes this — not the sign-in call returning.
  /// A restart of the daemon onto the account and the desk being re-seated both
  /// happen after the browser lands, and holding the sheet over them is what
  /// keeps the person from clicking into a grid that is being rebuilt.
  void _onChange() {
    if (_popped || !mounted || !notifier.signedIn) return;
    _popped = true;
    // ⚠️ AFTER the frame. The account arrives in the middle of a rebuild — the
    // notification that carries it comes from work started during one — and
    // popping there is `setState() called during build`, which is what left the
    // sheet standing over a desk that was already signed in (owner,
    // 2026-09-23). One frame later the tree is settled and the route leaves
    // cleanly.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      Navigator.of(context).pop(true);
    });
  }

  @override
  Widget build(BuildContext context) {
    if (!kIsWeb) {
      return PopScope(canPop: false, child: SignInStepScreen(app: notifier));
    }
    // ⚠️ THE SCREEN ITSELF, not a smaller copy of it. A sheet with its own
    // layout was a second sign-in to keep in step with this one — two cards,
    // two button states, two sets of words — and it read as the login screen
    // having been redesigned (owner, 2026-09-23). What changes here is only
    // WHERE it appears: over the desk, with a way back out.
    // ⚠️ Esc is bound OUT HERE, around the screen, so the screen's own Esc — which
    // cancels a sign-in that is in flight — wins while there is one to cancel.
    // The X itself is the SCREEN's, on its card: see LoginScreen.onClose.
    // ⚠️ This route is built once, apart from the shell that rebuilds the
    // full-window screen, so it follows the notifier itself: a sign-in shows
    // what arrives mid-flight here too — the phone's QR, then whose account.
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.escape, includeRepeats: false):
            _dismiss,
      },
      child: ListenableBuilder(
        listenable: notifier,
        builder: (_, _) => LoginScreen(
          notifier: notifier,
          onClose: _dismiss,
          reason: widget.reason,
          offerPhone: widget.offerPhone,
        ),
      ),
    );
  }

  void _dismiss() {
    if (notifier.canCancelLogin) notifier.cancelLogin();
    Navigator.of(context).pop(false);
  }
}

/// Scrolls its child into view when it first appears: the QR and its Cancel are taller than the
/// button they replace, and on a short window they would otherwise land below the fold.
class _RevealOnShow extends StatefulWidget {
  const _RevealOnShow({required this.child});

  final Widget child;

  @override
  State<_RevealOnShow> createState() => _RevealOnShowState();
}

class _RevealOnShowState extends State<_RevealOnShow> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(Scrollable.ensureVisible(context, alignment: 1));
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
