import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'swarm_home_list.dart';
import 'swarm_inbox.dart';
import 'swarm_row.dart';
import 'swarm_style.dart';
import 'team_glance.dart';

/// The rows of Swarm Home: a project with how many people read it, how many
/// agents are running and when it last moved, its tile a dot and its name a
/// channel's, as C1 draws them (2026-10-30); the projects quiet for a day
/// folded in one row.

/// A team in a line of coloured dots, as B1 draws it: "● 4 working ● 1
/// waiting", each dot in its state's colour ([swarmStateColor]), who is down
/// in red words too, and heard as words alone. With nobody counted, the
/// team's line in words ("No agents yet", "All idle").
class SwarmTeamDots extends StatelessWidget {
  const SwarmTeamDots(this.glance, {super.key, this.lead});

  final SwarmTeamGlance glance;

  /// Words before the dots: the Swarm, where Home shows several.
  final String? lead;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final quiet = AppType.caption(
      color: AppPalette.textSecondary,
      height: 1.35,
    );
    final parts = glance.parts;
    // Heard in words: "1 working · 1 waiting", never the dots.
    final heard = [?lead, glance.line].join(' · ');
    return Semantics(
      label: heard,
      excludeSemantics: true,
      child: Text.rich(
        TextSpan(
          children: [
            if (lead case final lead?) TextSpan(text: '$lead · '),
            if (parts.isEmpty) TextSpan(text: glance.line),
            for (final (i, part) in parts.indexed) ...[
              if (i > 0) const TextSpan(text: '  '),
              TextSpan(
                text: '● ',
                style: TextStyle(color: swarmStateColor(part.state)),
              ),
              TextSpan(
                text: part.text,
                style: part.state == SwarmAgentState.down
                    ? TextStyle(color: AppColors.danger)
                    : null,
              ),
            ],
          ],
        ),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: quiet,
      ),
    );
  }
}

/// What a need asks, as its Home row's title: a decision's question, a tag's
/// words, the question work waits on (or the work itself).
String swarmNeedAsk(SwarmNeed need) => switch (need) {
  SwarmDecisionNeed(:final decision) => decision.question,
  SwarmMentionNeed(:final mention) =>
    mention.text.isNotEmpty ? mention.text : mention.conversationTitle,
  SwarmWorkNeed(:final work) => work.question ?? work.conversation.label,
};

/// An invitation to a Swarm on Home (Tony's mobile list, task 24), one line: the
/// Swarm's name, Not now and Join. The account's, so it shows whichever Swarm
/// or filter Home is on.
class SwarmInvitationRow extends StatelessWidget {
  const SwarmInvitationRow({
    super.key,
    required this.invitation,
    required this.joining,
    required this.onJoin,
    required this.onLater,
  });

  final SwarmInvitation invitation;
  final bool joining;
  final VoidCallback onJoin, onLater;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return SwarmRow(
      title: invitation.name.trim(),
      chevron: null,
      onTap: null,
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          TtyTextButton(
            key: ValueKey('swarm-invitation-later-${invitation.inviteId}'),
            label: 'Not now',
            color: tty.dim,
            onPressed: joining ? null : onLater,
          ),
          const SizedBox(width: AppSpace.s),
          TtyTextButton(
            key: ValueKey('swarm-invitation-join-${invitation.inviteId}'),
            label: joining ? 'Joining…' : 'Join',
            onPressed: joining ? null : onJoin,
          ),
        ],
      ),
    );
  }
}

/// One project on Home, on one line as Slack's channels (Tony, 2026-11-03):
/// its name as a channel's ("#openharness") — bold and bright with something
/// new in it, quiet otherwise — its Swarm faint after it where Home shows
/// several, the first to go when the row is short, and at its end the tags
/// waiting in it ("@2", filled), or a skeleton in their place while what
/// waits is on its way ([tagsLoading]). No dot for how its team is: one on
/// every row said little, and the name already says what waits on the person
/// (Tony, 2026-11-03). No second line: who reads it and how long ago it moved
/// were the same on every row. A private project has a lock at its end,
/// after its tags, as the desktop's sidebar marks it. A tap opens it; a long
/// press offers its pin ([onLongPress]).
class SwarmHomeProjectRow extends StatelessWidget {
  const SwarmHomeProjectRow({
    super.key,
    required this.project,
    this.swarmName,
    this.tagsLoading = false,
    required this.onTap,
    this.onLongPress,
  });

  /// One line, as tall as a thumb's touch.
  static const double height = minTouchTarget;

  final SwarmHomeProject project;

  /// Its Swarm, where Home shows several.
  final String? swarmName;

