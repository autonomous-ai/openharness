import 'identity.dart' show superTabPersonName;
import 'live_card_model.dart';
import 'profile_model.dart';

export 'profile_model.dart';

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

/// [rows] by id; the first row wins where two share one, as a scan would.
Map<String, T> _byId<T>(List<T> rows, String Function(T row) idOf) => {
  for (final row in rows.reversed) idOf(row): row,
};

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
      role = _text(row, 'role'),
      generation = row['generation'] as String?,
      avatar = SuperTabAvatarPicture.fromJson(row['avatar']),
      status = SuperTabPersonStatus.fromJson(row['status']),
      chosenUsername = row['username'] as String?,
      username =
          row['username'] as String? ??
          superTabDefaultUsername(_text(row, 'email'));
  SuperTabPerson._named(SuperTabPerson person, this.username)
    : id = person.id,
      email = person.email,
      role = person.role,
      generation = person.generation,
      avatar = person.avatar,
      status = person.status,
      chosenUsername = person.chosenUsername;
  final String id, email, role;
  final SuperTabAvatarPicture? avatar;
  final SuperTabPersonStatus? status;

  /// How the Swarm tags them (`@username`), as the server sends it; from an
  /// older server, their default ([superTabUsernames]). Desktop's rule.
  final String username;

  /// The name the server sent; null from a server without usernames.
  final String? chosenUsername;

  /// Their status while it lasts.
  SuperTabPersonStatus? statusAt(DateTime now) =>
      status?.shownAt(now) == true ? status : null;

  /// This membership: a new one each time the person joins the Swarm. Null
  /// from a backend that does not send it.
  final String? generation;
  bool get canWrite => role == 'owner' || role == 'collaborator';
}

/// The name an email's prefix makes: lowercased, only the characters a
/// username takes, never too short. Unnumbered; [superTabUsernames] numbers
/// it. Desktop's `superTabDefaultUsername`, byte for byte.
String superTabDefaultUsername(String email) {
  var prefix = email
      .split('@')
      .first
      .toLowerCase()
      .replaceAll(RegExp(r'[^a-z0-9._-]'), '')
      .replaceFirst(RegExp(r'^[._-]+'), '');
  if (prefix.length > 30) prefix = prefix.substring(0, 30);
  if (prefix.isEmpty) return 'user';
  return prefix.length < 2 ? '${prefix}1' : prefix;
}

/// [people], each with their username: the one the server sent, else (an
/// older server, which sends none) their email prefix numbered (`ken2`) after
/// the people before them, as Desktop names them.
List<SuperTabPerson> superTabUsernames(List<SuperTabPerson> people) {
  final taken = {for (final p in people) ?p.chosenUsername};
  return List.unmodifiable([
    for (final person in people)
      if (person.chosenUsername != null)
        person
      else
        SuperTabPerson._named(person, () {
          final root = superTabDefaultUsername(person.email);
          var name = root;
          for (var n = 2; taken.contains(name); n++) {
            name = '$root$n';
          }
          taken.add(name);
          return name;
        }()),
  ]);
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
      buddyOf = switch (row['buddyOf']) {
        {'personId': final String person} => person,
        _ => null,
      },
      // Read as the desktop does; the phone draws no thread sessions yet.
      buddySession = SuperTabBuddySessionOf.fromJson(row['buddySession']),
      limitedUntil = DateTime.tryParse(row['limitedUntil'] as String? ?? ''),
      alerting = List.unmodifiable(
        (row['alerting'] as List?)?.whereType<String>() ?? const <String>[],
      ),
      avatar = SuperTabAvatarPicture.fromJson(row['avatar']),
      downSince = DateTime.tryParse(row['downSince'] as String? ?? ''),
      workDecision = switch (row['workDecision']) {
        final String decision when _workDecisions.contains(decision) =>
          decision,
        _ => null,
      },
      confidential = row['confidential'] == true,
      configuration = Map.unmodifiable(superTabMap(row['configuration']));
  final String id, projectId, name, machineId, harnessId, contributorId;

  /// Set by its contributor or its project's Lead; null draws its pattern.
  final SuperTabAvatarPicture? avatar;

  /// Until when routing skips it: its machine saw a usage limit on its screen
  /// (spec/2026-10-23-lead-sees-agent-terminal.md). Null when none was seen.
  final DateTime? limitedUntil;

  /// What its machine is alerting about now (backend terminal.ts): `prompt`
  /// while it waits at a prompt in its terminal, gone once that is answered.
  final List<String> alerting;

  /// Since when its machine has reported its session gone, or its host confirmed a stop (backend machines.ts). Null
  /// while it runs.
  final DateTime? downSince;

  /// What its project's Lead decided once its work was over (backend
  /// model.ts `workDecision`): `awaiting` a decision, kept (`keep`) for more
  /// work, or `stop`ped. Null while it has not finished any.
  final String? workDecision;

  static const _workDecisions = {'awaiting', 'keep', 'stop'};

  /// The account whose computer runs it; a contributor may run agents on a computer another account shared with them.
  final String machineOwnerId;

  /// Its session read private chats: a Product Manager, now or before, or an agent in a private chat. Only the person
  /// whose computer runs it may watch it, but every member watches the current Product Manager, view only
  /// (backend projects.ts `watchClosed`, terminal_unavailable.dart `superTabTerminalPrivate`).
  final bool confidential;
  // Keep the legacy default for callers while allowing group-based roster ownership.
  final bool hasProjectId;
  final String? displayName;
  // Absent until the backend sends one; an agent without a role is a Builder.
  final String? role;
  final String? roleId;
  bool get isReviewer => role == 'reviewer';

  /// A person's private agent for one project (spec: Buddies, 10-28); it
  /// never takes work. The backend gives it no role, only its person.
  bool get isBuddy => buddyOf != null;

  /// The person whose Buddy it is; null for any other agent.
  final String? buddyOf;

  /// Set on a Buddy's thread session (desktop model.dart); null otherwise.
  final SuperTabBuddySessionOf? buddySession;
  final Map<String, dynamic> configuration;
  String get engine => configuration['engine'] as String? ?? '';
}

