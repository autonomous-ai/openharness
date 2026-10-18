import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../tty.dart';
import '../tty_controls.dart';
import 'onboarding_picture.dart';
import 'set_up_computer.dart' show StepsTimeline, goToSteps;

/// How an onboarding screen's slots are measured: the welcome's, or "On your computer, go to"'s —
/// which every screen after signing in shares (its wait, and the computer joining), so the picture
/// stays put from one to the next.
enum OnboardingLayout {
  /// ① A headline of up to three lines — or, in its place while it is up, the status's two: why a
  /// sign-in did not finish, why the phone was signed out; the two accounts and, under them, one
  /// quiet line — Continue with email · QR code, or Cancel in their place — at the foot.
  welcome,

  /// ② The headline, the link and the steps on the computer under it — "Not you? Sign out" under
  /// the account among them; one quiet line at the foot, the wait's "See your computers ›" once it
  /// is slow.
  goTo,
}

/// The one layout every onboarding screen is drawn on — the welcome, "On your computer, go to" and
/// the computer joining — so that going from one to the next only the words change.
///
/// ```
/// ‹                                   (leading, trailing)
///
///   Manage all your agents on all      headline: 22pt mono semibold, up to three lines
///   your computers from your phone.    [underHeadline] — ②'s link and steps
///   ⇥ You were signed out. Sign in…    status, on ① — in the headline's place while it is up
///
///          ┌──────────────────┐
///          │     picture      │        the middle, the same place on every screen of a [layout]
///          └──────────────────┘
///      Looking for your computer▌      status, on ② — centred, under the picture
///
///   [ Continue with Google  ]          actions, at the foot
///   [ Continue with Apple   ]
///   ✉ Continue with email · ⊞ QR code  the quiet line: the lesser ways in, as words
/// ```
///
/// ⚠️ **Every slot is measured the same way on every screen of a [layout]**, whatever it holds — the
/// headline and what goes under it, the foot — so the picture sits at one height whichever of them
/// is up, and never moves (`docs/research/2026-10-11-phone-onboarding`, "Type and space"). It only
/// shrinks where the phone is short or the text large. Between the welcome and the screens after
/// it, the screen changes whole as the phone signs in, and the picture with it.
///
/// Between screens the words rise 8pt into place over 250ms (a 200ms fade under Reduce Motion);
/// what changes in the picture is its own business ([OnboardingPicture]).
class OnboardingFrame extends StatelessWidget {
  const OnboardingFrame({
    super.key,
    required this.headline,
    required this.picture,
    this.headlineKey,
    this.underHeadline,
    this.status,
    this.actions,
    this.leading,
    this.trailing,
    this.layout = OnboardingLayout.welcome,
  });

  final String headline;
  final Key? headlineKey;

  /// How the slots are measured — see the class comment.
  final OnboardingLayout layout;

  /// Under the headline, rising with it: "On your computer, go to"'s link and steps.
  final Widget? underHeadline;

  /// The picture, laid out in the middle at its own 320 × 300 proportions.
  final Widget picture;

  /// One centred line under the picture ([OnboardingStatus]) — on the welcome, in the headline's
  /// place instead while it is up (owner, 2026-10-14): what it says is what to read first, and the
  /// headline comes back as it goes.
  final Widget? status;

  /// The foot: the accounts and the quiet line under them.
  final Widget? actions;

  /// Top left, and top right — back, a way out.
  final Widget? leading;
  final Widget? trailing;

  /// The one left edge, and the right.
  static const double side = 35;

  static const double headlineSize = 22;
  static const double _headlineHeight = 1.32;

  /// The headline's face — 22pt mono semibold, set a little tighter than the terminal's — for every
  /// step of onboarding, the email's too.
  static TextStyle headlineStyle(Tty tty) => tty
      .style(size: headlineSize, weight: FontWeight.w600)
      .copyWith(height: _headlineHeight, letterSpacing: -.03 * headlineSize);

  /// The quiet line's size, and the status line's.
  static const double quietSize = TtySize.meta;

  /// ②'s steps under the link ([goToSteps]): the gap above them.
  static const double stepsAbove = 24;

  /// The picture may reach wider than the words, as far as this from each edge.
  static const double _pictureSide = 27;

  /// The top row, where back sits.
  static const double _bar = 44;

