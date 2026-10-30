import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:share_plus/share_plus.dart';

import 'package:harness_mobile/core/handoff.dart';
import 'package:harness_mobile/measurement/onboarding_measurement.dart';
import 'package:harness_mobile/measurement/product_measurement.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import '../settings_page.dart' show confirmSignOut;
import '../tty.dart';
import '../tty_controls.dart';
import 'join_moment.dart';
import 'onboarding_copy.dart';
import 'onboarding_frame.dart';
import 'onboarding_picture.dart';
import 'set_up_computer.dart' show StepsTimeline, goToSteps;

/// ② Your computer: "On your computer, go to", the address, and the phone looking for the computer
/// that opens it.
///
/// ```
///   On your computer, go to
///   [ autonomous.ai/go           ⇪ ]     the address IS the button: it sends the link
///
///        ┌─────────────────────┐
///        │ dashed computers,   │          the laptop breathing, rings out from the phone
///        │ the laptop breathes │
///        └─────────────────────┘
///      Looking for your computer▌
///
///   (1) Download and install Harness     what to do there ([GoToComputer])
///    │
///   (2) Sign in
///       Use ada@gmail.com
///       Not you? Sign out                at home only ([NotYouSignOut])
/// ```
///
/// At home this is what an account with no computer stands on (`agent_home.dart`, which builds it
/// from [ComputerWatch] and [GoToComputer] on its own [OnboardingStage], with
/// "Not you? Sign out" under the account). This page is the same
/// step pushed from Computers ▸ Add computer, with back: a second computer is set up the way the
/// first was (`docs/research/2026-10-11-phone-onboarding`, "More computers, more phones").
///
/// It watches the account for a computer it has not seen. When one joins, it has its moment —
/// "MacBook Pro is ready.", the laptop drawing itself and lighting, the notes ([JoinMoment]) — and
/// goes back to the list, which has it now; a tap goes back sooner.
class YourComputerPage extends StatefulWidget {
  const YourComputerPage({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  State<YourComputerPage> createState() => _YourComputerPageState();
}

class _YourComputerPageState extends State<YourComputerPage>
    with SingleTickerProviderStateMixin {
  /// The account's computers when this page came up: a computer joining is one not among them.
  ///
  /// ⚠️ Taken in [initState], not on first read: read first when the account's next answer lands,
  /// that answer — the computer that just joined among it — would be what "already there" means.
  late final Set<String> _known;

  /// The computer that joined, by its name, once one has.
  String? _joined;

  late final JoinMoment _moment = JoinMoment(vsync: this, onDone: _back);

  @override
  void initState() {
    super.initState();
    _known = {
      for (final machine in widget.notifier.machines) machine.machineId,
    };
    widget.notifier.addListener(_lookForNew);
  }

  @override
  void dispose() {
    widget.notifier.removeListener(_lookForNew);
    _moment.dispose();
    super.dispose();
  }

  void _lookForNew() {
    if (!mounted || _joined != null) return;
    final added = widget.notifier.machines
        .where((machine) => !_known.contains(machine.machineId))
        .firstOrNull;
    if (added == null) return;
    setState(() => _joined = added.displayName);
    // After the frame that draws it joined: the moment, and the computer named to the device log
    // as the person's own — no "New device" for the one they are looking at.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      widget.notifier.welcomeMachine(added.machineId);
      _moment.start();
    });
  }

  bool _leaving = false;

