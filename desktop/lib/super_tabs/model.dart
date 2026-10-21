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
      projectId = row['projectId'] as String? ?? 'lead',
      name = _text(row, 'name'),
      machineId = _text(row, 'machineId'),
      harnessId = _text(row, 'harnessId'),
      contributorId = _text(row, 'contributorId'),
      configuration = Map.unmodifiable(superTabMap(row['configuration']));
  final String id, projectId, name, machineId, harnessId, contributorId;
  final Map<String, dynamic> configuration;
  String get engine => configuration['engine'] as String? ?? '';
}

class SuperTabConversation {
  SuperTabConversation.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      projectId = row['projectId'] as String? ?? 'lead',
      number = (row['number'] as num?)?.toInt(),
      title = _text(row, 'title'),
      leadId = row['leadId'] as String?,
      agentIds = List.unmodifiable((row['agentIds'] as List).cast<String>()),
      archived = row['archived'] == true,
      checks = _list(
        row['checks'] ?? const [],
        (check) => Map<String, dynamic>.unmodifiable(check),
      ),
      brief = _text(row, 'brief'),
      lastMessageSequence = (row['lastMessageSequence'] as num?)?.toInt() ?? 0,
      assignment = row['assignment'] == null
          ? null
          : Map.unmodifiable(superTabMap(row['assignment']));
  final String id, projectId, title, brief;
  final int? number;
  String get label => number == null ? title : '#$number $title';
  final String? leadId;
  final List<String> agentIds;
  final bool archived;
  final List<Map<String, dynamic>> checks;
  final int lastMessageSequence;
  final Map<String, dynamic>? assignment;
}

class SuperTabProject {
  SuperTabProject.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      name = _text(row, 'name'),
      ownerId = _text(row, 'ownerId'),
      leadConversationId = _text(row, 'leadConversationId'),
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
      ) {
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

  bool isLead(String agentId) => projects.any(
    (p) => conversation(p.leadConversationId)?.leadId == agentId,
  );

  String agentName(String id, {String fallback = 'Agent'}) =>
      isLead(id) ? 'Lead' : agent(id)?.name ?? fallback;

  String authorName(SuperTabMessage message) =>
      message.fromAgent && isLead(message.authorId)
      ? 'Lead'
      : message.authorName;
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

/// An image sent with a message. A message read never carries its bytes;
/// they are read in [parts] (SuperTabController.attachmentBytes).
class SuperTabAttachment {
  SuperTabAttachment.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      name = _text(row, 'name'),
      mime = _text(row, 'mime'),
      size = (row['size'] as num).toInt(),
      width = (row['width'] as num?)?.toInt(),
      height = (row['height'] as num?)?.toInt(),
      parts = (row['parts'] as num).toInt();
  final String id, name, mime;
  final int size, parts;
  final int? width, height;
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
      deliveries = _list(
        row['deliveries'] ?? const [],
        (d) => Map<String, dynamic>.unmodifiable(d),
      ),
      attachments = _list(
        row['attachments'] ?? const [],
        SuperTabAttachment.fromJson,
      );
  final String id, conversationId, text;
  final List<SuperTabAttachment> attachments;

  /// One line for a quote of it: its text, or what it carries when it is
  /// only images.
  String get preview => shownText.trim().isNotEmpty || attachments.isEmpty
      ? shownText
      : attachments.length == 1
      ? 'Image'
      : '${attachments.length} images';

  /// The text to draw beside its images. A message of images alone is stored
  /// with `[image]` or `[N images]` (backend attachments.ts
  /// `imagesPlaceholder`) for clients that cannot show them; this one does.
  String get shownText =>
      attachments.isNotEmpty &&
          text ==
              (attachments.length == 1
                  ? '[image]'
                  : '[${attachments.length} images]')
      ? ''
      : text;
  final String? replyTo;
  final int sequence;
  final Map<String, dynamic> author;
  final Map<String, dynamic> source;
  final DateTime? createdAt;
  final List<Map<String, dynamic>> deliveries;
  String get authorName => author['name'] as String? ?? 'Unknown';
  String get authorId => author['id'] as String? ?? '';
  bool get fromAgent => author['kind'] == 'agent';
  bool get fromTerminal => source['kind'] == 'native';
  SuperTabRoute? get route => SuperTabRoute.fromSource(source);
  bool get routeOverride => source['kind'] == 'route-override';
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

  bool get queued => deliveries.any(
    (d) => d['status'] == 'queued' || d['status'] == 'claimed',
  );
  bool get uncertain => deliveries.any((d) => d['status'] == 'uncertain');
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