  @override
  Widget build(BuildContext context) {
    final scaler = MediaQuery.textScalerOf(context);
    final line = scaler.scale(headlineSize) * _headlineHeight;
    // A button is 52pt, or taller when its text is larger ([TtyPrimaryButton]).
    final button = math.max(
      TtyPrimaryButton.height,
      scaler.scale(TtySize.title) * 1.2 + 20,
    );
    final quiet = math.max(44.0, scaler.scale(quietSize) * 1.45);
    // Room for two lines of status: a sign-in's failure can run to a second.
    final statusRow = 2 * scaler.scale(quietSize) * 1.45;
    // ① says it in the headline's place; ② under the picture.
    final statusInHeadline = layout == OnboardingLayout.welcome;
    final (head, foot) = switch (layout) {
      // The headline's three lines, or the status's two in their place; the two accounts and the
      // quiet line under them.
      OnboardingLayout.welcome => (
        math.max(3 * line, statusRow),
        2 * button + 2 * _buttonGap + quiet + 8,
      ),
      // Two lines of headline, the link and the steps; one quiet line.
      OnboardingLayout.goTo => (
        2 * line +
            _underGap +
            button +
            stepsAbove +
            // With an account named, as it is once signed in, and "Not you? Sign out" under it.
            StepsTimeline.heightOf(goToSteps('you'), scaler, under: true),
        quiet + 8,
      ),
    };
    final underPicture = statusInHeadline ? 0.0 : 10 + statusRow;

    return LayoutBuilder(
      builder: (context, box) {
        final width = box.maxWidth, height = box.maxHeight;
        final headTop = _bar + 16;
        final middleTop = headTop + head + 24;
        final middleBottom = height - foot - 16;
        // The picture and its status line, centred in what is left between the words and the foot.
        final room = math.max(0.0, middleBottom - middleTop - underPicture);
        final pictureWidth = math.max(
          0.0,
          math.min(width - 2 * _pictureSide, room * 320 / 300),
        );
        final pictureHeight = pictureWidth * 300 / 320;
        final block = pictureHeight + underPicture;
        final pictureTop =
            middleTop + math.max(0.0, (middleBottom - middleTop - block) / 2);

        return Stack(
          children: [
            Positioned(
              left: 0,
              right: 0,
              top: pictureTop,
              height: pictureHeight,
              child: Center(
                child: SizedBox(
                  width: pictureWidth,
                  height: pictureHeight,
                  child: picture,
                ),
              ),
            ),
            if (status case final status? when !statusInHeadline)
              Positioned(
                left: side,
                right: side,
                top: pictureTop + pictureHeight + 10,
                child: Center(child: status),
              ),
            Positioned(
              left: side,
              right: side,
              top: headTop,
              child: _Words(
                headline: headline,
                headlineKey: headlineKey,
                under: underHeadline,
                status: statusInHeadline ? status : null,
              ),
            ),
            if (actions case final actions?)
              Positioned(left: side, right: side, bottom: 8, child: actions),
            if (leading case final leading?)
              Positioned(left: 0, top: 0, height: _bar, child: leading),
            if (trailing case final trailing?)
              Positioned(right: 0, top: 0, height: _bar, child: trailing),
          ],
        );
      },
    );
  }

  static const double _underGap = 23;
  static const double _buttonGap = 10;
}

/// An onboarding screen whole: the terminal's ground, the safe area, [OnboardingFrame] and its
/// [OnboardingPicture] — for the screens after sign-in, which home switches between.
///
/// ⚠️ **One widget for each of them, built in the same place, and that is what keeps the picture
/// alive between them.** Home answers its wait, "On your computer, go to" and the computer joining
/// with this same widget, so Flutter keeps the picture's state across the switch and only its
/// [scene] changes — rings going on, the laptop lighting — rather than a new picture starting over.
class OnboardingStage extends StatelessWidget {
  const OnboardingStage({
    super.key,
    required this.headline,
    required this.scene,
    this.headlineKey,
    this.enterFrom,
    this.agent,
    this.join,
    this.underHeadline,
    this.status,
    this.actions,
    this.leading,
    this.trailing,
    this.onTap,
    this.layout = OnboardingLayout.goTo,
  });

  final String headline;
  final Key? headlineKey;
  final OnboardingScene scene;

  /// "On your computer, go to"'s, for every screen after signing in — see [OnboardingLayout].
  final OnboardingLayout layout;

