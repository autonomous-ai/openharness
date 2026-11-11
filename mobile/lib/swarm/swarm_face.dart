import 'package:flutter/material.dart';

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

final _peopleById = Expando<Map<String, SuperTabPerson>>();

/// Who wears what in a Swarm as last read.
extension SwarmPictures on SuperTabSnapshot {
  /// The member [id]; looked up per row on every build, so kept by id once
  /// per read, as the snapshot's own lookups are.
  SuperTabPerson? person(String id) =>
      (_peopleById[this] ??= {for (final p in people.reversed) p.id: p})[id];

  /// What the author of [message] wears, an agent or a person.
  SuperTabAvatarPicture? authorPicture(SuperTabMessage message) =>
      message.fromAgent
      ? agent(message.authorId)?.avatar
      : person(message.authorId)?.avatar;
}

/// The same for two pictures drawn alike, though each read makes new ones:
/// what a row kept as it was compares.
Object? swarmPictureKey(SuperTabAvatarPicture? picture) => switch (picture) {
  SuperTabUploadedAvatar(:final url) => url,
  SuperTabPresetAvatar(:final key) => key,
  null => null,
};
