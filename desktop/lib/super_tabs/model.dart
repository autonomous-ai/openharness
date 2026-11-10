import 'dart:convert';

import 'package:cryptography/dart.dart' show DartSha256;

import 'identity.dart' show superTabPersonName;
import 'profile_model.dart';

export 'profile_model.dart';

/// The engines a Swarm agent runs: Claude Code and Codex, and no other (backend superTabs/commands.ts `SWARM_ENGINE`).
const kSwarmEngines = {'claude', 'codex'};

/// The id the backend gives what [parts] name (superTabs/model.ts `stableId`): the first 24 hex digits of the SHA-256 of them
/// as JSON. An agent is `[machineId, harnessId]`. (A message a person sends is the same over `[tab, 'person:<account>',
/// receipt]`, which `superTabMessageId` keeps in its own text: the phone carries a copy of it, and its parity test compares
/// the two.)
String stableId(List<String> parts) => const DartSha256()
    .hashSync(utf8.encode(jsonEncode(parts)))
    .bytes
    .map((b) => b.toRadixString(16).padLeft(2, '0'))
    .join()
    .substring(0, 24);

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

/// What a project calls its coordinator when the backend names none (one from before project instructions), and
/// what every new project starts with.
const kDefaultCoordinatorName = 'Product Manager';

/// A role's compact badge: the name when it is 12 characters or fewer, else its first 11 and "…".
String superTabRoleBadge(String roleName) {
  final characters = roleName.runes.toList();
  return characters.length <= 12
      ? roleName
      : '${String.fromCharCodes(characters.take(11))}…';
}

class SuperTabPerson {
  SuperTabPerson.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      email = _text(row, 'email'),
      role = _text(row, 'role'),
      generation = row['generation'] as String?,
      joinedVia = row['joinedVia'] as String?,
      avatar = SuperTabAvatarPicture.fromJson(row['avatar']),
      chosenUsername = row['username'] as String?,
      name = switch (row['name']) {
        final String name when name.trim().isNotEmpty => name,
        _ => null,
      },
      username =
          row['username'] as String? ??
          superTabDefaultUsername(_text(row, 'email'));
  SuperTabPerson._named(SuperTabPerson person, this.username)
    : id = person.id,
      email = person.email,
      role = person.role,
      generation = person.generation,
      joinedVia = person.joinedVia,
      avatar = person.avatar,
      chosenUsername = person.chosenUsername,
      name = person.name;
  final String id, email, role;

  /// How the Swarm shows and tags them, as the server sends it, worked out in
  /// its join order. From an older server, their default
  /// ([superTabUsernames]). Their email is never shown in its place.
  final String username;

  /// The name the server sent; null from a server without usernames.
  final String? chosenUsername;

  /// The name they set for the Swarm to show ("Minh Nguyen",
  /// backend/src/superTabs/personNames.ts); null until they set one, and
  /// from an older server.
  final String? name;

  /// How the Swarm shows them: the name they set, else their username. A tag
  /// still types [username].
  String get shownName => name ?? username;
  final SuperTabAvatarPicture? avatar;

  /// This membership: a new one each time the person joins the Swarm. Null
  /// from a backend that does not send it.
  final String? generation;

  /// How they joined: `domain` when they were added automatically for their
  /// email's domain. Null otherwise and from an older server.
  final String? joinedVia;
  bool get canWrite => role == 'owner' || role == 'collaborator';
}

/// The name an email's prefix makes: lowercased, only the characters a
/// username takes, never too short. Unnumbered; [superTabUsernames] numbers it.
String superTabDefaultUsername(String email) {
  var prefix = email
      .split('@')
      .first
      .toLowerCase()
      .replaceAll(RegExp(r'[^a-z0-9._-]'), '')
      .replaceAll(RegExp(r'\.{2,}'), '.')
      .replaceFirst(RegExp(r'^[._-]+'), '');
  if (prefix.length > 30) prefix = prefix.substring(0, 30);
  // Never a dot at the end, so `@name` in a message tags them.
  prefix = prefix.replaceFirst(RegExp(r'\.+$'), '');
  if (prefix.isEmpty) return 'user';
  return prefix.length < 2 ? '${prefix}1' : prefix;
}

