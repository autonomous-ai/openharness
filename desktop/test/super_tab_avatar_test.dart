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
  test(
    'an agent’s pattern is stable for its name and differs between names',
    () {
      final kai = superTabAgentPattern('Kai');
      expect(superTabAgentPattern('Kai').cells, kai.cells);
      expect(superTabAgentPattern('Kai').hue, kai.hue);
      final names = [
        'Kai',
        'Ivy',
        'River',
        'Ellis',
        'Theo',
        'Sage',
        'Quinn',
        'Atlas',
      ];
      final patterns = {
        for (final n in names) superTabAgentPattern(n).cells.join(),
      };
      expect(patterns, hasLength(names.length));
      // Mirrored left to right, like a face.
      for (var row = 0; row < 5; row++) {
        expect(kai.cells[row * 5], kai.cells[row * 5 + 4]);
        expect(kai.cells[row * 5 + 1], kai.cells[row * 5 + 3]);
      }
      expect(kai.cells.where((on) => on), isNotEmpty);
    },
  );

  testWidgets('an agent without a picture shows its pattern and engine badge', (
    tester,
  ) async {
    await tester.pumpWidget(
      host(SuperTabAvatar.agent(agentNamed('Kai', engine: 'codex'), size: 28)),
    );
    expect(find.byKey(const ValueKey('super-avatar-pattern')), findsOneWidget);
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
    expect(find.byKey(const ValueKey('super-avatar-pattern')), findsNothing);
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
