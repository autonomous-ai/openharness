import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../phone/phone_sheet.dart';
import '../phone/tty.dart';
import '../phone/tty_controls.dart';
import '../settings/experimental_features.dart';
import '../shared/theme/app_space.dart';
import '../shared/theme/app_theme.dart';
import 'swarm_inbox.dart';
import 'swarm_session.dart';

/// One of the person's computers as Swarm's start screen lists it: its name,
/// and whether it is away for real (`phoneMachineAway`).
typedef SwarmComputer = ({String name, bool away});

/// One of the person's own computers a Buddy may run on: never one shared
/// with them, nor a Harness Team account. [away] ones are listed, not picked.
typedef SwarmOwnComputer = ({String id, String name, bool away});

/// What Swarm shows before there is a Swarm to show — one screen each, with
/// one button. Swarm turned off is not one of them: the app is as it was, and
/// Settings offers Swarm.
enum SwarmStart {
  /// The account has no computer at all: Connect a computer.
  noComputer,

  /// The Swarms were read, and there is none: Show me how.
  none,

  /// No Swarm, and an invitation to one waiting: Join.
  invited,

  /// No Swarm, and the invitations could not be read: Try again. Not "No
  /// Swarm yet", which would send the person to start one (#1802's review).
  invitesFailed,
}

/// Which start screen applies, from what the phone already knows: [computers]
/// as the account's list says (null until it has answered) and what [inbox]
/// read. Null when there is a Swarm to show, or nothing is known yet.
///
/// No computer answering shows no start screen: Home draws what it has —
/// what was read or kept, or rows on their way — and the reads retry quietly
/// (`swarmRequest`). A screen in Home's place once flashed "Connect one of
/// your computers" for 10 to 25 seconds at a time with the computer connected
/// all along (owner's iPhone, 2026-10-27), and "No computer online" stayed
/// after a force-quit while the Mac was connecting (2026-10-28).
SwarmStart? swarmStart(SwarmInbox inbox, List<SwarmComputer>? computers) {
  if (computers == null) return null;
  if (computers.isEmpty) return SwarmStart.noComputer;
  if (!inbox.loaded || inbox.swarms.isNotEmpty) return null;
  if (inbox.invitations.isNotEmpty) return SwarmStart.invited;
  return inbox.invitationsFailed ? SwarmStart.invitesFailed : SwarmStart.none;
}

/// The person's computers as the start screens need them: the app's machine
/// list in the app (`AppSwarmComputers`), a stand-in in a test.
abstract interface class SwarmComputers implements Listenable {
  /// The account's computers; null until its list has answered.
  List<SwarmComputer>? get computers;

  /// A [recheck] is under way.
  bool get rechecking;

  /// Reads the list again and calls the computers that are away: Try again.
  Future<void> recheck();

  /// Opens the steps to connect a computer.
  void add(BuildContext context);

  /// The person's own computers ([SwarmOwnComputer]); empty until the list
  /// has answered.
  List<SwarmOwnComputer> get own;

  /// Asks the person's own computer [machineId] one Swarm question of its
  /// own, such as preparing a Buddy's folder (`prepareContribution`).
  Future<Map<String, dynamic>> ask(
    String machineId,
    Map<String, dynamic> payload,
  );
}

/// The start screen Swarm Home shows in place of its body, or null when it
/// shows its own — Home's one call. It follows the computers ([SwarmScope]);
/// the caller rebuilds it as [session]'s inbox changes.
SwarmStartView? swarmStartView(BuildContext context, SwarmSession session) {
  final computers = SwarmScope.computersOf(context);
  final start = swarmStart(session.inbox, computers?.computers);
  if (start == null || computers == null) return null;
  return SwarmStartView(start: start, session: session, computers: computers);
}

/// One start screen ([SwarmStart]), the whole of Home's body under its own
/// top bar: what is the matter in a title and a line, and one button. Shows
/// only what the phone already has: the computers' names, and an
/// invitation's Swarm by name with the role offered — nothing of the Swarm is
/// read before Join.
class SwarmStartView extends StatefulWidget {
  const SwarmStartView({
    super.key,
    required this.start,
    required this.session,
    required this.computers,
  });

  final SwarmStart start;
  final SwarmSession session;
  final SwarmComputers computers;

  @override
  State<SwarmStartView> createState() => _SwarmStartViewState();
}

class _SwarmStartViewState extends State<SwarmStartView> {
  /// Try again is looking: for the computers, then the Swarms through them.
  bool _looking = false;

  SwarmInbox get _inbox => widget.session.inbox;

