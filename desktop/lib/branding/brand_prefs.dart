// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';

/// What the cold-launch splash shows. [omarchy] reads the system's own wordmark at runtime
/// (`/usr/share/omarchy/logo.svg`); nothing of Omarchy's is bundled in this repo.
enum BootLogo { omarchy, harness, custom, none }

/// What sits inside the ring of an agent that waits on you.
enum AvatarSource { generic, initials, system, custom }

@immutable
class BrandPrefs {
  const BrandPrefs({this.bootLogo, this.customLogoPath, this.avatar = AvatarSource.generic, this.avatarPath, this.initials = ''});

  /// Null until chosen, which means no splash: a person turns it on in Settings ▸ Appearance.
  final BootLogo? bootLogo;
  final String? customLogoPath;
  final AvatarSource avatar;
  final String? avatarPath;
  final String initials;

  BrandPrefs copyWith({BootLogo? bootLogo, String? customLogoPath, AvatarSource? avatar, String? avatarPath, String? initials}) => BrandPrefs(
        bootLogo: bootLogo ?? this.bootLogo,
        customLogoPath: customLogoPath ?? this.customLogoPath,
        avatar: avatar ?? this.avatar,
        avatarPath: avatarPath ?? this.avatarPath,
        initials: initials ?? this.initials,
      );

  @override
  bool operator ==(Object other) =>
      other is BrandPrefs && other.bootLogo == bootLogo && other.customLogoPath == customLogoPath && other.avatar == avatar && other.avatarPath == avatarPath && other.initials == initials;
  @override
  int get hashCode => Object.hash(bootLogo, customLogoPath, avatar, avatarPath, initials);
}

/// The logo the splash will actually draw, after every fallback.
@immutable
class ResolvedLogo {
  const ResolvedLogo(this.kind, [this.path]);
  final BootLogo kind;

  /// A file on disk for [BootLogo.omarchy] and [BootLogo.custom]; null for the bundled Harness icon.
  final String? path;
  bool get isSvg => path?.toLowerCase().endsWith('.svg') ?? false;
}

@immutable
class ResolvedAvatar {
  const ResolvedAvatar(this.kind, {this.path, this.initials = ''});
  final AvatarSource kind;
  final String? path;
  final String initials;
}

/// Boot logo and personal avatar, stored beside the other appearance settings. Keys:
/// `brand_boot_logo`, `brand_boot_logo_path`, `brand_avatar`, `brand_avatar_path`,
/// `brand_avatar_initials`. Picked files are validated (SVG or PNG, at most 2 MB, real content) and
/// copied into `<data dir>/brand/`, so moving or deleting the original never breaks the app. Every
/// read falls back: a missing file means the default, never an error.
class BrandPrefsStore extends ValueNotifier<BrandPrefs> {
  BrandPrefsStore({LocalKeyValueStore? storage, Directory? dataDir, this.omarchyLogoPath = '/usr/share/omarchy/logo.svg', String? systemAvatarPath})
      : _storage = storage ?? HarnessFileStore.shared,
        _dataDir = dataDir ?? Directory('${_home()}/.harness/desktop-app-v2/brand'),
        systemAvatarPath = systemAvatarPath ?? '${_home()}/.face',
        super(const BrandPrefs());

  static String _home() => kIsWeb ? '' : (Platform.environment['HOME'] ?? Platform.environment['USERPROFILE'] ?? '');

  static const bootLogoKey = 'brand_boot_logo';
  static const bootLogoPathKey = 'brand_boot_logo_path';
  static const avatarKey = 'brand_avatar';
  static const avatarPathKey = 'brand_avatar_path';
  static const initialsKey = 'brand_avatar_initials';
  static const maxBytes = 2 * 1024 * 1024;

  final LocalKeyValueStore _storage;
  final Directory _dataDir;
  final String omarchyLogoPath;
  final String systemAvatarPath;

  bool get omarchyAvailable => !kIsWeb && File(omarchyLogoPath).existsSync();
  bool get systemAvatarAvailable => !kIsWeb && File(systemAvatarPath).existsSync();

  Future<void> load() async {
    try {
      final saved = <String, String?>{};
      for (final k in [bootLogoKey, bootLogoPathKey, avatarKey, avatarPathKey, initialsKey]) {
        saved[k] = await _storage.read(k);
      }
      value = BrandPrefs(
        bootLogo: BootLogo.values.where((e) => e.name == saved[bootLogoKey]).firstOrNull,
        customLogoPath: saved[bootLogoPathKey],
        avatar: AvatarSource.values.where((e) => e.name == saved[avatarKey]).firstOrNull ?? AvatarSource.generic,
        avatarPath: saved[avatarPathKey],
        initials: saved[initialsKey] ?? '',
      );
    } catch (_) {
      // Unreadable settings leave the defaults in place.
    }
  }

