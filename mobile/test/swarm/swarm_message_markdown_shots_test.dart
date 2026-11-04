import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';

/// Review captures of a long agent report in both phone themes. Set
/// `SWARM_MESSAGE_MARKDOWN_SHOTS` to the output folder when capturing them.
final shots = Platform.environment['SWARM_MESSAGE_MARKDOWN_SHOTS'];

final report =
    '''
## Reconnect review

The **retry path** now handles *slow networks* without dropping agent work.
Read the [pull request](https://github.com/example/mobile/pull/42) and task #42.

### What changed

- Messages resume from the last saved event.
- The reader can scroll a long report without losing its place.
- Code remains easy to copy.

> “A disconnected reader should not lose the conversation.”

| Check | Result |
| --- | --- |
| Replay | Passed |
| Links | Open |

```dart
await reader.resume();
```

### Agent notes

${[for (var i = 1; i <= 24; i++) '- Finding $i remains visible while scrolling.'].join('\n')}
''';

void main() {
  setUpAll(() async {
    if (shots == null || !Platform.isMacOS) return;
    final sf = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFont', 'Roboto']) {
      await (FontLoader(family)..addFont(Future.value(sf))).load();
    }
    final mono = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNSMono.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFontMonospaced', 'monospace']) {
      await (FontLoader(family)..addFont(Future.value(mono))).load();
    }
    final manifest =
        jsonDecode(await rootBundle.loadString('FontManifest.json')) as List;
    for (final entry in manifest.cast<Map<String, dynamic>>()) {
      final loader = FontLoader(entry['family'] as String);
      for (final font in (entry['fonts'] as List).cast<Map>()) {
        loader.addFont(rootBundle.load(font['asset'] as String));
      }
      await loader.load();
    }
  });

  testWidgets('a long agent report renders in both phone themes', (
    tester,
  ) async {
    if (shots == null) return;
    addTearDown(tester.view.reset);
    tester.view
      ..physicalSize = const Size(390, 844) * 3
      ..devicePixelRatio = 3;
    final previousPalette = grid.AppTheme.palette.value;
    final previousBrightness = grid.AppTheme.brightness.value;
    addTearDown(() {
      grid.AppTheme.palette.value = previousPalette;
      grid.AppTheme.brightness.value = previousBrightness;
    });
    final message = SuperTabMessage.fromJson({
      'id': 'report-1',
      'conversationId': 'conversation-1',
      'text': report,
      'sequence': 1,
      'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'Lead'},
      'createdAt': DateTime.utc(2026, 11, 3, 10, 42).toIso8601String(),
    });
    await tester.runAsync(() => Directory(shots!).create(recursive: true));
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      grid.AppTheme.palette.value = palette;
      grid.AppTheme.brightness.value = palette.brightness;
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: palette.brightness),
          home: RepaintBoundary(
            key: const ValueKey('swarm-message-markdown-shot'),
            child: Scaffold(
              body: ListView(
                children: [
                  SwarmMessageRow(
                    message: message,
                    name: 'River',
                    look: (picture: null, status: null),
                    role: 'PM',
                    pm: true,
                    mentions: SwarmMentions(const []),
                    references: const {42: 'task-42'},
                    onOpenConversation: (_) {},
                    grouped: false,
                    lit: false,
                    quote: null,
                    actions: false,
                    onTap: () {},
                    onLongPress: () {},
                    onReply: null,
                  ),
                ],
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final boundary = tester.renderObject<RenderRepaintBoundary>(
        find.byKey(const ValueKey('swarm-message-markdown-shot')),
      );
      final name = palette == HarnessPalette.graphite ? 'dark' : 'light';
      final saved = await tester.runAsync(() async {
        final image = await boundary.toImage(pixelRatio: 1);
        try {
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          await File('$shots/swarm-message-markdown-$name.png')
              .writeAsBytes(png!.buffer.asUint8List());
          return true;
        } finally {
          image.dispose();
        }
      });
      expect(saved, isTrue);
    }
  });
}