  void _back() {
    if (!mounted || _leaving) return;
    _leaving = true;
    unawaited(
      Navigator.of(context).maybePop().then((popped) {
        if (!popped) _leaving = false;
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final joined = _joined;
    return OnboardingStage(
      headline: joined == null
          ? OnboardingCopy.goToHeadline
          : OnboardingCopy.ready(joined),
      headlineKey: const ValueKey('your-computer-headline'),
      scene: joined == null ? OnboardingScene.looking : OnboardingScene.joined,
      join: joined == null ? null : _moment.picture,
      leading: TtyBackButton(onPressed: _back),
      underHeadline: joined == null
          ? ComputerWatch(
              notifier: widget.notifier,
              child: GoToComputer(account: widget.notifier.currentUser?.email),
            )
          : null,
      status: joined == null
          ? const OnboardingStatus(OnboardingCopy.looking)
          : null,
      onTap: joined == null ? null : _moment.skip,
    );
  }
}

/// What goes under "On your computer, go to": the link ([GoAddressButton]) and, under it, what to do
/// there — as a timeline ([goToSteps]): download and install Harness, and sign in with this account.
/// Signed in there with it, the computer joins the account, and the screen moves on by itself
/// ([ComputerWatch]): no Add Phone, nothing to scan.
class GoToComputer extends StatelessWidget {
  const GoToComputer({
    super.key,
    required this.account,
    this.notYou,
    this.onSent,
  });

  /// The account the computer has to sign in to — this phone's.
  final String? account;

  /// Under the account, at home: [NotYouSignOut]. None on the page pushed from Computers, and
  /// none with no account to name — "Not you?" would ask about nobody.
  final Widget? notYou;

  /// The address went out through the share sheet ([GoAddressButton.onSent]).
  final VoidCallback? onSent;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      GoAddressButton(onSent: onSent),
      const SizedBox(height: OnboardingFrame.stepsAbove),
      StepsTimeline(
        steps: goToSteps(account),
        under: account == null ? null : notYou,
      ),
    ],
  );
}

/// "Not you? Sign out", right under the account "On your computer, go to" names at home — where
/// this screen is all an account with no computer has, and that account may be the wrong one. Next
/// to it, not at the foot (owner, 2026-10-12): the question is about the line above it. Asks first
/// ([confirmSignOut]).
///
/// ⚠️ **One line of the note to the eye, a 44pt target all the same.** [StepsTimeline.heightOf]
/// counts it as the one line it shows; the rest of the target reaches down into the room the frame
/// leaves under the steps, where nothing else is.
class NotYouSignOut extends StatelessWidget {
  const NotYouSignOut({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: '${OnboardingCopy.notYou} ${OnboardingCopy.signOut}',
      excludeSemantics: true,
      child: GestureDetector(
        key: const ValueKey('home-sign-out'),
        behavior: HitTestBehavior.opaque,
        onTap: () {
          HapticFeedback.selectionClick();
          notifier.onboardingMeasurement.mark(
            ProductFlow.computerWait,
            OnboardingMark.notYou,
          );
          unawaited(confirmSignOut(context, notifier));
        },
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Align(
            alignment: Alignment.topLeft,
            widthFactor: 1,
            // The question as quiet as the account over it; the way out in the text's colour.
            child: Text.rich(
              TextSpan(
                text: '${OnboardingCopy.notYou} ',
                children: [
                  TextSpan(
                    text: OnboardingCopy.signOut,
                    style: TextStyle(
                      color: tty.text,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ],
              ),
              maxLines: 1,
              softWrap: false,
              overflow: TextOverflow.ellipsis,
              style: StepsTimeline.noteStyle(tty),
            ),
          ),
        ),
      ),
    );
  }
}

/// Asks the account for its computers every few seconds while it is up: nothing pushes a new
/// computer to a phone that has none connected, and this is the screen waiting for one.
///
/// A request that fails (offline for a moment) is simply asked again on the next tick — caught
/// here, where it would otherwise reach the zone as an unhandled error every five seconds.
class ComputerWatch extends StatefulWidget {
  const ComputerWatch({super.key, required this.notifier, required this.child});

  final AppNotifier notifier;
  final Widget child;

  static const every = Duration(seconds: 5);

  @override
  State<ComputerWatch> createState() => _ComputerWatchState();
}

class _ComputerWatchState extends State<ComputerWatch> {
  Timer? _watch;

  @override
  void initState() {
    super.initState();
    _watch = Timer.periodic(ComputerWatch.every, (_) {
      if (!mounted) return;
      unawaited(widget.notifier.refreshMachines().catchError((Object _) {}));
    });
  }

