import 'package:flutter_test/flutter_test.dart';
import 'package:harness/viewer/viewer_location.dart';

void main() {
  test(
    'viewer destinations round trip escaped identities without granting access',
    () {
      const path = '/?viewer=1&machine=server&agent=a%20%2F%3F%26%C3%A9';
      final location = ViewerLocation.parse(
        Uri.parse('https://harness.example$path'),
      )!;
      expect(location.machineId, 'server');
      expect(location.agentId, 'a /?&é');
      expect(ViewerLocation.returnPath(path), path);
      for (final invalid in [
        'https://other.example$path',
        '//other.example$path',
        '/auth/callback?code=secret',
        '/?viewer=1&machine=m',
        '/?viewer=1&machine=m&agent=',
        '/?viewer=1&machine=m&agent=a&agent=b',
        '/?viewer=1&machine=m&agent=%0A',
        '/view/else?machine=m&agent=a',
      ]) {
        expect(ViewerLocation.returnPath(invalid), isNull, reason: invalid);
      }
    },
  );

  test('viewer and OAuth tabs cannot restore terminal workspace', () {
    for (final path in [
      '/?viewer=1&machine=m&agent=a',
      '/?viewer=1',
      '/auth/callback',
      '/callback',
    ]) {
      expect(
        ViewerLocation.workspaceAllowed(
          Uri.parse('https://harness.example$path'),
        ),
        isFalse,
      );
    }
    expect(
      ViewerLocation.workspaceAllowed(Uri.parse('https://harness.example/')),
      isTrue,
    );
  });

  test(
    'malformed UTF-8 and duplicate viewer flags fail closed without throwing',
    () {
      for (final query in [
        'viewer=1&machine=m&agent=%FF',
        'viewer=1&machine=%C0%AF&agent=a',
        'viewer=%FF&machine=m&agent=a',
        'viewer=1&machine=m&agent=a&unknown=%FF',
        '%FF=x&viewer=1&machine=m&agent=a',
        'viewer=1&viewer=0&machine=m&agent=a',
        'viewer=0&machine=m&agent=a',
        'viewer=1&machine=m&machine=n&agent=a',
        'viewer=1&machine=m&agent=%7F',
        'viewer=1&machine=m&agent=${'a' * 161}',
      ]) {
        final uri = Uri.parse('https://harness.example/?$query');
        expect(ViewerLocation.isRoute(uri), isTrue, reason: query);
        expect(ViewerLocation.parse(uri), isNull, reason: query);
        expect(ViewerLocation.workspaceAllowed(uri), isFalse, reason: query);
        expect(ViewerLocation.returnPath('/?$query'), isNull, reason: query);
      }
      expect(ViewerLocation.returnPath(null), isNull);
      expect(ViewerLocation.returnPath(42), isNull);
      expect(ViewerLocation.returnPath('http://[invalid'), isNull);
    },
  );

  test('encoded query keys and boundary identities survive sign-in', () {
    final uri = Uri.parse(
      'https://harness.example/?view%65r=1&machine=${'m' * 160}&agent=%E6%B5%8B%E8%AF%95%2B%23',
    );
    expect(ViewerLocation.isRoute(uri), isTrue);
    expect(ViewerLocation.parse(uri)!.machineId.length, 160);
    expect(ViewerLocation.parse(uri)!.agentId, '测试+#');
    expect(ViewerLocation.workspaceAllowed(uri), isFalse);
    expect(ViewerLocation.parse(Uri.parse('https://harness.example/')), isNull);
  });
}