/// A thread session's thread and starting sequence (desktop model.dart).
class SuperTabBuddySessionOf {
  const SuperTabBuddySessionOf(this.thread, this.from);
  final String thread;
  final int from;

  static SuperTabBuddySessionOf? fromJson(Object? value) {
    if (value is! Map) return null;
    final json = superTabMap(value);
    final thread = json['thread'];
    if (thread is! String || thread.isEmpty) return null;
    final from = json['from'];
    return SuperTabBuddySessionOf(thread, from is num ? from.toInt() : 0);
  }
}

/// One live or starting thread session of a Buddy chat (desktop model.dart).
class SuperTabBuddySession {
  SuperTabBuddySession.fromJson(Map<String, dynamic> json)
    : thread = json['thread'] is String ? json['thread'] as String : '',
      startId = json['startId'] is String ? json['startId'] as String : '',
      agentId = json['agentId'] is String ? json['agentId'] as String : null,
      at = json['at'] is num ? (json['at'] as num).toInt() : 0;
  final String thread, startId;
  final String? agentId;
  final int at;
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
      kind = row['kind'] as String?,
      buddyOwnerId = row['buddyOwnerId'] as String?,
      buddyName = row['buddyName'] as String?,
      buddySessions = List.unmodifiable(
        (row['buddySessions'] is List ? row['buddySessions'] as List : const [])
            .whereType<Map>()
            .map((json) => SuperTabBuddySession.fromJson(superTabMap(json)))
            .where((session) => session.thread.isNotEmpty),
      ),
      number = (row['number'] as num?)?.toInt(),
      title = _text(row, 'title'),
      leadId = row['leadId'] as String?,
      agentIds = List.unmodifiable((row['agentIds'] as List).cast<String>()),
      archived = row['archived'] == true,
      dormant = row['dormant'] == true,
      // A Buddy chat names no audience: its person alone reads it.
      audience = row['kind'] == 'buddy' && row['buddyOwnerId'] is String
          ? List.unmodifiable([row['buddyOwnerId'] as String])
          : row['audience'] is Map
          ? List.unmodifiable([
              for (final person
                  in superTabMap(row['audience'])['people'] as List? ??
                      const [])
                if (person is Map && person['id'] is String) person['id'],
            ])
          : null,
      checks = _list(
        row['checks'] ?? const [],
        (check) => Map<String, dynamic>.unmodifiable(check),
      ),
      pullRequestUrls = List.unmodifiable(
        (row['pullRequestUrls'] as List?)?.whereType<String>() ??
            const <String>[],
      ),
      cards = SuperTabCards.fromJson(row['cards']),
      reviewOf = row['reviewOf'] as String?,
      brief = _text(row, 'brief'),
      task = row['task'] is Map
          ? SuperTabTask.fromJson(superTabMap(row['task']))
          : null,
      lastMessageSequence = (row['lastMessageSequence'] as num?)?.toInt() ?? 0,
      lastMainSequence = (row['lastMainSequence'] as num?)?.toInt(),
      reactionSeq = (row['reactionSeq'] as num?)?.toInt() ?? 0,
      changedAt = row['changedAt'] is num
          ? DateTime.fromMillisecondsSinceEpoch(
              (row['changedAt'] as num).toInt(),
              isUtc: true,
            )
          : null,
      assignment = row['assignment'] == null
          ? null
          : Map.unmodifiable(superTabMap(row['assignment'])),
      liveness = row['liveness'] is Map
          ? Map.unmodifiable(superTabMap(row['liveness']))
          : null,
      leadAction = row['leadAction'] is Map
          ? Map.unmodifiable(superTabMap(row['leadAction']))
          : null;
  final String id, projectId, title, brief;