  @override
  void dispose() {
    _watch?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// The address, as the button that sends it: the green of the screen's one action, the address at
/// its left edge and the share mark at its right. Pressed, the share sheet — AirDrop to the Mac
/// beside you first, or a message to yourself.
///
/// While it is up it also offers the page to a Mac nearby by Handoff ([Handoff]): signed in to the
/// same Apple account, the Mac shows it in its Dock, and nothing is typed at all.
///
/// [inline], it is words in a step instead — under the camera's "On your computer, go to"
/// (`set_up_computer.dart`'s ComputerSteps): the address in green, underlined, the share mark after
/// it, and no fill (owner, 2026-10-15). The full button there outweighed the camera, the one thing
/// that page is for, and stood the first step three times as tall as the others.
class GoAddressButton extends StatefulWidget {
  const GoAddressButton({super.key, this.onSent, this.inline = false});

  /// The share sheet sent the address somewhere — not merely opened and dismissed.
  final VoidCallback? onSent;

  /// Words in a step rather than the green button: see the class's note.
  final bool inline;

  /// [inline]'s height: one line of words to the eye, more than that to a thumb.
  ///
  /// ⚠️ Not 44: the room round the words is the gap between "On your computer, go to" and the
  /// address, and at 44 the two read as two lines apart rather than one sentence.
  static const double inlineHeight = 36;

  @override
  State<GoAddressButton> createState() => _GoAddressButtonState();
}

class _GoAddressButtonState extends State<GoAddressButton> {
  bool _down = false;
  late final AppLifecycleListener _lifecycle;

  static final _url = Uri.parse(OnboardingCopy.goUrl);

  @override
  void initState() {
    super.initState();
    unawaited(Handoff.offer(this, _url));
    // iOS stops advertising in the background — the person away installing Harness — so the page
    // is offered again whenever the app is back in front.
    _lifecycle = AppLifecycleListener(
      onResume: () => unawaited(Handoff.offer(this, _url)),
    );
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    unawaited(Handoff.withdraw(this));
    super.dispose();
  }

  /// The share sheet with the address, anchored to the button for iPad, where it is a popover.
  Future<void> _send() async {
    final box = context.findRenderObject() as RenderBox?;
    final origin = box == null || !box.attached
        ? null
        : box.localToGlobal(Offset.zero) & box.size;
    try {
      final result = await SharePlus.instance.share(
        ShareParams(
          uri: _url,
          subject: 'Get Harness for your computer',
          sharePositionOrigin: origin,
        ),
      );
      if (result.status == ShareResultStatus.success) widget.onSent?.call();
    } catch (_) {
      // No share sheet came up: the address is still there to type, and can be pressed again.
    }
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: '${OnboardingCopy.goAddress}, Send link',
      excludeSemantics: true,
      child: GestureDetector(
        key: const ValueKey('go-address'),
        behavior: HitTestBehavior.opaque,
        onTapDown: (_) => setState(() => _down = true),
        onTapCancel: () => setState(() => _down = false),
        onTapUp: (_) => setState(() => _down = false),
        onTap: () {
          HapticFeedback.lightImpact();
          unawaited(_send());
        },
        child: widget.inline ? _words(tty) : _button(tty),
      ),
    );
  }

  /// Pressed, a fill or the words darken on the finger's way DOWN, as the phone's other buttons do.
  Color _pressed(Color color) => _down
      ? Color.alphaBlend(Colors.black.withValues(alpha: 0.18), color)
      : color;

  /// [GoAddressButton.inline]: the address and the share mark, in green, at the step's size — as
  /// tall as [GoAddressButton.inlineHeight], the words centred in it.
  Widget _words(Tty tty) {
    final ink = _pressed(tty.green);
    return ConstrainedBox(
      constraints: const BoxConstraints(
        minHeight: GoAddressButton.inlineHeight,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Flexible(
            child: Text(
              OnboardingCopy.goAddress,
              maxLines: 1,
              softWrap: false,
              overflow: TextOverflow.ellipsis,
              style: tty
                  .style(size: TtySize.row, weight: FontWeight.w600, color: ink)
                  .copyWith(
                    decoration: TextDecoration.underline,
                    decorationColor: ink.withValues(alpha: 0.45),
                  ),
            ),
          ),
          const SizedBox(width: 8),
          Icon(LucideIcons.share300, size: 16, color: ink),
        ],
      ),
    );
  }

  /// The green button: the address at its left edge, the share mark at its right.
  Widget _button(Tty tty) {
    final ink = tty.onFill(tty.theme.black);
    return Container(
      // At least this tall, and taller when the text is larger — never clipped.
      constraints: const BoxConstraints(minHeight: TtyPrimaryButton.height),
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
      decoration: BoxDecoration(
        color: _pressed(tty.green),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          // One line on any phone: a narrow one shrinks it rather than breaking the address.
          Expanded(
            child: FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Text(
                OnboardingCopy.goAddress,
                maxLines: 1,
                softWrap: false,
                style: tty.style(
                  size: TtySize.title,
                  weight: FontWeight.w600,
                  color: ink,
                ),
              ),
            ),
          ),
          const SizedBox(width: 12),
          Icon(LucideIcons.share300, size: 20, color: ink),
        ],
      ),
    );
  }
}
