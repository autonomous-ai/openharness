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

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

const _people = {
  'owner': ('local-owner-token', 'owner@local.test'),
  'peer': ('local-peer-token', 'peer@local.test'),
};

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final query = Uri.base.queryParameters;
  final person = _people[query['as'] ?? 'owner'];
  final tabId = query['tab'];
  if (Uri.base.host != '127.0.0.1' || person == null || tabId == null) {
    throw StateError('Local review needs a loopback origin, ?tab= and ?as=');
  }
  final (token, email) = person;
  final dio = Dio(
    BaseOptions(
      baseUrl: Uri.base.origin,
      headers: {'authorization': 'Bearer $token'},
      validateStatus: (_) => true,
    ),
  );
  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final response = await dio.request<Map<String, dynamic>>(
      path,
      data: body,
      options: Options(method: method),
    );
    final answer = response.data ?? const {};
    if (answer['success'] != true) {
      final error = superTabMap(answer['error']);
      throw SuperTabFailure(
        error['code'] as String? ?? 'ERROR',
        error['message'] as String? ?? 'Failed.',
        statusCode: response.statusCode ?? 0,
      );
    }
    return superTabMap(answer['data']);
  }

  // The account id the backend gave this person on first use.
  final first = await request('GET', '/api/super-tabs/$tabId/parts');
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
  await controller.refresh();
  final project = controller.snapshot!.projects.first.id;
  if (!controller.expandedProjects.contains(project)) {
    controller.toggleProject(project);
  }
  if (query['open'] == 'pm') {
    await controller.openPmChat(project);
  } else if (query['group'] case final group?) {
    await controller.select(group);
  }
  await controller.loadMessages(controller.selectedId);
  runApp(
    MaterialApp(
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
