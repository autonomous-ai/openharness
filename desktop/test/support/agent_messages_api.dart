import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/desk_sync.dart';

/// The daemon's desk and Agent Messages proxies, scripted: a window's tabs
/// live on a desk, and each desk tab has an Agent Messages flag beside it
/// (backend routes/agentMessages.ts).
class AgentMessagesApi extends ApiClient {
  AgentMessagesApi() : super(config: AppConfig.dev, session: AuthSession());

  DeskDoc doc = const DeskDoc(revision: 0, tabs: []);
  final flags = <String, bool>{};
  int reads = 0;

  /// A daemon or backend that predates Agent Messages (404).
  bool unsupported = false;

  /// A daemon whose backend is away: the read throws.
  Object? readError;
  Object? writeError;
  final writes = <(String, bool)>[];

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
          {
            'id': tab.id,
            'name': tab.name,
            'enabled': flags[tab.id] ?? false,
            'panes': const [],
          },
      ],
    };
  }

  @override
  Future<Map<String, dynamic>> setAgentMessages(
    String tabId,
    bool enabled,
  ) async {
    writes.add((tabId, enabled));
    if (writeError case final error?) throw error;
    flags[tabId] = enabled;
    return {'tabId': tabId, 'enabled': enabled, 'revision': writes.length};
  }
}

/// Signs [app] in on [api] and joins its desk, so its tabs can have Agent
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
  // The flags are read beside the desk, after it is joined: let that read
  // land without a timer, so widget and plain tests alike can call this.
  for (var i = 0; i < 10 && !app.agentMessages.loaded; i++) {
    await Future<void>.value();
  }
  return fake;
}
