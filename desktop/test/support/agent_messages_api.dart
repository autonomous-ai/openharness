import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/settings/experimental_features.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/desk_sync.dart';

/// The daemon's desk and Agent Messages proxies, scripted: a window's tabs
/// live on a desk, and the Agent Messages read answers for its tabs (backend
/// routes/agentMessages.ts). The backend still says each tab's old flag, off
/// unless someone turned it on; the app no longer reads it.
class AgentMessagesApi extends ApiClient {
  AgentMessagesApi() : super(config: AppConfig.dev, session: AuthSession());

  DeskDoc doc = const DeskDoc(revision: 0, tabs: []);
  int reads = 0;

  /// A daemon or backend that predates Agent Messages (404).
  bool unsupported = false;

  /// A daemon whose backend is away: the read throws.
  Object? readError;

  Map<String, dynamic> _json(DeskDoc d) => {
    'revision': d.revision,
    'tabs': [for (final t in d.tabs) t.toJson()],
  };

  @override
  Future<Map<String, dynamic>?> desk() async => _json(doc);

  @override
  Future<Map<String, dynamic>?> deskOps(List<Map<String, dynamic>> ops) async {
    doc = DeskDoc(
      revision: doc.revision + 1,
      tabs: applyDeskOps(doc.tabs, ops),
    );
    return _json(doc);
  }

  @override
  Future<Map<String, dynamic>?> readAgentMessageTabs() async {
    reads++;
    if (readError case final error?) throw error;
    if (unsupported) return null;
    return {
      'revision': doc.revision,
      'machines': const [],
      'tabs': [
        for (final tab in doc.tabs)
          {'id': tab.id, 'name': tab.name, 'enabled': false, 'panes': const []},
      ],
    };
  }
}

/// Signs [app] in on [api] and joins its desk, so its tabs can show Agent
/// Messages; [AppNotifier.agentMessagesOffered] holds for its desk tabs after.
Future<AgentMessagesApi> joinAgentMessagesDesk(
  AppNotifier app, [
  AgentMessagesApi? api,
]) async {
  final fake = api ?? AgentMessagesApi();
  app
    ..api = fake
    ..status = AppStatus.authenticated;
  await app.deskStartForTest();
  // Agent Messages is asked about beside the desk, after it is joined: let
  // that read land without a timer, so widget and plain tests alike can call
  // this.
  for (var i = 0; i < 10 && !app.agentMessages.loaded; i++) {
    await Future<void>.value();
  }
  await agentMessagesSwitch(app, true);
  return fake;
}

/// The account's Agent Messages switch (Settings ▸ Experimental), as the
/// backend answers it. Tab Activity, the leader and the People and Tasks of a
/// tab that is not shared need it on beside the daemon's and backend's support
/// (final review I1); [joinAgentMessagesDesk] turns it on.
Future<void> agentMessagesSwitch(AppNotifier app, bool on) async {
  final store = app.experimentalFeatures;
  final account = store.accountId ?? 'u-test';
  store.bind(account, transport: _AgentMessagesSwitch(account, on));
  await store.refresh();
}

class _AgentMessagesSwitch implements ExperimentalSettingsTransport {
  _AgentMessagesSwitch(this.accountId, this.on);
  final String accountId;
  final bool on;

  @override
  Future<Map<String, dynamic>> read() async => {
    'accountId': accountId,
    'revision': 0,
    'features': {
      for (final feature in ExperimentalFeature.values)
        feature.id: feature == ExperimentalFeature.agentMessages && on,
    },
  };

  @override
  Future<Map<String, dynamic>> write(
    String account,
    ExperimentalFeature feature,
    bool enabled,
  ) => throw UnsupportedError('The switch is set by agentMessagesSwitch.');
}
