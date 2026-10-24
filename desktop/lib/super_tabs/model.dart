/// Backend records are independent of the desktop's visible panes and tab layout.
Map<String, dynamic> superTabMap(Object? value) => value is Map
    ? Map<String, dynamic>.from(value)
    : throw const FormatException('Invalid Swarm response.');

String _text(Map<String, dynamic> value, String key) => value[key] is String
    ? value[key] as String
    : throw FormatException('Missing Swarm $key.');

List<T> _list<T>(Object? value, T Function(Map<String, dynamic>) read) =>
    value is List
    ? List.unmodifiable(value.map((row) => read(superTabMap(row))))
    : throw const FormatException('Invalid Swarm list.');

/// Work that waits on a person: the agent needs a decision (`needs_human`) or
/// is stuck (`blocked`). Both stay active work until the agent moves on.
bool superTabWorkWaits(Object? status) =>
    status == 'needs_human' || status == 'blocked';

/// How a work status reads in the app. `blocked` is what the agent calls it;
/// people read Stuck. Statuses this build does not know read as sent.
String superTabWorkStatusLabel(String status) =>
    status == 'blocked' ? 'stuck' : status.replaceAll('_', ' ');

class SuperTabPerson {
  SuperTabPerson.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      email = _text(row, 'email'),
      role = _text(row, 'role');
  final String id, email, role;
  bool get canWrite => role == 'owner' || role == 'collaborator';
}

class SuperTabAgent {
  SuperTabAgent.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      hasProjectId = row['projectId'] != null,
      projectId = row['projectId'] as String? ?? 'lead',
      name = _text(row, 'name'),
      displayName = row['displayName'] as String?,
      machineId = _text(row, 'machineId'),
      harnessId = _text(row, 'harnessId'),
      contributorId = _text(row, 'contributorId'),
      machineOwnerId =
          row['machineOwnerId'] as String? ?? _text(row, 'contributorId'),
      role = row['role'] as String?,
      roleId = row['roleId'] as String?,
      limitedUntil = DateTime.tryParse(row['limitedUntil'] as String? ?? ''),
      configuration = Map.unmodifiable(superTabMap(row['configuration']));
  final String id, projectId, name, machineId, harnessId, contributorId;

  /// Until when routing skips it: its machine saw a usage limit on its screen
  /// (spec/2026-10-23-lead-sees-agent-terminal.md). Null when none was seen.
  final DateTime? limitedUntil;

  /// The account whose computer runs it; a contributor may run agents on a computer another account shared with them.
  final String machineOwnerId;
  // Keep the legacy default for callers while allowing group-based roster ownership.
  final bool hasProjectId;
  final String? displayName;
  // Absent until the backend sends one; an agent without a role is a Builder.
  final String? role;
  final String? roleId;
  bool get isReviewer => role == 'reviewer';
  final Map<String, dynamic> configuration;
  String get engine => configuration['engine'] as String? ?? '';
}

class SuperTabTask {
  SuperTabTask.fromJson(Map<String, dynamic> row)
    : goal = _text(row, 'goal'),
      changes = _text(row, 'changes'),
      constraints = _text(row, 'constraints'),
      owns = List.unmodifiable((row['owns'] as List).cast<String>());

  final String goal, changes, constraints;
  final List<String> owns;
}

