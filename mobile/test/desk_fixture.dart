import 'package:harness_mobile/api/api_client.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/desk_sync.dart';

import 'agent_pager_fixture.dart';

/// The backend's desk routes, answered in memory: a document, and ops applied
/// to it the way `backend/src/routes/desk.ts` applies them.
///
/// Every other call is the real [ApiClient]'s, which in a test reaches a Dio
/// that is never built — nothing here makes one.
class DeskApi extends ApiClient {
  DeskApi({this.tabs = const []})
    : super(config: AppConfig.dev, session: AuthSession());

  List<DeskTab> tabs;
  int revision = 0;

  /// The ops this phone sent, in order.
  final List<Map<String, dynamic>> written = [];

  Map<String, dynamic> get doc => {
    'revision': revision,
    'tabs': [for (final tab in tabs) tab.toJson()],
  };

  @override
  Future<Map<String, dynamic>?> desk() async => doc;

  @override
  Future<Map<String, dynamic>?> deskOps(List<Map<String, dynamic>> ops) async {
    written.addAll(ops);
    tabs = applyDeskOps(tabs, ops);
    revision++;
    return doc;
  }
}

/// A tab of `m`'s agents, named.
DeskTab deskTab(String id, String name, List<String> agentIds) => DeskTab(
  id: id,
  name: name,
  panes: [
    for (final agentId in agentIds)
      DeskPaneRef(machineId: 'm', agentId: agentId),
  ],
);

/// The pager fixture's app — one machine `m` running [pagerAgentIds] — signed
/// in to an account whose desk holds [tabs].
///
/// [opensTerminals] false leaves the machine listing its agents while refusing
/// to open a stream for any of them (`AppNotifier._canAttachAgent`). For a test
/// about which agents a tab offers, that is the difference between asserting on
/// a list and nursing four terminal sessions through their keyframes.
Future<AppNotifier> deskApp(
  PagerConn conn, {
  List<DeskTab> tabs = const [],
  bool opensTerminals = true,
}) async {
  final app = pagerApp(conn);
  app.api = DeskApi(tabs: tabs);
  if (!opensTerminals) {
    app.stateOf('m')!.terminalCapabilityAvailable = false;
  }
  await app.deskSyncForTest();
  // ⚠️ A test is not a phone somebody is holding. Joining the desk arms the
  // foreground poll (see [PhoneDesk.pollInterval]), and `testWidgets` fails a
  // test that leaves a timer running. Tests about the poll itself drive
  // [PhoneDesk] directly, with an interval of their own.
  app.handleAppPaused();
  return app;
}

/// The desk this app is talking to.
DeskApi deskApiOf(AppNotifier app) => app.api as DeskApi;
