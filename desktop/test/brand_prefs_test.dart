// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/branding/boot_splash.dart';
import 'package:harness/branding/brand_prefs.dart';
import 'package:harness/branding/brand_section.dart';

class _Memory implements LocalKeyValueStore {
  final Map<String, String> data = {};
  @override
  Future<String?> read(String key) async => data[key];
  @override
  Future<void> write(String key, String value) async => data[key] = value;
  @override
  Future<void> delete(String key) async => data.remove(key);
}

// Generic placeholders only: an 8x8 PNG header and a tiny SVG. No personal assets.
final _png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...List.filled(64, 0)];
const _svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

void main() {
  late Directory tmp;
  late _Memory mem;
  var n = 0;
  BrandPrefsStore store({bool omarchy = true, bool face = false}) {
    final sys = Directory('${tmp.path}/sys${n++}')..createSync(recursive: true);
    final logo = File('${sys.path}/logo.svg');
    final faceFile = File('${sys.path}/.face');
    if (omarchy) logo.writeAsStringSync(_svg);
    if (face) faceFile.writeAsBytesSync(_png);
    return BrandPrefsStore(storage: mem, dataDir: Directory('${tmp.path}/data'), omarchyLogoPath: logo.path, systemAvatarPath: faceFile.path);
  }

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('brand');
    mem = _Memory();
  });
  tearDown(() => tmp.deleteSync(recursive: true));

  group('boot logo', () {
    test('is off until chosen, with or without Omarchy on the machine', () async {
      final a = store();
      await a.load();
      expect(a.value.bootLogo, isNull, reason: 'nothing chosen yet');
      expect(a.resolveBootLogo().kind, BootLogo.none);
      final b = store(omarchy: false);
      await b.load();
      expect(b.resolveBootLogo().kind, BootLogo.none);
      expect(b.omarchyAvailable, isFalse);
    });

    test('a saved Omarchy choice falls back to Harness on a machine without Omarchy', () async {
      mem.data[BrandPrefsStore.bootLogoKey] = 'omarchy';
      final s = store(omarchy: false);
      await s.load();
      expect(s.resolveBootLogo().kind, BootLogo.harness);
    });

    test('custom: validated, copied into the data dir, and a missing copy falls back', () async {
      final s = store();
      await s.load();
      final src = File('${tmp.path}/mine.png')..writeAsBytesSync(_png);
      expect(await s.setCustomLogo(src.path), isNull);
      expect(s.value.bootLogo, BootLogo.custom);
      final r = s.resolveBootLogo();
      expect(r.kind, BootLogo.custom);
      expect(r.path, startsWith('${tmp.path}/data'));
      expect(mem.data[BrandPrefsStore.bootLogoKey], 'custom');
      File(r.path!).deleteSync();
      expect(s.resolveBootLogo().kind, BootLogo.none, reason: 'no splash when the custom file is gone');
    });

    test('custom files are rejected by size and type, and the old choice is kept', () async {
      final s = store();
      await s.load();
      final big = File('${tmp.path}/big.png')..writeAsBytesSync([..._png, ...List.filled(BrandPrefsStore.maxBytes, 0)]);
      final txt = File('${tmp.path}/notes.txt')..writeAsStringSync('hello');
      final fake = File('${tmp.path}/fake.png')..writeAsStringSync('not a png');
      expect(await s.setCustomLogo(big.path), contains('2 MB'));
      expect(await s.setCustomLogo(txt.path), contains('SVG or PNG'));
      expect(await s.setCustomLogo(fake.path), contains('not a valid'));
      expect(await s.setCustomLogo('${tmp.path}/missing.svg'), isNotNull);
      expect(s.value.bootLogo, isNull);
    });

    test('an SVG custom logo is accepted; None is remembered', () async {
      final s = store();
      await s.load();
      final src = File('${tmp.path}/mark.svg')..writeAsStringSync(_svg);
      expect(await s.setCustomLogo(src.path), isNull);
      expect(s.resolveBootLogo().isSvg, isTrue);
      await s.setBootLogo(BootLogo.none);
      final again = store();
      await again.load();
      expect(again.resolveBootLogo().kind, BootLogo.none);
    });
  });

  group('avatar', () {
    test('default is the generic glyph; initials are kept short and upper case', () async {
      final s = store();
      await s.load();
      expect(s.resolveAvatar().kind, AvatarSource.generic);
      await s.setInitials(' ab c ');
      expect(s.resolveAvatar().kind, AvatarSource.initials);
      expect(s.resolveAvatar().initials, 'ABC');
      await s.setInitials('');
      expect(s.resolveAvatar().kind, AvatarSource.generic);
    });

    test('the system avatar is offered only when ~/.face exists, and falls back when it goes', () async {
      final none = store();
      await none.load();
      expect(none.systemAvatarAvailable, isFalse);
      final s = store(face: true);
      await s.load();
      expect(s.systemAvatarAvailable, isTrue);
      await s.setAvatar(AvatarSource.system);
      expect(s.resolveAvatar().kind, AvatarSource.system);
      File(s.systemAvatarPath).deleteSync();
      expect(s.resolveAvatar().kind, AvatarSource.generic);
    });

    test('a custom avatar is validated and cached in the data dir', () async {
      final s = store();
      await s.load();
      final src = File('${tmp.path}/me.png')..writeAsBytesSync(_png);
      expect(await s.setCustomAvatar(src.path), isNull);
      final r = s.resolveAvatar();
      expect(r.kind, AvatarSource.custom);
      expect(r.path, startsWith('${tmp.path}/data'));
      expect(await s.setCustomAvatar('${tmp.path}/nope.gif'), isNotNull);
      expect(s.resolveAvatar().kind, AvatarSource.custom);
    });
  });

  group('widgets', () {
    testWidgets('the splash never shows when the choice is None', (tester) async {
      BootSplash.debugReset();
      final s = store();
      await tester.runAsync(() async {
        await s.load();
        await s.setBootLogo(BootLogo.none);
      });
      await tester.pumpWidget(MaterialApp(home: BootSplash(brand: s, child: const Text('app'))));
      expect(find.byKey(BootSplash.overlayKey), findsNothing);
    });

    testWidgets('the Appearance pickers list the choices; Omarchy only where it is installed', (tester) async {
      final s = store(omarchy: false);
      await tester.runAsync(s.load);
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: BrandSection(store: s)))));
      for (final label in ['Harness', 'Custom…', 'None', 'Generic', 'Initials', 'Custom image…']) {
        expect(find.text(label), findsWidgets, reason: label);
      }
      expect(find.text('System avatar'), findsNothing, reason: 'no ~/.face here');
      expect(find.widgetWithText(ChoiceChip, 'Omarchy'), findsNothing, reason: 'no Omarchy logo here');
      await tester.tap(find.widgetWithText(ChoiceChip, 'None'));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
      expect(s.value.bootLogo, BootLogo.none);
    });
  });
}
