import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';

import '../logging/app_log.dart';
import 'harness_file_store.dart';

/// The files the Swarm sealed its Home and its drafts in, beside the app's state, each with the
/// copy a write went through.
const swarmLeftoverFiles = [
  'swarm-home.bin',
  'swarm-home.bin.next',
  'swarm-kept.bin',
  'swarm-kept.bin.next',
];

/// Its folders in the app's temporary folder: the chat files it kept, one folder per account, and
/// the copies of files a chat was sending.
const swarmLeftoverFolders = ['swarm-attachments', 'harness-swarm-outgoing'];

/// The Keychain keys (Android: Keystore-backed) its two files were sealed under.
const swarmLeftoverKeys = ['swarm_home_key', 'swarm_kept_key'];

/// Its Android notification channels, which the phone's own settings still list.
const _swarmChannels = ['swarm-needs-you', 'swarm-quiet'];

/// The keys [forgetSwarmLeftovers] takes out: true when [key] was there.
abstract interface class LeftoverKeys {
  Future<bool> remove(String key);
}

class KeychainLeftoverKeys implements LeftoverKeys {
  const KeychainLeftoverKeys();

  static const _storage = FlutterSecureStorage(
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.first_unlock_this_device,
    ),
  );

  @override
  Future<bool> remove(String key) async {
    if (!await _storage.containsKey(key: key)) return false;
    await _storage.delete(key: key);
    return true;
  }
}

/// What the Swarm left on this phone when it was taken out of the app (2026-11-14): sign-out used
/// to clear it, and nothing reads it now. Gone at every launch until 2027-02-14, when this file can
/// go, and `harness/app_badge` in `ios/Runner/AppDelegate.swift` with it.
///
/// Only the names above: what is not there is skipped, so a second run does nothing. One step that
/// fails does not stop the others. The log says how many went, never where or what.
Future<void> forgetSwarmLeftovers({
  Directory? state,
  Future<Directory> Function() temporary = getTemporaryDirectory,
  LeftoverKeys keys = const KeychainLeftoverKeys(),
}) async {
  var files = 0, folders = 0, removedKeys = 0;
  final failed = <String>{};
  Future<void> step(Future<void> Function() run) async {
    try {
      await run();
    } catch (error) {
      // The type alone: a file system error names its path.
      failed.add('${error.runtimeType}');
    }
  }

  final beside = state ?? HarnessFileStore.shared.directory;
  for (final name in swarmLeftoverFiles) {
    await step(() async {
      final file = File('${beside.path}/$name');
      if (!await file.exists()) return;
      await file.delete();
      files++;
    });
  }
  await step(() async {
    final temp = await temporary();
    for (final name in swarmLeftoverFolders) {
      final folder = Directory('${temp.path}/$name');
      if (!await folder.exists()) continue;
      await folder.delete(recursive: true);
      folders++;
    }
  });
  for (final key in swarmLeftoverKeys) {
    await step(() async {
      if (await keys.remove(key)) removedKeys++;
    });
  }
  if (Platform.isIOS) {
    // The app icon's count the Swarm set, which no one else sets or takes off.
    await step(
      () => const MethodChannel('harness/app_badge').invokeMethod<void>('set', 0),
    );
  }
  if (Platform.isAndroid) {
    final android = FlutterLocalNotificationsPlugin()
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >();
    for (final channel in _swarmChannels) {
      await step(
        () async => android?.deleteNotificationChannel(channelId: channel),
      );
    }
  }
  if (files + folders + removedKeys > 0) {
    appLog.info(
      'swarm',
      'leftovers removed: $files files, $folders folders, $removedKeys keys',
    );
  }
  if (failed.isNotEmpty) {
    appLog.warn('swarm', 'leftovers not all removed: ${failed.join(', ')}');
  }
}
