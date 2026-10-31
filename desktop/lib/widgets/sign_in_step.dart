import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../auth/phone_sign_in.dart';
import '../auth/sign_in_provider.dart';
import '../logging/app_log.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import 'approval_sign_in_panel.dart';
import 'or_divider.dart';
import 'quiet_link.dart';
import 'setup_tour.dart';
import 'sign_in_provider_button.dart';
import 'window_chrome.dart';

/// Required sign-in after setup on a computer that holds no account
/// ([AppNotifier.signInStepShowing]).
///
/// It stands where the tour stood and looks like its last slide: what an
/// account adds on the left, one line each, and the ways in on the right:
/// Continue with Google, Continue with Apple, and the browser sign-in page's
/// other ways (email, GitHub, passkey) as a button of the same size; then,
/// after OR, Scan with your phone and Sign in on another device — the ways a
/// new or remote computer signs in with no browser of its own (Scholes's
/// end-to-end test of 1.3.44, 2026-10-31: a remote computer stopped here).
/// Nothing on it changes while the browser is open — every way in stays live
/// instead (owner, 2026-10-11). A scan or code under way takes the ways in's
/// place ([approval]) until it is approved or cancelled.
/// Design: `docs/research/2026-10-08-onboarding-redesign/index.html`, 1b.

/// The page's two lines of title.
const signInStepTitle = 'Sign in to take\nHarness everywhere.';

/// What an account adds, one line each.
const signInStepBenefits = [
  (icon: AppIcons.monitor, line: 'All your machines, one window'),
  (icon: AppIcons.smartphone, line: 'Your agents on your phone'),
  (icon: AppIcons.globe, line: 'Harness in any browser'),
  (icon: AppIcons.panelsTopLeft, line: 'Same tabs on every computer'),
];

/// The page itself, apart from the app: what it says and its three controls.
class SignInStep extends StatelessWidget {
  const SignInStep({
    super.key,
    required this.onSignIn,
    this.onApprove,
    this.approval,
    this.starting = false,
    this.startingProvider,
    this.finishing = false,
    this.error,
    this.sessionExpired = false,
    this.signingOut = false,
    this.signOutError,
    this.onRetrySignOut,
    this.recovery,
  });

  /// Continue with Google, Continue with Apple, or — with no provider — Email,
  /// GitHub or passkey, which is the sign-in page's own chooser.
  final ValueChanged<SignInProvider?> onSignIn;

  /// Scan with your phone, or Sign in on another device. Null where this app
  /// cannot sign in that way: the page then offers the browser alone.
  final ValueChanged<ApprovalSignIn>? onApprove;

  /// A scan or a code under way ([ApprovalSignInPanel]): shown in place of the
  /// ways in.
  final Widget? approval;

  /// A sign-in was pressed and its browser has not opened yet. The control
  /// that began it ([startingProvider]; none is email) steps back for that
  /// moment so the press reads as taken. Its words do not change.
  final bool starting;
  final SignInProvider? startingProvider;

  /// The browser has approved and the account is being seated.
  final bool finishing;