  Future<void> _tryAgain() async {
    if (_looking) return;
    setState(() => _looking = true);
    try {
      await widget.computers.recheck();
      await _inbox.refresh();
    } catch (_) {
      // Nothing found: the screen stays, ready to try again.
    } finally {
      if (mounted) setState(() => _looking = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([_inbox, widget.computers]),
    builder: (context, _) {
      AppTheme.watch(context);
      final tty = Tty.of(context);
      return switch (widget.start) {
        SwarmStart.noComputer => _StartScreen(
          key: const ValueKey('swarm-start-no-computer'),
          mark: const _Mark(icon: LucideIcons.monitor300),
          title: 'No computer yet',
          line:
              'Swarm reaches your team through your computers. Connect one '
              'to start.',
          primary: TtyPrimaryButton(
            label: 'Connect a computer',
            onPressed: () => widget.computers.add(context),
          ),
        ),
        SwarmStart.none => _StartScreen(
          key: const ValueKey('swarm-start-none'),
          mark: const _Mark(icon: LucideIcons.network300),
          title: 'No Swarm yet',
          line:
              'A Swarm is a team of agents that works on your projects. Start '
              'one on your computer and it shows up here.',
          primary: TtyPrimaryButton(
            label: 'Show me how',
            onPressed: () => unawaited(_showHow(context)),
          ),
          // The invitations list is the account's email's: an invite to it
          // comes here by itself, and there is no link to open.
          quiet: Padding(
            padding: const EdgeInsets.only(top: AppSpace.m),
            child: Text(
              'Invites to your email show up here.',
              textAlign: TextAlign.center,
              style: tty.style(color: tty.dim, size: TtySize.meta),
            ),
          ),
        ),
        SwarmStart.invited => _invited(tty),
        SwarmStart.invitesFailed => _StartScreen(
          key: const ValueKey('swarm-start-invites-failed'),
          mark: const _Mark(icon: LucideIcons.mailWarning300),
          title: "Couldn't check invitations",
          line:
              "Swarm couldn't read the invitations to your email just now. "
              'You may have one waiting.',
          primary: TtyPrimaryButton(
            label: 'Try again',
            busy: _looking,
            busyLabel: 'Checking…',
            onPressed: () => unawaited(_tryAgain()),
          ),
        ),
      };
    },
  );

  Widget _invited(Tty tty) {
    // Put off since this screen was chosen: Home picks again at its next
    // build, so this one draws nothing meanwhile.
    if (_inbox.invitations.isEmpty) return const SizedBox.shrink();
    final invitation = _inbox.invitations.first;
    final name = invitation.name.trim();
    return _StartScreen(
      key: const ValueKey('swarm-start-invited'),
      mark: _Mark(letter: name.isEmpty ? '?' : name.characters.first),
      eyebrow: "You're invited to",
      title: name,
      line: switch (invitation.role) {
        'collaborator' => 'You can collaborate',
        'viewer' => 'You can view',
        _ => null,
      },
      more: [
        if (_inbox.joinError case final error?)
          Text(
            error,
            key: const ValueKey('swarm-join-error'),
            style: tty.style(color: tty.red, size: TtySize.meta),
          ),
      ],
      primary: TtyPrimaryButton(
        label: 'Join $name',
        busy: _inbox.joining.contains(invitation.inviteId),
        busyLabel: 'Joining…',
        onPressed: () => unawaited(_inbox.join(invitation)),
      ),
      quiet: TtyTextButton(
        label: 'Not now',
        onPressed: () => _inbox.notNow(invitation),
      ),
    );
  }
}

/// How to start a Swarm, in the three steps the desktop takes: a sheet over
/// No Swarm yet, closed with Got it.
Future<void> _showHow(BuildContext context) => Navigator.of(
  context,
  rootNavigator: true,
).push(phoneSheetRoute<void>(context, builder: (_) => const _HowSheet()));

/// The switcher's Join or create a Swarm: the phone makes no Swarm and sends
/// no invitation, so the same sheet, with how one is joined too.
Future<void> showSwarmJoinOrCreate(BuildContext context) =>
    Navigator.of(context, rootNavigator: true).push(
      phoneSheetRoute<void>(
        context,
        builder: (_) => const _HowSheet(join: true),
      ),
    );

class _HowSheet extends StatelessWidget {
  const _HowSheet({this.join = false});

  /// Says how a Swarm is joined, too.
  final bool join;

  static const _steps = [
    'Open Harness on your computer.',
    // The desktop's New Swarm (desktop/lib/shortcuts/app_shortcuts.dart).
    'Press ⌘S.',
    'Name it and add your first project.',
  ];

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpace.screenInset,
          AppSpace.l,
          AppSpace.screenInset,
          AppSpace.m,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TtyText(
              join ? 'Join or create a Swarm' : 'Start a Swarm',
              size: TtySize.title,
              weight: FontWeight.w600,
            ),
            if (join) ...[
              const SizedBox(height: 12),
              Text(
                'To join one, ask its owner to invite you. To start one:',
                style: tty.style(color: tty.dim, size: TtySize.row),
              ),
            ],
            const SizedBox(height: 18),
            for (final (index, step) in _steps.indexed)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpace.l),
                child: Row(
                  children: [
                    Container(
                      width: 30,
                      height: 30,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: ttyRaised(tty),
                        shape: BoxShape.circle,
                      ),
                      child: TtyText(
                        '${index + 1}',
                        size: TtySize.meta,
                        color: tty.dim,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(step, style: tty.style(size: TtySize.row)),
                    ),
                  ],
                ),
              ),
            Text(
              "It shows up here when it's ready.",
              style: tty.style(color: tty.dim, size: TtySize.row),
            ),
            const SizedBox(height: 18),
            TtyPrimaryButton(
              label: 'Got it',
              onPressed: () => Navigator.of(context).pop(),
            ),
          ],
        ),
      ),
    );
  }
}

