import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/pull_request_status.dart';
import '../core/open_in_browser.dart';
import '../shared/theme/pull_request_icon.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'pull_request_entry.dart';
import '../shared/theme/app_icons.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'model.dart';

List<Uri> superTabPullRequestLinks(String text) => {
  for (final match in RegExp(
    r'https://github\.com/([A-Za-z0-9_-]+)/([A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)\b',
  ).allMatches(text))
    if (int.tryParse(match.group(3)!) case final number?
        when number <= 9007199254740991)
      Uri.parse(match.group(0)!),
}.toList();

class SuperTabPullRequestLinks extends StatelessWidget {
  const SuperTabPullRequestLinks(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) {
    final links = superTabPullRequestLinks(text);
    if (links.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Wrap(
        spacing: 8,
        runSpacing: 6,
        children: [
          for (final link in links.take(4))
            OutlinedButton.icon(
              onPressed: () => unawaited(
                launchUrl(link, mode: LaunchMode.externalApplication),
              ),
              icon: const Icon(AppIcons.externalLink, size: 14),
              label: Text(
                '${link.pathSegments[1]} · PR #${link.pathSegments[3]}',
              ),
            ),
        ],
      ),
    );
  }
}

/// Linked URLs are read by the viewer's computer, independently of the agents' branches.
class SuperTabPullRequests extends StatefulWidget {
  const SuperTabPullRequests({
    super.key,
    required this.controller,
    this.app,
    this.read,
    this.visible = true,
    this.now = DateTime.now,
  });
  final SuperTabController controller;
  final AppNotifier? app;
  final Future<Map<String, dynamic>> Function(List<String>)? read;
  final bool visible;
  final DateTime Function() now;
  @override
  State<SuperTabPullRequests> createState() => _SuperTabPullRequestsState();
}

class _SuperTabPullRequestsState extends State<SuperTabPullRequests> {
  final _entries = <String, SuperTabPullRequestEntry>{};
  final _legacy = <String, PullRequestStatus>{};
  bool _all = false, _loading = false, _showMerged = false, _closed = false;
  bool _unsupported = false, _tickers = true;
  // This computer's GitHub was not reachable yet, as when a restored Swarm
  // reads before the computer connects: unlike the other codes, it passes.
  bool _localUnavailable = false;
  String? _scope, _error;
  String _linksKey = '';
  DateTime? _checkedAt;
  int _revision = 0;
  Timer? _timer, _ageTimer;
  SuperTabController get c => widget.controller;
  bool get _active =>
      widget.visible && _tickers && (widget.app?.foreground.value ?? true);
  bool get _projectScope =>
      _all || c.snapshot?.isProjectLead(c.selectedId) == true;
  List<SuperTabConversation> get _groups =>
      c.snapshot?.conversations
          .where(
            (g) => _projectScope
                ? g.projectId == c.selected?.projectId
                : g.id == c.selectedId,
          )
          .toList() ??
      const [];

  Map<String, ({Uri url, Set<String> groups})> get _links {
    final links = <String, ({Uri url, Set<String> groups})>{};
    void include(Uri url, String group) {
      final key = url.toString();
      links[key] = (url: url, groups: {...?links[key]?.groups, group});
    }

    for (final group in _groups) {
      for (final stored in group.pullRequestUrls) {
        for (final link in superTabPullRequestLinks(stored)) {
          include(link, group.title);
        }
      }
      for (final message in c.messages(group.id)) {
        for (final link in superTabPullRequestLinks(message.text)) {
          include(link, group.title);
        }
      }
      if (_unsupported) {
        for (final id in group.agentIds) {
          if (_legacy[id] case final pr?) {
            include(pr.url, group.title);
          }
        }
      }
    }
    return links;
  }

  @override
  void initState() {
    super.initState();
    c.addListener(_changed);
    widget.app?.foreground.addListener(_visibilityChanged);
    _changed();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final enabled = TickerMode.valuesOf(context).enabled;
    if (_tickers != enabled) {
      _tickers = enabled;
      _visibilityChanged();
    }
  }

