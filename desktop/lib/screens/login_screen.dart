import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:harness/terminal/terminal_text.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../widgets/login_fleet_map.dart';
import '../widgets/login_relay_diagram.dart';

/// The sign-in screen.
///
/// Lead with the reach: your machines, wherever they are, feeding this one
/// window — the picture is [LoginFleetMap], and it moves only where a packet
/// moves. The privacy guarantee stays in the quiet footer.
///
/// **All four states live here**, in one card, rather than the two screens this
/// used to be. Pressing Sign in swapped the whole window for
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
  const LoginScreen({super.key, required this.notifier});

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
        !compact ||
        MediaQuery.textScalerOf(context).scale(terminalFontStore.size) <= 20;

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
        body: Stack(
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
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const _AppMark(),
                        SizedBox(height: gap),
                        Text(
                          'Your agents, wherever they run',
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'At home, at the office, in the cloud — every machine you '
                          'sign in to becomes part of one desk, here.',
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                        SizedBox(height: gap),
                        if (showFleet) ...[
                          const LoginFleetMap(),
                          SizedBox(height: gap),
                        ],
                        _Action(notifier: notifier, waiting: waiting),
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
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The button, and what it becomes while the browser is open.
///
/// One widget for both because they are one control in two states: the label
/// changes, a spinner replaces the glyph, and Cancel appears beside it. Nothing
/// moves position, so the wait reads as *this button is working* rather than as
/// a new screen.
class _Action extends StatefulWidget {
  const _Action({required this.notifier, required this.waiting});

  final AppNotifier notifier;
  final bool waiting;

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

    if (!widget.waiting) {
      final signingOutFailed = notifier.signOutError != null;
      return Column(
        children: [
          FilledButton.icon(
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
                  'Sign in through your browser to continue.',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall,
            ),
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
  const _Seal();

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Column(
      children: [
        Divider(height: 1, color: grid.AppPalette.divider),
        const SizedBox(height: 16),
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