class SuperTabConversation {
  SuperTabConversation.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      // The Product Managers' conversation belongs to no project; a group from
      // before projects belongs to the first.
      projectId =
          row['projectId'] as String? ?? (row['kind'] == 'leads' ? '' : 'lead'),
      number = (row['number'] as num?)?.toInt(),
      title = _text(row, 'title'),
      leadId = row['leadId'] as String?,
      agentIds = List.unmodifiable((row['agentIds'] as List).cast<String>()),
      archived = row['archived'] == true,
      checks = _list(
        row['checks'] ?? const [],
        (check) => Map<String, dynamic>.unmodifiable(check),
      ),
      pullRequestUrls = List.unmodifiable(
        (row['pullRequestUrls'] as List?)?.whereType<String>() ??
            const <String>[],
      ),
      brief = _text(row, 'brief'),
      task = row['task'] is Map
          ? SuperTabTask.fromJson(superTabMap(row['task']))
          : null,
      lastMessageSequence = (row['lastMessageSequence'] as num?)?.toInt() ?? 0,
      assignment = row['assignment'] == null
          ? null
          : Map.unmodifiable(superTabMap(row['assignment']));
  final String id, projectId, title, brief;
  final SuperTabTask? task;
  final int? number;
  String get label => number == null ? title : '#$number $title';
  final String? leadId;
  final List<String> agentIds;
  final bool archived;
  final List<Map<String, dynamic>> checks;

  /// Persisted links may be absent on older backends; loaded messages still supply links.
  final List<String> pullRequestUrls;
  final int lastMessageSequence;
  final Map<String, dynamic>? assignment;
}

class SuperTabRole {
  SuperTabRole.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      name = _text(row, 'name'),
      kind = _text(row, 'kind'),
      version = _text(row, 'version');

  final String id, name, kind, version;
}

class SuperTabProject {
  SuperTabProject.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      name = _text(row, 'name'),
      ownerId = _text(row, 'ownerId'),
      leadConversationId = _text(row, 'leadConversationId'),
      skillMode = row['skillMode'] == 'default' ? 'default' : 'orchestration',
      skillSet =
          const {'default', 'orchestration', 'custom'}.contains(row['skillSet'])
          ? row['skillSet'] as String
          : row['skillMode'] == 'default'
          ? 'default'
          : 'orchestration',
      roles = row['roles'] is List
          ? _list(row['roles'], SuperTabRole.fromJson)
          : null,
      isPrivate = row['visibility'] == 'private',
      memberIds = [
        for (final member in row['members'] as List? ?? const [])
          superTabMap(member)['id'] as String,
      ],
      updateMinutes = (row['updateMinutes'] as num?)?.toInt() ?? 5,
      repository = row['repository'] is Map
          ? Map.unmodifiable(superTabMap(row['repository']))
          : null;
  final String id, name, ownerId, leadConversationId;
  final String skillMode;
  final String skillSet;
  final List<SuperTabRole>? roles;
  final bool isPrivate;
  final List<String> memberIds;
  final int updateMinutes;
  final Map<String, dynamic>? repository;
}

class SuperTabSnapshot {
  SuperTabSnapshot.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      name = _text(row, 'name'),
      ownerId = _text(row, 'ownerId'),
      paused = row['paused'] == true,
      project = row['project'] == null
          ? null
          : Map.unmodifiable(superTabMap(row['project'])),
      people = _list(row['people'], SuperTabPerson.fromJson),
      agents = _list(row['agents'], SuperTabAgent.fromJson),
      machines = _list(
        row['machines'] ?? const [],
        (m) => Map<String, dynamic>.unmodifiable(m),
      ),
      conversations = _list(
        row['conversations'],
        SuperTabConversation.fromJson,
      ),
      invitations = _list(
        row['invitations'],
        (row) => Map<String, dynamic>.unmodifiable(row),
      ),
      leadsConversationId = row['leadsConversationId'] as String?,
      localModels = SuperTabLocalModels.read(row['localModels']),
      mentionsWaiting = (row['mentionsWaiting'] as num?)?.toInt() ?? 0 {
    if (row['version'] != 1) {
      throw const FormatException('Update Harness to open this Swarm.');
    }
    projects = _list(
      row['projects'] ??
          [
            {
              'id': 'lead',
              'name': name,
              'ownerId': ownerId,
              'leadConversationId': 'lead',
              'visibility': 'public',
              'members': <Object>[],
              'updateMinutes': 5,
              if (project != null) 'repository': project,
            },
          ],
      SuperTabProject.fromJson,
    );
  }
  final String id, name, ownerId;
  final Map<String, dynamic>? project;
  final bool paused;
  final List<SuperTabPerson> people;
  final List<SuperTabAgent> agents;
  final List<Map<String, dynamic>> machines;
  final List<SuperTabConversation> conversations;
  late final List<SuperTabProject> projects;
  final List<Map<String, dynamic>> invitations;