  /// What waits in its Swarm is not read yet: its tags may still come.
  final bool tagsLoading;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final news = project.news;
    final bright = news.bold || news.tags > 0;
    final name = '#${project.project.name}';
    return _Tap(
      onTap: onTap,
      onLongPress: onLongPress,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: height),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpace.l,
            vertical: AppSpace.xs,
          ),
          child: Row(
            children: [
              Expanded(
                child: Semantics(
                  label: bright && news.tags == 0 ? 'Unread messages' : null,
                  child: Text.rich(
                    TextSpan(
                      text: name,
                      children: [
                        if (swarmName case final swarm?)
                          TextSpan(
                            text: '  $swarm',
                            style: AppType.caption(
                              color: AppPalette.textFaint,
                              height: 1.3,
                            ),
                          ),
                      ],
                    ),
                    key: const ValueKey('swarm-project-name'),
                    semanticsLabel: [name, ?swarmName].join(', '),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppType.label(
                      color: bright
                          ? AppPalette.textPrimary
                          : AppPalette.textSecondary,
                      height: 1.3,
                      fontWeight: bright ? AppFont.semibold : null,
                    ),
                  ),
                ),
              ),
              if (news.tags > 0) ...[
                const SizedBox(width: 12),
                SwarmTags(news.tags, filled: true),
              ] else if (tagsLoading) ...[
                const SizedBox(width: 12),
                // As big as the filled tags it stands for.
                const Skeleton(
                  key: ValueKey('swarm-project-tags-loading'),
                  width: 36,
                  height: 20,
                  radius: 10,
                ),
              ],
              // At its end, after its tags, as the desktop's sidebar marks
              // it: in sight however long the name.
              if (project.project.isPrivate) ...[
                const SizedBox(width: AppSpace.s),
                Icon(
                  LucideIcons.lock300,
                  key: const ValueKey('swarm-project-private'),
                  size: 14,
                  color: AppPalette.textSecondary,
                  semanticLabel: 'Private project',
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// The projects quiet for a day, folded in one row at the foot of Projects,
/// as C1 draws it: a chevron that turns as they open ([open]), then "Other
/// projects · 9".
class SwarmOtherProjectsRow extends StatelessWidget {
  const SwarmOtherProjectsRow({
    super.key,
    required this.count,
    required this.open,
    required this.onTap,
  });

  final int count;
  final bool open;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      expanded: open,
      child: _Tap(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: SwarmRow.height),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpace.l,
              vertical: AppSpace.m,
            ),
            child: Row(
              children: [
                SizedBox(
                  width: 16,
                  child: Icon(
                    open
                        ? LucideIcons.chevronDown300
                        : LucideIcons.chevronRight300,
                    size: 18,
                    color: AppPalette.textFaint,
                  ),
                ),
                const SizedBox(width: AppSpace.s),
                Expanded(
                  child: Text(
                    'Other projects · $count',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppType.label(color: AppPalette.textSecondary),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A row's ink on a tap, with a click a thumb can feel.
class _Tap extends StatelessWidget {
  const _Tap({required this.onTap, this.onLongPress, required this.child});

  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  final Widget child;

  @override
  Widget build(BuildContext context) => Material(
    color: Colors.transparent,
    child: InkWell(
      onTap: onTap,
      onLongPress: onLongPress == null
          ? null
          : () {
              HapticFeedback.mediumImpact();
              onLongPress!();
            },
      child: child,
    ),
  );
}

/// A project's pin, offered on a long press of its Home row: one row, Pin or
/// Unpin ([pinned]). Answers true when it was tapped, null when closed. While
/// it is open, [watch] tells of changes to what Home lists: once the project
/// is no longer [listed] — its Swarm or its project taken away — it shows
/// nothing of it and closes, and a tap answers nothing.
Future<bool?> showSwarmPinSheet(
  BuildContext context, {
  required String name,
  required bool pinned,
  required Listenable watch,
  required bool Function() listed,
}) => showModalBottomSheet<bool>(
  context: context,
  backgroundColor: AppGlass.rowFill,
  shape: AppControl.sheetShape,
  builder: (context) =>
      _PinSheet(name: name, pinned: pinned, watch: watch, listed: listed),
);

class _PinSheet extends StatefulWidget {
  const _PinSheet({
    required this.name,
    required this.pinned,
    required this.watch,
    required this.listed,
  });

  final String name;
  final bool pinned;
  final Listenable watch;
  final bool Function() listed;

  @override
  State<_PinSheet> createState() => _PinSheetState();
}

class _PinSheetState extends State<_PinSheet> {
  bool _closing = false;

  /// Closes the sheet once, after the frame it went blank in.
  void _close() {
    if (_closing) return;
    _closing = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final route = ModalRoute.of(context);
      if (route == null || !route.isActive) return;
      if (route.isCurrent) {
        Navigator.of(context).pop();
      } else {
        Navigator.of(context).removeRoute(route);
      }
    });
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.watch,
    builder: (context, _) {
      if (_closing || !widget.listed()) {
        _close();
        return const SizedBox.shrink();
      }
      final pinned = widget.pinned;
      return SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpace.l,
            AppSpace.s,
            AppSpace.l,
            AppSpace.l,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // The grabber: a capsule as wide as the two largest steps.
              Center(
                child: Container(
                  width: AppSpace.xl + AppSpace.m,
                  height: AppSpace.xs,
                  margin: const EdgeInsets.only(bottom: AppSpace.s),
                  decoration: ShapeDecoration(
                    color: AppGlass.hair,
                    shape: const StadiumBorder(),
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  AppSpace.m,
                  AppSpace.xs,
                  AppSpace.m,
                  AppSpace.s,
                ),
                child: Text(
                  widget.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppType.caption(color: AppPalette.textSecondary),
                ),
              ),
              Semantics(
                button: true,
                child: InkWell(
                  key: const ValueKey('swarm-pin'),
                  borderRadius: BorderRadius.circular(AppControl.radius),
                  // Taken away since the last frame: nothing to pin.
                  onTap: () => widget.listed()
                      ? Navigator.of(context).pop(true)
                      : _close(),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(
                      minHeight: minTouchTarget,
                    ),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: AppSpace.m,
                        vertical: AppSpace.s,
                      ),
                      child: Row(
                        children: [
                          Icon(
                            pinned ? LucideIcons.pinOff300 : LucideIcons.pin300,
                            size: 20,
                            color: AppPalette.textPrimary,
                          ),
                          const SizedBox(width: AppSpace.m),
                          Text(
                            pinned ? 'Unpin' : 'Pin to top',
                            style: AppType.body(color: AppPalette.textPrimary),
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
    },
  );
}
