/// The Super Tab against a local, isolated backend, for review screenshots.
///
/// Build for web with `--dart-define=HARNESS_TEST=true` and serve it from a
/// loopback origin that passes `/api/` to the local backend of the local
/// backend recipe (fake SSO tokens, local MongoDB and Redis). Open it with
/// `?tab=<id>&as=owner|peer` and optionally `&open=pm` (that person's Chat
/// with PM, created on first use) or `&group=<id>`. It refuses any origin but
/// 127.0.0.1 and knows only the recipe's two fake test tokens: it never
/// reaches a real account or production data.
library;

import 'dart:convert';
import 'dart:js_interop';

import 'package:flutter/material.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:web/web.dart' as web;

const _people = {
  'owner': ('local-owner-token', 'owner@local.test'),
  'peer': ('local-peer-token', 'peer@local.test'),
};

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    await _review();
  } catch (error, stack) {
    // A review page that cannot load says why, on the page and in the console.
    debugPrint('Local review failed: $error\n$stack');
    runApp(
      MaterialApp(home: Scaffold(body: Text('Local review failed: $error'))),
    );
  }
}

Future<void> _review() async {
  final query = Uri.base.queryParameters;
  final person = _people[query['as'] ?? 'owner'];
  final tabId = query['tab'];
  if (Uri.base.host != '127.0.0.1' || person == null || tabId == null) {
    throw StateError('Local review needs a loopback origin, ?tab= and ?as=');
  }
  final (token, email) = person;
  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final response = await web.window
        .fetch(
          path.toJS,
          web.RequestInit(
            method: method,
            headers:
                {
                      'authorization': 'Bearer $token',
                      'content-type': 'application/json',
                    }.jsify()!
                    as web.HeadersInit,
            body: body == null ? null : jsonEncode(body).toJS,
          ),
        )
        .toDart;
    final answer = superTabMap(
      jsonDecode((await response.text().toDart).toDart),
    );
    if (answer['success'] != true) {
      final error = superTabMap(answer['error']);
      throw SuperTabFailure(
        error['code'] as String? ?? 'ERROR',
        error['message'] as String? ?? 'Failed.',
        statusCode: response.status,
      );
    }
    return superTabMap(answer['data']);
  }

  // The account id the backend gave this person on first use.
  final first = await request('GET', '/api/super-tabs/$tabId/parts');
  debugPrint('review: first load read');
  final accountId = [
    for (final member in first['members'] as List)
      if ((member as Map)['data']['email'] == email) member['key'] as String,
  ].single;
  const palette = HarnessPalette.paper;
  grid.AppTheme.palette.value = palette;
  grid.AppTheme.brightness.value = palette.brightness;
  final controller = SuperTabController(
    tabId: tabId,
    accountId: accountId,
    request: request,
    save: (_) async {},
    pollInterval: Duration.zero,
  );
  debugPrint('review: account $accountId');
  await controller.refresh();
  debugPrint('review: refreshed, error ${controller.error}');
  final project = controller.snapshot!.projects.first.id;
  if (!controller.expandedProjects.contains(project)) {
    controller.toggleProject(project);
  }
  if (query['open'] == 'pm') {
    await controller.openPmChat(project);
  } else if (query['group'] case final group?) {
    await controller.select(group);
  }
  debugPrint('review: opened ${controller.selectedId}');
  await controller.loadMessages(controller.selectedId);
  debugPrint('review: messages loaded');
  final navigator = GlobalKey<NavigatorState>();
  runApp(
    MaterialApp(
      navigatorKey: navigator,
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: palette.brightness),
      home: Scaffold(
        body: SuperTabView(
          controller: controller,
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          machineName: (_) => 'Local machine',
        ),
      ),
    ),
  );
}