/// Swarm turned off: what it does, in three lines, and Turn on Swarm. The
/// one way to it is Settings ▸ Experimental, while Swarm is off.
class SwarmIntroPage extends StatelessWidget {
  const SwarmIntroPage({super.key, required this.features});

  final ExperimentalFeaturesStore features;

  static const _ticks = [
    'See what needs you',
    'Answer in one tap',
    'Brainstorm with your Buddy',
  ];

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    void back() => unawaited(Navigator.of(context).maybePop());
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: TtyBackButton(onPressed: back),
            ),
            Expanded(
              child: _StartScreen(
                mark: const _Mark(icon: LucideIcons.network300),
                title: 'Your team of agents, on your phone',
                more: [
                  for (final tick in _ticks)
                    Padding(
                      padding: const EdgeInsets.only(bottom: AppSpace.m),
                      child: Row(
                        children: [
                          Icon(
                            LucideIcons.check300,
                            size: 20,
                            color: tty.green,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Text(
                              tick,
                              style: tty.style(size: TtySize.row),
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
                primary: TtyPrimaryButton(
                  label: 'Turn on Swarm',
                  onPressed: () {
                    // On at once; only the memory for the next launch waits.
                    unawaited(features.set(PhoneExperiment.swarm, true));
                    back();
                  },
                ),
                quiet: TtyTextButton(label: 'Not now', onPressed: back),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A start screen's layout: its mark, an eyebrow over the title, a line,
/// what [more] it shows, then its one button at the foot, with [quiet] under
/// it.
class _StartScreen extends StatelessWidget {
  const _StartScreen({
    super.key,
    required this.mark,
    required this.title,
    required this.primary,
    this.eyebrow,
    this.line,
    this.more = const [],
    this.quiet,
  });

  final Widget mark;
  final String title;
  final String? eyebrow, line;
  final List<Widget> more;
  final Widget primary;
  final Widget? quiet;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.xl,
              AppSpace.xl,
              AppSpace.xl,
              AppSpace.l,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                mark,
                const SizedBox(height: 18),
                if (eyebrow case final eyebrow?) ...[
                  Text(
                    eyebrow,
                    style: tty.style(color: tty.dim, size: TtySize.row),
                  ),
                  const SizedBox(height: 4),
                ],
                // Wrapped, not one line as a [TtyText]: an invitation's
                // name is as long as its owner made it.
                Text(
                  title,
                  style: tty.style(
                    size: TtySize.display,
                    weight: FontWeight.w600,
                  ),
                ),
                if (line case final line?) ...[
                  const SizedBox(height: 12),
                  Text(
                    line,
                    style: tty.style(color: tty.dim, size: TtySize.row),
                  ),
                ],
                if (more.isNotEmpty) const SizedBox(height: 20),
                ...more,
              ],
            ),
          ),
        ),
        Padding(
          padding: EdgeInsets.fromLTRB(
            AppSpace.screenInset,
            AppSpace.m,
            AppSpace.screenInset,
            AppSpace.m + MediaQuery.paddingOf(context).bottom,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [primary, ?quiet],
          ),
        ),
      ],
    );
  }
}

/// A start screen's mark: a glyph, or an invitation's first letter, on a
/// raised square.
class _Mark extends StatelessWidget {
  const _Mark({this.icon, this.letter});

  final IconData? icon;
  final String? letter;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Container(
      width: 64,
      height: 64,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: ttyRaised(tty),
        borderRadius: BorderRadius.circular(AppCard.radius),
      ),
      child: icon != null
          ? Icon(icon, size: 30, color: tty.text)
          : TtyText(
              letter ?? '',
              size: TtySize.display,
              weight: FontWeight.w600,
            ),
    );
  }
}
