import 'dart:convert';
import 'dart:io';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/harness_file_store.dart';
import 'package:harness/settings/config_store.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late Directory scratch;
  late Directory dataDirectory;

  setUp(() async {
    scratch = await Directory.systemTemp.createTemp('desktop-file-store-test-');
    dataDirectory = Directory('${scratch.path}/desktop-app');
  });

  tearDown(() async {
    if (await scratch.exists()) {
      await scratch.delete(recursive: true);
    }
  });

  test('defaults to the Desktop directory beneath Harness home', () {
    final path = HarnessFileStore.defaultDirectoryPath(
      environment: {'HOME': '/Users/tester'},
    );

    expect(path, '/Users/tester/.harness/desktop-app-v2');
  }, skip: Platform.isWindows);

  test(
    'persists values across instances without losing concurrent writes',
    () async {
      final first = HarnessFileStore(directory: dataDirectory);
      final second = HarnessFileStore(directory: dataDirectory);

      await Future.wait([
        first.write('alpha', 'one'),
        second.write('beta', 'two'),
      ]);

      final reopened = HarnessFileStore(directory: dataDirectory);
      expect(await reopened.read('alpha'), 'one');
      expect(await reopened.read('beta'), 'two');

      await reopened.delete('alpha');
      expect(
        await HarnessFileStore(directory: dataDirectory).read('alpha'),
        isNull,
      );
      expect(await reopened.read('beta'), 'two');
    },
  );

  test('auth and config share one persistent document', () async {
    final storage = HarnessFileStore(directory: dataDirectory);
    final auth = AuthSession(storage: storage);
    final config = ConfigStore(storage: storage);

    await auth.saveLogin(
      token: 'access-secret',
      refreshToken: 'refresh-secret',
      autonomousEnv: 'stag',
      expiresIn: 3600,
    );
    await config.save('https://harness-api.example.test');
    await config.saveEnvironment('stag');
    await config.saveSkippedDesktopUpdateVersion('1.2.3');

    final reopenedStorage = HarnessFileStore(directory: dataDirectory);
    final reopenedAuth = AuthSession(storage: reopenedStorage);
    final reopenedConfig = ConfigStore(storage: reopenedStorage);

    expect(await reopenedAuth.accessToken(), 'access-secret');
    expect(await reopenedAuth.refreshToken(), 'refresh-secret');
    expect(await reopenedAuth.autonomousEnv(), 'stag');
    expect(await reopenedAuth.accessTokenExpiresAt(), isNotNull);
    expect(
      (await reopenedConfig.load()).apiBaseUrl,
      'https://harness-api.example.test',
    );
    expect(reopenedConfig.config.autonomousEnv, 'stag');
    expect(reopenedConfig.skippedDesktopUpdateVersion, '1.2.3');

    await reopenedConfig.saveSkippedDesktopUpdateVersion(null);
    await reopenedConfig.load();
    expect(reopenedConfig.skippedDesktopUpdateVersion, isNull);

    await reopenedAuth.clear();
    expect(await reopenedAuth.accessToken(), isNull);
    expect(await reopenedAuth.refreshToken(), isNull);
    expect(
      (await reopenedConfig.load()).apiBaseUrl,
      'https://harness-api.example.test',
    );
  });

  test('batch reads select keys and respect intervening writes', () async {
    final first = HarnessFileStore(directory: dataDirectory);
    final second = HarnessFileStore(directory: dataDirectory);
    await first.write('preference', 'before');
    await first.write('credential', 'synthetic-secret');

    final keys = ['preference', 'missing', 'preference'];
    final before = first.readMany(keys);
    keys.add('credential'); // An enqueued request owns its original key set.
    final write = second.write('preference', 'after');
    final after = first.readMany(['preference', 'missing']);
    expect(await before, {'preference': 'before', 'missing': null});
    await write;
    expect(await after, {'preference': 'after', 'missing': null});

    await second.delete('preference');
    expect(await first.readMany(['preference']), {'preference': null});
    expect(await second.read('credential'), 'synthetic-secret');
  });

  test('an empty batch does not create storage', () async {
    final store = HarnessFileStore(directory: dataDirectory);
    expect(await store.readMany([]), isEmpty);
    expect(await dataDirectory.exists(), isFalse);
  });

  test('batch reads retain corruption and future-schema recovery', () async {
    final store = HarnessFileStore(directory: dataDirectory);
    await store.write('seed', 'value');
    await store.stateFile.writeAsString('{broken');
    expect(await store.readMany(['seed']), {'seed': null});
    expect(await store.stateFile.exists(), isFalse);
    final backups = await dataDirectory
        .list()
        .where((entry) => entry.path.contains('state.corrupt-'))
        .toList();
    expect(backups, hasLength(1));
    expect(await File(backups.single.path).readAsString(), '{broken');

    final futureDocument = jsonEncode({
      'version': HarnessFileStore.schemaVersion + 1,
      'values': {'seed': 'future'},
    });
    await store.stateFile.writeAsString(futureDocument);
    await expectLater(
      store.readMany(['seed']),
      throwsA(isA<UnsupportedStateVersionException>()),
    );
    expect(await store.stateFile.readAsString(), futureDocument);
  });

  test('quarantines malformed JSON and starts with empty state', () async {
    final store = HarnessFileStore(directory: dataDirectory);
    await store.write('seed', 'value');
    await store.stateFile.writeAsString('{not-json');

    final reopened = HarnessFileStore(directory: dataDirectory);
    expect(await reopened.read('seed'), isNull);
    expect(await reopened.stateFile.exists(), isFalse);
    final backups = await dataDirectory
        .list()
        .where((entry) => entry.path.contains('state.corrupt-'))
        .toList();
    expect(backups, hasLength(1));
    expect(await File(backups.single.path).readAsString(), '{not-json');
  });

  test('refuses to overwrite a newer state schema', () async {
    final store = HarnessFileStore(directory: dataDirectory);
    await store.write('seed', 'value');
    await store.stateFile.writeAsString(
      jsonEncode({
        'version': HarnessFileStore.schemaVersion + 1,
        'values': {'seed': 'future'},
      }),
    );

    final reopened = HarnessFileStore(directory: dataDirectory);
    await expectLater(
      reopened.write('another', 'value'),
      throwsA(isA<UnsupportedStateVersionException>()),
    );
    expect(
      jsonDecode(await reopened.stateFile.readAsString())['version'],
      HarnessFileStore.schemaVersion + 1,
    );
  });

  test('creates private directory, state, lock, and backup modes', () async {
    final store = HarnessFileStore(directory: dataDirectory);
    await store.write('seed', 'value');
    await store.stateFile.writeAsString('broken');
    await HarnessFileStore(directory: dataDirectory).read('seed');

    expect((await dataDirectory.stat()).mode & 0x1ff, 0x1c0); // 0700
    for (final entry in await dataDirectory.list().toList()) {
      if (entry is File) {
        expect((await entry.stat()).mode & 0x1ff, 0x180); // 0600
      }
    }
  }, skip: Platform.isWindows);

  test(
    'reads repair directory and lock permissions changed between calls',
    () async {
      final store = HarnessFileStore(directory: dataDirectory);
      await store.write('preference', 'kept');
      final lock = File(
        '${dataDirectory.path}/${HarnessFileStore.lockFileName}',
      );

      for (final reader in [
        store,
        HarnessFileStore(directory: dataDirectory),
      ]) {
        expect(
          (await Process.run('/bin/chmod', [
            '755',
            dataDirectory.path,
          ])).exitCode,
          0,
        );
        expect(
          (await Process.run('/bin/chmod', ['664', lock.path])).exitCode,
          0,
        );
        expect(await reader.readMany(['preference']), {'preference': 'kept'});
        expect((await dataDirectory.stat()).mode & 0xfff, 0x1c0);
        expect((await lock.stat()).mode & 0xfff, 0x180);
        expect((await store.stateFile.stat()).mode & 0xfff, 0x180);
      }
    },
    skip: Platform.isWindows,
  );

  test(
    'a replacement directory at the same path is made private again',
    () async {
      final store = HarnessFileStore(directory: dataDirectory);
      await store.write('preference', 'old');
      await dataDirectory.delete(recursive: true);
      await dataDirectory.create();
      expect(
        (await Process.run('/bin/chmod', ['755', dataDirectory.path])).exitCode,
        0,
      );
      await store.write('preference', 'new');
      expect(await store.read('preference'), 'new');
      expect((await dataDirectory.stat()).mode & 0xfff, 0x1c0);
      expect((await store.stateFile.stat()).mode & 0xfff, 0x180);
    },
    skip: Platform.isWindows,
  );
}
