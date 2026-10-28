import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'model.dart';

/// What a person or an agent wears inside their round mark, as the desktop
/// draws it (`desktop/lib/super_tabs/avatar_art.dart`): the picture they
/// uploaded, the built-in one they picked on a wash of [tint], or [fallback]
/// — their initial — when they have neither, while an upload loads, and when
/// it cannot.
class SwarmFace extends StatelessWidget {
  const SwarmFace({
    super.key,
    required this.picture,
    required this.size,
    required this.tint,
    required this.fallback,
  });

  final SuperTabAvatarPicture? picture;
  final double size;
  final Color tint;
  final Widget fallback;

  @override
  Widget build(BuildContext context) => switch (picture) {
    SuperTabUploadedAvatar(:final url) => ClipOval(
      child: Image(
        image: SwarmAvatarImages.of(context, url),
        width: size,
        height: size,
        fit: BoxFit.cover,
        // A link signed anew keeps the picture shown while it loads.
        gaplessPlayback: true,
        frameBuilder: (context, child, frame, synchronous) =>
            frame == null && !synchronous ? fallback : child,
        errorBuilder: (context, _, _) => fallback,
      ),
    ),
    SuperTabPresetAvatar(:final glyph) => Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: tint.withValues(alpha: .18),
        shape: BoxShape.circle,
      ),
      child: Text(
        glyph,
        textScaler: TextScaler.noScaling,
        style: TextStyle(fontSize: size * .58, height: 1),
      ),
    ),
    null => fallback,
  };
}

/// Where an uploaded avatar's picture is read from: its signed link
/// (backend avatarLinks.ts), over the network. Tests hand in bytes instead.
class SwarmAvatarImages extends InheritedWidget {
  const SwarmAvatarImages({
    super.key,
    required this.image,
    required super.child,
  });

  final ImageProvider Function(Uri url) image;

  static ImageProvider of(BuildContext context, Uri url) =>
      context.dependOnInheritedWidgetOfExactType<SwarmAvatarImages>()?.image(
        url,
      ) ??
      swarmAvatarImage(url);

  @override
  bool updateShouldNotify(SwarmAvatarImages old) => old.image != image;
}

/// The links of the photos drawn while this account has been signed in.
final _drawnLinks = <String>{};

/// The uploaded picture at [url], over the network, remembered so that
/// [swarmForgetAvatarImages] can let it go. Never kept on disk.
ImageProvider swarmAvatarImage(Uri url) {
  _drawnLinks.add(url.toString());
  return NetworkImage(url.toString());
}

/// Lets go of every photo drawn, as the account leaves: none of another
/// account's people stays in memory.
void swarmForgetAvatarImages() {
  // Nothing drawn, nothing to let go: and no painting needed to know it.
  if (_drawnLinks.isEmpty) return;
  final cache = PaintingBinding.instance.imageCache;
  for (final link in _drawnLinks) {
    cache.evict(NetworkImage(link), includeLive: true);
  }
  _drawnLinks.clear();
}

/// [face], [size] round, with a person's [status] emoji at its corner while
/// the status lasts; then it goes by itself. Read as [name] and the status.
class SwarmStatusFace extends StatelessWidget {
  const SwarmStatusFace({
    super.key,
    required this.face,
    required this.name,
    required this.size,
    required this.status,
  });

  final Widget face;
  final String name;
  final double size;
  final SuperTabPersonStatus? status;

  @override
  Widget build(BuildContext context) {
    if (status == null) return face;
    return SwarmUntil(
      until: status!.until,
      builder: (context) {
        final shown = status!.shownAt(clock.now()) ? status : null;
        if (shown == null) return face;
        final badge = (size * .5).clamp(12.0, 22.0);
        return Semantics(
          label: '$name, ${shown.label}',
          excludeSemantics: true,
          child: SizedBox.square(
            dimension: size,
            child: Stack(
              clipBehavior: Clip.none,
              children: [
                face,
                if (shown.emoji case final emoji?)
                  Positioned(
                    right: -badge * .25,
                    bottom: -badge * .25,
                    child: Container(
                      key: const ValueKey('swarm-status-badge'),
                      width: badge,
                      height: badge,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: AppPalette.panelBg,
                        shape: BoxShape.circle,
                        border: Border.all(color: AppGlass.hair, width: .5),
                      ),
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
      },
    );
  }
}

/// Builds [builder] again at [until], when something it shows runs out (a
/// status that clears itself), even when nothing else changes on the page:
/// the desktop's `SuperTabUntil`.
class SwarmUntil extends StatefulWidget {
  const SwarmUntil({super.key, required this.until, required this.builder});
  final DateTime? until;
  final WidgetBuilder builder;

  @override
  State<SwarmUntil> createState() => _SwarmUntilState();
}

class _SwarmUntilState extends State<SwarmUntil> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _schedule();
  }

  @override
  void didUpdateWidget(SwarmUntil old) {
    super.didUpdateWidget(old);
    if (old.until != widget.until) _schedule();
  }

  void _schedule() {
    _timer?.cancel();
    _timer = null;
    final until = widget.until;
    if (until == null) return;
    final left = until.difference(clock.now());
    if (left.isNegative) return;
    _timer = Timer(left + const Duration(milliseconds: 1), () {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder(context);
}

/// What a person or an agent wears: the picture they chose and, for a
/// person, their status.
typedef SwarmLook = ({
  SuperTabAvatarPicture? picture,
  SuperTabPersonStatus? status,
});

final _peopleById = Expando<Map<String, SuperTabPerson>>();

/// Who wears what in a Swarm as last read.
extension SwarmLooks on SuperTabSnapshot {
  /// The member [id]; looked up per row on every build, so kept by id once
  /// per read, as the snapshot's own lookups are.
  SuperTabPerson? person(String id) =>
      (_peopleById[this] ??= {for (final p in people.reversed) p.id: p})[id];

  SwarmLook agentLook(String id) => (picture: agent(id)?.avatar, status: null);

  SwarmLook personLook(String id) {
    final found = person(id);
    return (picture: found?.avatar, status: found?.status);
  }

  SwarmLook authorLook(SuperTabMessage message) => message.fromAgent
      ? agentLook(message.authorId)
      : personLook(message.authorId);
}

/// The same for two looks drawn alike, though each read makes new ones: what
/// a row kept as it was compares.
Object swarmLookKey(SwarmLook look) => (
  switch (look.picture) {
    SuperTabUploadedAvatar(:final url) => url,
    SuperTabPresetAvatar(:final key) => key,
    null => null,
  },
  look.status?.text,
  look.status?.emoji,
  look.status?.until,
);