/// [people], each with their username: the one the server sent, else (an older
/// server, which sends none) their email prefix numbered (`ken2`) after the
/// people before them. The server works out names in its own join order and
/// sends them (backend/src/superTabs/usernames.ts), since members can arrive
/// in any order.
List<SuperTabPerson> superTabUsernames(List<SuperTabPerson> people) {
  final taken = {for (final p in people) ?p.chosenUsername};
  return [
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
  ];
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
      kind = row['kind'] as String?,
      chatId = row['chatId'] as String?,
      myAgent = row['myAgent'] as bool?,
      roleId = row['roleId'] as String?,
      roleName = row['roleName'] as String?,
      limitedUntil = DateTime.tryParse(row['limitedUntil'] as String? ?? ''),
      alerting = List.unmodifiable(
        (row['alerting'] as List?)?.whereType<String>() ?? const <String>[],
      ),
      switchRequest = row['switchRequest'] is Map
          ? Map.unmodifiable(superTabMap(row['switchRequest']))
          : null,
      gridModel = row['gridModel'] as String?,
      profileId = row['profileId'] as String?,
      avatar = SuperTabAvatarPicture.fromJson(row['avatar']),
      downSince = DateTime.tryParse(row['downSince'] as String? ?? ''),
      confidential = row['confidential'] == true,
      configuration = Map.unmodifiable(superTabMap(row['configuration']));
  final String id, projectId, name, machineId, harnessId, contributorId;

  /// What it is and where its person talks to it (backend #4116): `pm` or `regular`, and the chat it
  /// has, or none yet. An older backend sends neither.
  final String? kind, chatId;

  /// Whether it is in the reader's My agents (backend agentKind.ts inMyAgents, task #4192): an agent of theirs running on their own account and not finished. Null from an older backend.
  final bool? myAgent;

  /// Set by its contributor or its project's Lead; null draws its pattern.
  final SuperTabAvatarPicture? avatar;

  /// Until when routing skips it: its machine saw a usage limit on its screen
  /// (spec/2026-10-23-lead-sees-agent-terminal.md). Null when none was seen.
  final DateTime? limitedUntil;

  /// What its machine is alerting about now (backend terminal.ts): `prompt`
  /// while it waits at a prompt in its terminal, gone once that is answered.
  final List<String> alerting;

  /// A Product Manager's engine switch that is asked for and not yet
  /// done (backend `switchRequest`); null otherwise.
  final Map<String, dynamic>? switchRequest;

  /// The model on the Swarm's grid it runs on; null on its own subscription
  /// (backend Agent.gridModel).
  final String? gridModel;

  /// The account on its machine it runs in; `default` when none is chosen.
  /// Null until the backend reports it: the engine's default account.
  final String? profileId;

  /// Since when its machine has reported its session gone, or its host confirmed a stop (backend machines.ts). Null
  /// while it runs.
  final DateTime? downSince;

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

  /// The role the project's document gives it; null from a backend before project instructions.
  final String? roleName;

  final Map<String, dynamic> configuration;
  String get engine => configuration['engine'] as String? ?? '';
}

class SuperTabConversation {
  SuperTabConversation.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      // A group from before projects belongs to the first; a person's chat
      // with one of their own agents belongs to none: it is not a task of the
      // first project (audit #4211, finding 3).
      projectId =
          row['projectId'] as String? ??
          (row['kind'] == 'agent-chat' ? '' : 'lead'),
      kind = row['kind'] as String?,
      number = (row['number'] as num?)?.toInt(),
      title = _text(row, 'title'),
      leadId = row['leadId'] as String?,
      agentIds = List.unmodifiable((row['agentIds'] as List).cast<String>()),
      archived = row['archived'] == true,
      dormant = row['dormant'] == true,
      audience = row['audience'] is Map
          ? List.unmodifiable([
              for (final person
                  in superTabMap(row['audience'])['people'] as List? ??
                      const [])
                if (person is Map && person['id'] is String) person['id'],
            ])
          : null,
      pullRequestUrls = List.unmodifiable(
        (row['pullRequestUrls'] as List?)?.whereType<String>() ??
            const <String>[],
      ),
      lastMessageSequence = (row['lastMessageSequence'] as num?)?.toInt() ?? 0,
      lastMainSequence = (row['lastMainSequence'] as num?)?.toInt(),
      lastPersonSequence = (row['lastPersonSequence'] as num?)?.toInt() ?? 0,
      reactionSeq = (row['reactionSeq'] as num?)?.toInt() ?? 0;
  final String id, projectId, title;

  /// What the backend calls it apart from a workgroup: `agent-chat` for a
  /// person's chat with one of their agents. A `leads` one is never kept
  /// ([SuperTabSnapshot]).
  final String? kind;

  /// A person's chat with one of their own agents (backend #4116): the agent
  /// takes the message, so it needs no Lead.
  bool get isAgentChat => kind == 'agent-chat';
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

  /// Persisted links may be absent on older backends; loaded messages still supply links.
  final List<String> pullRequestUrls;

  final int lastMessageSequence;

  /// Its newest message in the main stream: a reply only in its thread
  /// leaves it. Null from a backend before threads, or before this
  /// conversation's first message since.
  final int? lastMainSequence;

  /// Its newest main-stream message from a person, not a system row (backend
  /// parts/commit.ts): what makes its sidebar row bold (#2427). 0 before a
  /// person's first message since that backend.
  final int lastPersonSequence;