  /// Where the projects' Product Managers talk, Swarm-wide; null in a Swarm
  /// from before it (spec 2026-10-23-leads-see-and-talk.md).
  final String? leadsConversationId;

  /// The Local models add-on, once the owner has turned it on; null before.
  final SuperTabLocalModels? localModels;

  /// The reader's tags still waiting for them, Swarm-wide; 0 from a backend
  /// before tags (spec 2026-10-24-lead-mentions.md).
  final int mentionsWaiting;
  SuperTabConversation? conversation(String id) =>
      conversations.where((c) => c.id == id).firstOrNull;
  SuperTabAgent? agent(String id) =>
      agents.where((a) => a.id == id).firstOrNull;

  SuperTabProject? projectFor(String conversationId) {
    final group = conversation(conversationId);
    return projects.where((p) => p.id == group?.projectId).firstOrNull;
  }

  bool isProjectLead(String conversationId) =>
      projects.any((p) => p.leadConversationId == conversationId);

  SuperTabProject? leadProjectForAgent(String agentId) => projects
      .where((p) => conversation(p.leadConversationId)?.leadId == agentId)
      .firstOrNull;

  bool isLead(String agentId) => leadProjectForAgent(agentId) != null;

  SuperTabRole? activeRoleForAgent(SuperTabAgent agent) {
    final leadProject = leadProjectForAgent(agent.id);
    final roleKind = leadProject != null
        ? 'lead'
        : agent.isReviewer
        ? 'reviewer'
        : 'builder';
    final project =
        leadProject ??
        projects.where((entry) => entry.id == agent.projectId).firstOrNull;
    if (project?.skillSet != 'custom') return null;
    final roles = project?.roles ?? const <SuperTabRole>[];
    return roles
            .where((role) => role.id == agent.roleId && role.kind == roleKind)
            .firstOrNull ??
        roles.where((role) => role.kind == roleKind).firstOrNull;
  }

  String? leadProtectionReason(String agentId) {
    final project = leadProjectForAgent(agentId);
    if (project == null) return null;
    return '${agentName(agentId)} is the Product Manager of project ${project.name}. Delete the project first.';
  }

  /// The agents of a workgroup whose role is Reviewer.
  List<SuperTabAgent> reviewers(SuperTabConversation group) => [
    for (final id in group.agentIds)
      if (agent(id) case final a? when a.isReviewer) a,
  ];

  String agentName(String id, {String fallback = 'Agent'}) =>
      agent(id)?.displayName ?? agent(id)?.name ?? fallback;

  /// [machineId]'s contribution to this Swarm, if it has one.
  Map<String, dynamic>? pool(String machineId) =>
      machines.where((m) => m['machineId'] == machineId).firstOrNull;

  /// The Mac's Harness Team account folded into [machineId]'s row: its pool names [machineId] as `hostMachineId`
  /// (docs/plans/2026-10-24-swarm-team-account.md). The backend adds it with its Mac and changes it with it.
  Map<String, dynamic>? teamPoolOf(String machineId) => pool(machineId) == null
      ? null
      : machines
            .where(
              (m) =>
                  m['hostMachineId'] == machineId &&
                  m['machineId'] != machineId,
            )
            .firstOrNull;

  /// The machine [machineId] is shown as, one row per computer: the Mac, for its Harness Team account while that
  /// Mac is in the Swarm too; [machineId] itself otherwise, a machine used only for agents included.
  String placeOf(String machineId) {
    final host = pool(machineId)?['hostMachineId'];
    return host is String && teamPoolOf(host)?['machineId'] == machineId
        ? host
        : machineId;
  }

