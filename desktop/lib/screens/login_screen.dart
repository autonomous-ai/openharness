import 'dart:async';

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/services.dart';

import '../auth/sign_in_provider.dart';
import '../shared/widgets/qr_code_view.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../widgets/login_fleet_map.dart';
import '../widgets/login_relay_diagram.dart';
import '../widgets/or_divider.dart';
import '../widgets/sign_in_provider_button.dart';
import '../widgets/web_download_button.dart';

/// The sign-in screen.
///
/// Lead with the reach: your machines, wherever they are, feeding this one
/// window — the picture is [LoginFleetMap], and it moves only where a packet
/// moves. The privacy guarantee stays in the quiet footer.
///
/// **All four states live here**, in one layout, rather than the two screens this
/// used to be. The web uses a full-page fleet map and prominent CTA; native
/// sign-in retains its compact card. Pressing Sign in once swapped the window for
/// `AwaitingBrowserLoginScreen`, at a different type scale — a hard cut in the
/// middle of a flow, and the reason the button's own spinner was almost never
/// seen. The wait is now a state of the button, so the frame never jumps.
///
/// The way in is two buttons, Continue with Google and Continue with Apple
/// ([SignInProviderButton]), as on the Autonomous storefront — not one Sign in
/// that left the choice to the browser (owner, 2026-10-01).
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

  /// Closes this screen, when there is something behind it to go back to.
  ///
  /// Null is the WALL: the viewer's sign-in, and any window with nothing of its
  /// own to show — there is nowhere to close to, and an X that led nowhere would
  /// be the only control on the screen that does nothing. Non-null is the sheet
  /// a guest desktop window raises over its desk (`showSignInSheet`), and the X
  /// belongs on the CARD, where a person looks for the close of the thing in
  /// front of them — not in the corner of the screen behind it (owner,
  /// 2026-09-23).
  final VoidCallback? onClose;

  const LoginScreen({super.key, required this.notifier, this.onClose});

  /// Matches `EnvironmentSetupScreen` (560) and `LinkMachineScreen` (460) —
  /// wide enough for the diagram to breathe, still centred at the 880×560
  /// minimum window.
  static const double _cardWidth = 520;

  @override
  Widget build(BuildContext context) {
    // Law 4: a widget that reads a colour token watches, or it freezes on the
    // boot palette when the theme flips. This screen used to call it zero times.
    grid.AppTheme.watch(context);

    // The same flag `RootShell` routes on, so the button's state and the reason
    // this screen is on screen at all can never disagree.
    final waiting = notifier.signingIn || notifier.signingOut;
    final compact = MediaQuery.sizeOf(context).height < 640;
    final gap = compact ? 16.0 : 24.0;
    // Preserve room for the primary action and its explanation at the minimum
    // window size with enlarged text. The illustration is supplementary.
    final showFleet =
        !compact || MediaQuery.textScalerOf(context).scale(16) <= 20;

    return CallbackShortcuts(
      bindings: {
        if (notifier.canCancelLogin)
          const SingleActivator(
            LogicalKeyboardKey.escape,
            includeRepeats: false,
          ): notifier.cancelLogin,
      },
      child: Scaffold(
        // The PANEL tone, not the window's. In light both `windowBg` and the
        // card's `surfaceFill` are pure white, so a card on the window is a card
        // you cannot see — only its shadow separates it, and at this size that
        // reads as a printing artefact rather than as a raised block. The rail's
        // own barely-there grey gives the card something to sit on in both
        // themes, which is the same trick the app plays everywhere else.
        backgroundColor: grid.AppPalette.panelBg,
        body: kIsWeb
            ? _webPage(context, waiting: waiting)
            : Stack(
                children: [
                  const Positioned.fill(child: LoginAurora()),
                  Center(
                    child: SingleChildScrollView(
                      padding: EdgeInsets.all(compact ? 16 : 24),
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: _cardWidth),
                        child: Container(
                          // The app's raised-block recipe: fill plus a soft lift, no rim.
                          decoration: BoxDecoration(
                            color: grid.AppGlass.surfaceFill,
                            borderRadius: BorderRadius.circular(14),
                            boxShadow: grid.AppCard.shadow,
                          ),
                          padding: EdgeInsets.all(compact ? 20 : 24),
                          child: Stack(
                            clipBehavior: Clip.none,
                            children: [
                              if (onClose != null)
                                // Into the card's own padding, so the glyph sits in
                                // the CORNER rather than level with the app mark —
                                // which read as a misplaced control (owner,
                                // 2026-09-23). Negative offsets need Clip.none above.
                                Positioned(
                                  top: compact ? -12 : -16,
                                  right: compact ? -12 : -16,
                                  child: IconButton(
                                    key: const Key('login-close-button'),
                                    tooltip: 'Close',
                                    iconSize: 18,
                                    visualDensity: VisualDensity.compact,
                                    color: grid.AppPalette.textSecondary,
                                    icon: const Icon(AppIcons.close),
                                    onPressed: onClose,
                                  ),
                                ),
                              Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  const _AppMark(),
                                  SizedBox(height: gap),
                                  Text(
                                    'Your agents, wherever they run',
                                    textAlign: TextAlign.center,
                                    style: grid.AppType.title(),
                                  ),
                                  const SizedBox(height: 8),
                                  Text(
                                    'At home, at the office, in the cloud — every machine you '
                                    'sign in to becomes part of one desk, here.',
                                    textAlign: TextAlign.center,
                                    style: Theme.of(context)
                                        .textTheme
                                        .bodySmall,
                                  ),
                                  SizedBox(height: gap),
                                  if (showFleet) ...[
                                    const LoginFleetMap(),
                                    SizedBox(height: gap),
                                  ],
                                  _Action(
                                    notifier: notifier,
                                    waiting: waiting,
                                    compact: compact,
                                  ),
                                  if (notifier.lastError != null &&
                                      !notifier.sessionExpired) ...[
                                    const SizedBox(height: 16),
                                    _ErrorTile(
                                      message: notifier.lastError!,
                                      onRetry: notifier.retryLogin,
                                    ),
                                  ],
                                  SizedBox(height: gap),
                                  const _Seal(),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
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
                  const WebDownloadButton(),
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
                                  'At home, at the office, in the cloud — every machine you '
                                  'sign in to becomes part of one desk, here.',
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
                                child: const LoginFleetMap(seamless: true),
                              ),
                              SizedBox(height: gap),
                              ConstrainedBox(
                                constraints: const BoxConstraints(
                                  maxWidth: 520,
                                ),
                                child: _Action(
                                  notifier: notifier,
                                  waiting: waiting,
                                  compact: compact,
                                  prominent: true,
                                ),
                              ),
                              if (notifier.lastError != null &&
                                  !notifier.sessionExpired) ...[
                                const SizedBox(height: 16),
                                ConstrainedBox(
                                  constraints: const BoxConstraints(
                                    maxWidth: 520,
                                  ),
                                  child: _ErrorTile(
                                    message: notifier.lastError!,
                                    onRetry: notifier.retryLogin,
                                  ),
                                ),
                              ],
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
  });

  final AppNotifier notifier;
  final bool waiting;

  /// A short window: the ways in close up, so the line under them — which is
  /// where an expired session and a failed sign-out are explained — stays on
  /// screen at the minimum window.
  final bool compact;
  final bool prominent;

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
                if (notifier.canSignInWithPhone &&
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

    // A phone approved this sign-in: whose account is it? Someone else's phone may have scanned
    // the code, and nothing is signed in until the person here says yes.
    if (notifier.pendingConfirmEmail case final email?) {
      final previous = notifier.previousAccountEmail;
      final changed =
          previous != null && previous.toLowerCase() != email.toLowerCase();
      return Column(
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
                ? 'This computer was signed in as $previous. Continue only if $email is yours.'
                : 'Your phone approved this sign-in. Continue only if this is your account.',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall
                ?.copyWith(color: changed ? grid.AppPalette.warn : null),
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 8,
            alignment: WrapAlignment.center,
            children: [
              FilledButton(
                key: const Key('login-phone-continue'),
                autofocus: true,
                onPressed: () => notifier.confirmPhoneSignIn(true),
                child: const Text('Continue'),
              ),
              TextButton(
                key: const Key('login-phone-refuse'),
                onPressed: () => notifier.confirmPhoneSignIn(false),
                child: const Text('Cancel'),
              ),
            ],
          ),
        ],
      );
    }

    // Waiting for a phone to scan the QR.
    if (notifier.pendingQrLink case final link?) {
      return _RevealOnShow(
        child: Column(
          children: [
            QrCodeView(
              key: const Key('login-phone-qr'),
              data: link,
              side: 200,
              semanticLabel: 'QR code to sign in with your phone',
            ),
            const SizedBox(height: 12),
            Text(
              'On your phone: Harness ▸ Settings ▸ Sign in a computer',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              alignment: WrapAlignment.center,
              children: [
                // Back to the two buttons: that is where the browser's way in is chosen.
                TextButton(
                  onPressed: notifier.cancelLogin,
                  style: TextButton.styleFrom(
                    foregroundColor: grid.AppPalette.textSecondary,
                  ),
                  child: const Text('Cancel'),
                ),
              ],
            ),
          ],
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
                  ?.copyWith(color: grid.AppPalette.textFaint),
            ),
          ],
        ),
      ],
    );
  }
}

/// The app icon, on a recess that gives it somewhere to stand.
///
/// The asset is the Dock icon: an amber mark on its own charcoal tile. At 40px
/// on this card that tile composites into the card behind it — they are within
/// a few points of the same grey — so the tile disappears and what is left is a
/// bare amber shape floating in the middle of an indigo-and-teal screen. It
/// read as a warning badge rather than as a logo, and it took the eye before
/// the headline did.
///
/// The fix is not to recolour the brand. It is to give the mark the ground it
/// was drawn to sit on: [grid.AppCard.inset] is a step *darker* than the card
/// in dark and a step warmer-grey in light, so the tile has an edge again in
/// both themes. The amber then reads as deliberate — the one warm thing on the
/// screen, contained — instead of as a sticker someone left on.
class _AppMark extends StatelessWidget {
  const _AppMark();

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Container(
      width: 56,
      height: 56,
      decoration: BoxDecoration(
        color: grid.AppCard.inset,
        // Radius 12 inside the card's 14 — a child is never rounder than its
        // parent, and the asset's own corners are rounder still inside this.
        borderRadius: BorderRadius.circular(12),
      ),
      alignment: Alignment.center,
      // No ClipRRect: the asset carries its own rounded corners, and clipping
      // would cut the edge twice. Same reason About renders it bare.
      child: Image.asset(
        'assets/app_icon.png',
        width: 36,
        height: 36,
        filterQuality: FilterQuality.medium,
      ),
    );
  }
}

