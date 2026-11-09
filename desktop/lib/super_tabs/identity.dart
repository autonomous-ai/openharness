import 'package:flutter/material.dart';

import '../shared/theme/swarm_palette.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import 'avatar_art.dart';
import 'model.dart';

/// The one avatar for a person or an agent everywhere in the Swarm: rows,
/// messages, mentions, the Glance and the leaderboard. Stable across
/// engine/model changes. An agent wears its engine as a small badge, a Lead its
/// gold ring.
class SuperTabAvatar extends StatelessWidget {
  const SuperTabAvatar({
    super.key,
    required this.identity,
    required this.name,
    this.size = 30,
    this.picture,
    this.engine,
    this.face = false,
  }) : lead = false;

  SuperTabAvatar.person(SuperTabPerson person, {super.key, this.size = 30})
    : identity = 'person:${person.id}',
      name = person.shownName,
      picture = person.avatar,
      engine = null,
      face = false,
      lead = false;

  /// [engineBadge] off where the row already shows the engine beside the
  /// name (the roster, messages), so it shows once. [lead] marks a PM with
  /// the Lead ring (task #4461).
  SuperTabAvatar.agent(
    SuperTabAgent agent, {
    super.key,
    String? name,
    this.size = 30,
    bool engineBadge = true,
    this.lead = false,
  }) : identity = 'agent:${agent.id}',
       name = name ?? agent.displayName ?? agent.name,
       picture = agent.avatar,
       engine = engineBadge ? agent.engine : null,
       face = true;

  /// The avatar of a roster row, agent or person, so their names start at one inset.
  static const rowSize = 24.0;

  final String identity, name;
  final double size;
  final SuperTabAvatarPicture? picture;

  /// The agent's engine, drawn as its badge; null for a person.
  final String? engine;

  /// Draw the agent face rather than an initial when there is no picture.
  final bool face;

  /// A Lead's thin gold ring around the face, outside its box so no row
  /// moves: a PM in My agents.
  final bool lead;

  @override
  Widget build(BuildContext context) {
    final badge = size * .46;
    return Semantics(
      label: lead ? 'Lead' : null,
      child: SizedBox.square(
        dimension: size,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            SuperTabAvatarFace(
              identity: identity,
              name: name,
              size: size,
              picture: picture,
              face: face,
            ),
            if (lead)
              Positioned.fill(
                child: OverflowBox(
                  maxWidth: double.infinity,
                  maxHeight: double.infinity,
                  child: CustomPaint(
                    key: const ValueKey('super-lead-ring'),
                    size: Size.square(
                      size * (1 + 2 * (_ringGap + _ringStroke)),
                    ),
                    painter: _LeadRingPainter(
                      stroke: size * _ringStroke,
                      gap: size * _ringGap,
                    ),
                  ),
                ),
              ),
            if (engine case final engine? when engine.isNotEmpty)
              Positioned(
                right: -badge * .2,
                bottom: -badge * .2,
                child: _Badge(
                  size: badge,
                  child: EngineMark(engine: engine, size: badge * .72),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// The Lead ring's stroke and its gap from the face, as shares of the face's
/// diameter (anh Dee, task #4461).
const _ringStroke = .05, _ringGap = .07;

class _LeadRingPainter extends CustomPainter {
  _LeadRingPainter({required this.stroke, required this.gap});
  final double stroke, gap;
  final color = SwarmPalette.leadRing;

  @override
  void paint(Canvas canvas, Size size) => canvas.drawCircle(
    size.center(Offset.zero),
    size.width / 2 - stroke / 2,
    Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke,
  );

  @override
  bool shouldRepaint(_LeadRingPainter old) =>
      old.stroke != stroke || old.gap != gap;
}

class _Badge extends StatelessWidget {
  const _Badge({required this.size, required this.child});
  final double size;
  final Widget child;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: DesktopChrome.surface,
      shape: BoxShape.circle,
      border: Border.all(color: DesktopChrome.rim, width: .5),
    ),
    child: child,
  );
}

String superTabPersonName(String email) => email.split('@').first;

/// A computer as it calls itself: a Bonjour hostname without its `.local` suffix ("MacBookPro2021"), never mapped
/// to a model name, so two machines of one model stay told apart. A name a person chose stays as it is.
/// What names a Mac's Harness Team account entry after its Mac's name (backend model.ts TEAM_ENTRY_LABEL, task #3060).
const kTeamEntryLabel = ' · Team account';

String superTabMachineName(String name) {
  // A Team account entry reads as its Mac's name and the label: the Mac's part is shown like any hostname, the label kept.
  const team = kTeamEntryLabel;
  if (name.length > team.length && name.endsWith(team)) {
    return '${superTabMachineName(name.substring(0, name.length - team.length))}$team';
  }
  const suffix = '.local';
  return name.length > suffix.length && name.toLowerCase().endsWith(suffix)
      ? name.substring(0, name.length - suffix.length)
      : name;
}