  /// Counts changes to rows already sent here (backend messageEdits.ts), as
  /// its messages pages also say: a move asks for the page shown again. An
  /// edit or a delete moves it; so does a reaction, which it began counting
  /// and still does until the backend stops writing them, though Desktop draws
  /// none (that read finds nothing new). Absent, it is 0, the pages' own value
  /// then.
  final int reactionSeq;
}

/// The zone a project's day is read in when its digest names none (backend
/// superTabs/localTime.ts `DEFAULT_TIME_ZONE`).
const superTabDefaultTimeZone = 'Asia/Ho_Chi_Minh';

class SuperTabProject {
  SuperTabProject.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      name = _text(row, 'name'),
      ownerId = _text(row, 'ownerId'),
      leadConversationId = _text(row, 'leadConversationId'),
      skillMode = row['skillMode'] == 'default' ? 'default' : 'orchestration',
      coordinatorName = row['coordinatorName'] as String?,
      instructionsRevision =
          (row['instructionsRevision'] as num?)?.toInt() ?? 0,
      notesRevision = (row['notesRevision'] as num?)?.toInt() ?? 0,
      githubRevision = (row['githubRevision'] as num?)?.toInt() ?? 0,
      isPrivate = row['visibility'] == 'private',
      memberIds = [
        for (final member in row['members'] as List? ?? const [])
          superTabMap(member)['id'] as String,
      ],
      memberGenerations = {
        for (final member in row['members'] as List? ?? const [])
          superTabMap(member)['id'] as String:
              superTabMap(member)['generation'] as String?,
      },
      updateMinutes = (row['updateMinutes'] as num?)?.toInt() ?? 5,
      timeZone = switch (row['digest']) {
        {'timeZone': final String zone} when zone.isNotEmpty => zone,
        _ => superTabDefaultTimeZone,
      },
      status = SuperTabProjectStatus.read(row['status']),
      repository = row['repository'] is Map
          ? Map.unmodifiable(superTabMap(row['repository']))
          : null,
      repositoryCreation = SuperTabRepositoryCreation.read(
        row['repositoryCreation'],
      ),
      archived = row['archived'] == true;
  final String id, name, ownerId, leadConversationId;

  /// Kept read-only and out of the project list: a v3 tab's project that had messages when it was closed (backend
  /// commands.ts `project.closeTab`).
  final bool archived;

  /// The zone its day is read in, as the server reads it for the crew
  /// dispatch and the morning digest: its digest's, else
  /// [superTabDefaultTimeZone] (backend dispatch.ts `openTasks`).
  final String timeZone;

  /// Sent to the daemon unchanged as `swarmSkillMode` when an agent starts (an older CLI refuses other values).
  final String skillMode;

  /// What this project calls its coordinator; null from a backend before project instructions.
  final String? coordinatorName;
  final int instructionsRevision, notesRevision;

  /// Moves when its repository's GitHub access may have changed (someone allowed it, or the app was installed): the
  /// app reads that access again at once rather than keeping it 5 minutes. 0 from a backend before it (task #2316).
  final int githubRevision;

  /// Whether the backend keeps an instruction document for it.
  bool get hasInstructions => coordinatorName != null;
  final bool isPrivate;
  final List<String> memberIds;

  /// Each member's generation when they were added (null when the backend sent none): a member whose person now has
  /// another generation left the Swarm and came back, and is no longer in the project.
  final Map<String, String?> memberGenerations;
  final int updateMinutes;

  /// What the coordinator last said of the project's progress, shown in the
  /// status card at the top of its chat; null from an older backend and
  /// before the first report.
  final SuperTabProjectStatus? status;
  final Map<String, dynamic>? repository;

  /// Its owner's last New Repository from New Project and what GitHub's
  /// sign-in made of it (task #3374); null when none was asked, and from a
  /// backend before it.
  final SuperTabRepositoryCreation? repositoryCreation;
}

/// A new repository asked for a project (backend projects.ts
/// `RepositoryCreation`, task #1788): [at] names the ask an outcome answers.
class SuperTabRepositoryCreation {
  const SuperTabRepositoryCreation({
    required this.owner,
    required this.name,
    required this.private,
    required this.at,
    required this.state,
    this.repositoryUrl,
    this.reachable,
    this.reason,
  });

  /// Null for anything but a whole ask: the apps then show no outcome.
  static SuperTabRepositoryCreation? read(Object? value) {
    if (value is! Map) return null;
    final owner = value['owner'], name = value['name'];
    final at = value['at'], state = value['state'];
    if (owner is! String || name is! String || at is! num || state is! String) {
      return null;
    }
    return SuperTabRepositoryCreation(
      owner: owner,
      name: name,
      private: value['private'] != false,
      at: at.toInt(),
      state: state,
      repositoryUrl: switch (value['repositoryUrl']) {
        final String url => url,
        _ => null,
      },
      reachable: switch (value['reachable']) {
        final bool reachable => reachable,
        _ => null,
      },
      reason: switch (value['reason']) {
        final String reason => reason,
        _ => null,
      },
    );
  }