/// The sign-in screen, raised OVER the desk rather than instead of it.
///
/// A desktop window opens on this computer without an account, and what an
/// account adds — the other machines, the shared desk, voice on the dial — is
/// asked for at the moment the person reaches for it. This is [LoginScreen]
/// ITSELF on a route above the desk, not a smaller copy: a second layout was a
/// second sign-in to keep in step, and it read as the screen having been
/// redesigned. [reason] is accepted for the call sites that have one to give.
///
/// Closes itself the moment the account arrives — [AppNotifier.signedIn] flips
/// — or when the person cancels, whichever comes first. Returns whether the
/// sign-in completed, so a caller that opened it on the way to something (Link
/// Machine, say) knows whether to carry on.
Future<bool> showSignInSheet(
  BuildContext context,
  AppNotifier notifier, {
  String? reason,
}) async {
  if (notifier.signedIn) return true;
  final completed = await Navigator.of(context).push<bool>(
    PageRouteBuilder<bool>(
      opaque: true,
      barrierDismissible: false,
      transitionDuration: Duration.zero,
      reverseTransitionDuration: Duration.zero,
      pageBuilder: (_, _, _) =>
          _SignInSheet(notifier: notifier, reason: reason),
    ),
  );
  return completed ?? notifier.signedIn;
}

class _SignInSheet extends StatefulWidget {
  const _SignInSheet({required this.notifier, this.reason});

  final AppNotifier notifier;
  final String? reason;

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
        builder: (_, _) => LoginScreen(notifier: notifier, onClose: _dismiss),
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
