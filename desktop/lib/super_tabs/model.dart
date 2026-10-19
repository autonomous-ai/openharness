/// Backend records are independent of the desktop's visible panes and tab layout.
Map<String, dynamic> superTabMap(Object? value) => value is Map
    ? Map<String, dynamic>.from(value)
    : throw const FormatException('Invalid Super Tab response.');

String _text(Map<String, dynamic> value, String key) => value[key] is String
    ? value[key] as String
    : throw FormatException('Missing Super Tab $key.');

List<T> _list<T>(Object? value, T Function(Map<String, dynamic>) read) =>
    value is List
    ? List.unmodifiable(value.map((row) => read(superTabMap(row))))
    : throw const FormatException('Invalid Super Tab list.');

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
      name = _text(row, 'name'),
      machineId = _text(row, 'machineId'),
      harnessId = _text(row, 'harnessId'),
      contributorId = _text(row, 'contributorId'),
      configuration = Map.unmodifiable(superTabMap(row['configuration']));
  final String id, name, machineId, harnessId, contributorId;
  final Map<String, dynamic> configuration;
  String get engine => configuration['engine'] as String? ?? '';
}

class SuperTabConversation {
  SuperTabConversation.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
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
  final String id, title, brief;
  final String? leadId;
  final List<String> agentIds;
  final bool archived;
  final List<Map<String, dynamic>> checks;
  final int lastMessageSequence;
  final Map<String, dynamic>? assignment;
}

class SuperTabSnapshot {
  SuperTabSnapshot.fromJson(Map<String, dynamic> row)
    : id = _text(row, 'id'),
      name = _text(row, 'name'),
      ownerId = _text(row, 'ownerId'),
      paused = row['paused'] == true,
      people = _list(row['people'], SuperTabPerson.fromJson),
      agents = _list(row['agents'], SuperTabAgent.fromJson),
      conversations = _list(
        row['conversations'],
        SuperTabConversation.fromJson,
      ),
      invitations = _list(
        row['invitations'],
        (row) => Map<String, dynamic>.unmodifiable(row),
      ) {
    if (row['version'] != 1) {
      throw const FormatException('Update Harness to open this Super Tab.');
    }
  }
  final String id, name, ownerId;
  final bool paused;
  final List<SuperTabPerson> people;
  final List<SuperTabAgent> agents;
  final List<SuperTabConversation> conversations;
  final List<Map<String, dynamic>> invitations;
  SuperTabConversation? conversation(String id) =>
      conversations.where((c) => c.id == id).firstOrNull;
  SuperTabAgent? agent(String id) =>
      agents.where((a) => a.id == id).firstOrNull;

  bool isLead(String agentId) => conversation('lead')?.leadId == agentId;

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
      );
  final String id, conversationId, text;
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
