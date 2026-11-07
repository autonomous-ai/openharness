import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'support/stack.dart';

/// The stack's control server (scripts/swarm-flows-stack.mts) acts as the
/// person's other account and their agents, and changes the runner's files:
/// only the test that started it may use it (security review of #3568).
void main() {
  if (cliRoot == null) {
    test('Swarm stack control', () {}, skip: skipReason);
    return;
  }
  late SwarmStack stack;
  setUpAll(() async => stack = await SwarmStack.start());
  tearDownAll(() => stack.stop());

  Future<int> post(String path, Object body, {String? token}) async {
    final client = HttpClient();
    try {
      final request = await client.post(
        '127.0.0.1',
        stack.config['controlPort'] as int,
        path,
      );
      request.headers.contentType = ContentType.json;
      if (token != null) request.headers.set(controlTokenHeader, token);
      request.write(jsonEncode(body));
      final response = await request.close();
      await response.drain<void>();
      return response.statusCode;
    } finally {
      client.close(force: true);
    }
  }

  test('a request without the run\'s token is refused', () async {
    expect(await post('/api', {'as': 'owner', 'path': '/api/auth/me'}), 403);
    expect(
      await post('/engine', {'name': 'claude', 'crashes': true}, token: 'x'),
      403,
    );
    expect(
      await post('/api', {
        'as': 'owner',
        'path': '/api/auth/me',
      }, token: stack.config['controlToken'] as String),
      200,
    );
  });

  test('the engine control names only Claude Code or Codex', () async {
    final token = stack.config['controlToken'] as String;
    for (final name in ['../../outside', 'gh', 'sudo', '']) {
      expect(
        await post('/engine', {'name': name, 'crashes': true}, token: token),
        400,
        reason: name,
      );
    }
  });
}