  /// Whether more than one person can start work here: teammates' agents are a question only then.
  bool get hasTeammates => people.where((p) => p.role != 'viewer').length > 1;

  // Resolve the person shown in chat from the same identity as the roster.
  // Recorded labels remain the fallback for agents no longer in the Swarm.
  String authorName(SuperTabMessage message) => message.fromAgent
      ? agentName(message.authorId, fallback: message.authorName)
      : message.authorName;
}

/// The Swarm's Local models add-on (docs/plans/2026-10-23-swarm-local-models.md): its grid, whether it is on, and what the
/// owner's computer last reported about setting the grid up (`ready` null until it has).
class SuperTabLocalModels {
  const SuperTabLocalModels({
    required this.grid,
    required this.enabled,
    this.ready,
    this.error,
  });

  static SuperTabLocalModels? read(Object? value) {
    if (value is! Map || value['grid'] is! String) return null;
    return SuperTabLocalModels(
      grid: value['grid'] as String,
      enabled: value['enabled'] == true,
      ready: value['ready'] is bool ? value['ready'] as bool : null,
      error: value['error'] is String ? value['error'] as String : null,
    );
  }

  final String grid;
  final bool enabled;
  final bool? ready;
  final String? error;
}

/// One model the Swarm can start Builders on now, as a machine's fresh reading says: on the Swarm's grid (`local`, a
/// member's engine; `api`, an API a member shares), usable from any machine; or shared with the machine's owner and
/// offered by them (`shared`), usable on that machine alone.
typedef SuperTabLocalModelRow = ({
  String grid,
  String model,
  String name,
  String machine,
  String kind,
});

/// Every model the Swarm can use now, once each, from the machines' fresh readings (backend `MACHINE_FRESH_MS`).
List<SuperTabLocalModelRow> superTabLocalModelRows(
  SuperTabSnapshot? snapshot, {
  required DateTime now,
  Duration freshFor = const Duration(seconds: 45),
}) {
  final local = snapshot?.localModels;
  if (local == null || !local.enabled) return const [];
  final rows = <SuperTabLocalModelRow>[];
  for (final pool in snapshot!.machines) {
    final observation = pool['observation'];
    if (observation is! Map) continue;
    final at = observation['receivedAt'];
    if (at is! num ||
        now.difference(DateTime.fromMillisecondsSinceEpoch(at.toInt())) >
            freshFor) {
      continue;
    }
    for (final m
        in observation['localModels'] is List
            ? observation['localModels'] as List
            : const []) {
      if (m is! Map || m['grid'] is! String || m['model'] is! String) continue;
      final grid = m['grid'] as String, model = m['model'] as String;
      if (rows.any((r) => r.grid == grid && r.model == model)) continue;
      rows.add((
        grid: grid,
        model: model,
        name: m['name'] is String ? m['name'] as String : model,
        machine: pool['name'] as String? ?? 'A machine',
        kind: m['kind'] is String
            ? m['kind'] as String
            : grid == local.grid
            ? 'local'
            : 'shared',
      ));
    }
  }
  return rows;
}

/// One model a machine serves on the Swarm's grid, as its last reading says.
typedef SuperTabServedModel = ({String model, String name});

/// The models [pool]'s reading says it serves on [grid]. A reading older than [freshFor] says nothing (backend
/// `MACHINE_FRESH_MS`), as the route reads it.
List<SuperTabServedModel> superTabServedModels(
  Map<String, dynamic>? pool,
  String grid, {
  required DateTime now,
  Duration freshFor = const Duration(seconds: 45),
}) {
  final observation = pool?['observation'];
  if (observation is! Map) return const [];
  final at = observation['receivedAt'];
  if (at is! num ||
      now.difference(DateTime.fromMillisecondsSinceEpoch(at.toInt())) >
          freshFor) {
    return const [];
  }
  return [
    for (final m
        in observation['localModels'] is List
            ? observation['localModels'] as List
            : const [])
      if (m is Map && m['grid'] == grid && m['model'] is String)
        (
          model: m['model'] as String,
          name: m['name'] is String
              ? m['name'] as String
              : m['model'] as String,
        ),
  ];
}

