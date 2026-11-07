import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/avatar_art.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/widgets/engine_identity.dart';

SuperTabAgent agentNamed(
  String name, {
  String engine = 'claude',
  Object? avatar,
}) => SuperTabAgent.fromJson({
  'id': 'id-$name',
  'name': name,
  'machineId': 'm',
  'harnessId': 'h',
  'contributorId': 'p',
  'configuration': {'engine': engine},
  'avatar': ?avatar,
});
SuperTabPerson personWith({Object? avatar, Object? status}) =>
    SuperTabPerson.fromJson({
      'id': 'p1',
      'email': 'dee@example.com',
      'role': 'owner',
      'avatar': ?avatar,
      'status': ?status,
    });
Widget host(Widget child) => MaterialApp(
  home: Scaffold(body: Center(child: child)),
);

void main() {
  // anh Dee's pick (task #4461): the face's colour, shift and tilt come from the FNV-1a hash of the trimmed,
  // lowercased name; these names cover all eight colours.
  Color hsl(double h, double s, double l) =>
      HSLColor.fromAHSL(1, h, s / 100, l / 100).toColor();
  final palette = [
    (hsl(14, 86, 72), hsl(10, 76, 62)), // coral
    (hsl(38, 92, 70), hsl(32, 84, 59)), // apricot
    (hsl(146, 46, 64), hsl(150, 42, 52)), // sage
    (hsl(178, 44, 60), hsl(182, 48, 48)), // teal
    (hsl(206, 82, 70), hsl(212, 72, 59)), // sky
    (hsl(238, 72, 76), hsl(242, 60, 65)), // periwinkle
    (hsl(274, 60, 76), hsl(278, 48, 64)), // lilac
    (hsl(334, 76, 76), hsl(338, 66, 65)), // rose
  ];
  test('an agent’s face takes its colour, shift and tilt from its name', () {
    // name: (hash % 8, shift, tilt), worked out by hand from the hash.
    const faces = {
      'Kai': (0, 3.0, 0.0),
      'River': (1, 0.0, 5.0),
      'Quinn': (2, 3.0, -9.0),
      'Buddy': (3, -3.0, 10.0),
      'Atlas': (4, 0.0, -4.0),
      'Ivy': (5, -3.0, 0.0),
      'Milo': (6, -3.0, 0.0),
      'Nova': (7, 3.0, 0.0),
    };
    for (final MapEntry(key: name, value: (colour, shift, tilt))
        in faces.entries) {
      final face = superTabAgentFace(name);
      expect(
        (face.top, face.bottom, face.shift, face.tilt),
        (palette[colour].$1, palette[colour].$2, shift, tilt),
        reason: name,
      );
      expect(superTabAgentFace('  ${name.toUpperCase()} ').top, face.top);
    }
  });

  testWidgets('a face draws the numbers of the design: disc, eyes and smile '
      'in ink #221F29, tilted and shifted', (tester) async {
    const ink = Color(0xFF221F29);
    Future<Finder> draw(String name) async {
      await tester.pumpWidget(
        host(
          SuperTabAvatarFace(
            identity: 'agent:$name',
            name: name,
            size: 100,
            face: true,
          ),
        ),
      );
      return find.byKey(const ValueKey('super-agent-face'));
    }

    bool eye(Symbol method, List<dynamic> args, double x) =>
        method == #drawOval &&
        args[0] ==
            Rect.fromCenter(center: Offset(x, 45), width: 10.4, height: 14) &&
        (args[1] as Paint).color.toARGB32() == ink.toARGB32();
    final quinn = await draw('Quinn');
    expect(tester.getSize(quinn), const Size.square(100));
    // Quinn's hash shifts it 3 units right and tilts it 9 degrees left.
    expect(
      quinn,
      paints
        ..circle(x: 50, y: 50, radius: 50)
        ..rotate(angle: -9 * math.pi / 180)
        ..something((m, a) => eye(m, a, 36 + 3))
        ..something((m, a) => eye(m, a, 64 + 3))
        // The smile: (37,62) through (50,74) to (63,62), shifted; its dip
        // reaches y 68 under the middle.
        ..something((m, a) {
          if (m != #drawPath) return false;
          final (path, paint) = (a[0] as Path, a[1] as Paint);
          return paint.color.toARGB32() == ink.toARGB32() &&
              paint.style == PaintingStyle.stroke &&
              (paint.strokeWidth - 5.6).abs() < 1e-5 &&
              paint.strokeCap == StrokeCap.round &&
              path.contains(const Offset(50 + 3, 65)) &&
              !path.contains(const Offset(50 + 3, 60)) &&
              !path.contains(const Offset(50 + 3, 70));
        }),
    );
  });

  testWidgets('an agent without a picture shows its face and engine badge', (
    tester,
  ) async {
    await tester.pumpWidget(
      host(SuperTabAvatar.agent(agentNamed('Kai', engine: 'codex'), size: 28)),
    );
    expect(find.byKey(const ValueKey('super-agent-face')), findsOneWidget);
    final badge = tester.widget<EngineMark>(find.byType(EngineMark));
    expect(badge.engine, 'codex');
    expect(tester.getSize(find.byType(SuperTabAvatar)), const Size.square(28));
  });

  testWidgets('a preset shows its picture, an upload its image', (
    tester,
  ) async {
    await tester.pumpWidget(
      host(
        SuperTabAvatar.agent(
          agentNamed('Kai', avatar: {'kind': 'preset', 'key': 'owl'}),
        ),
      ),
    );
    expect(find.text('🦉'), findsOneWidget);
    expect(find.byKey(const ValueKey('super-agent-face')), findsNothing);
    await tester.pumpWidget(
      host(
        SuperTabAvatar.person(
          personWith(
            avatar: {
              'kind': 'upload',
              'url': 'https://storage.googleapis.com/avatars/me?X-Goog-Signature=s',
            },
          ),
        ),
      ),
    );
    final image = tester.widget<Image>(find.byType(Image));
    expect(
      (image.image as NetworkImage).url,
      'https://storage.googleapis.com/avatars/me?X-Goog-Signature=s',
    );
  });

  testWidgets(
    'a person without a picture keeps their initial; a status shows beside it',
    (tester) async {
      final now = DateTime.utc(2026, 10, 27, 9);
      await tester.pumpWidget(
        host(
          SuperTabAvatar.person(
            personWith(status: {'text': 'Coffee', 'emoji': '☕'}),
            now: now,
          ),
        ),
      );
      expect(find.text('D'), findsOneWidget);
      expect(find.text('☕'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('Coffee')), findsOneWidget);
      await tester.pumpWidget(
        host(
          SuperTabAvatar.person(
            personWith(
              status: {
                'text': 'Lunch',
                'emoji': '🍽️',
                'until': '2026-10-27T08:00:00.000Z',
              },
            ),
            now: now,
          ),
        ),
      );
      expect(find.text('🍽️'), findsNothing);
    },
  );
}