  ResolvedLogo resolveBootLogo() {
    // No splash until somebody picks a logo; a picked image that has gone shows none either.
    const fallback = ResolvedLogo(BootLogo.none);
    switch (value.bootLogo) {
      case null:
      case BootLogo.none:
        return fallback;
      case BootLogo.harness:
        return const ResolvedLogo(BootLogo.harness);
      case BootLogo.omarchy:
        return omarchyAvailable ? ResolvedLogo(BootLogo.omarchy, omarchyLogoPath) : const ResolvedLogo(BootLogo.harness);
      case BootLogo.custom:
        final p = value.customLogoPath;
        return p != null && !kIsWeb && File(p).existsSync() ? ResolvedLogo(BootLogo.custom, p) : fallback;
    }
  }

  ResolvedAvatar resolveAvatar() {
    const generic = ResolvedAvatar(AvatarSource.generic);
    switch (value.avatar) {
      case AvatarSource.generic:
        return generic;
      case AvatarSource.initials:
        return value.initials.isEmpty ? generic : ResolvedAvatar(AvatarSource.initials, initials: value.initials);
      case AvatarSource.system:
        return systemAvatarAvailable ? ResolvedAvatar(AvatarSource.system, path: systemAvatarPath) : generic;
      case AvatarSource.custom:
        final p = value.avatarPath;
        return p != null && !kIsWeb && File(p).existsSync() ? ResolvedAvatar(AvatarSource.custom, path: p) : generic;
    }
  }

  Future<void> setBootLogo(BootLogo logo) async {
    value = value.copyWith(bootLogo: logo);
    await _storage.write(bootLogoKey, logo.name);
  }

  /// Validates and copies [source]; returns a message for the person on failure (choice unchanged).
  Future<String?> setCustomLogo(String source) async {
    final copied = await _import(source, 'boot-logo');
    if (copied.error != null) return copied.error;
    value = value.copyWith(bootLogo: BootLogo.custom, customLogoPath: copied.path);
    await _storage.write(bootLogoPathKey, copied.path!);
    await _storage.write(bootLogoKey, BootLogo.custom.name);
    return null;
  }

  Future<void> setAvatar(AvatarSource source) async {
    value = value.copyWith(avatar: source);
    await _storage.write(avatarKey, source.name);
  }

  /// Up to three letters, upper case. Empty goes back to the generic glyph.
  Future<void> setInitials(String raw) async {
    final clean = raw.replaceAll(RegExp(r'\s+'), '').toUpperCase();
    final initials = clean.length > 3 ? clean.substring(0, 3) : clean;
    value = value.copyWith(initials: initials, avatar: initials.isEmpty ? AvatarSource.generic : AvatarSource.initials);
    await _storage.write(initialsKey, initials);
    await _storage.write(avatarKey, value.avatar.name);
  }

  Future<String?> setCustomAvatar(String source) async {
    final copied = await _import(source, 'avatar');
    if (copied.error != null) return copied.error;
    value = value.copyWith(avatar: AvatarSource.custom, avatarPath: copied.path);
    await _storage.write(avatarPathKey, copied.path!);
    await _storage.write(avatarKey, AvatarSource.custom.name);
    return null;
  }

  /// A problem with [path] as an image, or null when it is a real SVG or PNG under [maxBytes].
  static Future<String?> validateImage(String path) async {
    final f = File(path);
    if (!await f.exists()) return 'That file no longer exists.';
    final ext = path.toLowerCase().split('.').last;
    if (ext != 'svg' && ext != 'png') return 'Choose an SVG or PNG image.';
    final size = await f.length();
    if (size > maxBytes) return 'That image is larger than 2 MB.';
    final head = await f.openRead(0, 512).fold<List<int>>([], (a, b) => a..addAll(b));
    final ok = ext == 'png'
        ? head.length >= 8 && listEquals(head.sublist(0, 8), const [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        : utf8.decode(head, allowMalformed: true).contains('<svg');
    return ok ? null : 'That is not a valid ${ext.toUpperCase()} file.';
  }

  Future<({String? path, String? error})> _import(String source, String name) async {
    try {
      final problem = await validateImage(source);
      if (problem != null) return (path: null, error: problem);
      await _dataDir.create(recursive: true);
      final ext = source.toLowerCase().split('.').last;
      // A fresh name each time, so a cached decode of the previous image is never shown again.
      final dest = File('${_dataDir.path}/$name-${DateTime.now().microsecondsSinceEpoch}.$ext');
      await File(source).copy(dest.path);
      for (final old in _dataDir.listSync().whereType<File>()) {
        if (old.path != dest.path && old.uri.pathSegments.last.startsWith('$name-')) {
          try {
            old.deleteSync();
          } catch (_) {}
        }
      }
      return (path: dest.path, error: null);
    } catch (e) {
      return (path: null, error: 'Could not use that file: $e');
    }
  }
}

/// The app's one instance, loaded in `loadPersistedSettings()`.
final brandPrefsStore = BrandPrefsStore();