  /// What the backend calls it apart from a workgroup: `leads` for the Product
  /// Managers' conversation, `buddy` for a person's chat with their Buddy.
  final String? kind;
  bool get isBuddyChat => kind == 'buddy';

  /// The person a Buddy chat belongs to; only they read it.
  final String? buddyOwnerId;

  /// The name a Buddy chat's person chose for their Buddy, kept while no
  /// Buddy runs; null for the default (backend buddies.ts renameBuddy).
  final String? buddyName;

  /// A Buddy chat's live or starting thread sessions (desktop model.dart).
  final List<SuperTabBuddySession> buddySessions;
  final SuperTabTask? task;
  final int? number;
  String get label => number == null ? title : '#$number $title';
  final String? leadId;
  final List<String> agentIds;
  final bool archived;

  /// A private conversation's people, who read it with the project's Lead
  /// and nobody else; null for a conversation the project shares.
  final List<String>? audience;

  /// Out of the Swarm's active groups: archived, or finished and quiet for a
  /// day. Read on demand; a new message brings it back.
  final bool dormant;

  /// Listed with the project's closed groups, not its active ones.
  bool get closed => archived || dormant;
  final List<Map<String, dynamic>> checks;

  /// Persisted links may be absent on older backends; loaded messages still supply links.
  final List<String> pullRequestUrls;

  /// Its messages drawn as live cards (swarm_live_card.dart); none from an
  /// older backend.
  final SuperTabCards cards;

  /// A review group's reviewed group; null for any other conversation.
  final String? reviewOf;
  final int lastMessageSequence;

  /// Its newest message in the main stream: a reply only in its thread
  /// leaves it. Null from a backend before threads, or before this
  /// conversation's first message since.
  final int? lastMainSequence;

  /// The newest message that makes it unread, as the desktop's
  /// `SuperTabController.unread` counts it: a reply only in its thread does
  /// not, as it is not in the chat.
  int get mainSequence => lastMainSequence ?? lastMessageSequence;

  /// Moves whenever a reaction here is added or taken back (backend
  /// reactions.ts): the messages shown are read again for their counts.
  final int reactionSeq;

  /// When it last changed, a message included: its part's `changedAt`,
  /// which the phone's reader adds to what it read
  /// ([SuperTabParts.groupChangedAt]), as no state names it. Null where it
  /// is not known: a state read some other way, or a Home kept from before.
  final DateTime? changedAt;
  final Map<String, dynamic>? assignment;

  /// Whether its task waits on purpose or is stuck, as the server last found
  /// it (`state`, `why`, `since`, `personId`); absent while it is working,
  /// and from older backends. Read as the desktop's model reads it
  /// (desktop_parity_test); the phone shows none of it yet.
  final Map<String, dynamic>? liveness;

  /// The Product Manager's last action on its task (`kind`, `at`); read as
  /// [liveness] is.
  final Map<String, dynamic>? leadAction;
}

