import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/logging/redact.dart';

/// What reaches `~/.harness/logs`, where a line outlives whatever it was
/// minted for by a fortnight. The frames and URLs worth logging are the ones
/// most likely to carry a credential, so every shape one takes is pinned here.
void main() {
  group('a frame, by its keys', () {
    test('a secret-named key is blanked, however it is spelled or nested', () {
      final line = redactValue({
        'engine': 'codex',
        'apiKey': 'sk-live',
        'accessToken': 'eyJ…',
        'refresh_token': 'r',
        'Authorization': 'Bearer x',
        'turn': {'urls': 'turn:relay', 'username': 'u', 'credential': 'c'},
        'sessionId': 's-1',
        'cookie': 'a=b',
      });

      expect(
        line,
        '{engine: codex, apiKey: <redacted>, accessToken: <redacted>, '
        'refresh_token: <redacted>, Authorization: <redacted>, '
        'turn: {urls: turn:relay, username: u, credential: <redacted>}, '
        'sessionId: <redacted>, cookie: <redacted>}',
      );
    });

    test('what the person wrote is a length, never the words', () {
      expect(
        redactValue({
          'engine': 'claude',
          'prompt': 'fix the flaky login test',
          'cwd': '/work/app',
        }),
        '{engine: claude, prompt: <24 chars>, cwd: /work/app}',
      );
      expect(
        redactValue({'query': 'stripe webhook', 'limit': 20}),
        '{query: <14 chars>, limit: 20}',
      );
    });

    test('a list is a count, never its contents', () {
      expect(
        redactValue({
          'agents': [1, 2, 3],
          'one': ['x'],
        }),
        '{agents: [3 items], one: [1 item]}',
      );
      expect(redactValue(null), 'null');
    });

    test('a long value is clipped so one blob cannot bury the line', () {
      final line = redactValue({'sdp': 'v' * 500});
      expect(line, '{sdp: ${'v' * 120}…}');
    });

    test('the whole line has a budget of its own', () {
      final frame = {for (var i = 0; i < 40; i++) 'field$i': 'x' * 100};
      final line = summariseForLog(frame, maxLength: 300);
      expect(line, hasLength(301));
      expect(line, endsWith('…'));
      expect(summariseForLog({'ok': true}), '{ok: true}');
    });
  });

  group('free text', () {
    test('a bearer token is blanked whatever alphabet it is written in', () {
      expect(
        redactSecretsInText(
          'Authorization: Bearer eyJhbGciOi.J9eyJzdWIi.sig-_x',
        ),
        'Authorization: Bearer <redacted>',
      );
      // RFC 6750's b64token takes `+`, `/`, `~` and trailing `=` too — an
      // opaque token in plain base64 used to leak whole, being cut short of
      // the eight characters the rule wanted at its first `+`.
      expect(
        redactSecretsInText('Bearer abc123+def/ghi~jk=='),
        'Bearer <redacted>',
      );
    });

    test('basic credentials are blanked as bearer ones are', () {
      expect(
        redactSecretsInText('Authorization: Basic dXNlcjpwYXNzd29yZA=='),
        'Authorization: Basic <redacted>',
      );
    });

    test('vendor keys with a known prefix', () {
      expect(
        redactSecretsInText('key sk-ant-api03-AbCdEf123456 in use'),
        'key sk-<redacted> in use',
      );
    });

    test('the value after any secret-named field, however punctuated', () {
      expect(
        redactSecretsInText('{"session_token": "abcdef123456", "ok": 1}'),
        '{"session_token": "<redacted>", "ok": 1}',
      );
      expect(redactSecretsInText('password=hunter22'), 'password=<redacted>');
      expect(redactSecretsInText('api_key: abcdef'), 'api_key: <redacted>');
      // Too short to be a secret — `token: null` stays readable.
      expect(redactSecretsInText('token: null'), 'token: null');
    });

    test('a credential in a URL query is blanked, and only its value', () {
      expect(
        redactSecretsInText('GET https://h.invalid/x?sig=abc&lang=vi'),
        'GET https://h.invalid/x?sig=<redacted>&lang=vi',
      );
      // An OAuth redirect's one-time code is a credential until it is spent.
      expect(
        redactSecretsInText('GET https://h.invalid/cb?code=4/0AbCd&state=s1'),
        'GET https://h.invalid/cb?code=<redacted>&state=s1',
      );
      expect(
        redactSecretsInText('POST https://h.invalid/a?user=me&pwd=x1'),
        'POST https://h.invalid/a?user=me&pwd=<redacted>',
      );
    });

    test('ordinary text is left alone', () {
      const line = 'GET https://h.invalid/api/machines → 200 (118ms)';
      expect(redactSecretsInText(line), line);
    });
  });
}
