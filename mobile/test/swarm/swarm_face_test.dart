import 'dart:convert';
import 'dart:typed_data';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_face.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';

/// A 1×1 PNG: what a picture that loads decodes to.
final pixel = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
);

/// Links the face asked a picture for.
final asked = <Uri>[];

Future<void> show(WidgetTester tester, Widget child, {List<int>? bytes}) {
  asked.clear();
  final images = <Uri, ImageProvider>{};
  return tester.pumpWidget(
    MaterialApp(
      home: SwarmAvatarImages(
        image: (url) {
          if (!asked.contains(url)) asked.add(url);
          // One picture per link, as a network image is; bytes that are no
          // picture fail to decode, as a dead link fails.
          return images[url] ??= MemoryImage(
            Uint8List.fromList(bytes ?? [1, 2, 3]),
          );
        },
        child: Scaffold(body: Center(child: child)),
      ),
    ),
  );
}

/// Lets the picture decode, which happens outside the test's fake time:
/// until [done] holds, or for [rounds] turns when nothing is to appear.
Future<void> decode(
  WidgetTester tester, {
  bool Function()? done,
  int rounds = 100,
}) async {
  for (var i = 0; i < rounds && !(done?.call() ?? false); i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
    await tester.pump();
  }
  if (done != null) expect(done(), isTrue, reason: 'the picture never showed');
}

final photo = SuperTabUploadedAvatar.of(
  'https://storage.googleapis.com/avatars/me.png?sig=1',
)!;

/// The one face a person or an agent wears on the phone: their picture, the
/// built-in one they picked, or their initial when they have neither — and a
/// person's status emoji while it lasts.
void main() {
  testWidgets('a built-in picture shows instead of the initial', (
    tester,
  ) async {
    await show(
      tester,
      const SwarmAvatar(
        id: 'agent-1',
        name: 'Nova',
        picture: SuperTabPresetAvatar('fox'),
      ),
    );
    expect(find.text('🦊'), findsOneWidget);
    expect(find.text('N'), findsNothing);
  });

  testWidgets('no picture shows the initial', (tester) async {
    await show(tester, const SwarmAvatar(id: 'agent-1', name: 'Nova'));
    expect(find.text('N'), findsOneWidget);
  });

  testWidgets('an uploaded picture loads from its signed link', (tester) async {
    await tester.runAsync(
      () => show(
        tester,
        SwarmAvatar(id: 'person-1', name: 'tony', picture: photo),
        bytes: pixel,
      ),
    );
    await decode(
      tester,
      done: () => find.byType(RawImage).evaluate().isNotEmpty,
    );
    expect(asked, [
      Uri.parse('https://storage.googleapis.com/avatars/me.png?sig=1'),
    ]);
    expect(find.text('T'), findsNothing);
  });

  testWidgets('an uploaded picture that cannot load shows the initial', (
    tester,
  ) async {
    await tester.runAsync(
      () => show(
        tester,
        SwarmAvatar(id: 'person-1', name: 'tony', picture: photo),
      ),
    );
    // Shown as the initial while it loads, and after it fails.
    expect(find.text('T'), findsOneWidget);
    await decode(tester, rounds: 20);
    expect(find.text('T'), findsOneWidget);
  });

  testWidgets('a chat avatar shows the built-in picture too', (tester) async {
    await show(
      tester,
      const SwarmChatAvatar(
        name: 'tony',
        id: 'person-1',
        agent: false,
        picture: SuperTabPresetAvatar('rocket'),
      ),
    );
    expect(find.text('🚀'), findsOneWidget);
    expect(find.text('T'), findsNothing);
  });

  testWidgets('a chat avatar keeps the colour it always had, in both themes', (
    tester,
  ) async {
    // The chat's colours before they came from the member palette: the PM's
    // blue, then the six an agent takes by its id; a person's one fill.
    const agents = [
      Color(0xFF1D5BD6),
      Color(0xFF0F766E),
      Color(0xFF6D28D9),
      Color(0xFFA65A08),
      Color(0xFFBE123C),
      Color(0xFF15803D),
      Color(0xFF4E5D78),
    ];
    const person = Color(0xFF4B5F9B);
    Color? fill() =>
        (tester
                    .widget<Container>(
                      find.descendant(
                        of: find.byType(SwarmChatAvatar),
                        matching: find.byWidgetPredicate(
                          (w) =>
                              w is Container &&
                              (w.decoration as BoxDecoration?)?.shape ==
                                  BoxShape.circle,
                        ),
                      ),
                    )
                    .decoration
                as BoxDecoration)
            .color;
    final previous = AppTheme.brightness.value;
    addTearDown(() => AppTheme.brightness.value = previous);
    for (final brightness in Brightness.values) {
      AppTheme.brightness.value = brightness;
      // 'a' to 'f' land on each of the six agent colours once.
      for (final id in ['a', 'b', 'c', 'd', 'e', 'f', 'agent-lead']) {
        await show(tester, SwarmChatAvatar(name: 'River', id: id, agent: true));
        final sum = id.codeUnits.fold(0, (a, b) => a + b);
        expect(fill(), agents[1 + sum % 6], reason: '$id, $brightness');
      }
      await show(
        tester,
        const SwarmChatAvatar(name: 'River', id: 'a', agent: true, pm: true),
      );
      expect(fill(), agents.first, reason: 'the PM, $brightness');
      await show(
        tester,
        const SwarmChatAvatar(name: 'Tony', id: 'person-1', agent: false),
      );
      expect(fill(), person, reason: 'a person, $brightness');
    }
  });

  testWidgets('a status shows its emoji and is read with the name', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    await show(
      tester,
      SwarmAvatar(
        id: 'person-1',
        name: 'tony',
        status: SuperTabPersonStatus(
          text: 'Focusing',
          emoji: '🎯',
          until: clock.now().add(const Duration(hours: 1)),
        ),
      ),
    );
    expect(find.text('🎯'), findsOneWidget);
    expect(find.bySemanticsLabel('tony, 🎯 Focusing'), findsOneWidget);
    handle.dispose();
  });

  testWidgets('a status disappears by itself when its time passes', (
    tester,
  ) async {
    await show(
      tester,
      SwarmChatAvatar(
        name: 'tony',
        id: 'person-1',
        agent: false,
        status: SuperTabPersonStatus(
          text: 'At lunch',
          emoji: '🍽️',
          until: clock.now().add(const Duration(minutes: 30)),
        ),
      ),
    );
    expect(find.text('🍽️'), findsOneWidget);
    await tester.pump(const Duration(minutes: 29));
    expect(find.text('🍽️'), findsOneWidget);
    await tester.pump(const Duration(minutes: 1, seconds: 1));
    expect(find.text('🍽️'), findsNothing);
  });

  testWidgets('a status that has already ended shows nothing', (tester) async {
    await show(
      tester,
      SwarmAvatar(
        id: 'person-1',
        name: 'tony',
        status: SuperTabPersonStatus(
          text: 'Away',
          emoji: '🚶',
          until: clock.now().subtract(const Duration(minutes: 1)),
        ),
      ),
    );
    expect(find.text('🚶'), findsNothing);
  });
}
