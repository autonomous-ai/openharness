import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kIsWeb, visibleForTesting;
import 'package:flutter/services.dart';

import '../core/test_run.dart';
import '../core/web_form_factor.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../widgets/add_phone_dialog.dart' show PhonePairQr;
import '../widgets/login_fleet_map.dart';
import '../widgets/login_relay_diagram.dart';
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

  /// A machine's QR was opened here by a phone's camera (`/pair#…`) before signing in: the page
  /// says what signing in is for — adding that machine — and shows its fingerprint to compare.
  final ({String name, String? fingerprint})? pairingWith;

  const LoginScreen({
    super.key,
    required this.notifier,
    this.onClose,
    this.pairingWith,
  });

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
    // The QR of a sign-in by phone takes the illustration's place: at the minimum window both do not fit.
    final linking = notifier.phoneLink != null;
    final byPhone =
        (notifier.signingInByPhone &&
            (notifier.pendingSignInQr != null ||
                notifier.pendingAuthorizeUrl == null)) ||
        notifier.pendingSignInQr != null ||
        linking;
    final showFleet =
        !byPhone &&
        (!compact || MediaQuery.textScalerOf(context).scale(16) <= 20);

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
            ? _webPage(
                context,
                waiting: waiting,
                byPhone: byPhone,
                linking: linking,
              )
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
                                    icon: const Icon(Icons.close),
                                    onPressed: onClose,
                                  ),
                                ),
                              Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  const _AppMark(),
                                  SizedBox(height: gap),
                                  Text(
                                    linking
                                        ? 'Adding this computer to your devices'
                                        : byPhone
                                        ? 'Sign in with your phone'
                                        : 'Your agents, wherever they run',
                                    key: const Key('login-title'),
                                    textAlign: TextAlign.center,
                                    style: grid.AppType.title(),
                                  ),
                                  const SizedBox(height: 8),
                                  Text(
                                    linking
                                        ? 'Your phone approved it. Linking the two, then every machine '
                                              'you have — this closes when it is done.'
                                        : byPhone
                                        ? 'Scan this code with your phone and approve. This computer '
                                              'joins your devices — no password.'
                                        : 'At home, at the office, in the cloud — every machine you '
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
                                    onClose: onClose,
                                  ),
                                  if (notifier.lastError != null &&
                                      !notifier.sessionExpired) ...[
                                    const SizedBox(height: 16),
                                    _ErrorTile(
                                      message: notifier.lastError!,
                                      onRetry: notifier.login,
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

  Widget _webPage(
    BuildContext context, {
    required bool waiting,
    required bool byPhone,
    required bool linking,
  }) => Stack(
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
                                  pairingWith != null
                                      ? 'Sign in to add ${pairingWith!.name} to your devices'
                                      : linking
                                      ? 'Adding this browser to your devices'
                                      : byPhone
                                      ? 'Sign in with your phone'
                                      : 'Your agents, wherever they run',
                                  key: const Key('login-title'),
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
                                  pairingWith != null
                                      ? 'Then approve it, and it reaches your other machines — no password.'
                                            '${pairingWith!.fingerprint != null ? '\nFingerprint ${pairingWith!.fingerprint}' : ''}'
                                      : linking
                                      ? 'Your phone approved it. Linking this browser to your machines — '
                                            'this page moves on when it is done.'
                                      : byPhone
                                      ? 'Scan this code with your phone and approve. This browser joins '
                                            'your devices — no password.'
                                      : 'At home, at the office, in the cloud — every machine you '
                                            'sign in to becomes part of one desk, here.',
                                  textAlign: TextAlign.center,
                                  style: grid.AppType.body().copyWith(
                                    fontSize: 16,
                                    height: 1.5,
                                  ),
                                ),
                              ),
                              // The QR takes the illustration's place, as on the desktop card.
                              if (!byPhone) ...[
                                SizedBox(height: gap),
                                ConstrainedBox(
                                  constraints: BoxConstraints(
                                    maxWidth: compact ? 560 : 960,
                                  ),
                                  child: const LoginFleetMap(seamless: true),
                                ),
                              ],
                              SizedBox(height: gap),
                              ConstrainedBox(
                                constraints: const BoxConstraints(
                                  maxWidth: 520,
                                ),
                                child: _Action(
                                  notifier: notifier,
                                  waiting: waiting,
                                  prominent: true,
                                  onClose: onClose,
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
                                    onRetry: notifier.login,
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

/// The button, and what it becomes while the browser is open.
///
/// One widget for both because they are one control in two states: the label
/// changes, a spinner replaces the glyph, and Cancel appears beside it. Nothing
/// moves position, so the wait reads as *this button is working* rather than as
/// a new screen.
class _Action extends StatefulWidget {
  const _Action({
    required this.notifier,
    required this.waiting,
    this.prominent = false,
    this.onClose,
  });

  final AppNotifier notifier;
  final bool waiting;
  final bool prominent;

  /// The sheet's close, for the link steps' own button once there is nothing left to wait for.
  final VoidCallback? onClose;

  @override
  State<_Action> createState() => _ActionState();
}

class _ActionState extends State<_Action> {
  AppNotifier get notifier => widget.notifier;
  final _signInFocus = FocusNode(debugLabel: 'Sign in');

  /// The QR link last copied, so the button says so for that code and not a fresh one.
  String? _qrLinkCopied;
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

    // Signed in by phone: the same scan goes on to link that phone and bring this computer into its
    // trust group. The sheet stays up through it and closes itself once it is done.
    if (notifier.phoneLink case final link?) {
      return _PhoneLinkSteps(link: link, onClose: widget.onClose);
    }

    if (!widget.waiting) {
      final signingOutFailed = notifier.signOutError != null;
      return Column(
        children: [
          FilledButton.icon(
            style: buttonStyle,
            focusNode: _signInFocus,
            autofocus: true,
            onPressed: signingOutFailed ? notifier.logout : notifier.login,
            icon: Icon(
              signingOutFailed ? Icons.logout : Icons.login,
              size: grid.AppControl.iconSize,
            ),
            label: Text(signingOutFailed ? 'Retry sign out' : 'Sign in'),
          ),
          const SizedBox(height: 12),
          Semantics(
            liveRegion: signingOutFailed || notifier.sessionExpired,
            child: Text(
              notifier.signOutError ??
                  (notifier.sessionExpired ? notifier.lastError : null) ??
                  (kIsWeb && isMobileWeb
                      // The phone's own browser approves others; it cannot scan its own screen.
                      ? 'Sign in to open your workspace. Signing in a computer or '
                            'another browser? Sign in here first, then scan its code with '
                            'your camera — or in the Harness app: ⋯ → Scan a QR code.'
                      : 'Sign in with your phone — scan a QR, no password.'),
              key: const Key('login-idle-hint'),
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
          // A web desktop without a phone to hand keeps the SSO page one click away.
          if (kIsWeb && !isMobileWeb && !signingOutFailed) ...[
            const SizedBox(height: 4),
            TextButton(
              key: const Key('login-sso'),
              onPressed: () => notifier.login(qr: false),
              child: const Text('Continue with SSO'),
            ),
          ],
        ],
      );
    }

    // Signing in by phone: the QR is the whole screen's job — scan, approve on the phone. Its
    // square is held from the first frame, so the code lands in place rather than pushing in.
    final qr = notifier.pendingSignInQr;
    // A CLI that predates the QR sign-in ignores `--qr` and opens the browser's SSO instead: once
    // its page is out, this is a browser sign-in, and the wait below says so.
    final browserInstead = qr == null && notifier.pendingAuthorizeUrl != null;
    if (!browserInstead &&
        (notifier.signingInByPhone && !notifier.signingOut || qr != null)) {
      final approved = notifier.signInQrStage == 'approved';
      return Column(
        key: const Key('login-qr'),
        children: [
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(10),
            ),
            child: qr == null
                ? const SizedBox(
                    width: 220,
                    height: 220,
                    child: Center(
                      child: SizedBox(
                        width: 22,
                        height: 22,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.black54,
                        ),
                      ),
                    ),
                  )
                : Opacity(
                    opacity: approved ? .25 : 1,
                    child: PhonePairQr(data: qr.url, side: 220),
                  ),
          ),
          const SizedBox(height: 12),
          Semantics(
            liveRegion: true,
            child: Text(
              qr == null
                  ? 'Preparing your code…'
                  : approved
                  ? 'Approved on your phone — signing in…'
                  : 'Waiting for your phone…',
              key: const Key('login-qr-status'),
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ),
          if (qr?.fingerprint case final fp?) ...[
            const SizedBox(height: 6),
            Text(
              'fingerprint  $fp — check your phone shows the same',
              textAlign: TextAlign.center,
              style: grid.AppType.monoMeta(),
            ),
          ],
          if (!approved) ...[const SizedBox(height: 14), const _ScanSteps()],
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            alignment: WrapAlignment.center,
            children: [
              // The link the QR encodes, for a phone that cannot scan it — sent to it by message
              // or AirDrop and opened there.
              if (qr != null && !approved)
                TextButton.icon(
                  key: const Key('login-copy-link'),
                  onPressed: () async {
                    try {
                      await Clipboard.setData(ClipboardData(text: qr.url));
                    } catch (_) {
                      return;
                    }
                    if (!mounted) return;
                    setState(() => _qrLinkCopied = qr.url);
                  },
                  icon: Icon(
                    _qrLinkCopied == qr.url ? Icons.check : Icons.link,
                    size: 16,
                  ),
                  label: Text(
                    _qrLinkCopied == qr.url ? 'Link copied' : 'Copy link',
                  ),
                ),
              TextButton.icon(
                key: const Key('login-use-browser'),
                onPressed: approved ? null : notifier.useBrowserSignIn,
                icon: const Icon(Icons.open_in_new, size: 16),
                label: Text(
                  kIsWeb ? 'Continue with SSO' : 'Use browser instead',
                ),
              ),
              if (notifier.canCancelLogin)
                TextButton(
                  onPressed: notifier.cancelLogin,
                  child: const Text('Cancel'),
                ),
            ],
          ),
        ],
      );
    }

    final url = notifier.pendingAuthorizeUrl;
    final message =
        notifier.loginBrowserError ??
        (url != null && _copyFailureUrl == url
            ? 'Couldn’t copy the link. Try opening your browser again.'
            : null);
    return Column(
      children: [
        FilledButton.icon(
          style: buttonStyle,
          // Disabled, not hidden: the control the user just pressed has to stay
          // where they left it, saying what it is doing.
          onPressed: null,
          icon: const SizedBox(
            width: grid.AppControl.iconSize,
            height: grid.AppControl.iconSize,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          label: Text(
            notifier.signingOut
                ? 'Signing out…'
                : (url == null ? 'Signing in…' : 'Waiting for your browser'),
          ),
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
                  icon: const Icon(Icons.open_in_new, size: 16),
                  label: Text(
                    notifier.openingLoginBrowser
                        ? 'Opening browser…'
                        : 'Open browser',
                  ),
                ),
                TextButton.icon(
                  onPressed: _copying ? null : _copyLink,
                  icon: Icon(
                    _copiedUrl == url ? Icons.check : Icons.content_copy,
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
              Icon(Icons.error_outline, size: 16, color: danger),
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
            Icon(Icons.lock_outline, size: 13, color: grid.AppPalette.teal),
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

/// Whether the sign-in sheet opens straight onto its phone QR. Off under `flutter test`, where
/// a sign-in nobody asked for would spawn the fake CLI's login in every sheet test.
@visibleForTesting
bool signInSheetStartsQr = !kUnderTest;

class _SignInSheetState extends State<_SignInSheet> {
  AppNotifier get notifier => widget.notifier;
  bool _popped = false;

  @override
  void initState() {
    super.initState();
    notifier.addListener(_onChange);
    // The sheet opens on the QR — there is nothing to press first. A phone that is signed in
    // scans it and approves; "Use browser instead" is one click away for anyone without one.
    if (signInSheetStartsQr &&
        notifier.viewer == null &&
        !notifier.signingIn &&
        !notifier.signingOut) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && !notifier.signedIn && !notifier.signingIn) {
          unawaited(notifier.login(qr: true));
        }
      });
    }
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
    // Signed in by phone: stay up while the two exchange keys, then hold the result a moment so it
    // can be read — a little longer for a problem, which Add Phone can still fix from the desk.
    final link = notifier.phoneLink;
    if (link != null) {
      if (!link.settled || _holding) return;
      _holding = true;
      final failed = link.stage == PhoneLinkStage.failed;
      Future<void>.delayed(failed ? _failedHold : _doneHold, () {
        if (mounted && !_popped) _pop();
        // A timer, not a build: nothing else may schedule the frame the pop waits for.
        WidgetsBinding.instance.scheduleFrame();
      });
      return;
    }
    _pop();
  }

  /// How long "reaches N machines" stays up before the sheet goes.
  static const _doneHold = Duration(milliseconds: 2500);
  static const _failedHold = Duration(seconds: 4);
  bool _holding = false;

  void _pop() {
    if (_popped) return;
    _popped = true;
    // ⚠️ AFTER the frame. The account arrives in the middle of a rebuild — the
    // notification that carries it comes from work started during one — and
    // popping there is `setState() called during build`, which is what left the
    // sheet standing over a desk that was already signed in (owner,
    // 2026-09-23). One frame later the tree is settled and the route leaves
    // cleanly.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      notifier.dismissPhoneLink();
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
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.escape, includeRepeats: false):
            _dismiss,
      },
      // A route is not rebuilt by the shell beneath it: it listens for itself, or the QR that
      // arrives after the sheet opened never reaches the screen.
      child: ListenableBuilder(
        listenable: notifier,
        builder: (_, _) => LoginScreen(notifier: notifier, onClose: _dismiss),
      ),
    );
  }

  void _dismiss() {
    if (_popped) return;
    if (notifier.signedIn) {
      // Closed mid-link: the link goes on behind the desk, nothing left to show it.
      _pop();
      return;
    }
    _popped = true;
    if (notifier.canCancelLogin) notifier.cancelLogin();
    Navigator.of(context).pop(false);
  }
}

/// After a sign-in by phone: what the same scan is still doing — linking that phone, then bringing
/// this computer into its trust group — one line per step, ticked off as the CLI reports them.
class _PhoneLinkSteps extends StatelessWidget {
  const _PhoneLinkSteps({required this.link, this.onClose});

  final PhoneLinkStatus link;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final phone = link.phone ?? 'your phone';
    final stage = link.stage;
    final linked =
        stage == PhoneLinkStage.linking || stage == PhoneLinkStage.done;
    final failed = stage == PhoneLinkStage.failed;
    final n = link.machines.length;
    return Column(
      key: const Key('login-phone-link'),
      children: [
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 380),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const _Step(
                state: _StepState.done,
                text: 'Approved on your phone',
              ),
              const _Step(state: _StepState.done, text: 'Signed in'),
              _Step(
                state: linked
                    ? _StepState.done
                    : failed && link.phone == null
                    ? _StepState.failed
                    : _StepState.busy,
                text: linked || link.phone != null
                    ? 'Linked with $phone'
                    : failed
                    ? (kIsWeb ? 'Link to your machines' : 'Link your phone')
                    : (kIsWeb
                          ? 'Linking to your machines…'
                          : 'Linking your phone…'),
              ),
              if (linked || (failed && link.phone != null))
                _Step(
                  state: stage == PhoneLinkStage.done
                      ? _StepState.done
                      : failed
                      ? _StepState.failed
                      : _StepState.busy,
                  text: stage != PhoneLinkStage.done
                      ? 'Adding this ${kIsWeb ? 'browser' : 'computer'} to your devices…'
                      : n == 0
                      ? 'Added — machines you link later join too'
                      : 'Reaches $n ${n == 1 ? 'machine' : 'machines'}: '
                            '${link.machines.join(' · ')}',
                ),
            ],
          ),
        ),
        if (failed) ...[
          const SizedBox(height: 12),
          Semantics(
            liveRegion: true,
            child: Text(
              "Couldn't finish linking${link.error == null ? '' : ' (${link.error})'}. "
              '${kIsWeb ? 'You are signed in — link your machines from Machines.' : 'You are signed in — add your phone again from Harness ▸ Add Phone….'}',
              key: const Key('login-phone-link-error'),
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall
                  ?.copyWith(color: grid.AppPalette.warn),
            ),
          ),
        ],
        if (link.settled && onClose != null) ...[
          const SizedBox(height: 12),
          TextButton(
            key: const Key('login-phone-link-close'),
            onPressed: onClose,
            child: Text(failed ? 'Close' : 'Done'),
          ),
        ],
      ],
    );
  }
}

