import 'dart:async';

import 'package:flutter/material.dart';

import '../auth/sign_in_provider.dart';
import '../logging/app_log.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import 'quiet_link.dart';
import 'setup_tour.dart';
import 'sign_in_provider_button.dart';
import 'window_chrome.dart';

/// The sign-in step: the welcome's last page on a computer new to Harness that
/// holds no account ([AppNotifier.signInStepShowing]).
///
/// It stands where the tour stood and looks like its last slide: what an
/// account adds on the left, one line each, and Continue with Google and
/// Continue with Apple on the right. Under them, Skip and Continue with email.
/// Nothing else is on the page, and nothing on it changes while the browser is
/// open — every way in stays live instead (owner, 2026-10-11).
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

/// The page itself, apart from the app: what it says and its five controls.
class SignInStep extends StatelessWidget {
  const SignInStep({
    super.key,
    required this.onSignIn,
    required this.onSkip,
    this.starting = false,
    this.startingProvider,
    this.finishing = false,
    this.error,
  });

  /// Continue with Google, Continue with Apple, or — with no provider —
  /// Continue with email, which is the sign-in page's own chooser.
  final ValueChanged<SignInProvider?> onSignIn;
  final VoidCallback onSkip;

  /// A sign-in was pressed and its browser has not opened yet. The control
  /// that began it ([startingProvider]; none is email) steps back for that
  /// moment so the press reads as taken. Its words do not change.
  final bool starting;
  final SignInProvider? startingProvider;

  /// The browser has approved and the account is being seated.
  final bool finishing;

  /// Why the last sign-in did not finish.
  final String? error;

  /// The card's padding: the row under it starts and ends where the buttons
  /// inside it do.
  static const _cardPadding = 24.0;

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
                line: finishing ? 'Signing in…' : 'Harness is ready.',
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
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          // The app's raised-block recipe, as the sign-in card: fill plus a
          // soft lift, no rim.
          decoration: BoxDecoration(
            color: grid.AppGlass.surfaceFill,
            borderRadius: BorderRadius.circular(14),
            boxShadow: grid.AppCard.shadow,
          ),
          padding: const EdgeInsets.all(_cardPadding),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            spacing: 12,
            children: [
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
            ],
          ),
        ),
        const SizedBox(height: 10),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: _cardPadding),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              QuietLink(
                key: const Key('sign-in-step-skip'),
                label: 'Skip',
                onPressed: onSkip,
              ),
              const SizedBox(width: 16),
              // The longer of the two gives way first, at a large text size in
              // a small window.
              Flexible(
                child: _stepsBack(
                  starting && startingProvider == null,
                  QuietLink(
                    key: const Key('sign-in-step-email'),
                    label: 'Continue with email',
                    onPressed: () => onSignIn(null),
                  ),
                ),
              ),
            ],
          ),
        ),
        if (error case final error?) ...[
          const SizedBox(height: 10),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: _cardPadding),
            child: Semantics(
              liveRegion: true,
              child: Text(
                error,
                key: const Key('sign-in-step-error'),
                style: grid.AppType.label(
                  color: Theme.of(context).colorScheme.error,
                ),
              ),
            ),
          ),
        ],
      ],
    ),
  );

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

  @override
  void initState() {
    super.initState();
    appLog.info('onboarding', 'sign-in step: shown');
  }

  @override
  Widget build(BuildContext context) {
    final app = widget.app;
    return ListenableBuilder(
      listenable: app,
      builder: (context, _) {
        if (app.signingIn) {
          _error = null;
        } else if (_wasSigningIn) {
          // A cancelled sign-in leaves no error; a failed one leaves its own.
          _error = app.signedIn ? null : app.lastError;
        }
        _wasSigningIn = app.signingIn;
        return SignInStep(
          onSignIn: (provider) => unawaited(app.signInFromStep(provider)),
          onSkip: app.skipSignInStep,
          // Its browser is not open yet: the CLI has to start before it can
          // name the page.
          starting: app.canCancelLogin && app.pendingAuthorizeUrl == null,
          startingProvider: app.signInProvider,
          finishing: app.signingIn && !app.canCancelLogin,
          error: _error,
        );
      },
    );
  }
}
