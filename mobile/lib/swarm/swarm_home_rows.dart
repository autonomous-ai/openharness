import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/fzf.dart' show fzfAge;
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'model.dart';
import 'swarm_home_list.dart';
import 'swarm_inbox.dart';
import 'swarm_row.dart';
import 'swarm_style.dart';
import 'swarm_unread.dart';
import 'team_glance.dart';

/// The rows of Swarm Home: a project with its people's faces, how many agents
/// are running and when it last moved, its tile a dot and its name a
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

/// A project's people and its team on Home: up to [shown] faces, each over the
/// one before it, then how many agents are running ([SwarmTeamGlance.running]).
class SwarmTeamFaces extends StatelessWidget {
  const SwarmTeamFaces(
    this.glance, {
    super.key,
    required this.people,
    this.swarmName,
  });

  /// The most faces a row draws.
  static const shown = 5;

  /// As tall as the words beside it, so the row is as tall as its skeleton.
  static const _size = 18.0;

  /// From one face to the next: less than [_size], so they overlap, yet each
  /// initial stays whole.
  static const _step = 15.0;

  final SwarmTeamGlance glance;

  /// The project's people ([swarmProjectPeople]), in the order to draw them.
  final List<SuperTabPerson> people;

  /// Words after the count, the first to go when the row is short: the Swarm,
  /// where Home shows several.
  final String? swarmName;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final faces = people.take(shown).toList();
    final words = [glance.running, ?swarmName].join(' · ');
    return Semantics(
      label: [for (final person in faces) person.username, words].join(', '),
      excludeSemantics: true,
      child: Row(
        children: [
          if (faces.isNotEmpty) ...[
            SizedBox(
              key: const ValueKey('swarm-team-faces'),
              width: _size + _step * (faces.length - 1),
              height: _size,
              child: Stack(
                children: [
                  for (final (i, person) in faces.indexed)
                    Positioned(
                      left: _step * i,
                      child: SwarmAvatar(
                        key: ValueKey('swarm-team-face-${person.id}'),
                        id: person.id,
                        name: person.username,
                        picture: person.avatar,
                        size: _size,
                        // The row's own colour, so each face cuts into the
                        // one under it.
                        ring: AppGlass.rowFill,
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(width: AppSpace.s),
          ],
          Flexible(
            child: Text(
              words,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppType.caption(
                color: AppPalette.textSecondary,
                height: 1.35,
              ),
            ),
          ),
        ],
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

/// One project on Home, as C1 draws it: a dot in the colour of how its team
/// is ([swarmProjectColor]), its name as a channel's ("#openharness") — bold
/// and bright with something new in it, quiet otherwise — its people's faces
/// and how many agents are running ([SwarmTeamFaces]), and at its right how
/// long ago it last moved, over the tags waiting in it ("@2", filled) or,
/// unread, a dot. A tap opens it; a long press offers its pin
/// ([onLongPress]).
class SwarmHomeProjectRow extends StatelessWidget {
  const SwarmHomeProjectRow({
    super.key,
    required this.project,
    required this.glance,
    required this.people,
    required this.now,
    this.swarmName,
    required this.onTap,
    this.onLongPress,
  });

  final SwarmHomeProject project;
  final SwarmTeamGlance glance;

  /// Its people ([swarmProjectPeople]).
  final List<SuperTabPerson> people;
  final DateTime now;

  /// Its Swarm, where Home shows several.
  final String? swarmName;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final news = project.news;
    final bright = news.bold || news.tags > 0;
    final age = switch (project.active) {
      final at? => fzfAge(at.toLocal(), now.toLocal()),
      null => '',
    };
    return _Tap(
      onTap: onTap,
      onLongPress: onLongPress,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: SwarmRow.height),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpace.l,
            vertical: AppSpace.m,
          ),
          child: Row(
            children: [
              ExcludeSemantics(
                child: SizedBox(
                  key: const ValueKey('swarm-project-dot'),
                  width: 16,
                  child: Center(
                    child: _Dot(
                      size: 8,
                      color: swarmProjectColor(glance, news),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: AppSpace.s),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Semantics(
                      label: bright && news.tags == 0
                          ? 'Unread messages'
                          : null,
                      child: Text(
                        '#${project.project.name}',
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
                    const SizedBox(height: 3),
                    SwarmTeamFaces(glance, people: people, swarmName: swarmName),
                  ],
                ),
              ),
              if (age.isNotEmpty || bright) ...[
                const SizedBox(width: 12),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (age.isNotEmpty)
                      Text(
                        age,
                        style: AppType.caption(
                          color: AppPalette.textFaint,
                          height: 1.3,
                        ),
                      ),
                    if (news.tags > 0) ...[
                      const SizedBox(height: 4),
                      SwarmTags(news.tags, filled: true),
                    ] else if (news.bold) ...[
                      const SizedBox(height: 8),
                      ExcludeSemantics(
                        child: _Dot(size: 7, color: AppPalette.textPrimary),
                      ),
                    ],
                  ],
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

/// How a project's team is, as its dot on Home: red with someone down,
/// yellow with someone waiting or a tag waiting on the person, green with
/// someone working, faint otherwise.
Color swarmProjectColor(SwarmTeamGlance glance, SwarmRowNews news) =>
    glance.down > 0
    ? swarmStateColor(SwarmAgentState.down)
    : glance.waiting > 0 || news.tags > 0
    ? swarmStateColor(SwarmAgentState.waiting)
    : glance.working > 0
    ? swarmStateColor(SwarmAgentState.working)
    : AppPalette.textFaint;

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

/// A small round mark: what waits on the person in the warning colour, or
/// [color].
class _Dot extends StatelessWidget {
  const _Dot({required this.size, this.color});

  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      color: color ?? AppColors.warning,
      shape: BoxShape.circle,
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
