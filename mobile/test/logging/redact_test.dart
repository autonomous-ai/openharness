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

  group('a Swarm join link, by its text', () {
    final token = 'Ab3_' * 10 + 'xyz';

    /// What a computer answers the phone's read of a Swarm's sharing, as
    /// `WsConn.request` logs it (`← super_tabs …`).
    Map<String, dynamic> answer(String tabId) => {
      'value': {
        'revision': 3,
        'access': {'mode': 'link', 'role': 'viewer'},
        'joinUrl': 'harness://swarm/join/$tabId?token=$token',
      },
    };

    test(
      'its token never reaches the line, under a field not named for it',
      () {
        final line = '← super_tabs ${summariseForLog(answer('tab-1'))}';
        expect(line, isNot(contains(token)));
        expect(line, isNot(contains(token.substring(0, 8))));
        expect(
          line,
          contains('joinUrl: harness://swarm/join/tab-1?token=<redacted>'),
        );
      },
    );

    test('a long Swarm id: the clipped link keeps none of its token', () {
      // The token starts just before the 120th character, where a value is
      // clipped.
      final line = summariseForLog(answer('a' * 80));
      expect(line, isNot(contains(token.substring(0, 6))));
      expect(line, contains('?token=<redacted>'));
    });

    test('a value is blanked before it is clipped', () {
      // Clipped first, this token would keep two characters, fewer than the
      // `Bearer` rule needs to recognise it, and they would be written.
      final line = redactValue({'detail': '${'x' * 111}Bearer ab3defghijk'});
      expect(line, isNot(contains('Bearer ab')));
    });
  });
}