  @override
  void didUpdateWidget(SuperTabPullRequests oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.app != widget.app) {
      oldWidget.app?.foreground.removeListener(_visibilityChanged);
      widget.app?.foreground.addListener(_visibilityChanged);
      _scope = null;
    }
    if (oldWidget.controller != c) {
      oldWidget.controller.removeListener(_changed);
      c.addListener(_changed);
      _scope = null;
    }
    if (oldWidget.visible != widget.visible) _visibilityChanged();
    _changed();
  }

  void _visibilityChanged() {
    _timer?.cancel();
    _ageTimer?.cancel();
    if (!_active) {
      _revision++;
      _loading = false;
    } else {
      unawaited(_refresh());
    }
  }

  void _changed() {
    final scope =
        '${c.accountId}:${c.tabId}:${c.selected?.projectId}:${_projectScope ? '*' : c.selectedId}';
    if (scope != _scope) {
      _scope = scope;
      _entries.clear();
      _legacy.clear();
      _error = null;
      _checkedAt = null;
      _showMerged = false;
      _closed = false;
      _linksKey = '';
      unawaited(_refresh());
    } else {
      final key = _links.keys.join('|');
      if (!_loading && key != _linksKey) {
        unawaited(_refresh());
      } else if (mounted) {
        setState(() {});
      }
    }
  }

  void _schedule() {
    _timer?.cancel();
    _ageTimer?.cancel();
    if (!_active) return;
    if (_checkedAt != null) {
      _ageTimer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    }
    if (_unsupported ||
        _error != null ||
        _links.keys.any((url) => _entries[url]?.finalState != true)) {
      _timer = Timer(const Duration(seconds: 60), _refresh);
    }
  }

  Future<void> _refresh() async {
    if (!_active) return;
    final revision = ++_revision;
    _timer?.cancel();
    setState(() => _loading = true);
    final groups = _groups;
    try {
      if (_projectScope) {
        // The controller owns paging and caches; this never changes selection.
        for (final group in groups) {
          await c.loadMessages(group.id);
          if (!mounted || revision != _revision) return;
        }
      }
      final links = _links;
      _linksKey = links.keys.join('|');
      final urls = links.keys
          .where((url) => _entries[url]?.finalState != true)
          .toList();
      if ((!_unsupported || _localUnavailable) && urls.isNotEmpty) {
        final values = <String, SuperTabPullRequestEntry>{};
        String? error;
        var unsupported = false;
        for (var i = 0; i < urls.length; i += 50) {
          final answer =
              await (widget.read ?? widget.app?.readPullRequestsStatus)?.call(
                urls.skip(i).take(50).toList(),
              ) ??
              <String, dynamic>{'error': 'LOCAL_GITHUB_UNAVAILABLE'};
          if (!mounted || revision != _revision) return;
          if (const [
            'UNSUPPORTED',
            'E2EE_REQUIRED',
            'OWNER_REQUIRED',
            'LOCAL_GITHUB_UNAVAILABLE',
          ].contains(answer['error'])) {
            unsupported = true;
            _localUnavailable = answer['error'] == 'LOCAL_GITHUB_UNAVAILABLE';
            break;
          }
          if (answer['error'] is String) error ??= answer['error'];
          if (answer['rows'] is! List && error == null) error = 'UNAVAILABLE';
          for (final raw
              in answer['rows'] is List ? answer['rows'] as List : const []) {
            if (raw is! Map) continue;
            final entry = SuperTabPullRequestEntry.fromJson(
              Map<String, dynamic>.from(raw),
            );
            if (entry != null && urls.contains(entry.url.toString())) {
              values[entry.url.toString()] = entry;
            }
          }
        }
        _unsupported = unsupported;
        if (!unsupported) _localUnavailable = false;
        if (error == 'GH_MISSING' || error == 'GH_SIGNED_OUT') {
          // A changed login must not leave yesterday's private titles under today's account.
          _entries.clear();
          _checkedAt = null;
        } else {
          for (final item in values.entries) {
            if (item.value.status != 'unavailable') {
              _entries[item.key] = item.value;
            }
          }
          if (error == null && !_unsupported) _checkedAt = widget.now();
        }
        _error = error;
      }
      if (_unsupported) {
        final agents =
            c.snapshot?.agents
                .where((a) => groups.any((g) => g.agentIds.contains(a.id)))
                .toList() ??
            const <SuperTabAgent>[];
        final values = <String, PullRequestStatus>{};
        for (var i = 0; i < agents.length; i += 2) {
          await Future.wait(
            agents.skip(i).take(2).map((agent) async {
              final pr = PullRequestStatus.fromResult(
                await widget.app?.readAgentPullRequest(
                  agent.machineId,
                  agent.harnessId,
                ),
              );
              if (pr != null) values[agent.id] = pr;
            }),
          );
          if (!mounted || revision != _revision) return;
        }
        _legacy
          ..clear()
          ..addAll(values);
        _error = null;
      }
      if (links.isEmpty && _error == null) _checkedAt ??= widget.now();
    } catch (_) {
      if (!mounted || revision != _revision) return;
      _error = 'UNAVAILABLE';
    }
    if (!mounted || revision != _revision) return;
    setState(() => _loading = false);
    _schedule();
  }

  @override
  void dispose() {
    _revision++;
    _timer?.cancel();
    _ageTimer?.cancel();
    widget.app?.foreground.removeListener(_visibilityChanged);
    c.removeListener(_changed);
    super.dispose();
  }

  String get _fresh {
    if (_checkedAt == null) {
      return _loading ? 'Checking GitHub…' : 'Not checked';
    }
    final seconds = widget
        .now()
        .difference(_checkedAt!)
        .inSeconds
        .clamp(0, 9999999);
    return _error == null
        ? 'Checked $seconds s ago'
        : 'Checked ${pullRequestAge(_checkedAt, widget.now())}';
  }

  String? get _banner => switch (_error) {
    'GH_MISSING' => 'Install the GitHub CLI (gh) on this computer, then run gh auth login in Terminal; status shows up within a minute.',
    'GH_SIGNED_OUT' => "GitHub isn't signed in on this computer, so Harness can't read these pull requests. Run gh auth login in Terminal; status shows up within a minute.",
    'RATE_LIMITED' =>
      "GitHub is limiting this computer's requests. Trying again in 1 min.",
    null => null,
    _ =>
      _checkedAt == null
          ? "GitHub didn't answer. Trying again in 1 min."
          : "GitHub didn't answer. Showing what it said ${pullRequestAge(_checkedAt, widget.now())}; trying again in 1 min.",
  };

  @override
  Widget build(BuildContext context) {
    final links = _links;
    final entries = [
      for (final link in links.values)
        _entries[link.url.toString()] ??
            SuperTabPullRequestEntry(
              url: link.url,
              status: _loading && _checkedAt == null && _error == null
                  ? 'checking'
                  : 'unavailable',
            ),
    ];
    final checking = _checkedAt == null && _loading && _error == null;
    final login = _error == 'GH_MISSING' || _error == 'GH_SIGNED_OUT';
    int recent(SuperTabPullRequestEntry a, SuperTabPullRequestEntry b) =>
        (b.time ?? DateTime(1970)).compareTo(a.time ?? DateTime(1970));
    List<SuperTabPullRequestEntry> by(
      bool Function(SuperTabPullRequestEntry) test,
    ) => entries.where(test).toList()..sort(recent);
    final needs = by((e) => e.kind.index <= PullRequestKind.behind.index);
    final open =
        by(
          (e) =>
              e.kind.index >= PullRequestKind.ready.index &&
              e.kind.index <= PullRequestKind.open.index,
        )..sort(
          (a, b) => a.kind.index.compareTo(b.kind.index) == 0
              ? recent(a, b)
              : a.kind.index.compareTo(b.kind.index),
        );
    final merged = by((e) => e.kind == PullRequestKind.merged);
    Widget section(
      String title,
      List<SuperTabPullRequestEntry> rows, {
      bool always = false,
      bool collapsed = false,
    }) {
      if (rows.isEmpty && !always) return const SizedBox.shrink();
      final shown = title == 'Merged' && !_showMerged ? rows.take(5) : rows;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 14, 20, 4),
            child: title == 'Closed'
                ? Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      style: TextButton.styleFrom(
                        backgroundColor: Colors.transparent,
                        foregroundColor: DesktopChrome.muted,
                      ),
                      onPressed: () => setState(() => _closed = !_closed),
                      icon: Icon(
                        _closed ? AppIcons.chevronDown : AppIcons.chevronRight,
                        size: 12,
                      ),
                      label: Text(
                        'Closed ${rows.length}',
                        style: DesktopChrome.metadata(),
                      ),
                    ),
                  )
                : Text(
                    '$title ${rows.length}',
                    style: DesktopChrome.metadata(
                      color: title == 'Needs you' && rows.isNotEmpty
                          ? Theme.of(context).colorScheme.error
                          : null,
                    ).copyWith(fontWeight: FontWeight.w600),
                  ),
          ),
          if (!collapsed) ...[
            if (rows.isEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(90, 2, 20, 6),
                child: Text(
                  'Nothing needs you.',
                  style: DesktopChrome.metadata(),
                ),
              ),
            for (final entry in shown)
              _row(entry, links[entry.url.toString()]!.groups),
            if (title == 'Merged' && shown.length < rows.length)
              Align(
                alignment: Alignment.centerLeft,
                child: Padding(
                  padding: const EdgeInsets.only(left: 78),
                  child: TextButton(
                    style: TextButton.styleFrom(
                      backgroundColor: Colors.transparent,
                      foregroundColor: DesktopChrome.accent,
                    ),
                    onPressed: () => setState(() => _showMerged = true),
                    child: Text('Show ${rows.length - shown.length} more'),
                  ),
                ),
              ),
          ],
        ],
      );
    }

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 8),
          child: Row(
            children: [
              Expanded(
                child: Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    Text(
                      'Pull requests',
                      style: DesktopChrome.text(medium: true),
                    ),
                    Text('· ${links.length}', style: DesktopChrome.metadata()),
                    if (!_unsupported)
                      Text('· $_fresh', style: DesktopChrome.metadata()),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              if (c.snapshot?.isProjectLead(c.selectedId) == true)
                Text('This project', style: DesktopChrome.metadata())
              else
                DropdownButton<bool>(
                  value: _all,
                  underline: const SizedBox.shrink(),
                  items: const [
                    DropdownMenuItem(value: false, child: Text('This group')),
                    DropdownMenuItem(value: true, child: Text('This project')),
                  ],
                  onChanged: (value) {
                    if (value != null) {
                      setState(() => _all = value);
                      _changed();
                    }
                  },
                ),
            ],
          ),
        ),
        if (_banner case final banner?)
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 6),
            child: Semantics(
              liveRegion: true,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.error
                      .withValues(alpha: .1),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  banner,
                  style: DesktopChrome.metadata(
                    color: DesktopChrome.foreground,
                  ),
                ),
              ),
            ),
          ),
        Expanded(
          child: links.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          _loading
                              ? 'Checking GitHub…'
                              : 'No pull requests yet',
                          style: DesktopChrome.control(medium: true),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          'A GitHub pull request link posted in ${_projectScope ? 'any chat of this project' : 'this chat'} shows up here with its status.',
                          textAlign: TextAlign.center,
                          style: DesktopChrome.metadata(),
                        ),
                      ],
                    ),
                  ),
                )
              : ListView(
                  padding: const EdgeInsets.only(bottom: 16),
                  children: [
                    if (_unsupported)
                      for (final link in links.values)
                        _legacyRow(link.url, link.groups)
                    else if (checking)
                      section(
                        _projectScope
                            ? 'Linked in this project'
                            : 'Linked in this group',
                        entries,
                      )
                    else if (login)
                      section('Status unknown', entries)
                    else ...[
                      section('Needs you', needs, always: true),
                      section('Open', open),
                      section('Merged', merged),
                      section(
                        'Closed',
                        by((e) => e.kind == PullRequestKind.closed),
                        collapsed: !_closed,
                      ),
                      section(
                        'Status unknown',
                        by((e) => e.kind == PullRequestKind.unknown),
                      ),
                    ],
                  ],
                ),
        ),
      ],
    );
  }

  Color _color(SuperTabPullRequestEntry entry) => switch (entry.kind) {
    PullRequestKind.failed ||
    PullRequestKind.conflicts ||
    PullRequestKind.changes => Theme.of(context).colorScheme.error,
    PullRequestKind.ready || PullRequestKind.autoMerge => pullRequestIconColor(
      'Open',
      null,
      brightness: Theme.of(context).brightness,
    ),
    PullRequestKind.merged => pullRequestIconColor(
      'Merged',
      null,
      brightness: Theme.of(context).brightness,
    ),
    PullRequestKind.review => DesktopChrome.accent,
    PullRequestKind.behind || PullRequestKind.running => grid.AppPalette.warn,
    _ => DesktopChrome.muted,
  };
  Widget _row(SuperTabPullRequestEntry entry, Set<String> groups) {
    final bits = <Widget>[];
    void bit(String text, {Color? color, bool bold = false}) {
      if (text.isEmpty) return;
      if (bits.isNotEmpty) bits.add(Text('·', style: DesktopChrome.metadata()));
      bits.add(
        Text(
          text,
          style: DesktopChrome.metadata(color: color)
              .copyWith(fontWeight: bold ? FontWeight.w600 : null),
        ),
      );
    }

    bit(entry.label, color: _color(entry), bold: true);
    if (entry.status == 'found') {
      if (entry.kind != PullRequestKind.failed &&
          entry.kind != PullRequestKind.running) {
        bit(
          entry.checksLabel,
          color: entry.failed > 0
              ? Theme.of(context).colorScheme.error
              : entry.pending > 0
              ? grid.AppPalette.warn
              : entry.total > 0
              ? pullRequestIconColor(
                  'Open',
                  null,
                  brightness: Theme.of(context).brightness,
                )
              : null,
        );
      }
      bit('+${entry.additions} −${entry.deletions}');
    }
    bit('in ${groups.join(', ')}');
    final time = pullRequestAge(entry.time, widget.now());
    return Semantics(
      link: true,
      child: InkWell(
        key: ValueKey('super-pr-${entry.url}'),
        onTap: () => unawaited(openInBrowser(entry.url)),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 7),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 5),
                child: Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color:
                        const [
                          PullRequestKind.draft,
                          PullRequestKind.closed,
                          PullRequestKind.unknown,
                          PullRequestKind.checking,
                        ].contains(entry.kind)
                        ? null
                        : _color(entry),
                    border: Border.all(color: _color(entry), width: 1.5),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              SizedBox(
                width: 52,
                child: Text(
                  '#${entry.number}',
                  style: DesktopChrome.metadata(),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: entry.kind == PullRequestKind.checking
                              ? Align(
                                  alignment: Alignment.centerLeft,
                                  child: Container(
                                    width: 280,
                                    height: 10,
                                    margin: const EdgeInsets.symmetric(
                                      vertical: 3,
                                    ),
                                    decoration: BoxDecoration(
                                      color: DesktopChrome.rim,
                                      borderRadius: BorderRadius.circular(4),
                                    ),
                                  ),
                                )
                              : Text(
                                  entry.title.isNotEmpty
                                      ? entry.title
                                      : entry.repository,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: DesktopChrome.control(
                                    medium: entry.title.isNotEmpty,
                                  ),
                                ),
                        ),
                        if (time.isNotEmpty) ...[
                          const SizedBox(width: 12),
                          Text(
                            '${entry.state == 'Merged'
                                ? 'merged'
                                : entry.state == 'Closed'
                                ? 'closed'
                                : 'updated'} $time',
                            style: DesktopChrome.metadata(),
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 2),
                    Wrap(spacing: 6, runSpacing: 2, children: bits),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _legacyRow(Uri url, Set<String> groups) {
    final prior = _legacy.values.where((pr) => pr.url == url).firstOrNull;
    return ListTile(
      onTap: () => unawaited(openInBrowser(url)),
      title: Text(
        '${url.pathSegments.take(2).join('/')} #${url.pathSegments.last}',
        style: DesktopChrome.control(medium: true),
      ),
      subtitle: Text(
        [
          if (_projectScope) groups.join('  '),
          prior?.state ?? 'View status on GitHub',
        ].join('\n'),
        style: DesktopChrome.metadata(),
      ),
    );
  }
}
