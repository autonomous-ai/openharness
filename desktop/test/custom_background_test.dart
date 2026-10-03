import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/settings/appearance/wallpaper_section.dart';
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/custom_background.dart';
import 'package:harness/shared/theme/harness_background.dart';
import 'package:path/path.dart' as p;

class _Storage implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

Future<Uint8List> _png(int width, int height) async {
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawRect(
    ui.Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    ui.Paint()..color = const ui.Color(0xff3366cc),
  );
  final image = await recorder.endRecording().toImage(width, height);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  return data!.buffer.asUint8List();
}

Future<(int, int)> _size(File file) async {
  final buffer = await ui.ImmutableBuffer.fromUint8List(
    await file.readAsBytes(),
  );
  final descriptor = await ui.ImageDescriptor.encoded(buffer);
  final size = (descriptor.width, descriptor.height);
  descriptor.dispose();
  buffer.dispose();
  return size;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory root;
  late Directory backgrounds;

  setUp(() {
    root = Directory.systemTemp.createTempSync('custom-background-');
    backgrounds = Directory(p.join(root.path, 'backgrounds'));
  });
  tearDown(() => root.deleteSync(recursive: true));

  Future<String> source(String name, List<int> bytes) async {
    final file = File(p.join(root.path, name));
    await file.writeAsBytes(bytes);
    return file.path;
  }

  group('import', () {
    test('keeps a small image as it is', () async {
      final bytes = await _png(64, 36);
      final name = await importCustomBackground(
        await source('photo.png', bytes),
        backgrounds,
      );
      final copy = File(p.join(backgrounds.path, name));
      expect(p.extension(name), '.png');
      expect(await copy.readAsBytes(), bytes);
    });

    test('scales the longest side down to 3840', () async {
      final name = await importCustomBackground(
        await source('wide.png', await _png(4800, 200)),
        backgrounds,
      );
      expect(await _size(File(p.join(backgrounds.path, name))), (3840, 160));
    });

    test('refuses other formats, broken images and large files', () async {
      Future<String> refusal(String path) => importCustomBackground(
        path,
        backgrounds,
      ).then((_) => 'accepted', onError: (Object e) => '$e');

      expect(
        await refusal(await source('anim.gif', [1, 2, 3])),
        'Use a PNG, JPEG or WebP image.',
      );
      expect(
        await refusal(await source('broken.jpg', [1, 2, 3])),
        'That image couldn’t be opened.',
      );
      final large = File(p.join(root.path, 'large.png'));
      final handle = await large.open(mode: FileMode.write);
      await handle.truncate(customBackgroundMaxBytes + 1);
      await handle.close();
      expect(await refusal(large.path), 'Images must be 20 MB or smaller.');
      expect(
        await refusal(p.join(root.path, 'gone.png')),
        'Couldn’t read that file.',
      );
      expect(
        backgrounds.existsSync() ? backgrounds.listSync() : const [],
        isEmpty,
      );
    });
  });

  group('store', () {
    test('choosing selects and persists; replacing prunes the old copy; '
        'removing returns to Blank', () async {
      final storage = _Storage();
      final prefs = AppearancePrefsStore(
        storage: storage,
        backgroundsDirectory: backgrounds,
      );
      addTearDown(prefs.dispose);

      expect(
        await prefs.chooseCustomBackground(
          await source('a.png', await _png(8, 8)),
        ),
        isNull,
      );
      final first = prefs.value.custom.image!;
      expect(prefs.value.background, HarnessBackground.custom);
      expect(prefs.customBackgroundFile!.existsSync(), isTrue);

      await prefs.setCustomBackground(dim: 0.6, fit: BackgroundFit.tile);
      final restored = AppearancePrefsStore(
        storage: storage,
        backgroundsDirectory: backgrounds,
      );
      addTearDown(restored.dispose);
      await restored.load();
      expect(restored.value.background, HarnessBackground.custom);
      expect(
        restored.value.custom,
        CustomBackground(image: first, dim: 0.6, fit: BackgroundFit.tile),
      );

      // A refused file leaves everything as it was.
      expect(
        await prefs.chooseCustomBackground(await source('b.gif', [0])),
        isNotNull,
      );
      expect(prefs.value.custom.image, first);

      await prefs.setBackground(HarnessBackground.renaissance);
      expect(
        await prefs.chooseCustomBackground(
          await source('c.png', await _png(8, 8)),
        ),
        isNull,
      );
      final second = prefs.value.custom.image!;
      expect(second, isNot(first));
      expect(prefs.value.background, HarnessBackground.custom);
      // Dim and fit survive a new image.
      expect(prefs.value.custom.fit, BackgroundFit.tile);
      expect(backgrounds.listSync().map((e) => p.basename(e.path)), [second]);

      await prefs.removeCustomBackground();
      expect(prefs.value.background, HarnessBackground.plain);
      expect(prefs.value.custom.image, isNull);
      expect(backgrounds.listSync(), isEmpty);
    });

    test('a saved custom choice with no image restores as Blank', () async {
      final storage = _Storage()
        ..values['harness_start_background'] = 'custom'
        ..values['harness_custom_background'] = '{"image":"../state.json"}';
      final prefs = AppearancePrefsStore(
        storage: storage,
        backgroundsDirectory: backgrounds,
      );
      addTearDown(prefs.dispose);
      await prefs.load();
      expect(prefs.value.background, HarnessBackground.plain);
      expect(prefs.value.custom.image, isNull);
    });
  });

  testWidgets('custom card: choose, adjust, report a refusal, remove', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(600, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final prefs = AppearancePrefsStore(
      storage: _Storage(),
      backgroundsDirectory: backgrounds,
    );
    addTearDown(prefs.dispose);
    final good = (await tester.runAsync(
      () async => source('good.png', await _png(32, 18)),
    ))!;
    final bad = (await tester.runAsync(() => source('bad.png', [1, 2])))!;
    var next = good;

    await tester.pumpWidget(
      MaterialApp(
        home: Material(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: WallpaperSection(store: prefs, pickImage: () async => next),
          ),
        ),
      ),
    );

    // File work happens on the real clock; let it finish, then paint.
    Future<void> settle(bool Function() done) async {
      for (var i = 0; i < 100 && !done(); i++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 20)),
        );
        await tester.pump();
      }
      await tester.pump();
    }

    // Enabled again once the card has finished with the file.
    bool replaceEnabled() {
      final button = find.byKey(const ValueKey('custom-background-replace'));
      return button.evaluate().isNotEmpty &&
          tester.widget<TextButton>(button).onPressed != null;
    }

    expect(find.byKey(const ValueKey('custom-background-empty')), findsOne);
    expect(find.byKey(const ValueKey('custom-background-dim')), findsNothing);

    await tester.tap(find.byKey(const ValueKey('wallpaper-custom')));
    await settle(() => prefs.value.custom.image != null && replaceEnabled());
    expect(prefs.value.background, HarnessBackground.custom);
    expect(find.byKey(const ValueKey('custom-background-dim')), findsOne);

    await tester.ensureVisible(find.byKey(const ValueKey('fit-center')));
    await tester.tap(find.byKey(const ValueKey('fit-center')));
    await tester.pump();
    expect(prefs.value.custom.fit, BackgroundFit.center);

    next = bad;
    await tester.ensureVisible(
      find.byKey(const ValueKey('custom-background-replace')),
    );
    await tester.tap(find.byKey(const ValueKey('custom-background-replace')));
    await settle(
      () => find
          .byKey(const ValueKey('custom-background-error'))
          .evaluate()
          .isNotEmpty,
    );
    expect(find.text('That image couldn’t be opened.'), findsOne);
    expect(prefs.value.background, HarnessBackground.custom);

    // Built-in selected: the controls go, the image stays for one-click return.
    await tester.ensureVisible(find.byKey(const ValueKey('wallpaper-plain')));
    await tester.tap(find.byKey(const ValueKey('wallpaper-plain')));
    await tester.pump();
    expect(find.byKey(const ValueKey('custom-background-dim')), findsNothing);
    expect(prefs.value.custom.image, isNotNull);

    // The copy vanishing is reported on the card.
    await tester.runAsync(() => prefs.customBackgroundFile!.delete());
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(
      MaterialApp(
        home: Material(
          child: SingleChildScrollView(child: WallpaperSection(store: prefs)),
        ),
      ),
    );
    expect(find.byKey(const ValueKey('custom-background-missing')), findsOne);

    await tester.ensureVisible(
      find.byKey(const ValueKey('custom-background-remove')),
    );
    await tester.tap(find.byKey(const ValueKey('custom-background-remove')));
    await settle(() => prefs.value.custom.image == null);
    expect(find.byKey(const ValueKey('custom-background-empty')), findsOne);
    expect(prefs.value.background, HarnessBackground.plain);
  });
}
