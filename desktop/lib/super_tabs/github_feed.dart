import 'dart:convert';

import 'github_pulls.dart';

/// What a project's agents did on GitHub that its channel shows (Swarm v4, anh Dee 2026-11-09: "i dont see any agent to agent
/// chat"): a comment they signed on an issue or a pull request ("Pip, 14:05: ..."), a pull request they opened or that was
/// merged, a task labelled `builder:<name>` for them.
enum SwarmFeedKind { comment, opened, merged, task }

/// One of them, as GitHub told it and before it is matched to the agent it is by: that needs the Swarm's agents as they are
/// when it is drawn.
class SwarmFeedEvent {
  const SwarmFeedEvent({
    required this.id,
    required this.kind,
    required this.time,
    required this.number,
    required this.pull,
    required this.url,
    required this.text,
    this.login = '',
    this.association = '',
    this.by,
  });

  /// Unique in its repository: `comment:<id>`, `pull:<number>:opened`, `task:<event id>`.
  final String id;
  final SwarmFeedKind kind;
  final DateTime time;

  /// The issue's or pull request's number.
  final int number;

  /// Whether [number] is a pull request.
  final bool pull;

  /// Its page on GitHub.
  final String url;

  /// A comment's words; a pull request's or a task's title.
  final String text;

  /// Who wrote a comment on GitHub, and how GitHub marks them there.
  final String login, association;

  /// For a pull request or a task, whose it is by its builder label or its branch (`pip`); null when it names no one.
  final String? by;
}

/// One row of a feed, what it tells and when it sorts. A row that tells nothing (a stranger's comment, an event that is not a
/// label) is kept all the same: where a feed has been read back to is the oldest row it holds.
class SwarmFeedRow {
  const SwarmFeedRow(this.id, this.sortTime, [this.events = const []]);

  final String id;
  final DateTime sortTime;
  final List<SwarmFeedEvent> events;
}

/// The three lists of a repository's GitHub that tell what its agents do, newest first, a page of [perPage] rows at a time. Each
/// is read with `gh api` and the last answer's ETag: an unchanged list is a 304, which GitHub does not count against the rate
/// limit (the daemon reads the same lists to wake an agent, cli superTabs/githubMentions.ts). A `gh` call is a process: about
/// 0.13 s of CPU measured on a Mac under load, so the lists that change least are read least.
enum SwarmFeed {
  /// Comments on issues and on pull requests, by when they were written: the agents' talk, read each round.
  comments('issues/comments?sort=created&direction=desc', 1),

  /// Pull requests, by when they last changed (one opened or merged has just changed): read every third round.
  pulls('pulls?state=all&sort=updated&direction=desc', 3),

  /// What happened to issues and pull requests, where a label is put on: read every third round.
  labels('issues/events', 3);

  const SwarmFeed(this._path, this.every);

  final String _path;

  /// How many rounds pass between two reads of it.
  final int every;

  /// How many rows one read brings.
  static const perPage = 50;

  /// A comment is kept up to this many characters, as the relay hands one on (backend githubRelay.ts).
  static const textMax = 4000;

  /// The path of [page] of this feed, under `repos/<owner>/<name>/`.
  String path(int page) =>
      '$_path${_path.contains('?') ? '&' : '?'}per_page=$perPage&page=$page';

  /// The rows of one answer of this feed, in the order GitHub sent them; what is not a whole row is left out.
  List<SwarmFeedRow> read(String body) {
    final Object? json;
    try {
      json = jsonDecode(body);
    } on FormatException {
      return const [];
    }
    if (json is! List) return const [];
    final read = switch (this) {
      SwarmFeed.comments => _comment,
      SwarmFeed.pulls => _pull,
      SwarmFeed.labels => _label,
    };
    return [for (final row in json) ?read(row)];
  }

  /// Who may be an agent's: the repository's people, as GitHub marks each comment and pull request. Anyone may comment on a
  /// public repository, and a stranger who signs a comment "Pip," is not Pip.
  static const _team = {'OWNER', 'MEMBER', 'COLLABORATOR'};

  static SwarmFeedRow? _comment(Object? json) {
    if (json is! Map) return null;
    final id = json['id'], url = json['html_url'], issue = json['issue_url'];
    final body = json['body'], time = _time(json['created_at']);
    final number = issue is String ? int.tryParse(issue.split('/').last) : null;
    final association = json['author_association'];
    if (id is! int ||
        url is! String ||
        body is! String ||
        time == null ||
        number == null) {
      return null;
    }
    return SwarmFeedRow('comment:$id', time, [
      if (_team.contains(association))
        SwarmFeedEvent(
          id: 'comment:$id',
          kind: SwarmFeedKind.comment,
          time: time,
          number: number,
          pull: url.contains('/pull/'),
          url: url,
          text: body.length > textMax
              ? '${body.substring(0, textMax - 1)}…'
              : body,
          login: _login(json['user']),
          association: association as String,
        ),
    ]);
  }

  static SwarmFeedRow? _pull(Object? json) {
    if (json is! Map) return null;
    final number = json['number'], title = json['title'];
    final url = json['html_url'], opened = _time(json['created_at']);
    final changed = _time(json['updated_at']);
    if (number is! int ||
        title is! String ||
        url is! String ||
        opened == null ||
        changed == null) {
      return null;
    }
    final labels = [
      for (final label in json['labels'] is List ? json['labels'] as List : [])
        if (label is Map && label['name'] is String) label['name'] as String,
    ];
    final head = json['head'];
    final branch = head is Map && head['ref'] is String
        ? head['ref'] as String
        : '';
    final by = SwarmPull.authorOf(labels, branch);
    final association = json['author_association'];
    SwarmFeedEvent event(SwarmFeedKind kind, DateTime at) => SwarmFeedEvent(
      id: 'pull:$number:${kind.name}',
      kind: kind,
      time: at,
      number: number,
      pull: true,
      url: url,
      text: title,
      login: _login(json['user']),
      association: association is String ? association : '',
      by: by,
    );
    final merged = _time(json['merged_at']);
    return SwarmFeedRow('pull:$number', changed, [
      if (by != null && _team.contains(association)) ...[
        event(SwarmFeedKind.opened, opened),
        if (merged != null) event(SwarmFeedKind.merged, merged),
      ],
    ]);
  }

  static SwarmFeedRow? _label(Object? json) {
    if (json is! Map) return null;
    final id = json['id'], time = _time(json['created_at']);
    if (id is! int || time == null) return null;
    final label = json['label'], issue = json['issue'];
    final name = label is Map ? label['name'] : null;
    final number = issue is Map ? issue['number'] : null;
    final title = issue is Map ? issue['title'] : null;
    final url = issue is Map ? issue['html_url'] : null;
    final task =
        json['event'] == 'labeled' &&
        name is String &&
        name.startsWith('builder:') &&
        name.length > 8 &&
        number is int &&
        title is String &&
        url is String &&
        issue is Map &&
        issue['pull_request'] == null;
    return SwarmFeedRow('task:$id', time, [
      if (task)
        SwarmFeedEvent(
          id: 'task:$id',
          kind: SwarmFeedKind.task,
          time: time,
          number: number,
          pull: false,
          url: url,
          text: title,
          by: name.substring(8).toLowerCase(),
        ),
    ]);
  }

  static DateTime? _time(Object? value) =>
      value is String ? DateTime.tryParse(value) : null;

  static String _login(Object? user) =>
      user is Map && user['login'] is String ? user['login'] as String : '';
}