  /// Why the last sign-in did not finish.
  final String? error;
  final bool sessionExpired;
  final bool signingOut;
  final String? signOutError;
  final VoidCallback? onRetrySignOut;
  final Widget? recovery;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Material(
      key: const Key('sign-in-step'),
      color: grid.AppPalette.windowBg,
      child: LayoutBuilder(
        builder: (context, constraints) {
          // The tour's own margins: 5% of the window's width.
          final gutter = (constraints.maxWidth * 0.05).clamp(28.0, 72.0);
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(child: _stage(context, gutter)),
              _ReadyBar(
                gutter: gutter,
                line: signingOut
                    ? 'Signing out…'
                    : finishing
                    ? 'Signing in…'
                    : sessionExpired
                    ? 'Your session ended. Sign in again to continue.'
                    : 'Sign in to continue.',
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _stage(BuildContext context, double gutter) {
    final width = MediaQuery.sizeOf(context).width;
    final titleSize = (width * 0.031).clamp(28.0, 44.0);
    final text = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          header: true,
          child: Text(
            signInStepTitle,
            key: const Key('sign-in-step-title'),
            style:
                grid.AppType.display(
                  color: grid.AppPalette.textPrimary,
                  fontWeight: FontWeight.w700,
                ).copyWith(
                  fontSize: titleSize,
                  height: 1.08,
                  letterSpacing: -0.02 * titleSize,
                ),
          ),
        ),
        const SizedBox(height: 26),
        for (final (index, benefit) in signInStepBenefits.indexed) ...[
          if (index > 0) const SizedBox(height: 16),
          _Benefit(icon: benefit.icon, line: benefit.line),
        ],
      ],
    );
    return Stack(
      children: [
        const Positioned.fill(child: TourGlow()),
        Positioned.fill(
          child: Padding(
            // Top: clear of the traffic lights' band. Bottom: room for the
            // tagline.
            padding: EdgeInsets.fromLTRB(
              gutter,
              windowDragBandHeight + 16,
              gutter,
              56,
            ),
            child: Row(
              children: [
                Expanded(
                  flex: 120,
                  child: Center(
                    child: SingleChildScrollView(
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: text,
                      ),
                    ),
                  ),
                ),
                SizedBox(width: gutter * 0.8),
                Expanded(
                  flex: 100,
                  child: Center(
                    child: SingleChildScrollView(child: _waysIn(context)),
                  ),
                ),
              ],
            ),
          ),
        ),
        Positioned(
          left: gutter,
          right: gutter,
          bottom: 20,
          child: Text(
            tourTagline,
            style: grid.AppType.label(color: grid.AppPalette.onboardingTagline)
                .copyWith(fontSize: 13.5, letterSpacing: 0.3),
          ),
        ),
      ],
    );
  }