class SuperTabRole {
  SuperTabRole.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      name = _text(row, 'name'),
      kind = _text(row, 'kind'),
      version = _text(row, 'version'),
      defaults = row['defaults'] is Map
          ? Map.unmodifiable(superTabMap(row['defaults']))
          : null;

  final String id, name, kind, version;

  /// The engine, model and effort its agents start on when a start names
  /// none (backend projects.ts RoleDefaults). Read and kept as the desktop's
  /// model does; the phone shows none of it.
  final Map<String, dynamic>? defaults;
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
      _memberGenerations = {
        for (final member in row['members'] as List? ?? const [])
          superTabMap(member)['id'] as String:
              superTabMap(member)['generation'] as String?,
      },
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

  /// Each member's Swarm membership when they were added: who left the Swarm
  /// and joined again is not a member until added again.
  final Map<String, String?> _memberGenerations;

  /// Whether [person] is a member at their membership now, as the server
  /// checks (`canReadProject`).
  bool hasMember(SuperTabPerson person) =>
      _memberGenerations.containsKey(person.id) &&
      _memberGenerations[person.id] == person.generation;
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
      people = superTabUsernames(_list(row['people'], SuperTabPerson.fromJson)),
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
      startEfforts = Map.unmodifiable({
        for (final start
            in row['starts'] is List ? row['starts'] as List : const [])
          if (start case {
            'harnessId': final String harness,
            'request': {'effort': final String effort},
          })
            harness: effort,
      }),
      localModels = SuperTabLocalModels.read(row['localModels']),
      mentionsWaiting = (row['mentionsWaiting'] as num?)?.toInt() ?? 0,
      mentionsDigest = row['mentionsDigest'] as String?,
      decisionsWaiting = (row['decisionsWaiting'] as num?)?.toInt() ?? 0,
      decisionsDigest = row['decisionsDigest'] as String?,
      teamAccounts = row['teamAccounts'] != false,
      readMarks = Map.unmodifiable({
        if (row['readMarks'] case final Map marks)
          for (final MapEntry(:key, :value) in marks.entries)
            if (key is String && value is num) key: value.toInt(),
      }),
      buddiesEnabled = row['buddies'] == true,
      threadMarks = Map.unmodifiable({
        if (row['threadMarks'] case final Map marks)
          for (final MapEntry(key: id, value: threads) in marks.entries)
            if (id is String && threads is Map)
              id: Map<String, int>.unmodifiable({
                for (final MapEntry(:key, :value) in threads.entries)
                  if (key is String && value is num) key: value.toInt(),
              }),
      }),
      buddyStarts = List.unmodifiable([
        for (final start
            in row['starts'] is List ? row['starts'] as List : const [])
          if (start case {'request': {'buddyOf': Map _}})
            Map<String, dynamic>.unmodifiable(superTabMap(start)),
      ]) {
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

  /// The Swarm's Buddies setting: off unless its owner turned it on, and off
  /// from a backend before Buddies.
  final bool buddiesEnabled;

  /// The starts of Buddies, oldest first: a Buddy's add is under way while
  /// its start has neither a harness nor an error.
  final List<Map<String, dynamic>> buddyStarts;
  final List<SuperTabPerson> people;
  final List<SuperTabAgent> agents;
  final List<Map<String, dynamic>> machines;
  final List<SuperTabConversation> conversations;
  late final List<SuperTabProject> projects;
  final List<Map<String, dynamic>> invitations;

  /// The effort each started agent's start asked for, by harness id. Empty where the starts are not read (a view
  /// kept on this device leaves them out).
  final Map<String, String> startEfforts;

  /// Where the projects' Product Managers talk, Swarm-wide; null in a Swarm
  /// from before it (spec 2026-10-23-leads-see-and-talk.md).
  final String? leadsConversationId;

  /// The Local models add-on, once the owner has turned it on; null before.
  final SuperTabLocalModels? localModels;

  /// The reader's tags still waiting for them, Swarm-wide; 0 from a backend
  /// before tags (spec 2026-10-24-lead-mentions.md).
  final int mentionsWaiting;

  /// Which tags wait, as a digest that moves when they change though the
  /// count may not; null from a backend before it (superTabs/mentions.ts).
  final String? mentionsDigest;

  /// Decisions asked of the reader and not yet answered, Swarm-wide; 0 from a
  /// backend before decisions (backend superTabs/decisions.ts).
  final int decisionsWaiting;

  /// Which decisions wait, as a digest that moves when they change though the
  /// count may not; null from a backend before it (superTabs/decisions.ts).
  final String? decisionsDigest;

  /// False only where the server does not try Harness Team accounts yet
  /// (backend read/contract.ts `teamAccounts`), as on the desktop.
  final bool teamAccounts;

  /// The reader's own read marks kept on the server (backend readMarks.ts): the newest message sequence read, by
  /// conversation, on any of their devices. Never another person's.
  final Map<String, int> readMarks;

  /// The reader's own thread marks kept on the server (backend readMarks.ts): by conversation, the newest message
  /// sequence read in each thread, by its root, on any of their devices. Empty from a backend before them.
  final Map<String, Map<String, int>> threadMarks;

  // Built on first use: a read is never changed, and lookups run per row on
  // every build.
  late final _conversationsById = _byId(conversations, (c) => c.id);
  late final _agentsById = _byId(agents, (a) => a.id);
  late final _projectsById = _byId(projects, (p) => p.id);
  late final _projectsByLead = <String, SuperTabProject>{
    for (final p in projects.reversed)
      ?conversation(p.leadConversationId)?.leadId: p,
  };

  SuperTabConversation? conversation(String id) => _conversationsById[id];
  SuperTabAgent? agent(String id) => _agentsById[id];
  SuperTabProject? projectById(String id) => _projectsById[id];

  SuperTabProject? projectFor(String conversationId) {
    final group = conversation(conversationId);
    return group == null ? null : projectById(group.projectId);
  }

  bool isProjectLead(String conversationId) =>
      projects.any((p) => p.leadConversationId == conversationId);

  SuperTabProject? leadProjectForAgent(String agentId) =>
      _projectsByLead[agentId];

  bool isLead(String agentId) => leadProjectForAgent(agentId) != null;

  SuperTabRole? activeRoleForAgent(SuperTabAgent agent) {
    final leadProject = leadProjectForAgent(agent.id);
    final roleKind = leadProject != null
        ? 'lead'
        : agent.isReviewer
        ? 'reviewer'
        : 'builder';
    final project = leadProject ?? projectById(agent.projectId);
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

  String agentName(String id, {String fallback = 'Agent'}) {
    final found = agent(id);
    return found?.displayName ?? found?.name ?? fallback;
  }

  /// [machineId]'s contribution to this Swarm, if it has one.
  Map<String, dynamic>? pool(String machineId) =>
      machines.where((m) => m['machineId'] == machineId).firstOrNull;

  /// The Mac a Harness Team account's pool is part of: the machine its pool names as `hostMachineId` (stamped by the
  /// backend), while that Mac is in this Swarm too, from the same person (docs/plans/2026-10-24-swarm-team-account.md).
  /// Null for every other pool, a machine used only for agents included.
  String? _macOf(Map<String, dynamic>? team) {
    final host = team?['hostMachineId'];
    if (host is! String || host == team!['machineId']) return null;
    final mac = pool(host);
    return mac != null &&
            mac['hostMachineId'] == null &&
            mac['contributorId'] == team['contributorId']
        ? host
        : null;
  }

  /// Every Harness Team account's pool in [machineId]'s row: one, or more once the account was set up again and its old
  /// pool is still listed (backend superTabs/machines.ts `teamPoolsOf`). The backend changes them with the Mac.
  List<Map<String, dynamic>> teamPoolsOf(String machineId) => [
    for (final m in machines)
      if (_macOf(m) == machineId) m,
  ];

  /// The one of them that runs teammates' work on the Mac: not being removed, and the last to report (backend
  /// superTabs/machines.ts `teamPoolOf`). Null when there is none.
  Map<String, dynamic>? teamPoolOf(String machineId) {
    num reported(Map<String, dynamic> m) => switch (m['observation']) {
      {'receivedAt': final num at} => at,
      _ => -1,
    };
    Map<String, dynamic>? best;
    for (final m in teamPoolsOf(machineId)) {
      if (m['removal'] != null) continue;
      // Removed (`harness team remove` deletes its machine): the server reads a live account never so, and the Mac is a
      // Mac without one again, which its owner can set up from its row (local Team account run, 2026-10-28).
      if (m['teamWork'] case {'code': 'TEAM_ACCOUNT_REQUIRED'}) continue;
      if (best == null || reported(m) >= reported(best)) best = m;
    }
    return best;
  }

  /// The pool whose reading [accountId] sees for the machine row [machineId]: the Mac's Harness Team account for
  /// everyone but the Mac's own contributor, since it runs their agents, also while the owner is away from the Mac; the
  /// machine's own pool otherwise. The Machines view reads a machine by this one rule.
  Map<String, dynamic>? readingPoolOf(String machineId, String? accountId) {
    final own = pool(machineId), team = teamPoolOf(machineId);
    final contributor =
        own?['contributorId'] as String? ??
        agents
            .where((a) => placeOf(a.machineId) == machineId)
            .firstOrNull
            ?.contributorId;
    return team != null && contributor != accountId ? team : own;
  }

  /// The machine [machineId] is shown as in this Swarm, one row per computer: the Mac, for its Harness Team account
  /// while that Mac is in the Swarm too; [machineId] itself otherwise.
  String placeOf(String machineId) => _macOf(pool(machineId)) ?? machineId;

  /// Whether more than one person can start work here: teammates' agents are a question only then.
  bool get hasTeammates => people.where((p) => p.role != 'viewer').length > 1;

  // Resolve the person shown in chat from the same identity as the roster.
  // Recorded labels remain the fallback for agents no longer in the Swarm.
  String authorName(SuperTabMessage message) => message.fromAgent
      ? agentName(message.authorId, fallback: message.authorName)
      : superTabPersonName(message.authorName);
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

/// Whether [pool] is a Harness Team account's: stamped with the Mac it runs on (`hostMachineId`), whether or not that
/// Mac is still in the Swarm, or read as signed in as a Team account (`sessionKind`), as the backend tells them
/// (superTabs/machines.ts).
bool superTabTeamAccountPool(Map<String, dynamic> pool) =>
    switch (pool['hostMachineId']) {
      final String host when host.isNotEmpty => true,
      _ => false,
    } ||
    switch (pool['observation']) {
      {'sessionKind': 'team'} => true,
      _ => false,
    };

/// Every model the Swarm can use now, once each, from the machines' fresh readings (backend `MACHINE_FRESH_MS`). With
/// [lentBy], only those of the machines that person lends the Swarm: never a teammate's, nor a Harness Team account's
/// ([superTabTeamAccountPool]), which runs teammates' work.
List<SuperTabLocalModelRow> superTabLocalModelRows(
  SuperTabSnapshot? snapshot, {
  required DateTime now,
  Duration freshFor = const Duration(seconds: 45),
  String? lentBy,
}) {
  final local = snapshot?.localModels;
  if (local == null || !local.enabled) return const [];
  final rows = <SuperTabLocalModelRow>[];
  for (final pool in snapshot!.machines) {
    if (lentBy != null &&
        (pool['contributorId'] != lentBy || superTabTeamAccountPool(pool))) {
      continue;
    }
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
      // Still starting (the grid does not list it yet): not usable by the Swarm now.
      if (m is! Map ||
          m['grid'] is! String ||
          m['model'] is! String ||
          m['starting'] == true) {
        continue;
      }
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
      if (m is Map &&
          m['grid'] == grid &&
          m['model'] is String &&
          m['starting'] != true)
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

/// Messages in the order a conversation shows them: by sequence, then id, as
/// the backend pages them (messages from before the parts migration can share
/// a sequence).
int superTabMessageOrder(SuperTabMessage a, SuperTabMessage b) {
  final bySequence = a.sequence.compareTo(b.sequence);
  return bySequence != 0 ? bySequence : a.id.compareTo(b.id);
}

/// Where a conversation's older history continues: the message a page ended
/// on (docs/design/2026-10-26-swarm-state-parts.md, section 4.6).
class SuperTabPage {
  const SuperTabPage(this.sequence, this.id);
  SuperTabPage.of(SuperTabMessage message) : this(message.sequence, message.id);

  /// The backend's `next`, or null at the start of the conversation.
  static SuperTabPage? read(Object? next) => switch (next) {
    {'sequence': final num sequence, 'id': final String id} => SuperTabPage(
      sequence.toInt(),
      id,
    ),
    null => null,
    _ => throw const FormatException('Invalid Swarm page.'),
  };

  final int sequence;
  final String id;
  Map<String, dynamic> toJson() => {'sequence': sequence, 'id': id};
}

/// Optional timing/hold fields keep messages from older backends readable.
class SuperTabDelivery {
  SuperTabDelivery.fromJson(Map<String, dynamic> row)
    : id = row['id'] as String?,
      agentId = row['agentId'] as String? ?? '',
      status = row['status'] as String? ?? '',
      holdReason = row['holdReason'] as String?,
      holdSince = _date(row['holdSince']),
      claimFailingSince = _date(row['claimFailingSince']),
      claimFailures = (row['claimFailures'] as num?)?.toInt(),
      deliveredAt = _date(row['deliveredAt']),
      answeredAt = _date(row['answeredAt']),
      updatedAt = _date(row['updatedAt']);
  final String? id, holdReason;
  final String agentId, status;

  /// Since when the backend's claims of this delivery fail, and how many have
  /// (prod 10-30, v1.3.71). Null from an older backend, and once a claim works.
  final DateTime? claimFailingSince;
  final int? claimFailures;
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

/// What a page says about one thread (backend threads.ts): the line under its
/// root, and who it marks unread for. Read as the desktop's model reads it
/// (desktop_parity_test); the phone draws the line, not yet who it is unread
/// for.
class SuperTabThread {
  SuperTabThread.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      replies = (row['replies'] as num).toInt(),
      lastSequence = (row['lastSequence'] as num).toInt(),
      lastAt = DateTime.tryParse(row['lastAt'] as String? ?? ''),
      authors = List.unmodifiable(
        (row['authors'] as List? ?? const []).map(superTabMap),
      ),
      people = List.unmodifiable(
        (row['people'] as List? ?? const []).whereType<String>(),
      );
  final String id;
  final int replies, lastSequence;
  final DateTime? lastAt;

  /// The newest distinct reply authors, newest first: the first wrote the
  /// last reply.
  final List<Map<String, dynamic>> authors;

  /// People who wrote in the thread or were tagged in it.
  final List<String> people;
}

class SuperTabMessage {
  SuperTabMessage.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      conversationId = _text(row, 'conversationId'),
      text = _text(row, 'text'),
      replyTo = row['replyTo'] as String?,
      thread = row['thread'] as String?,
      alsoInChat = row['alsoInChat'] == true,
      buddySession = row['buddySession'] == true,
      sequence = (row['sequence'] as num).toInt(),
      author = Map.unmodifiable(superTabMap(row['author'])),
      source = Map.unmodifiable(superTabMap(row['source'] ?? const {})),
      createdAt = DateTime.tryParse(row['createdAt'] as String? ?? ''),
      attachments = _attachments(row['attachments']),
      reactions = List.unmodifiable(
        SuperTabReactionCount.listFromJson(row['reactions']),
      ),
      mentions = List.unmodifiable(
        (row['mentions'] as List?)?.whereType<String>() ?? const <String>[],
      ),
      deliveries = _list(
        row['deliveries'] ?? const [],
        (d) => Map<String, dynamic>.unmodifiable(d),
      );
  final String id, conversationId, text;
  final String? replyTo;

  /// The root of this message's thread: its own id for a top-level message,
  /// null for one written before threads (its replies stay inline quotes).
  final String? thread;

  /// A thread reply also shown in the conversation's main stream.
  final bool alsoInChat;

  /// A reply in a Buddy thread session's thread (desktop model.dart).
  final bool buddySession;
  bool get threadReply => thread != null && thread != id;

  /// Whether the main stream lists it: a thread reply only when also sent.
  bool get inMainStream => !threadReply || alsoInChat;
  final int sequence;
  final Map<String, dynamic> author;
  final Map<String, dynamic> source;
  final DateTime? createdAt;
  final List<SuperTabAttachment> attachments;
  final List<SuperTabReactionCount> reactions;

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

  /// The person a Buddy's proposal speaks for, from the tag the server writes
  /// on it; null for every other message, whatever its text says.
  String? get proposalOwnerId =>
      source['kind'] == 'buddy-proposal' ? source['personId'] as String? : null;

  /// The agent a "waiting at a prompt" note is about; null for any other row.
  String? get promptAlertAgentId =>
      source['kind'] == 'terminal-alert' && source['alert'] == 'prompt'
      ? source['agentId'] as String?
      : null;

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
