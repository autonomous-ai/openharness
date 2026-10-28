import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_file_picker.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:image_picker/image_picker.dart' show XFile;

import '../voice_fakes.dart';
import '../swarm/swarm_fixture.dart';

/// Renders a phone Swarm chat attaching files — the composer with files, an upload under way,
/// the + sheet and the camera-off box — in light and dark, at iPhone 14 size in the system
/// fonts, to PNGs a reviewer can look at without a phone.
///
/// Skipped unless PHONE_RENDER_DIR names a directory to write into:
///
///     PHONE_RENDER_DIR=/tmp/renders flutter test test/render/swarm_attach_render_test.dart
///
/// macOS only: it loads SF Pro and SF Mono from /System/Library/Fonts.
final _outDir = Platform.environment['PHONE_RENDER_DIR'];

Future<void> _loadFonts() async {
  Future<void> load(String family, String file) async {
    final bytes = await File('/System/Library/Fonts/$file').readAsBytes();
    await (FontLoader(
      family,
    )..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
  }

  for (final family in ['.AppleSystemUIFont', 'SF Pro Text', 'Roboto']) {
    await load(family, 'SFNS.ttf');
  }
  for (final family in ['.AppleSystemUIFontMonospaced', 'SF Mono']) {
    await load(family, 'SFNSMono.ttf');
  }
  // The icons, from the package in the pub cache.
  final lucide =
      '${Platform.environment['HOME']}/.pub-cache/hosted/pub.dev/lucide_icons_flutter-3.1.19/assets';
  Future<void> icons(String family, String file) async {
    final bytes = await File('$lucide/$file').readAsBytes();
    await (FontLoader(
      family,
    )..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
  }

  await icons('packages/lucide_icons_flutter/Lucide', 'lucide.ttf');
  for (final weight in [100, 200, 300, 400, 500, 600]) {
    await icons(
      'packages/lucide_icons_flutter/Lucide$weight',
      'build_font/LucideVariable-w$weight.ttf',
    );
  }
}

/// A photo-like picture: a sky over a field, encoded as PNG.
Future<Uint8List> _photo(Color sky, Color ground) async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.drawRect(const Rect.fromLTWH(0, 0, 120, 80), Paint()..color = sky);
  canvas.drawRect(const Rect.fromLTWH(0, 50, 120, 30), Paint()..color = ground);
  canvas.drawCircle(const Offset(90, 22), 10, Paint()..color = Colors.amber);
  final image = await recorder.endRecording().toImage(120, 80);
  final png = await image.toByteData(format: ui.ImageByteFormat.png);
  return png!.buffer.asUint8List();
}

void main() {
  final skip = _outDir == null;
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';

  final original = (
    photos: pickSwarmPhotos,
    camera: takeSwarmPhoto,
    documents: pickSwarmFiles,
    copies: swarmPickerCopyFolders,
  );
  setUp(() => swarmPickerCopyFolders = () async => const []);
  tearDown(() {
    swarmPickerCopyFolders = original.copies;
    pickSwarmPhotos = original.photos;
    takeSwarmPhoto = original.camera;
    pickSwarmFiles = original.documents;
  });

  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        groups: [
          groupData(
            'g1',
            title: 'Login crash on iPhone',
            agentIds: ['agent-lead', 'agent-builder'],
            status: 'working',
            lastMessageSequence: 2,
          ),
        ],
      ),
      'members': [part(me, 1, person(me))],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    Map<String, dynamic> message(
      String id,
      int sequence,
      String text,
      Map<String, dynamic> author, {
      List<Map<String, dynamic>> attachments = const [],
    }) => {
      'id': id,
      'conversationId': 'g1',
      'text': text,
      'sequence': sequence,
      'author': author,
      'attachments': attachments,
      'reactions': <Object>[],
      'createdAt': DateTime.utc(2026, 10, 28, 4, sequence).toIso8601String(),
    };
    fake.routes[messages] = (_) => {
      'messages': [
        message(
          'm2',
          2,
          'Here is the crash and the log.',
          {'kind': 'person', 'id': me, 'name': 'tony'},
          attachments: [
            {
              'id': 'f1',
              'name': 'crash.log',
              'mime': 'text/plain',
              'size': 12 * 1024,
              'url': 'https://cdn.harness.autonomous.ai/f1/crash.log',
            },
          ],
        ),
        message('m1', 1, 'Can you send what you see on the phone?', {
          'kind': 'agent',
          'id': 'agent-lead',
          'name': 'River',
        }),
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/commands'] = (_) =>
        Completer<Object?>().future;
    return fake;
  }

  /// Uploads held where they are, a fixed part of the way up.
  Future<Map<String, dynamic>> stuck({
    required String tabId,
    required String conversationId,
    required String name,
    required String mime,
    required Uint8List bytes,
    required dynamic cancel,
    required void Function(double sent) onProgress,
  }) {
    onProgress(0.6);
    return Completer<Map<String, dynamic>>().future;
  }

  Future<void> shoot(WidgetTester tester, GlobalKey key, String name) async {
    await tester.runAsync(() async {
      final boundary =
          key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 3);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      final file = File('$_outDir/$name.png');
      await file.parent.create(recursive: true);
      await file.writeAsBytes(png!.buffer.asUint8List());
    });
  }

  for (final brightness in Brightness.values) {
    final look = brightness.name;

    Future<GlobalKey> chat(WidgetTester tester, {SwarmUpload? upload}) async {
      await tester.runAsync(_loadFonts);
      final photos = (await tester.runAsync(
        () async => [
          await _photo(const Color(0xFF7FB2E5), const Color(0xFF5E8C4A)),
          await _photo(const Color(0xFFE9A86B), const Color(0xFF3F5B73)),
        ],
      ))!;
      pickSwarmPhotos = (limit) async => [
        XFile.fromData(photos[0], path: '/copies/IMG_2041.jpg'),
        XFile.fromData(photos[1], path: '/copies/IMG_2050.jpg'),
      ];
      pickSwarmFiles = () async => [
        XFile.fromData(
          Uint8List(640 * 1024),
          path: '/copies/report.pdf',
          length: 640 * 1024,
        ),
      ];
      takeSwarmPhoto = () async =>
          throw PlatformException(code: 'camera_access_denied');

      // A palette carries its brightness: a light one is how the app goes light.
      final palette = HarnessPalette.values.firstWhere(
        (p) => p.brightness == brightness,
      );
      final previous = (
        grid.AppTheme.brightness.value,
        grid.AppTheme.palette.value,
      );
      grid.AppTheme.palette.value = palette;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() {
        grid.AppTheme.brightness.value = previous.$1;
        grid.AppTheme.palette.value = previous.$2;
      });
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
      tester.view.viewPadding = const FakeViewPadding(
        top: 47 * 3,
        bottom: 34 * 3,
      );
      addTearDown(tester.view.reset);

      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: backend().request,
        upload: upload ?? stuck,
        notices: SilentSystemNotices(),
        features: features,
      )..foreground = false;
      addTearDown(host.dispose);
      final key = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: key,
          child: grid.BrightnessScope(
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: brightness),
              builder: (context, child) =>
                  SwarmScope(notifier: host, child: child!),
              home: const SwarmConversationPage(
                swarmId: tab,
                conversationId: 'g1',
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return key;
    }

    Future<void> pick(WidgetTester tester, String row) async {
      await tester.tap(find.byKey(const ValueKey('swarm-attach')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(ValueKey(row)));
      await tester.pumpAndSettle();
      // Thumbnails decode on the real clock, not the test's.
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 300)),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('composer with files ($look)', skip: skip, (tester) async {
      final key = await chat(tester);
      await pick(tester, 'swarm-attach-library');
      await pick(tester, 'swarm-attach-files');
      await tester.enterText(find.byType(TextField), 'Here are the shots');
      await tester.pumpAndSettle();
      await shoot(tester, key, 'swarm-attach-composer-$look');
    });

    testWidgets('upload under way ($look)', skip: skip, (tester) async {
      final key = await chat(tester);
      await pick(tester, 'swarm-attach-library');
      await tester.tap(find.byKey(const ValueKey('swarm-send')));
      await tester.pump();
      await tester.pump();
      await shoot(tester, key, 'swarm-attach-uploading-$look');
    });

    testWidgets('the + sheet ($look)', skip: skip, (tester) async {
      final key = await chat(tester);
      await tester.tap(find.byKey(const ValueKey('swarm-attach')));
      await tester.pumpAndSettle();
      await shoot(tester, key, 'swarm-attach-sheet-$look');
    });

    testWidgets('camera access off ($look)', skip: skip, (tester) async {
      final key = await chat(tester);
      await pick(tester, 'swarm-attach-camera');
      await shoot(tester, key, 'swarm-attach-camera-off-$look');
    });
  }
}
