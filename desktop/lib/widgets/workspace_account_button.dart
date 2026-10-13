import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'desktop_chrome.dart';
import 'workspace_bar_control.dart';

/// The last thing in the tab row, as in a browser's toolbar: Sign in while this
/// computer holds no account, and whose account it is once it does.
///
/// Sign in is the only control in the row with a word and a fill — everything
/// before it is an icon — because it is the one the row is asking for
/// (owner, 2026-10-11). Design:
/// `docs/research/2026-10-08-onboarding-redesign/index.html`, section 5.
class WorkspaceSignInButton extends StatelessWidget {
  const WorkspaceSignInButton({super.key, this.onPressed});

  final VoidCallback? onPressed;

  static const label = 'Sign in';
  static const tooltip = 'Sign in to Harness';

  static Size _labelSize(BuildContext context) {
    final painter = TextPainter(
      text: TextSpan(text: label, style: DesktopChrome.control(medium: true)),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    final size = painter.size;
    painter.dispose();
    return size;
  }

  static double widthOf(BuildContext context) => _labelSize(context).width + 28;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final enabled = onPressed != null;
    final accent = grid.AppPalette.swarmAccent;
    // The accent is the bar's own ink, so the bar's own surface reads on it.
    final ink = grid.AppPalette.swarmTabBar;
    return WorkspaceBarControl(
      label: label,
      tooltip: tooltip,
      onPressed: onPressed,
      builder: (context, emphasized) => Container(
        width: widthOf(context),
        height: math.max(
          grid.AppControl.heightSmall,
          _labelSize(context).height + 12,
        ),
        alignment: Alignment.center,
        decoration: ShapeDecoration(
          color: accent.withValues(
            alpha: !enabled
                ? .35
                : emphasized
                ? 1
                : .9,
          ),
          shape: const StadiumBorder(),
        ),
        child: Text(
          label,
          maxLines: 1,
          softWrap: false,
          style: DesktopChrome.control(color: ink, medium: true),
        ),
      ),
    );
  }
}

/// Whose account this window is signed in to: its initial, in a circle. A
/// press opens the account menu (`account_menu.dart`).
///
/// The initial, not the account's picture: the Mac's tab row is native and
/// loads nothing from the web, and the two hosts draw the same thing.
class WorkspaceAvatarButton extends StatelessWidget {
  const WorkspaceAvatarButton({
    super.key,
    required this.initial,
    required this.tooltip,
    this.onPressed,
  });

  /// One letter, or empty while the profile has not been read: a person mark.
  final String initial;
  final String tooltip;
  final VoidCallback? onPressed;

  /// The circle. Its slot in the row is [widthOf].
  static const diameter = 24.0;

  static double widthOf(BuildContext context) => diameter + 8;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final enabled = onPressed != null;
    final accent = grid.AppPalette.swarmAccent;
    return WorkspaceBarControl(
      label: 'Account',
      tooltip: tooltip,
      onPressed: onPressed,
      builder: (context, emphasized) => SizedBox(
        width: widthOf(context),
        height: math.max(grid.AppControl.heightSmall, diameter),
        child: Center(
          child: AccountAvatar(
            initial: initial,
            diameter: diameter,
            emphasized: emphasized,
            enabled: enabled,
            accent: accent,
          ),
        ),
      ),
    );
  }
}

/// The account's mark, in the tab row and at the head of its menu.
class AccountAvatar extends StatelessWidget {
  const AccountAvatar({
    super.key,
    required this.initial,
    required this.diameter,
    required this.accent,
    this.emphasized = false,
    this.enabled = true,
  });

  final String initial;
  final double diameter;
  final Color accent;
  final bool emphasized;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final ink = accent.withValues(alpha: enabled ? 1 : .45);
    return Container(
      width: diameter,
      height: diameter,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: accent.withValues(alpha: emphasized ? .28 : .18),
        border: Border.all(
          color: accent.withValues(alpha: emphasized ? .7 : .4),
        ),
      ),
      child: initial.isEmpty
          ? Icon(AppIcons.user, size: diameter * .55, color: ink)
          : Text(
              initial,
              maxLines: 1,
              softWrap: false,
              // Its own size, whatever the window's text size: it is a mark in
              // a fixed circle, not a line of text.
              textScaler: TextScaler.noScaling,
              style: DesktopChrome.control(
                color: ink,
                medium: true,
              ).copyWith(fontSize: diameter * .48, height: 1),
            ),
    );
  }
}

/// The one letter an account wears: of its name, else of its email.
String accountInitial(String? name, String? email) {
  final source = ((name?.trim().isNotEmpty ?? false) ? name! : email ?? '')
      .trim();
  return source.isEmpty ? '' : source.characters.first.toUpperCase();
}