  final String owner, name;
  final bool private;

  /// When it was asked (ms since the epoch, the server's clock).
  final int at;

  /// `waiting`, `creating`, `created`, `taken`, `refused`, `failed` or
  /// `cancelled`.
  final String state;
  final String? repositoryUrl;

  /// Whether teammates' agents can reach it through the Harness GitHub App,
  /// once `created`.
  final bool? reachable;

  /// GitHub's reason, once `refused`.
  final String? reason;
}

/// A project's status card text: one per project, replaced by each report
/// (`project.report` with text), never posted to its chat.
class SuperTabProjectStatus {
  const SuperTabProjectStatus({required this.text, this.at, this.by});

  /// The longest text the backend keeps; a longer one is cut here too.
  static const maxText = 2000;

  /// Null for anything but a status with text: a missing or malformed field,
  /// or an empty report, shows no card.
  static SuperTabProjectStatus? read(Object? value) {
    if (value is! Map) return null;
    final text = value['text'];
    if (text is! String || text.trim().isEmpty) return null;
    final at = value['at'];
    final by = value['by'];
    return SuperTabProjectStatus(
      text: text.length > maxText ? text.substring(0, maxText) : text,
      at: at is String ? DateTime.tryParse(at) : null,
      by: by is String ? by : null,
    );
  }

  final String text;

  /// When it was written; null when the backend sent no readable time.
  final DateTime? at;

