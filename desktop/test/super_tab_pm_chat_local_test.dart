import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';

/// Each person's private chat with the Product Manager, against a real, local,
/// isolated backend. Opt-in: it runs only with `SWARM_LOCAL_BACKEND` set to a
/// loopback backend started as in the local backend recipe (fake SSO tokens,
/// local MongoDB and Redis), `SWARM_LOCAL_TAB` naming a Swarm both test people
/// belong to, and `SWARM_LOCAL_LEAD` its Lead agent, on a machine of the
/// owner's. It never reaches any other host.
///
///   `SWARM_LOCAL_BACKEND=http://127.0.0.1:18085 SWARM_LOCAL_TAB=ID \
///     SWARM_LOCAL_LEAD=AGENT flutter test test/super_tab_pm_chat_local_test.dart`
void main() {
  final backend = Platform.environment['SWARM_LOCAL_BACKEND'];
  final tabId = Platform.environment['SWARM_LOCAL_TAB'];
  final lead = Platform.environment['SWARM_LOCAL_LEAD'];
  final skip = backend == null || tabId == null || lead == null
      ? 'needs SWARM_LOCAL_BACKEND, SWARM_LOCAL_TAB and SWARM_LOCAL_LEAD'
      : Uri.parse(backend).host != '127.0.0.1'
      ? 'SWARM_LOCAL_BACKEND must be a loopback backend'
      : null;
  const owner = 'local-owner-token', peer = 'local-peer-token';

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
      final answer = jsonDecode(
        await response.transform(utf8.decoder).join(),
      ) as Map<String, dynamic>;
      if (answer['success'] != true) {
        final error = superTabMap(answer['error']);
        throw SuperTabFailure(
          error['code'] as String? ?? 'ERROR',
          error['message'] as String? ?? 'Failed.',
          statusCode: response.statusCode,
        );
      }
      return superTabMap(answer['data']);
    } finally {
      client.close();
    }
  }

  SuperTabController person(String token, String accountId) =>
      SuperTabController(
        tabId: tabId!,
        accountId: accountId,
        request: (method, path, {body}) =>
            call(token, method, path, body: body),
        save: (_) async {},
        pollInterval: Duration.zero,
      );

  Future<Object?> refusal(Future<void> Function() read) async {
    try {
      await read();
    } catch (failure) {
      return failure;
    }
    return null;
  }

  test("each person's chat reaches the Lead, the Lead's reply reaches only that person", () async {
    // Each person's account id, as the backend named them on first use.
    final members = await call(peer, 'GET', '/api/super-tabs/$tabId/parts');
    String idOf(String email) =>
        [
              for (final member in members['members'] as List)
                if ((member as Map)['data']['email'] == email) member['key'],
            ].single
            as String;
    final peerId = idOf('peer@local.test');
    final ken = person(peer, peerId);
    final secondWindow = person(peer, peerId);
    final boss = person(owner, idOf('owner@local.test'));
    addTearDown(ken.dispose);
    addTearDown(secondWindow.dispose);
    addTearDown(boss.dispose);
    await ken.refresh();
    await secondWindow.refresh();
    await boss.refresh();
    expect(ken.error, isNull);
    final project = ken.snapshot!.projects.first.id;

    // Two windows open the chat: one conversation, the Lead in it.
    expect(await ken.openPmChat(project), isTrue);
    expect(await secondWindow.openPmChat(project), isTrue);
    final chat = ken.pmChat(project)!;
    expect(secondWindow.selectedId, chat.id);
    expect(chat.audience, [peerId]);
    expect(chat.agentIds, contains(lead));
    expect(chat.title, 'peer');
    expect(await boss.openPmChat(project), isTrue);
    final bossChat = boss.pmChat(project)!;
    expect(bossChat.id, isNot(chat.id));

    // The person writes; the message is delivered to the Lead.
    final ask = 'Which build should I try? ${DateTime.now().toIso8601String()}';
    await ken.select(chat.id);
    ken.setDraft(chat.id, ask);
    expect(await ken.send(), isNotNull);
    await ken.loadMessages(chat.id);
    final asked = ken.messages(chat.id).firstWhere((m) => m.text == ask);
    expect(asked.deliveries.map((d) => d['agentId']), [lead]);

    // The Lead answers there, as its host posts for it.
    final answer = 'Try build 42. ${DateTime.now().toIso8601String()}';
    await call(
      owner,
      'POST',
      '/api/super-tabs/$tabId/commands',
      body: {
        'operationId': superTabOperationId(),
        'asAgentId': lead,
        'command': {
          'type': 'message.send',
          'conversationId': chat.id,
          'text': answer,
          'replyTo': asked.id,
          'recipientIds': <String>[],
        },
      },
    );
    await ken.refresh();
    expect(ken.unread(ken.pmChat(project)!), isTrue);
    await ken.loadMessages(chat.id);
    expect(ken.messages(chat.id).map((m) => m.text), contains(answer));

    // Nobody else reads it: not the Swarm's owner, not even by its id.
    await boss.refresh();
    expect(boss.snapshot!.conversation(chat.id), isNull);
    expect(
      await refusal(
        () => call(
          owner,
          'GET',
          '/api/super-tabs/$tabId/conversations/${chat.id}/messages',
        ),
      ),
      isA<SuperTabFailure>(),
    );
    expect(
      await refusal(
        () => call(owner, 'GET', '/api/super-tabs/$tabId/groups/${chat.id}'),
      ),
      isA<SuperTabFailure>().having((f) => f.statusCode, 'status', 404),
    );
    expect(ken.snapshot!.conversation(bossChat.id), isNull);

    // The Lead reads both people's chats.
    final asLead = await call(
      owner,
      'GET',
      '/api/super-tabs/$tabId/parts?asAgentId=$lead',
    );
    final seen = [
      for (final group in asLead['groups'] as List) (group as Map)['key'],
    ];
    expect(seen, containsAll([chat.id, bossChat.id]));
  }, skip: skip);
}
