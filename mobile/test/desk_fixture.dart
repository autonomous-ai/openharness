import 'package:harness_mobile/api/api_client.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/desk_sync.dart';
import 'package:harness_mobile/state/phone_desk.dart';

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

/// A tab of `m`'s agents, named — by hand unless [custom] is false, when the
/// name is the desk's placeholder and the tab is called after its first agent.
DeskTab deskTab(
  String id,
  String name,
  List<String> agentIds, {
  bool custom = true,
}) => DeskTab(
  id: id,
  name: name,
  nameIsCustom: custom,
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
  LocalKeyValueStore? storage,
}) async {
  final app = pagerApp(conn, storage: storage);
  app.api = DeskApi(tabs: tabs);
  if (!opensTerminals) {
    app.stateOf('m')!.terminalCapabilityAvailable = false;
  }
  await syncDesk(app);
  return app;
}

/// Read the desk now, and leave no poll behind.
///
/// ⚠️ A test is not a phone somebody is holding. Reading the desk arms the
/// foreground poll (see [PhoneDesk.pollInterval]) and `testWidgets` fails a test
/// that leaves a timer running — so every read a test makes ends the way
/// backgrounding the app would. Tests about the poll itself drive [PhoneDesk]
/// directly, with an interval of their own.
Future<void> syncDesk(AppNotifier app) async {
  await app.deskSyncForTest();
  app.handleAppPaused();
}

/// The desk this app is talking to.
DeskApi deskApiOf(AppNotifier app) => app.api as DeskApi;