class SuperTabRouteChoice {
  const SuperTabRouteChoice(this.id, this.title);
  final String id, title;
}

/// The routing decision a Lead message reports: who got the task and why.
class SuperTabRoute {
  SuperTabRoute._(
    this.decisionId,
    this.via,
    this.p,
    this.belowFloor,
    this.why,
    this.fallback,
    this.pick,
    this.alternatives,
  );
  static SuperTabRoute? fromSource(Map<String, dynamic> s) {
    final pick = s['pick'];
    final decisionId = s['decisionId'];
    if (s['kind'] != 'route' ||
        decisionId is! String ||
        pick is! Map ||
        pick['id'] is! String ||
        pick['title'] is! String) {
      return null;
    }
    final via = s['via'];
    final why = s['why'];
    final alternatives = s['alternatives'];
    return SuperTabRoute._(
      decisionId,
      via is String ? via : 'order',
      s['p'] is num ? (s['p'] as num).toDouble() : null,
      s['belowFloor'] == true,
      why is String ? why : '',
      s['fallback'] is String ? s['fallback'] as String : null,
      SuperTabRouteChoice(pick['id'] as String, pick['title'] as String),
      [
        if (alternatives is List)
          for (final a in alternatives)
            if (a is Map && a['id'] is String && a['title'] is String)
              SuperTabRouteChoice(a['id'] as String, a['title'] as String),
      ],
    );
  }

  /// The Lead's reason for the task. Why the policy order decided, when it did,
  /// is [fallback]: `unsure` or `unavailable`.
  final String decisionId, via, why;
  final String? fallback;
  final double? p;
  final bool belowFloor;
  final SuperTabRouteChoice pick;
  final List<SuperTabRouteChoice> alternatives;
}

/// A file sent with a message. The chat never loads [url] by itself.
class SuperTabAttachment {
  SuperTabAttachment.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      name = _text(row, 'name'),
      mime = _text(row, 'mime'),
      size = (row['size'] as num).toInt(),
      url = _text(row, 'url');
  final String id, name, mime, url;
  final int size;

  /// The kinds the backend serves to be seen in place; every other kind is
  /// served as a download.
  bool get isImage => const {
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
  }.contains(mime);
}

/// A message's files. A row that does not read is left out, so one bad row
/// cannot hide the page of messages it came in.
List<SuperTabAttachment> _attachments(Object? rows) => List.unmodifiable([
  if (rows is List)
    for (final row in rows) ?_tryAttachment(row),
]);

SuperTabAttachment? _tryAttachment(Object? row) {
  try {
    return SuperTabAttachment.fromJson(superTabMap(row));
  } catch (_) {
    return null;
  }
}

/// Optional timing/hold fields keep messages from older backends readable.
class SuperTabDelivery {
  SuperTabDelivery.fromJson(Map<String, dynamic> row)
    : id = row['id'] as String?,
      agentId = row['agentId'] as String? ?? '',
      status = row['status'] as String? ?? '',
      holdReason = row['holdReason'] as String?,
      holdSince = _date(row['holdSince']),
      deliveredAt = _date(row['deliveredAt']),
      answeredAt = _date(row['answeredAt']),
      updatedAt = _date(row['updatedAt']);
  final String? id, holdReason;
  final String agentId, status;
  final DateTime? holdSince, deliveredAt, answeredAt, updatedAt;
  static DateTime? _date(Object? value) =>
      value is String ? DateTime.tryParse(value) : null;
  bool get pending => status == 'queued' || status == 'claimed';
  bool get delivered => status == 'delivered' || status == 'confirmed';

