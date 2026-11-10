/// Avatars as the backend sends them (backend superTabs/profile.ts). Only
/// Swarm members read them; a value this build does not know reads as absent.
library;

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

/// Where the chat files' CDN serves them, the same setting as the chat files'
/// own host. A server without an avatar bucket keeps pictures there too, in
/// [kSuperTabAvatarFolder].
const kSuperTabAvatarCdnHost = String.fromEnvironment(
  'SUPER_TAB_ATTACHMENTS_HOST',
  defaultValue: 'cdn.harness.autonomous.ai',
);

/// The folder a server without an avatar bucket keeps pictures in, among the
/// chat files (backend avatarLinks.ts): it links nothing outside it.
const kSuperTabAvatarFolder = 'avatars';

/// A picture someone uploaded, through the link a member read carries: https,
/// and only on the avatar host (a private bucket's signed link) or in the
/// avatars folder on the chat files' CDN (a server without an avatar bucket,
/// Ken 2026-10-28). Never a chat file, and never an outside address.
class SuperTabUploadedAvatar extends SuperTabAvatarPicture {
  const SuperTabUploadedAvatar._(this.url);
  final Uri url;

  static SuperTabUploadedAvatar? of(String value) {
    final url = Uri.tryParse(value);
    if (url == null || url.scheme != 'https') return null;
    if (url.host == kSuperTabAvatarHost) return SuperTabUploadedAvatar._(url);
    final path = url.pathSegments;
    final inFolder =
        path.length > 1 &&
        path.first == kSuperTabAvatarFolder &&
        path
            .skip(1)
            .every((part) => part.isNotEmpty && part != '..' && part != '.');
    return url.host == kSuperTabAvatarCdnHost && inFolder
        ? SuperTabUploadedAvatar._(url)
        : null;
  }
}

class SuperTabPresetAvatar extends SuperTabAvatarPicture {
  const SuperTabPresetAvatar(this.key);
  final String key;
  String get glyph => superTabAvatarPresets[key]!;
}

/// The preset pictures a person or an agent may wear (backend AVATAR_PRESETS): nothing offers them
/// any more, but those already chosen are drawn.
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
