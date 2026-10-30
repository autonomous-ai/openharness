import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/parts.dart';

/// The Swarm client against a real, local, isolated backend (#1726 group 4,
/// check 2). Opt-in: it runs only with `SWARM_LOCAL_BACKEND` set to a
/// loopback backend started as in the group 3 recipe (fake SSO tokens, local
/// MongoDB and Redis), and `SWARM_LOCAL_TAB` naming a Swarm both test people
/// belong to. It never reaches any other host.
///
///   `SWARM_LOCAL_BACKEND=http://127.0.0.1:18085 SWARM_LOCAL_TAB=ID \
///     flutter test test/super_tab_local_backend_test.dart`
void main() {
  final backend = Platform.environment['SWARM_LOCAL_BACKEND'];
  final tabId = Platform.environment['SWARM_LOCAL_TAB'];
  final skip = backend == null || tabId == null
      ? 'needs SWARM_LOCAL_BACKEND and SWARM_LOCAL_TAB'
      : Uri.parse(backend).host != '127.0.0.1'
      ? 'SWARM_LOCAL_BACKEND must be a loopback backend'
      : null;
  const owner = 'local-owner-token', peer = 'local-peer-token';

  /// Response bytes by read kind, in order.
  final bytes = <String, List<int>>{};

  /// The last first load answered.
  Map<String, dynamic>? firstLoad;

  Future<Map<String, dynamic>> call(
    String token,
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final client = HttpClient();
    try {
      final request = await client.openUrl(method, Uri.parse('$backend$path'));
      request.headers
        ..set('authorization', 'Bearer $token')
        ..contentType = ContentType.json;
      if (body != null) request.write(jsonEncode(body));
      final response = await request.close();
      final text = await response.transform(utf8.decoder).join();
      final kind = Uri.parse(path).pathSegments.length > 3
          ? Uri.parse(path).pathSegments[3]
          : 'tab';
      (bytes[kind] ??= []).add(utf8.encode(text).length);
      final answer = jsonDecode(text) as Map<String, dynamic>;
      if (answer['success'] != true) {
        final error = superTabMap(answer['error']);
        throw SuperTabFailure(
          error['code'] as String? ?? 'ERROR',
          error['message'] as String? ?? 'Failed.',
          statusCode: response.statusCode,
        );
      }
      final data = superTabMap(answer['data']);
      if (kind == 'parts') firstLoad = data;
      return data;
    } finally {
      client.close();
    }
  }

  test('a Swarm opens with one first load, then reads only what another client changed', () async {
    final c = SuperTabController(
      tabId: tabId!,
      accountId: 'local-owner',
      request: (method, path, {body}) => call(owner, method, path, body: body),
      save: (_) async {},
      pollInterval: Duration.zero,
    );
    await c.refresh();
    expect(c.error, isNull);
    final lead = c.snapshot!.projects.first.leadConversationId;
    final before = c.snapshot!.conversation(lead)!.lastMessageSequence;

    // An idle poll: nothing changed but what the overlap sends again.
    await c.refresh();
    expect(c.error, isNull);

    // Another client posts, as the second person.
    final text = 'From the second client ${DateTime.now().toIso8601String()}';
    await call(
      peer,
      'POST',
      '/api/super-tabs/$tabId/commands',
      body: {
        'operationId': superTabOperationId(),
        'command': {
          'type': 'message.send',
          'conversationId': lead,
          'text': text,
          'replyTo': null,
          'recipientIds': <String>[],
        },
      },
    );
    await c.refresh();
    expect(c.error, isNull);
    expect(
      c.snapshot!.conversation(lead)!.lastMessageSequence,
      greaterThan(before),
    );
    await c.loadMessages(lead);
    expect(c.messages(lead).map((m) => m.text), contains(text));

    // The old whole-Swarm read is refused for old clients.
    Object? old;
    try {
      await call(owner, 'GET', '/api/super-tabs/$tabId');
    } catch (failure) {
      old = failure;
    }
    expect(
      old,
      isA<SuperTabFailure>()
          .having((f) => f.statusCode, 'status', 426)
          .having((f) => f.code, 'code', 'UPDATE_REQUIRED'),
    );

    // What a poll costs now, against today's full read of this Swarm:
    // the old route sent the whole visible state every 3 s.
    final state = jsonEncode({
      'success': true,
      'data': {
        'revision': 0,
        'state': SuperTabParts.firstLoad(firstLoad!).state,
      },
    });
    // ignore: avoid_print
    print(
      'bytes: first load ${bytes['parts']}, change reads ${bytes['changes']}, '
      'today\'s full read of the same Swarm ~${utf8.encode(state).length}',
    );
    c.dispose();
  }, skip: skip);
}
