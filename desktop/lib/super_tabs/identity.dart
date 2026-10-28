import 'package:clock/clock.dart';
import 'package:flutter/material.dart';

import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import 'avatar_art.dart';
import 'model.dart';
import 'until.dart';

/// The one avatar for a person or an agent everywhere in the Swarm: rows,
/// messages, mentions, the Glance and the leaderboard. Stable across
/// engine/model changes. An agent wears its engine as a small badge; a person
/// their status emoji while it lasts.
class SuperTabAvatar extends StatelessWidget {
  const SuperTabAvatar({
    super.key,
    required this.identity,
    required this.name,
    this.size = 30,
    this.picture,
    this.engine,
    this.status,
    this.pattern = false,
    this.now,
  });

  SuperTabAvatar.person(
    SuperTabPerson person, {
    super.key,
    this.size = 30,
    this.now,
  }) : identity = 'person:${person.id}',
       name = superTabPersonName(person.email),
       picture = person.avatar,
       engine = null,
       status = person.status,
       pattern = false;

  /// [engineBadge] off where the row already shows the engine beside the
  /// name (the roster, messages), so it shows once.
  SuperTabAvatar.agent(
    SuperTabAgent agent, {
    super.key,
    String? name,
    this.size = 30,
    bool engineBadge = true,
  }) : identity = 'agent:${agent.id}',
       name = name ?? agent.displayName ?? agent.name,
       picture = agent.avatar,
       engine = engineBadge ? agent.engine : null,
       status = null,
       pattern = true,
       now = null;

  final String identity, name;
  final double size;
  final SuperTabAvatarPicture? picture;

  /// The agent's engine, drawn as its badge; null for a person.
  final String? engine;

  /// The person's status; it shows until its time, and the avatar redraws
  /// then by itself.
  final SuperTabPersonStatus? status;

  /// A fixed time to judge [status] by; the clock's when null.
  final DateTime? now;

  /// Draw the agent pattern rather than an initial when there is no picture.
  final bool pattern;

  @override
  Widget build(BuildContext context) {
    final badge = size * .46;
    final face = SuperTabAvatarFace(
      identity: identity,
      name: name,
      size: size,
      picture: picture,
      pattern: pattern,
    );
    return SuperTabUntil(
      until: now == null ? status?.until : null,
      builder: (context) => _drawn(face, badge),
    );
  }

  Widget _drawn(Widget face, double badge) {
    final status = this.status?.shownAt(now ?? clock.now()) == true
        ? this.status
        : null;
    return Semantics(
      label: status == null ? null : '$name, ${status.label}',
      child: SizedBox.square(
        dimension: size,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            face,
            if (engine case final engine? when engine.isNotEmpty)
              Positioned(
                right: -badge * .2,
                bottom: -badge * .2,
                child: _Badge(
                  size: badge,
                  child: EngineMark(engine: engine, size: badge * .72),
                ),
              ),
            if (status?.emoji case final emoji?)
              Positioned(
                right: -badge * .2,
                bottom: -badge * .2,
                child: _Badge(
                  size: badge,
                  child: Text(
                    emoji,
                    textScaler: TextScaler.noScaling,
                    style: TextStyle(fontSize: badge * .66, height: 1),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
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
String superTabMachineName(String name) {
  const suffix = '.local';
  return name.length > suffix.length && name.toLowerCase().endsWith(suffix)
      ? name.substring(0, name.length - suffix.length)
      : name;
}