enum _StepState { done, busy, failed }

class _Step extends StatelessWidget {
  const _Step({required this.state, required this.text});

  final _StepState state;
  final String text;

  @override
  Widget build(BuildContext context) {
    final color = switch (state) {
      _StepState.done => grid.AppPalette.accentOnSurface,
      _StepState.busy => grid.AppPalette.textSecondary,
      _StepState.failed => grid.AppPalette.warn,
    };
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 18,
            height: 18,
            child: state == _StepState.busy
                ? Padding(
                    padding: const EdgeInsets.all(2),
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: color,
                    ),
                  )
                : Icon(
                    state == _StepState.done
                        ? Icons.check_circle
                        : Icons.error_outline,
                    size: 18,
                    color: color,
                  ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: state == _StepState.busy
                    ? grid.AppPalette.textSecondary
                    : grid.AppPalette.textPrimary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// How to scan a sign-in QR, spelled out: nobody should have to guess which app does it.
///
/// ```
/// Scan it with your phone, either:
///  1  Camera — point it at the code and tap the link. Harness opens in
///     your phone's browser: sign in if asked, then tap Approve.
///  2  The Harness app — ⋯ → Scan a QR code, then Approve.
/// ```
class _ScanSteps extends StatelessWidget {
  const _ScanSteps();

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final body = Theme.of(context).textTheme.bodySmall;
    Widget step(String n, String title, String text) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 22,
            child: Text(
              n,
              style: grid.AppType.monoLabel(
                color: grid.AppPalette.accentOnSurface,
              ),
            ),
          ),
          Expanded(
            child: Text.rich(
              TextSpan(
                children: [
                  TextSpan(
                    text: title,
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  TextSpan(text: ' — $text'),
                ],
              ),
              style: body,
            ),
          ),
        ],
      ),
    );
    return ConstrainedBox(
      key: const Key('login-scan-steps'),
      constraints: const BoxConstraints(maxWidth: 420),
      child: Container(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
        decoration: BoxDecoration(
          color: grid.AppPalette.textPrimary.withValues(alpha: .05),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Scan it with your phone, either:', style: body),
            const SizedBox(height: 4),
            step(
              '1',
              'Camera',
              'point it at the code and tap the link. Harness opens in your '
                  "phone's browser: sign in if asked, then tap Approve.",
            ),
            step('2', 'The Harness app', '⋯ → Scan a QR code, then Approve.'),
          ],
        ),
      ),
    );
  }
}