  /// The agent that wrote it.
  final String? by;
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
      _machines = _machineRows(row['machines'] ?? const []),
      // The Product Managers chat is gone (Dee, 2026-10-31): an older server
      // still sends it, by its kind or the id the head names, and no screen
      // may list or open it.
      conversations = List.unmodifiable(
        _list(
          row['conversations'],
          SuperTabConversation.fromJson,
        ).where((g) => g.kind != 'leads' && g.id != row['leadsConversationId']),
      ),
      invitations = _list(
        row['invitations'],
        (row) => Map<String, dynamic>.unmodifiable(row),
      ),
      _starts = Map.unmodifiable({
        for (final start
            in row['starts'] is List ? row['starts'] as List : const [])
          if (start case {'id': final String id})
            id: (
              harnessId: start['harnessId'] as String?,
              error: start['error'] as String?,
            ),
      }),
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
      teamAccounts = row['teamAccounts'] != false,
      removedMachines = [
        for (final id in row['removedMachines'] as List? ?? const [])
          if (id is String) id,
      ],
      autoJoin = row['autoJoin'] == true,
      chatSettings = Map.unmodifiable({
        if (row['chatSettings'] case final Map settings)
          for (final MapEntry(:key, :value) in settings.entries)
            if (key is String && value is String)
              key: SuperTabNotify.parse(value),
      }),
      readMarks = Map.unmodifiable({
        if (row['readMarks'] case final Map marks)
          for (final MapEntry(:key, :value) in marks.entries)
            if (key is String && value is num) key: value.toInt(),
      }),
      threadMarks = Map.unmodifiable({
        if (row['threadMarks'] case final Map marks)
          for (final MapEntry(key: id, value: threads) in marks.entries)
            if (id is String && threads is Map)
              id: Map<String, int>.unmodifiable({
                for (final MapEntry(:key, :value) in threads.entries)
                  if (key is String && value is num) key: value.toInt(),
              }),
      }) {
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
  List<Map<String, dynamic>> get machines => _machines;
  List<Map<String, dynamic>> _machines;

  static List<Map<String, dynamic>> _machineRows(Object? rows) =>
      _list(rows, (m) => Map<String, dynamic>.unmodifiable(m));

  /// A machine's report arrived and nothing else moved: only the machines are
  /// new, so nothing worked out from the rest of the Swarm is done again
  /// (`SuperTabController.machinesChanged` says so).
  void replaceMachines(List<Map<String, dynamic>> rows) =>
      _machines = _machineRows(rows);
  final List<SuperTabConversation> conversations;
  late final List<SuperTabProject> projects;

  /// The projects a list offers: an archived one (a v3 tab's project kept read-only, personal_projects.dart) is no
  /// longer worked in.
  late final List<SuperTabProject> listedProjects = List.unmodifiable(
    projects.where((p) => !p.archived),
  );
  final List<Map<String, dynamic>> invitations;

  /// Each agent start's outcome so far, by its id: the harness it made, or
  /// why it failed (backend AgentStart); null for a start this read does not
  /// hold.
  ({String? harnessId, String? error})? startOf(String id) => _starts[id];
  final Map<String, ({String? harnessId, String? error})> _starts;

  /// The effort each started agent's start asked for, by harness id. Empty where the starts are not read (a view
  /// kept on this device leaves them out).
  final Map<String, String> startEfforts;

  /// The Local models add-on, once the owner has turned it on; null before.
  final SuperTabLocalModels? localModels;

  /// The reader's tags still waiting for them, Swarm-wide; 0 from a backend
  /// before tags (spec 2026-10-24-lead-mentions.md).
  /// Whether this Swarm's server uses Harness Team accounts: false only where
  /// it says it does not try them yet (backend read/contract.ts `teamAccounts`).
  final bool teamAccounts;

  /// The reader's own machines they took out of this Swarm: an automatic add
  /// leaves them out (backend model.ts removedMachines). Empty from an older
  /// backend.
  final List<String> removedMachines;

  /// People at the owner's email domain are added automatically (head
  /// `autoJoin`, every member reads it): someone who leaves is not added back.
  final bool autoJoin;

  /// The reader's own notification setting by conversation (backend chatSettings.ts); a chat not listed is at
  /// [SuperTabNotify.mentions]. Never another person's.
  final Map<String, SuperTabNotify> chatSettings;

  /// The reader's own read marks kept on the server (backend readMarks.ts): the newest message sequence read, by
  /// conversation, on any of their devices. Never another person's.
  final Map<String, int> readMarks;

  /// The reader's own thread marks kept on the server (backend readMarks.ts): by conversation, the newest message
  /// sequence read in each thread, by its root, on any of their devices. Empty from a backend before them.
  final Map<String, Map<String, int>> threadMarks;
  SuperTabConversation? conversation(String id) =>
      conversations.where((c) => c.id == id).firstOrNull;
  SuperTabAgent? agent(String id) =>
      agents.where((a) => a.id == id).firstOrNull;

  SuperTabProject? projectById(String id) =>
      projects.where((p) => p.id == id).firstOrNull;

  SuperTabProject? projectFor(String conversationId) {
    final group = conversation(conversationId);
    return projects.where((p) => p.id == group?.projectId).firstOrNull;
  }

  bool isProjectLead(String conversationId) =>
      projects.any((p) => p.leadConversationId == conversationId);

  /// The agents whose terminals [conversationId] opens: a project chat's
  /// coordinator alone, whoever else an older Swarm still holds there (#2207);
  /// any other group's members.
  List<String> paneAgentIds(String conversationId) {
    final group = conversation(conversationId);
    if (group == null) return const [];
    if (!isProjectLead(conversationId)) return group.agentIds;
    final lead = group.leadId;
    return lead != null && group.agentIds.contains(lead) ? [lead] : const [];
  }

  SuperTabProject? leadProjectForAgent(String agentId) => projects
      .where((p) => conversation(p.leadConversationId)?.leadId == agentId)
      .firstOrNull;

  bool isLead(String agentId) => leadProjectForAgent(agentId) != null;

  /// [projectId]'s Product Manager, while it has one.
  SuperTabAgent? leadOf(String projectId) {
    final id = conversation(projectById(projectId)?.leadConversationId ?? '')
        ?.leadId;
    return id == null ? null : agent(id);
  }

  /// Whether [accountId] may switch [projectId]'s Product Manager: the project's
  /// owner, or the owner of the machine it runs on (the backend decides again).
  bool maySwitchLead(String projectId, String? accountId) {
    final lead = leadOf(projectId);
    return lead != null &&
        accountId != null &&
        (projectById(projectId)?.ownerId == accountId ||
            lead.machineOwnerId == accountId);
  }

  /// What [projectId] calls its coordinator: its `coordinatorName`, or [kDefaultCoordinatorName] from a backend
  /// that names none.
  String coordinatorNameOf(String projectId) =>
      projectById(projectId)?.coordinatorName ?? kDefaultCoordinatorName;

  /// The role [agentId] goes by, and its badge: the role the project's document gives it, or, from a backend before
  /// project instructions, its kind's (Product Manager/PM, Reviewer/Rev, Engineer/Dev). Null for an unknown agent.
  ({String name, String badge})? roleOf(String agentId) {
    final agent = this.agent(agentId);
    if (agent == null) return null;
    final name = agent.roleName?.trim() ?? '';
    if (name.isNotEmpty) return (name: name, badge: superTabRoleBadge(name));
    if (isLead(agentId)) return (name: 'Product Manager', badge: 'PM');
    if (agent.role == 'reviewer') return (name: 'Reviewer', badge: 'Rev');
    return (name: 'Engineer', badge: 'Dev');
  }

  String? leadProtectionReason(String agentId) {
    final project = leadProjectForAgent(agentId);
    if (project == null) return null;
    return '${agentName(agentId)} is the ${coordinatorNameOf(project.id)} of project ${project.name}. Delete the project first.';
  }

  /// The person [personId] by the name the Swarm shows: their username; null for someone not in it.
  String? usernameOf(String personId) =>
      people.where((p) => p.id == personId).firstOrNull?.username;

  String agentName(String id, {String fallback = 'Agent'}) =>
      agent(id)?.displayName ?? agent(id)?.name ?? fallback;

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

  // Resolve the person shown in chat from the same identity as the roster.
  // Recorded labels remain the fallback for agents no longer in the Swarm.
  String authorName(SuperTabMessage message) => message.fromAgent
      ? agentName(message.authorId, fallback: message.authorName)
      : people.where((p) => p.id == message.authorId).firstOrNull?.shownName ??
            superTabPersonName(message.authorName);
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

/// One model a machine of the Swarm serves, as its reading says: on the Swarm's grid (`local`, a member's engine;
/// `api`, an API a member shares), usable from any machine; or shared with the machine's owner and offered by them
/// (`shared`), usable on that machine alone.
typedef SuperTabLocalModelRow = ({
  String grid,
  String model,
  String name,
  String machineId,
  String machine,
  String kind,
});

/// Every model the Swarm's machines serve now, once per machine, from their fresh readings (backend
/// `MACHINE_FRESH_MS`); with [freshFor] null, from readings of any age.
List<SuperTabLocalModelRow> superTabLocalModelRows(
  SuperTabSnapshot? snapshot, {
  required DateTime now,
  Duration? freshFor = const Duration(seconds: 45),
}) {
  final local = snapshot?.localModels;
  if (local == null || !local.enabled) return const [];
  final rows = <SuperTabLocalModelRow>[];
  for (final pool in snapshot!.machines) {
    final observation = pool['observation'];
    if (observation is! Map) continue;
    final at = observation['receivedAt'];
    if (at is! num ||
        (freshFor != null &&
            now.difference(DateTime.fromMillisecondsSinceEpoch(at.toInt())) >
                freshFor)) {
      continue;
    }
    final machineId = pool['machineId'] as String? ?? '';
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
      if (rows.any(
        (r) => r.machineId == machineId && r.grid == grid && r.model == model,
      )) {
        continue;
      }
      rows.add((
        grid: grid,
        model: model,
        name: m['name'] is String ? m['name'] as String : model,
        machineId: machineId,
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

/// One account of a machine as its report lists it (backend
/// `observation.profiles`): opaque id, a label with no path or email, and what
/// is left of its allowance when known.
typedef SuperTabProfile = ({
  String engine,
  String id,
  String label,
  int? leftPercent,
  DateTime? resetsAt,
});

/// The accounts [pool] reports; empty from a machine that reports none.
List<SuperTabProfile> superTabProfilesOf(Map<String, dynamic>? pool) {
  final observation = pool?['observation'];
  final rows = observation is Map ? observation['profiles'] : null;
  return [
    for (final p in rows is List ? rows : const [])
      if (p is Map &&
          p['engine'] is String &&
          p['id'] is String &&
          p['label'] is String)
        (
          engine: p['engine'] as String,
          id: p['id'] as String,
          label: p['label'] as String,
          leftPercent: (p['leftPercent'] as num?)?.toInt(),
          resetsAt: DateTime.tryParse(p['resetsAt'] as String? ?? ''),
        ),
  ];
}

/// A file sent with a message. The chat never loads [url] by itself.
class SuperTabAttachment {
  SuperTabAttachment.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      name = _text(row, 'name'),
      mime = _text(row, 'mime'),
      size = (row['size'] as num).toInt(),
      url = _text(row, 'url'),
      // Read defensively: a field of the wrong type reads as absent, never as
      // a failed row.
      link = row['link'] is String ? row['link'] as String : null,
      unlinked = row['unlinked'] == true,
      expiresAt = row['expiresAt'] is num
          ? (row['expiresAt'] as num).toInt()
          : null,
      voice = SuperTabVoice.read(row['voice']),
      width = _positive(row['width']),
      height = _positive(row['height']),
      thumb = SuperTabThumb.read(row['thumb']);

  /// [url] is the address the file was stored with, on the attachments CDN:
  /// what an older server hands out, and what stops opening once the bucket
  /// is private.
  final String id, name, mime, url;
  final int size;

  /// A short-lived signed link to the file (backend fileLinks.ts), made for
  /// this read; null from an older server, or when none could be signed.
  /// Opened in place of [url] whenever there is one.
  final String? link;

  /// The server could not sign a link this time: [url] is never opened then,
  /// a fresh link is asked for first (it may sign now).
  final bool unlinked;

  /// When [link] stops opening, in epoch milliseconds.
  final int? expiresAt;

  /// The clip's facts when this file is a voice message (backend
  /// superTabs/voiceMessages.ts); null for any other file, and from an older
  /// server.
  final SuperTabVoice? voice;

  /// A picture's size as it is shown, and the small copy the server made of
  /// it at upload (backend superTabs/thumbnails.ts): a chat draws [thumb] and
  /// the full-screen viewer opens the original. Null for any other file, a
  /// picture sent before thumbnails, and from an older server.
  final int? width, height;
  final SuperTabThumb? thumb;

  /// The kinds the backend serves to be seen in place; every other kind is
  /// served as a download.
  bool get isImage => const {
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
  }.contains(mime);
}

int? _positive(Object? value) =>
    value is num && value == value.toInt() && value > 0 ? value.toInt() : null;

/// The thumbnail of a picture: linked in the same read as the original, so
/// whoever may open the original may open it and nobody else.
class SuperTabThumb {
  const SuperTabThumb({
    required this.url,
    required this.width,
    required this.height,
    required this.size,
    this.link,
    this.expiresAt,
    this.unlinked = false,
  });

  /// [row] as a thumbnail, or null when any part of it does not read: the
  /// picture is then drawn from the original.
  static SuperTabThumb? read(Object? row) {
    if (row is! Map) return null;
    final width = _positive(row['width']),
        height = _positive(row['height']),
        size = _positive(row['size']);
    if (row['url'] is! String ||
        width == null ||
        height == null ||
        size == null) {
      return null;
    }
    return SuperTabThumb(
      url: row['url'] as String,
      width: width,
      height: height,
      size: size,
      link: row['link'] is String ? row['link'] as String : null,
      expiresAt: row['expiresAt'] is num
          ? (row['expiresAt'] as num).toInt()
          : null,
      unlinked: row['unlinked'] == true,
    );
  }

  final String url;
  final int width, height, size;

  /// Its short-lived signed link, as [SuperTabAttachment.link] is the original's.
  final String? link;
  final int? expiresAt;

  /// The server could not sign it this time: the original is drawn.
  final bool unlinked;
}

/// A voice message's clip, as the server read it once before it was sent:
/// its words are the message's text.
class SuperTabVoice {
  const SuperTabVoice({
    required this.durationMs,
    required this.waveform,
    required this.transcribed,
    this.failure,
  });

  /// [row] as a clip, or null when any part of it does not read: the file is
  /// still shown, as an ordinary file.
  static SuperTabVoice? read(Object? row) {
    if (row is! Map) return null;
    final duration = row['durationMs'], bars = row['waveform'];
    final transcribed = row['transcribed'], failure = row['failure'];
    if (duration is! num ||
        duration < 0 ||
        bars is! List ||
        !bars.every((bar) => bar is num) ||
        transcribed is! bool) {
      return null;
    }
    return SuperTabVoice(
      durationMs: duration.toInt(),
      waveform: List.unmodifiable([
        for (final bar in bars.cast<num>()) bar.toInt().clamp(0, barMax),
      ]),
      transcribed: transcribed,
      failure: failure is String ? failure : null,
    );
  }

  /// The tallest bar of [waveform].
  static const barMax = 31;

  final int durationMs;

  /// The clip's loudness in bars, each 0 to [barMax].
  final List<int> waveform;

  /// Whether the message's text is the clip's words.
  final bool transcribed;

  /// Why it has no words: `limit` (the sender's daily voice quota was used)
  /// or `failed`.
  final String? failure;

  Duration get length => Duration(milliseconds: durationMs);
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

  // One line cannot promise arrival while another recipient still waits, and
  // one agent's cancelled copy is no Not sent while another got the message
  // (10-30): Not sent only when no recipient got it.
  int get receiptOrder => switch (status) {
    'uncertain' => 0,
    'queued' || 'claimed' => 1,
    'delivered' || 'confirmed' => 2,
    'answered' => 3,
    'cancelled' => 4,
    _ => 5,
  };
}

/// What a page says about one thread (backend threads.ts): the line under its
/// root, and who it marks unread for.
class SuperTabThread {
  SuperTabThread.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      ask = row['ask'] as String?,
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

  /// Where the ask at its root stands (backend threads.ts).
  final String? ask;
  final int replies, lastSequence;
  final DateTime? lastAt;

  /// What its root's row says after the time: a Buddy's proposal nobody has
  /// answered yet; null for any other message. A task's state is no tag: its
  /// agent reacts 👀 and ✅ on the row instead (anh Dee, 11-04, task #2925),
  /// so an older server's On it and Shipped draw nothing.
  String? get askTag => ask == 'proposal' ? '✋ Proposal' : null;

  /// The newest distinct reply authors, newest first: the first wrote the
  /// last reply.
  final List<Map<String, dynamic>> authors;

  /// People who wrote in the thread or were tagged in it.
  final List<String> people;
}

/// The source kinds of a task's root in the project chat.
const _taskRootKinds = {'task-line', 'buddy-proposal'};

/// What a task's root posted before #2867 reads ahead of its title. Stored rows
/// keep it, so this stays for as long as rows from before 2026-11-04 are kept.
const _oldTaskRootPrefix = "Let's build: ";

String _messageText(Map<String, dynamic> row) {
  final text = _text(row, 'text');
  return _taskRootKinds.contains(
            superTabMap(row['source'] ?? const {})['kind'],
          ) &&
          text.startsWith(_oldTaskRootPrefix)
      ? text.substring(_oldTaskRootPrefix.length)
      : text;
}

class SuperTabMessage {
  SuperTabMessage.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      conversationId = _text(row, 'conversationId'),
      text = _messageText(row),
      replyTo = row['replyTo'] as String?,
      thread = row['thread'] as String?,
      alsoInChat = row['alsoInChat'] == true,
      sequence = (row['sequence'] as num).toInt(),
      author = Map.unmodifiable(superTabMap(row['author'])),
      source = Map.unmodifiable(superTabMap(row['source'] ?? const {})),
      createdAt = DateTime.tryParse(row['createdAt'] as String? ?? ''),
      editedAt = DateTime.tryParse(row['editedAt'] as String? ?? ''),
      deletedAt = DateTime.tryParse(row['deletedAt'] as String? ?? ''),
      attachments = _attachments(row['attachments']),
      mentions = List.unmodifiable(
        (row['mentions'] as List?)?.whereType<String>() ?? const <String>[],
      ),
      recipientIds = List.unmodifiable(
        (row['recipientIds'] as List?)?.whereType<String>() ?? const <String>[],
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

  bool get threadReply => thread != null && thread != id;

  /// Whether the main stream lists it: a thread reply only when also sent.
  bool get inMainStream => !threadReply || alsoInChat;
  final int sequence;
  final Map<String, dynamic> author;
  final Map<String, dynamic> source;
  final DateTime? createdAt;

  /// When its author last changed its text, as the backend's `message.edit`
  /// records it; null for one never edited.
  final DateTime? editedAt;

  /// When its author deleted it. Only a message with replies is still read
  /// after that: its tombstone, which keeps its thread.
  final DateTime? deletedAt;
  bool get deleted => deletedAt != null;
  final List<SuperTabAttachment> attachments;

  /// The people a Lead tagged in this message, by person id.
  final List<String> mentions;

  /// The agents it was sent to (backend `recipientIds`): the ones its words name, with `--to`, or `@Name`. Empty for a post
  /// that names nobody, and from a backend that does not send them.
  final List<String> recipientIds;

  /// An agent's post that is to other agents: Swarm v4's channel draws it on its own row, as talk (its name over `@Juno`). It reads the
  /// message alone, so a roster that changes regroups no row.
  bool get namesAgents => fromAgent && recipientIds.isNotEmpty;
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

  /// What was typed into an agent's terminal, a scheduled prompt too: no chat
  /// row and nothing unread (Ken 11-04, task #2849). Its answer still is one.
  bool get terminalPrompt => fromTerminal && source['phase'] == 'prompt';

  /// A terminal's recording gap: no chat row and nothing unread, since it gives
  /// a person nothing to do (Dee 11-05, task #3127). The server keeps it for
  /// diagnosis, and a required recovery still reaches the coordinator.
  bool get terminalGap => fromTerminal && source['phase'] == 'gap';

  /// A task's root the server posted in its person's name (plain chat, #2294):
  /// theirs to read, not their own writing, so it reads nothing before it and
  /// is unread for them as anyone else's message is.
  bool get postedForAuthor => _taskRootKinds.contains(source['kind']);

  /// The agent a "waiting at a prompt" note is about; null for any other row.
  String? get promptAlertAgentId =>
      source['kind'] == 'terminal-alert' && source['alert'] == 'prompt'
      ? source['agentId'] as String?
      : null;

  /// The Product Manager a usage-limit note is about; null for any other row.
  String? get leadLimitAgentId =>
      source['kind'] == 'terminal-alert' &&
          source['alert'] == 'limit' &&
          source['lead'] == true
      ? source['agentId'] as String?
      : null;

  /// A note the backend writes about a terminal: a Lead's typing, or an alert.
  bool get terminalEvent =>
      source['kind'] == 'terminal-input' || source['kind'] == 'terminal-alert';

  /// A line the backend posted for an instructions save: no chat row and
  /// nothing unread, since it gives a person nothing to do (Dee 11-05, task
  /// #3165). The backend posts none since #3132; the History keeps every
  /// revision.
  bool get instructionsSave => source['kind'] == 'instructions';

  /// A line the chat draws as its own row, with no sender's header (view.dart):
  /// a message after it has no header to join (Diego, #2547).
  bool get drawsOwnRow => terminalEvent;
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

/// A person's notification setting for one chat, as Slack's channel settings: every new message, only tags of
/// them (the default, what Desktop did before), or muted: greyed, never bold, never counting.
enum SuperTabNotify {
  all,
  mentions,
  muted;

  static SuperTabNotify parse(String? value) => switch (value) {
    'all' => all,
    'muted' => muted,
    _ => mentions,
  };
}
