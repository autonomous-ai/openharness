import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';

/// A project carries its status card text as the desktop's model reads it
/// (desktop_parity_test): the phone shows no card yet, but drops nothing.
void main() {
  Map<String, dynamic> project(Object? status) => {
    'id': 'p',
    'name': 'Mobile',
    'ownerId': 'me',
    'leadConversationId': 'lead',
    'visibility': 'public',
    'members': <Object>[],
    'updateMinutes': 5,
    'status': status,
  };

  test('reads the text, time and writer, as the desktop does', () {
    final status = SuperTabProject.fromJson(
      project({'text': 'Building', 'at': '2026-10-31T09:52:00Z', 'by': 'pm'}),
    ).status!;
    expect(status.text, 'Building');
    expect(status.at, DateTime.utc(2026, 10, 31, 9, 52));
    expect(status.by, 'pm');
  });

  test('none, empty or malformed reads as no status; long text is cut', () {
    for (final value in <Object?>[
      null,
      'x',
      {'text': ' '},
      {'text': 1},
    ]) {
      expect(SuperTabProject.fromJson(project(value)).status, isNull);
    }
    final long = 'a' * (SuperTabProjectStatus.maxText + 5);
    expect(
      SuperTabProject.fromJson(project({'text': long})).status!.text,
      hasLength(2000),
    );
  });
}
