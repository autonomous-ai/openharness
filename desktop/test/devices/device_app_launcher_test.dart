import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/devices/device_app_launcher.dart';

/// The rule every writer of the entry follows (the Device app, Desktop, the
/// one-line installer), as data.
final _vectors = jsonDecode(
  File('../tests/fixtures/app-list-entry-vectors.json').readAsStringSync(),
) as Map<String, dynamic>;

/// The Linux app-list entry against a temporary home: nothing here writes
/// under this computer's own. The entry's paths are POSIX, so Windows skips.
void main() {
  late Directory root;
  late String home, place;

  setUp(() {
    root = Directory.systemTemp.createTempSync('device-app-launcher-test-');
    home = '${root.path}/home/p';
    place = '$home/.local/opt/Harness-Device.AppImage';
    File(place)
      ..createSync(recursive: true)
      ..writeAsStringSync('');
  });
  tearDown(() => root.deleteSync(recursive: true));

  File entryIn(String data) =>
      File('$data/applications/harness-device.desktop');
  File iconIn(String data) => File('$data/icons/harness-device.png');
  String data() => '$home/.local/share';

  /// A vectors' text with its home, `/home/p`, under the temporary root.
  String rooted(String text) =>
      text.replaceAll('/home/p', '${root.path}/home/p');

  Future<void> write(
    String appImage, {
    Map<String, String>? environment,
    List<int>? icon = const [1, 2, 3],
  }) => writeDeviceAppLauncher(
    appImage,
    environment: environment ?? {'HOME': home},
    extractIcon: (_) async => icon,
  );

  /// An entry, as a person or an earlier copy left it, that starts [target].
  void entryFor(String target) => entryIn(data())
    ..createSync(recursive: true)
    ..writeAsStringSync('[Desktop Entry]\nExec=$target\n');

  test(
    'the entry starts the place, named Harness Device, with its icon',
    () async {
      await write(place);

      final withIcon = (_vectors['entries'] as List).first as Map;
      expect(withIcon['icon'], isTrue);
      expect(
        entryIn(data()).readAsStringSync(),
        rooted(withIcon['entry'] as String),
      );
      expect(iconIn(data()).readAsBytesSync(), [1, 2, 3]);
    },
    skip: Platform.isWindows,
  );

  test("the entry is the vectors' byte for byte", () async {
    for (final vector in (_vectors['entries'] as List).cast<Map>()) {
      final dataHome = rooted(vector['dataHome'] as String);
      await writeDeviceAppLauncher(
        rooted(vector['appImage'] as String),
        environment: {'HOME': home, 'XDG_DATA_HOME': dataHome},
        extractIcon: (_) async => vector['icon'] as bool ? const [1] : null,
      );

      expect(
        entryIn(dataHome).readAsStringSync(),
        rooted(vector['entry'] as String),
        reason: vector['appImage'] as String,
      );
      entryIn(dataHome).deleteSync();
    }
  }, skip: Platform.isWindows);

  test("the decisions are the vectors'", () {
    for (final vector in (_vectors['decisions'] as List).cast<Map>()) {
      final onDisk = (vector['onDisk'] as List).cast<String>().toSet();
      expect(
        deviceAppLauncherChange(
          existing: vector['existing'] as String?,
          appImage: vector['appImage'] as String,
          wanted: vector['wanted'] as String,
          exists: onDisk.contains,
        ),
        vector['write'],
        reason: vector['name'] as String,
      );
    }
  });

  test('a path with a control character writes nothing', () async {
    for (final appImage in [
      '$home/a\nb/Harness-Device.AppImage',
      '$home/a\tb/Harness-Device.AppImage',
      '$home/a\x7fb/Harness-Device.AppImage',
    ]) {
      await write(appImage);
    }
    await write(place, environment: {'HOME': '$home/a\rb'});

    expect(
      Directory(root.path)
          .listSync(recursive: true)
          .whereType<File>()
          .map((file) => file.path),
      [place],
    );
  }, skip: Platform.isWindows);

  test('the entry is written whole', () async {
    await write(place);
    iconIn(data()).deleteSync();
    await write(place, icon: const [4, 5]);

    expect(
      Directory('${data()}/applications')
          .listSync()
          .map((file) => file.uri.pathSegments.last),
      ['harness-device.desktop'],
    );
    expect(
      Directory('${data()}/icons')
          .listSync()
          .map((file) => file.uri.pathSegments.last),
      ['harness-device.png'],
    );
    expect(iconIn(data()).readAsBytesSync(), [4, 5]);
  }, skip: Platform.isWindows);

  test('XDG_DATA_HOME is followed', () async {
    final xdg = '${root.path}/xdg';

    await write(place, environment: {'HOME': home, 'XDG_DATA_HOME': xdg});

    expect(entryIn(xdg).readAsStringSync(), contains('Exec=$place\n'));
    expect(
      entryIn(xdg).readAsStringSync(),
      contains('Icon=$xdg/icons/harness-device.png\n'),
    );
    expect(iconIn(xdg).readAsBytesSync(), [1, 2, 3]);
    expect(entryIn(data()).existsSync(), isFalse);
  }, skip: Platform.isWindows);

  test('a place with a space is quoted in Exec=', () async {
    final spaced = '${root.path}/Nguyễn Văn A';
    final appImage = '$spaced/.local/opt/Harness-Device.AppImage';

    await write(appImage, environment: {'HOME': spaced});

    final entry = entryIn('$spaced/.local/share').readAsStringSync();
    expect(entry, contains('Exec="$appImage"\n'));
    expect(
      entry,
      contains('Icon=$spaced/.local/share/icons/harness-device.png\n'),
    );
  }, skip: Platform.isWindows);

  test('a % in the place is written %% in Exec=', () async {
    final odd = '${root.path}/50%off';
    final appImage = '$odd/.local/opt/Harness-Device.AppImage';

    await write(appImage, environment: {'HOME': odd});

    expect(
      entryIn('$odd/.local/share').readAsStringSync(),
      contains(
        'Exec=${root.path}/50%%off/.local/opt/Harness-Device.AppImage\n',
      ),
    );
  }, skip: Platform.isWindows);

  test(
    'an entry for a place with a " in it is read whole, and stays',
    () async {
      final odd = '${root.path}/a"b';
      final appImage = '$odd/.local/opt/Harness-Device.AppImage';
      File(appImage)
        ..createSync(recursive: true)
        ..writeAsStringSync('');
      await write(appImage, environment: {'HOME': odd});

      await forgetGoneDeviceAppLauncher(environment: {'HOME': odd});

      expect(entryIn('$odd/.local/share').existsSync(), isTrue);
    },
    skip: Platform.isWindows,
  );

  test('an icon that cannot be taken leaves the entry without one', () async {
    await write(place, icon: null);

    final entry = entryIn(data()).readAsStringSync();
    expect(entry, contains('Exec=$place\n'));
    expect(entry, isNot(contains('Icon=')));
    expect(iconIn(data()).existsSync(), isFalse);
  }, skip: Platform.isWindows);

  test(
    'an entry naming another AppImage still on disk is left alone',
    () async {
      final other = '$home/Downloads/Harness-Device-linux-x64.AppImage';
      File(other)
        ..createSync(recursive: true)
        ..writeAsStringSync('');
      entryFor(other);

      await write(place);

      expect(
        entryIn(data()).readAsStringSync(),
        '[Desktop Entry]\nExec=$other\n',
      );
      expect(iconIn(data()).existsSync(), isFalse);
    },
    skip: Platform.isWindows,
  );

  test('an entry whose AppImage is gone is written again', () async {
    entryFor('$home/Downloads/Harness-Device-linux-x64.AppImage');

    await write(place);

    expect(entryIn(data()).readAsStringSync(), contains('Exec=$place\n'));
    expect(iconIn(data()).readAsBytesSync(), [1, 2, 3]);
  }, skip: Platform.isWindows);

  // Desktop only ever writes Exec=<the place>: an entry that starts a program
  // by name, or through a wrapper, is someone else's, and the PATH finds it.
  test(
    'an entry that starts a program by name stays, at launch and on install',
    () async {
      for (final exec in ['harness-device', 'env X=1 harness-device']) {
        entryFor(exec);
        iconIn(data())
          ..createSync(recursive: true)
          ..writeAsBytesSync(const [9]);

        await forgetGoneDeviceAppLauncher(environment: {'HOME': home});
        await write(place);

        expect(
          entryIn(data()).readAsStringSync(),
          '[Desktop Entry]\nExec=$exec\n',
          reason: exec,
        );
        expect(iconIn(data()).readAsBytesSync(), const [9], reason: exec);
      }
    },
    skip: Platform.isWindows,
  );

  test('an entry for another AppImage that is gone stays at launch', () async {
    entryFor('$home/Downloads/Harness-Device-linux-x64.AppImage');

    await forgetGoneDeviceAppLauncher(environment: {'HOME': home});

    expect(entryIn(data()).existsSync(), isTrue);
  }, skip: Platform.isWindows);

  test('no home writes nothing and does not throw', () async {
    await write(place, environment: const {});
    await write(place, environment: const {'HOME': ''});

    expect(Directory('$home/.local/share').existsSync(), isFalse);
  }, skip: Platform.isWindows);

  test(
    "the AppImage's runtime is asked for the one icon, in a folder of its own",
    () async {
      final record = '${root.path}/record';
      final fake = File('${root.path}/fake.AppImage')
        ..writeAsStringSync(
          '#!/bin/sh\n'
          'printf "%s\\n" "\$@" > "$record.args"\n'
          'pwd > "$record.cwd"\n'
          'mkdir -p "squashfs-root/\$(dirname "\$2")"\n'
          'printf "icon" > "squashfs-root/\$2"\n',
        );
      Process.runSync('chmod', ['0755', fake.path]);

      final icon = await extractDeviceAppIcon(fake.path);

      expect(icon, 'icon'.codeUnits);
      expect(
        File('$record.args').readAsStringSync(),
        '--appimage-extract\n'
        'usr/share/icons/hicolor/128x128/apps/harness-device.png\n',
      );
      final folder = File('$record.cwd').readAsStringSync().trim();
      expect(folder, isNot(Directory.current.resolveSymbolicLinksSync()));
      expect(Directory(folder).existsSync(), isFalse);

      fake.writeAsStringSync('#!/bin/sh\npwd > "$record.cwd"\nexit 1\n');
      expect(await extractDeviceAppIcon(fake.path), isNull);
      expect(
        Directory(File('$record.cwd').readAsStringSync().trim()).existsSync(),
        isFalse,
      );
    },
    skip: Platform.isWindows,
  );

  test('once the AppImage is gone, the entry and its icon go', () async {
    await write(place);
    File(place).deleteSync();

    await forgetGoneDeviceAppLauncher(environment: {'HOME': home});

    expect(entryIn(data()).existsSync(), isFalse);
    expect(iconIn(data()).existsSync(), isFalse);
  }, skip: Platform.isWindows);

  test('an entry whose AppImage is there stays', () async {
    await write(place);

    await forgetGoneDeviceAppLauncher(environment: {'HOME': home});

    expect(entryIn(data()).readAsStringSync(), contains('Exec=$place\n'));
    expect(iconIn(data()).existsSync(), isTrue);
  }, skip: Platform.isWindows);

  test('an entry with no Exec= stays', () async {
    entryIn(data())
      ..createSync(recursive: true)
      ..writeAsStringSync('[Desktop Entry]\nName=Harness Device\n');

    await forgetGoneDeviceAppLauncher(environment: {'HOME': home});

    expect(entryIn(data()).existsSync(), isTrue);
  }, skip: Platform.isWindows);

  test('no entry, nothing happens', () async {
    await forgetGoneDeviceAppLauncher(environment: {'HOME': home});

    expect(Directory('$home/.local/share').existsSync(), isFalse);
  }, skip: Platform.isWindows);
}