  /// See [OnboardingPicture.enterFrom], [OnboardingPicture.agent] and [OnboardingPicture.join].
  final OnboardingScene? enterFrom;
  final String? agent;
  final Animation<double>? join;

  final Widget? underHeadline;
  final Widget? status;
  final Widget? actions;
  final Widget? leading;
  final Widget? trailing;

  /// A tap anywhere that is not a control — the joining's "a tap goes sooner".
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          child: OnboardingFrame(
            headline: headline,
            headlineKey: headlineKey,
            picture: OnboardingPicture(
              scene: scene,
              enterFrom: enterFrom,
              agent: agent,
              join: join,
            ),
            underHeadline: underHeadline,
            status: status,
            actions: actions,
            leading: leading,
            trailing: trailing,
            layout: layout,
          ),
        ),
      ),
    );
  }
}

/// The headline, and what goes under it, changing together: the new words rise 8pt into place as
/// the old fade. The welcome's [status] takes their place the same way while it is up, and gives
/// it back to the headline as it goes.
class _Words extends StatelessWidget {
  const _Words({
    required this.headline,
    this.headlineKey,
    this.under,
    this.status,
  });

  final String headline;
  final Key? headlineKey;
  final Widget? under;
  final Widget? status;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    return AnimatedSwitcher(
      duration: Duration(milliseconds: still ? 200 : 250),
      switchInCurve: Curves.easeOut,
      switchOutCurve: Curves.easeIn,
      layoutBuilder: (current, previous) => Stack(
        alignment: Alignment.topLeft,
        children: [...previous, ?current],
      ),
      transitionBuilder: (child, animation) => FadeTransition(
        opacity: animation,
        child: still
            ? child
            : AnimatedBuilder(
                animation: animation,
                child: child,
                builder: (context, child) => Transform.translate(
                  offset: Offset(0, 8 * (1 - animation.value)),
                  child: child,
                ),
              ),
      ),
      child: switch (status) {
        // Its own key whatever it says: one message giving way to another is not a new screen.
        final status? => KeyedSubtree(
          key: const ValueKey(#status),
          child: status,
        ),
        null => Column(
          key: ValueKey(headline),
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Semantics(
              header: true,
              child: Text(
                headline,
                key: headlineKey,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: OnboardingFrame.headlineStyle(tty),
              ),
            ),
            if (under case final under?) ...[
              const SizedBox(height: OnboardingFrame._underGap),
              under,
            ],
          ],
        ),
      },
    );
  }
}

/// The line under the picture — "Looking for your computer▌" — ending in the terminal's block
/// cursor, blinking once a second (steady under Reduce Motion). Said as it changes.
class OnboardingStatus extends StatefulWidget {
  const OnboardingStatus(this.text, {super.key, this.cursor = true});

  final String text;

  /// The block cursor after it: still looking.
  final bool cursor;

  @override
  State<OnboardingStatus> createState() => _OnboardingStatusState();
}

class _OnboardingStatusState extends State<OnboardingStatus>
    with SingleTickerProviderStateMixin {
  late final AnimationController _blink = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 1),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (still) {
      _blink
        ..stop()
        ..value = 0;
    } else if (!_blink.isAnimating) {
      _blink.repeat();
    }
  }

  @override
  void dispose() {
    _blink.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final scaler = MediaQuery.textScalerOf(context);
    final style = tty.style(
      size: OnboardingFrame.quietSize,
      weight: FontWeight.w500,
      color: Color.alphaBlend(tty.text.withValues(alpha: .85), tty.ground),
    );
    final size = scaler.scale(OnboardingFrame.quietSize);
    return Semantics(
      liveRegion: true,
      label: widget.text,
      excludeSemantics: true,
      child: Text.rich(
        TextSpan(
          text: widget.text,
          children: [
            if (widget.cursor)
              WidgetSpan(
                alignment: PlaceholderAlignment.middle,
                child: Padding(
                  padding: const EdgeInsets.only(left: 2),
                  child: AnimatedBuilder(
                    animation: _blink,
                    builder: (context, _) => Opacity(
                      // On for the first half of each second, off for the second — steps, as a
                      // terminal's cursor blinks, not a fade.
                      opacity: _blink.value < .5 ? 1 : 0,
                      child: SizedBox(
                        width: size * .48,
                        height: size,
                        child: ColoredBox(color: tty.green),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
        textAlign: TextAlign.center,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: style,
      ),
    );
  }
}