  // One line cannot promise arrival while another recipient still waits.
  int get receiptOrder => switch (status) {
    'uncertain' => 0,
    'queued' || 'claimed' => 1,
    'cancelled' => 2,
    'delivered' || 'confirmed' => 3,
    'answered' => 4,
    _ => 5,
  };
}

class SuperTabMessage {
  SuperTabMessage.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      conversationId = _text(row, 'conversationId'),
      text = _text(row, 'text'),
      replyTo = row['replyTo'] as String?,
      sequence = (row['sequence'] as num).toInt(),
      author = Map.unmodifiable(superTabMap(row['author'])),
      source = Map.unmodifiable(superTabMap(row['source'] ?? const {})),
      createdAt = DateTime.tryParse(row['createdAt'] as String? ?? ''),
      attachments = _attachments(row['attachments']),
      mentions = List.unmodifiable(
        (row['mentions'] as List?)?.whereType<String>() ?? const <String>[],
      ),
      deliveries = _list(
        row['deliveries'] ?? const [],
        (d) => Map<String, dynamic>.unmodifiable(d),
      );
  final String id, conversationId, text;
  final String? replyTo;
  final int sequence;
  final Map<String, dynamic> author;
  final Map<String, dynamic> source;
  final DateTime? createdAt;
  final List<SuperTabAttachment> attachments;

  /// The people a Lead tagged in this message, by person id.
  final List<String> mentions;
  final List<Map<String, dynamic>> deliveries;
  // Preserve the recorded identity for history and for removed agents. Views
  // with a current roster resolve the visible name through Snapshot.authorName.
  String get authorName =>
      (fromAgent ? author['displayName'] as String? : null) ??
      author['name'] as String? ??
      'Unknown';
  String get authorId => author['id'] as String? ?? '';
  bool get fromAgent => author['kind'] == 'agent';
  bool get fromTerminal => source['kind'] == 'native';
  SuperTabRoute? get route => SuperTabRoute.fromSource(source);
  bool get routeOverride => source['kind'] == 'route-override';

  /// A note the backend writes about a terminal: a Lead's typing, or an alert.
  bool get terminalEvent =>
      source['kind'] == 'terminal-input' || source['kind'] == 'terminal-alert';
  String? get terminalNote {
    if (!fromTerminal) return null;
    final phase = source['phase'];
    if (phase == 'gap') return 'Terminal recording interrupted';
    final operator =
        superTabMap(source['operator'] ?? const {})['name'] as String?;
    return phase == 'prompt' && operator != null
        ? 'Terminal input · session opened by $operator'
        : 'Terminal answer';
  }

  SuperTabDelivery? get receiptDelivery {
    final rows = deliveries.map(SuperTabDelivery.fromJson).toList();
    rows.sort((a, b) => a.receiptOrder.compareTo(b.receiptOrder));
    return rows.firstOrNull;
  }
}

/// The `remote` a daemon reports for a project: `host/owner/repo`, already
/// without credentials or transport (the CLI's `canonicalRepository`). A port
/// there may be SSH's, so only a plain host is read as an HTTPS address.
final _canonicalRemote = RegExp(
  r'^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/\S+$',
  caseSensitive: false,
);

/// A remote may contain a developer's embedded credential. Never share it.
/// Contributed machines clone this address, so a daemon's canonical remote
/// becomes the HTTPS URL that Harness's GitHub project source also clones.
String? superTabRepositoryUrl(String? remote) {
  if (remote == null || remote.isEmpty) return null;
  if (remote.startsWith('git@') && !remote.contains('://')) return remote;
  final address = _canonicalRemote.hasMatch(remote)
      ? 'https://$remote'
      : remote;
  final uri = Uri.tryParse(address);
  if (uri == null ||
      uri.host.isEmpty ||
      !['https', 'http', 'ssh', 'git'].contains(uri.scheme)) {
    return null;
  }
  if (uri.userInfo.isNotEmpty &&
      !(uri.scheme == 'ssh' && uri.userInfo == 'git')) {
    return null;
  }
  return address;
}
