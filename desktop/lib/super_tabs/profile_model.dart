/// Avatars, status lines and reactions as the backend sends them
/// (backend superTabs/profile.ts and reactions.ts). Only Swarm members read
/// them; a value this build does not know reads as absent.
library;

import 'attachment_upload.dart' show kSuperTabAttachmentHost;

/// What a member or agent shows instead of the default.
sealed class SuperTabAvatarPicture {
  const SuperTabAvatarPicture();

  static SuperTabAvatarPicture? fromJson(Object? value) => switch (value) {
    {'kind': 'upload', 'url': final String url} => SuperTabUploadedAvatar.of(
      url,
    ),
    {'kind': 'preset', 'key': final String key}
        when superTabAvatarPresets.containsKey(key) =>
      SuperTabPresetAvatar(key),
    _ => null,
  };
}

/// Where the backend's private avatar bucket serves its signed links
/// (backend superTabs/avatarLinks.ts): Cloud Storage's own host.
const kSuperTabAvatarHost = String.fromEnvironment(
  'SUPER_TAB_AVATARS_HOST',
  defaultValue: 'storage.googleapis.com',
);

/// The folder a server without an avatar bucket keeps pictures in on the chat
/// files' CDN (backend attachments.ts `SHARED_AVATAR_PREFIX`).
const kSuperTabAvatarFolder = 'avatars';

/// A picture someone uploaded, through the link a member read carries: https,
/// and only on the avatar host (a private bucket's signed link) or in the
/// avatar folder of the chat files' CDN (a server without an avatar bucket
/// keeps pictures there, Ken 2026-10-28), never a chat file on it. Never an
/// outside address.
class SuperTabUploadedAvatar extends SuperTabAvatarPicture {
  const SuperTabUploadedAvatar._(this.url);
  final Uri url;

  static SuperTabUploadedAvatar? of(String value) {
    final url = Uri.tryParse(value);
    return url != null &&
            url.scheme == 'https' &&
            (url.host == kSuperTabAvatarHost ||
                (url.host == kSuperTabAttachmentHost &&
                    url.path.startsWith('/$kSuperTabAvatarFolder/')))
        ? SuperTabUploadedAvatar._(url)
        : null;
  }
}

class SuperTabPresetAvatar extends SuperTabAvatarPicture {
  const SuperTabPresetAvatar(this.key);
  final String key;
  String get glyph => superTabAvatarPresets[key]!;
}

/// The pictures a person may pick (backend AVATAR_PRESETS), in offer order.
const superTabAvatarPresets = {
  'fox': '🦊',
  'owl': '🦉',
  'cat': '🐱',
  'panda': '🐼',
  'octopus': '🐙',
  'cactus': '🌵',
  'rocket': '🚀',
  'sun': '🌞',
};

/// A person's short status. Shown until [until] passes.
class SuperTabPersonStatus {
  const SuperTabPersonStatus({required this.text, this.emoji, this.until});
  final String text;
  final String? emoji;
  final DateTime? until;

  static SuperTabPersonStatus? fromJson(Object? value) => switch (value) {
    {'text': final String text} when text.trim().isNotEmpty =>
      SuperTabPersonStatus(
        text: text,
        emoji: value['emoji'] is String ? value['emoji'] as String : null,
        until: DateTime.tryParse(value['until'] as String? ?? ''),
      ),
    _ => null,
  };

  String get label => emoji == null ? text : '$emoji $text';
  bool shownAt(DateTime now) => until == null || now.isBefore(until!);
}

/// The status emoji a person may pick, with the words each offers
/// (backend STATUS_EMOJI).
const superTabStatusPresets = [
  ('🎯', 'Focusing'),
  ('☕', 'Coffee break'),
  ('🍽️', 'At lunch'),
  ('🌴', 'Out of office'),
  ('🚶', 'Away'),
  ('🤒', 'Out sick'),
];

/// The reactions a message can carry, in the order counts show.
enum SuperTabReactionEmoji {
  thumbsUp('thumbs_up', '👍'),
  tada('tada', '🎉'),
  heart('heart', '❤️'),
  laugh('laugh', '😄'),
  eyes('eyes', '👀'),
  rocket('rocket', '🚀');

  const SuperTabReactionEmoji(this.key, this.glyph);
  final String key, glyph;

  static SuperTabReactionEmoji? of(Object? key) =>
      values.where((e) => e.key == key).firstOrNull;
}

/// One emoji's count on one message, and who gave it.
class SuperTabReactionCount {
  const SuperTabReactionCount(this.emoji, this.by);
  final SuperTabReactionEmoji emoji;
  final List<({String kind, String id})> by;
  int get count => by.length;

  bool includes(String kind, String id) =>
      by.any((who) => who.kind == kind && who.id == id);

  static List<SuperTabReactionCount> listFromJson(Object? value) => [
    if (value is List)
      for (final row in value)
        if (row case {'emoji': final Object key}
            when SuperTabReactionEmoji.of(key) != null)
          SuperTabReactionCount(SuperTabReactionEmoji.of(key)!, [
            for (final who in row['by'] as List? ?? const [])
              if (who case {'kind': final String kind, 'id': final String id})
                (kind: kind, id: id),
          ]),
  ];
}