  Widget _waysIn(BuildContext context) => ConstrainedBox(
    constraints: const BoxConstraints(maxWidth: 440),
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        spacing: 12,
        children: [
          if (signingOut)
            const Center(
              child: SizedBox.square(
                dimension: 24,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            )
          else if (signOutError != null)
            FilledButton(
              autofocus: true,
              onPressed: onRetrySignOut,
              child: const Text('Retry sign out'),
            )
          else if (approval case final approval?)
            approval
          else ...[
            for (final provider in SignInProvider.values)
              _stepsBack(
                starting && startingProvider == provider,
                SignInProviderButton(
                  provider: provider,
                  prominent: true,
                  // Return signs in with the first.
                  autofocus: provider == SignInProvider.values.first,
                  onPressed: () => onSignIn(provider),
                ),
              ),
            // The sign-in page's own chooser: an email and its code, GitHub,
            // or a passkey. A button named for what it opens, not small print.
            _stepsBack(
              starting && startingProvider == null,
              FilledButton.icon(
                key: const Key('sign-in-step-email'),
                onPressed: () => onSignIn(null),
                style: _otherWay(filled: true),
                icon: const Icon(AppIcons.mail, size: 18),
                label: const Text(
                  'Email, GitHub or passkey',
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
            if (onApprove case final approve?) ...[
              const OrDivider(),
              OutlinedButton.icon(
                key: const Key('sign-in-step-scan'),
                onPressed: () => approve(ApprovalSignIn.phone),
                style: _otherWay(),
                icon: const Icon(AppIcons.smartphone, size: 18),
                label: const Text(
                  'Scan with your phone',
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              OutlinedButton.icon(
                key: const Key('sign-in-step-code'),
                onPressed: () => approve(ApprovalSignIn.code),
                style: _otherWay(),
                icon: const Icon(AppIcons.keyboard, size: 18),
                label: const Text(
                  'Sign in on another device',
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ],
          if ((signOutError ?? error) case final error?)
            Semantics(
              liveRegion: true,
              child: Text(
                error,
                key: const Key('sign-in-step-error'),
                style: grid.AppType.label(
                  color: Theme.of(context).colorScheme.error,
                ),
              ),
            ),
          if (recovery case final recovery?) recovery,
        ],
      ),
    ),
  );

  /// The ways in beside Google and Apple: their size and type, in the app's
  /// own colours — a raised card fill for the browser page's other ways, an
  /// outline for those another device approves.
  ButtonStyle _otherWay({bool filled = false}) {
    final ink = grid.AppPalette.textPrimary;
    return ButtonStyle(
      minimumSize: WidgetStatePropertyAll(
        SignInProviderButton.minimumSize(prominent: true),
      ),
      textStyle: WidgetStatePropertyAll(grid.AppType.heading()),
      foregroundColor: WidgetStatePropertyAll(ink),
      iconColor: WidgetStatePropertyAll(ink),
      backgroundColor: WidgetStatePropertyAll(
        filled ? grid.AppPalette.cardBg : Colors.transparent,
      ),
      side: WidgetStatePropertyAll(BorderSide(color: grid.AppPalette.divider)),
      overlayColor: WidgetStateProperty.resolveWith(
        (states) => ink.withValues(
          alpha: states.contains(WidgetState.pressed)
              ? .12
              : states.contains(WidgetState.hovered)
              ? .06
              : 0,
        ),
      ),
    );
  }

  /// [child], stepped back while its own sign-in is starting.
  Widget _stepsBack(bool back, Widget child) => AnimatedOpacity(
    opacity: back ? 0.55 : 1,
    duration: const Duration(milliseconds: 120),
    child: child,
  );
}

class _Benefit extends StatelessWidget {
  const _Benefit({required this.icon, required this.line});

  final IconData icon;
  final String line;

  @override
  Widget build(BuildContext context) {
    final accent = grid.AppPalette.onboardingAccent;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(
            color: accent.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: accent.withValues(alpha: 0.28)),
          ),
          child: ExcludeSemantics(child: Icon(icon, size: 18, color: accent)),
        ),
        const SizedBox(width: 14),
        Flexible(
          child: Text(
            line,
            style: grid.AppType.body(color: grid.AppPalette.textPrimary)
                .copyWith(fontSize: 18, fontWeight: FontWeight.w600),
          ),
        ),
      ],
    );
  }
}

/// The tour's install line in its finished state: this page comes after it.
class _ReadyBar extends StatelessWidget {
  const _ReadyBar({required this.gutter, required this.line});

  final double gutter;
  final String line;

  @override
  Widget build(BuildContext context) => Container(
    padding: EdgeInsets.fromLTRB(gutter, 14, gutter, 16),
    decoration: BoxDecoration(
      color: grid.AppPalette.panelBg,
      border: Border(top: BorderSide(color: grid.AppPalette.divider)),
    ),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            children: [
              Container(
                width: 8,
                height: 8,
                margin: const EdgeInsets.symmetric(horizontal: 3),
                decoration: BoxDecoration(
                  color: grid.AppPalette.online,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 8),
              Flexible(
                child: Semantics(
                  liveRegion: true,
                  child: Text(
                    line,
                    key: const Key('sign-in-step-ready-line'),
                    overflow: TextOverflow.ellipsis,
                    style: grid.AppType.label(
                      color: grid.AppPalette.textPrimary,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 9),
        ClipRRect(
          borderRadius: BorderRadius.circular(3),
          child: Container(height: 5, color: grid.AppPalette.online),
        ),
      ],
    ),
  );
}

/// The sign-in step bound to the app: shown by RootShell between setup and the
/// first workspace (see [AppNotifier.signInStepShowing]).
class SignInStepScreen extends StatefulWidget {
  const SignInStepScreen({super.key, required this.app});

  final AppNotifier app;

  @override
  State<SignInStepScreen> createState() => _SignInStepScreenState();
}

class _SignInStepScreenState extends State<SignInStepScreen> {
  var _wasSigningIn = false;

  /// Why a sign-in begun on this page ended without an account. Not
  /// [AppNotifier.lastError] as it stands: that also carries what the desk
  /// behind this page has to say, which is not this page's to show.
  String? _error;
  String? _copiedUrl;
  String? _copyFailureUrl;
  bool _copying = false;

  @override
  void initState() {
    super.initState();
    widget.app.addListener(_observeLogin);
    _observeLogin();
    appLog.info('onboarding', 'sign-in step: shown');
  }

  @override
  void didUpdateWidget(SignInStepScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.app != widget.app) {
      oldWidget.app.removeListener(_observeLogin);
      widget.app.addListener(_observeLogin);
      _wasSigningIn = false;
      _error = null;
      _observeLogin();
    }
  }

  @override
  void dispose() {
    widget.app.removeListener(_observeLogin);
    super.dispose();
  }

  // Capture both notifications when a sign-in fails before the next frame.
  void _observeLogin() {
    final app = widget.app;
    if (app.signingIn) {
      _error = null;
    } else if (_wasSigningIn) {
      _error = app.signedIn ? null : app.lastError;
    }
    _wasSigningIn = app.signingIn;
  }

  Future<void> _copyLink() async {
    final url = widget.app.pendingAuthorizeUrl;
    if (url == null || _copying) return;
    setState(() => _copying = true);
    var copied = false;
    try {
      await Clipboard.setData(ClipboardData(text: url));
      copied = true;
    } catch (_) {}
    if (!mounted) return;
    setState(() {
      _copying = false;
      if (widget.app.pendingAuthorizeUrl == url) {
        _copiedUrl = copied ? url : null;
        _copyFailureUrl = copied ? null : url;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final app = widget.app;
    return ListenableBuilder(
      listenable: app,
      builder: (context, _) {
        return CallbackShortcuts(
          bindings: {
            if (app.canCancelLogin)
              const SingleActivator(
                LogicalKeyboardKey.escape,
                includeRepeats: false,
              ): app.cancelLogin,
          },
          child: SignInStep(
            onSignIn: (provider) => unawaited(app.signInFromStep(provider)),
            onApprove: app.canSignInWithPhone && app.canSignInWithCode
                ? (method) => unawaited(app.approveFromStep(method))
                : null,
            approval: switch (app.approvalSignIn) {
              final method? => ApprovalSignInPanel(
                method: method,
                qrLink: app.pendingQrLink,
                code: app.pendingSignInCode,
                refreshAt: app.approvalRefreshAt,
                confirmEmail: app.pendingConfirmEmail,
                previousEmail: app.previousAccountEmail,
                answered: app.approvalAnswered,
                onConfirm: app.confirmPhoneSignIn,
                onCancel: app.cancelLogin,
              ),
              null => null,
            },
            // Its browser is not open yet: the CLI has to start before it can
            // name the page.
            starting: app.canCancelLogin && app.pendingAuthorizeUrl == null,
            startingProvider: app.signInProvider,
            finishing: app.signingIn && !app.canCancelLogin,
            error: app.loginBrowserError ?? _error,
            sessionExpired: app.sessionExpired,
            signingOut: app.signingOut,
            signOutError: app.signOutError,
            onRetrySignOut: () => unawaited(app.logout()),
            recovery:
                app.loginBrowserError != null && app.pendingAuthorizeUrl != null
                ? QuietLink(
                    key: const Key('sign-in-step-copy-link'),
                    label: _copiedUrl == app.pendingAuthorizeUrl
                        ? 'Link copied'
                        : _copyFailureUrl == app.pendingAuthorizeUrl
                        ? 'Could not copy. Try again'
                        : 'Copy sign-in link',
                    onPressed: _copying ? null : () => unawaited(_copyLink()),
                  )
                : null,
          ),
        );
      },
    );
  }
}
