import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/profile_model.dart';

/// Which uploaded-picture links the phone draws: a private avatar bucket's
/// signed link, or a picture kept with the chat files on their CDN (a server
/// without an avatar bucket, Ken 2026-10-28), but only in its avatars folder.
void main() {
  Uri? drawn(String url) =>
      switch (SuperTabAvatarPicture.fromJson({'kind': 'upload', 'url': url})) {
        final SuperTabUploadedAvatar upload => upload.url,
        _ => null,
      };

  test('a private bucket\'s signed link', () {
    const link =
        'https://storage.googleapis.com/avatars/tab/0123/avatar?X-Goog-Signature=1';
    expect(drawn(link), Uri.parse(link));
  });

  test('a picture in the avatars folder on the chat files\' CDN', () {
    const link = 'https://cdn.harness.autonomous.ai/avatars/tab/0123/avatar';
    expect(drawn(link), Uri.parse(link));
  });

  test('nothing else on the CDN, and nothing that only looks like it', () {
    for (final link in [
      // A chat file.
      'https://cdn.harness.autonomous.ai/super-tabs/tab/0123/photo.png',
      // Not https.
      'http://cdn.harness.autonomous.ai/avatars/tab/0123/avatar',
      // A folder that only starts the same, or the folder itself.
      'https://cdn.harness.autonomous.ai/avatars-old/tab/0123/avatar',
      'https://cdn.harness.autonomous.ai/avatars',
      'https://cdn.harness.autonomous.ai/avatars/',
      // Out of the folder again.
      'https://cdn.harness.autonomous.ai/avatars/../super-tabs/tab/photo.png',
      'https://cdn.harness.autonomous.ai/avatars/%2E%2E/super-tabs/photo.png',
      // Another host.
      'https://cdn.harness.autonomous.ai.example/avatars/tab/0123/avatar',
      'https://elsewhere.example/avatars/tab/0123/avatar',
    ]) {
      expect(drawn(link), isNull, reason: link);
    }
  });
}
