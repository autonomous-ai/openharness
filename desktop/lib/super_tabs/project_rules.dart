import 'dart:async';

import 'package:flutter/material.dart';

import '../core/relative_time.dart';
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/skeleton.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'detail_dialog.dart';
import 'dialog_scope.dart';
import 'instructions_model.dart';

const _gap = DesktopChrome.controlGap;
const _halfGap = _gap / 2;

DateTime _time(Object? value) =>
    DateTime.tryParse(value as String? ?? '') ??
    DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);

/// One change a rules save made: a field by its dotted path, or a whole list.
typedef SuperTabRulesChange = ({String path, Object? before, Object? after});

/// One kept revision of a project's rules (backend superTabs/policyStore.ts).
class SuperTabRulesRevision {
  SuperTabRulesRevision.fromJson(Map<String, dynamic> row)
    : revision = (row['revision'] as num?)?.toInt() ?? 0,
      summary = row['summary'] as String? ?? '',
      diff = List.unmodifiable([
        for (final change in row['diff'] as List? ?? const [])
          if (change is Map<String, dynamic>)
            (
              path: change['path'] as String? ?? '',
              before: change['before'],
              after: change['after'],
            ),
      ]),
      writtenBy = switch (row['writtenBy']) {
        {'kind': final String kind, 'id': final String id} => (
          kind: kind,
          id: id,
        ),
        _ => (kind: 'person', id: ''),
      },
      askedBy = row['askedBy'] as String?,
      at = _time(row['at']);
  final int revision;
  final String summary;
  final List<SuperTabRulesChange> diff;

  /// `kind` is `person` or `agent` (the project's PM).
  final ({String kind, String id}) writtenBy;
  final String? askedBy;
  final DateTime at;
}

/// A project's rules record as the backend answers it (superTabs/policy.ts): the record, its revision (0 is the
/// built-in seed, never saved) and its kept revisions, newest first.
class SuperTabProjectRules {
  SuperTabProjectRules.fromJson(Map<String, dynamic> row)
    : projectId = row['projectId'] as String? ?? '',
      revision = (row['revision'] as num?)?.toInt() ?? 0,
      seeded = row['seeded'] == true,
      rules = row['rules'] as Map<String, dynamic>? ?? const {},
      history = List.unmodifiable([
        for (final entry in row['history'] as List? ?? const [])
          if (entry is Map<String, dynamic>)
            SuperTabRulesRevision.fromJson(entry),
      ]);
  final String projectId;
  final int revision;
  final bool seeded;
  final Map<String, dynamic> rules;
  final List<SuperTabRulesRevision> history;
}

/// The backend path of a project's rules record.
String superTabRulesPath(String tabId, String projectId) =>
    '/api/super-tabs/${Uri.encodeComponent(tabId)}/projects/'
    '${Uri.encodeComponent(projectId)}/rules';

/// Project settings ▸ Project rules (task #3393): the record and its history, read only. People change it by asking
/// the PM, who saves it with their message.
Future<void> showSuperTabProjectRules(
  BuildContext context,
  SuperTabController c,
  String projectId,
) => showAppDialog<void>(
  context: context,
  builder: (context) => SuperTabDialogScope(
    controller: c,
    projectId: projectId,
    requireWrite: false,
    child: _ProjectRulesDialog(controller: c, projectId: projectId),
  ),
);

class _ProjectRulesDialog extends StatefulWidget {
  const _ProjectRulesDialog({
    required this.controller,
    required this.projectId,
  });

  final SuperTabController controller;
  final String projectId;

  @override
  State<_ProjectRulesDialog> createState() => _ProjectRulesDialogState();
}

class _ProjectRulesDialogState extends State<_ProjectRulesDialog> {
  SuperTabController get c => widget.controller;
  SuperTabProjectRules? _rules;
  Object? _failure;

  /// Counts reads, so that an older answer never lands over a newer one.
  int _reads = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_read());
  }

  Future<void> _read() async {
    final read = ++_reads;
    if (_failure != null) setState(() => _failure = null);
    try {
      final answer = await c.request(
        'GET',
        superTabRulesPath(c.tabId, widget.projectId),
      );
      if (!mounted || read != _reads) return;
      setState(() => _rules = SuperTabProjectRules.fromJson(answer));
    } catch (failure) {
      if (!mounted || read != _reads) return;
      setState(() => _failure = failure);
    }
  }

  String get _projectName =>
      c.snapshot?.projects
          .where((p) => p.id == widget.projectId)
          .firstOrNull
          ?.name ??
      'Project';

  @override
  Widget build(BuildContext context) {
    final rules = _rules;
    return SuperTabDetailDialog(
      title: 'Project rules',
      detail: rules == null
          ? _projectName
          : rules.seeded
          ? '$_projectName · Built-in rules'
          : '$_projectName · Revision ${rules.revision}',
      body: rules == null ? _empty() : _body(rules),
      footer: rules == null
          ? null
          : Text(
              'To change these, ask the PM in the project chat.',
              style: DesktopChrome.metadata(),
            ),
    );
  }

  Widget _empty() {
    final failure = _failure;
    if (failure is SuperTabFailure &&
        superTabMissingRoute(failure.code, failure.statusCode)) {
      return Text(
        'Project rules are not available on this server yet.',
        style: DesktopChrome.text(),
      );
    }
    if (failure != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Could not read the project rules.',
            style: DesktopChrome.metadata(),
          ),
          const SizedBox(height: _gap),
          TextButton(onPressed: _read, child: const Text('Try again')),
        ],
      );
    }
    return SkeletonBlock(
      semanticsLabel: 'Loading the project rules',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final width in const [.5, .8, .7, .6, .8])
            SkeletonText(style: DesktopChrome.text(), widthFactor: width),
        ],
      ),
    );
  }

  Widget _body(SuperTabProjectRules record) {
    final rules = record.rules;
    Map<String, dynamic> section(String key) =>
        rules[key] as Map<String, dynamic>? ?? const {};
    List<Map<String, dynamic>> list(Object? value) => [
      for (final entry in value as List? ?? const [])
        if (entry is Map<String, dynamic>) entry,
    ];
    String joined(Object? value) =>
        [for (final v in value as List? ?? const []) '$v'].join(', ');
    final window = section('releaseWindow');
    final pace = section('releasePace');
    final reviews = section('reviews');
    final train = section('mergeTrain');
    final pause = pace['backendPause'] as Map<String, dynamic>?;
    Widget row(String label, String value) =>
        SuperTabDetailRow(label: label, value: value);
    // The named lists: each with entries is its own section; the empty ones share one line, as the mockup draws.
    final lists =
        <(String, String, String, String Function(Map<String, dynamic>))>[
          (
            'Crew',
            'crew',
            'role',
            (r) {
              final names = joined(r['names']);
              return names.isEmpty ? 'Nobody yet' : names;
            },
          ),
          ('Caps', 'caps', 'name', (r) => '${r['value']}'),
          ('Paths', 'paths', 'name', (r) => '${r['path'] ?? ''}'),
          ('Lanes', 'lanes', 'name', (r) => joined(r['owns'])),
        ];
    final empty = [
      for (final (title, key, _, _) in lists)
        if (list(rules[key]).isEmpty) title,
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SuperTabDetailSection(
          first: true,
          title: 'Releases',
          children: [
            row(
              'Window',
              '${window['start']}–${window['end']} ${window['timeZone']}',
            ),
            row(
              'Backend',
              [
                'At most every ${_minutes(pace['backendEveryMinutes'])}',
                if (pause != null) 'not ${pause['start']}–${pause['end']}',
              ].join(' · '),
            ),
            row(
              'Desktop, CLI and web',
              pace['appsAfterVisibleBatch'] == true
                  ? 'After each visible batch'
                  : 'When someone releases them',
            ),
          ],
        ),
        SuperTabDetailSection(
          title: 'Reviews',
          children: [
            row('Every change', _reads_(reviews['defaultReads'])),
            for (final r in list(reviews['rows']))
              row(
                '${r['area'] ?? ''}',
                [
                  _reads_(r['reads']),
                  if (joined(r['paths']).isNotEmpty) joined(r['paths']),
                ].join(' · '),
              ),
          ],
        ),
        SuperTabDetailSection(
          title: 'Tests',
          children: [
            for (final t in list(reviews['test']))
              row('${t['where'] ?? ''}', joined(t['paths'])),
            if (joined(reviews['untested']).isNotEmpty)
              row('No test needed', joined(reviews['untested'])),
          ],
        ),
        SuperTabDetailSection(
          title: 'Merge train',
          children: [
            row(
              'Batch merge',
              '${train['enabled'] == true ? 'On' : 'Off'} · every '
                  '${train['everyMinutes']} minutes',
            ),
          ],
        ),
        for (final (title, key, label, value) in lists)
          if (list(rules[key]).isNotEmpty)
            SuperTabDetailSection(
              title: title,
              children: [
                for (final r in list(rules[key]))
                  row('${r[label] ?? ''}', value(r)),
              ],
            ),
        if (empty.isNotEmpty)
          SuperTabDetailSection(
            title: empty.join(' · '),
            children: [Text('None yet.', style: DesktopChrome.metadata())],
          ),
        SuperTabDetailSection(
          title: 'History',
          children: record.history.isEmpty
              ? [Text('No changes yet.', style: DesktopChrome.metadata())]
              : [for (final entry in record.history) _revision(entry)],
        ),
      ],
    );
  }

  Widget _revision(SuperTabRulesRevision entry) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const SizedBox(height: _halfGap),
      Text(
        'Revision ${entry.revision} · ${_writer(entry)} · '
        '${relativeAgo(entry.at, DateTime.now())}',
        style: DesktopChrome.metadata(),
      ),
      Text(entry.summary, style: DesktopChrome.control()),
      for (final change in entry.diff)
        Text(
          '${change.path}  ${_shown(change.before)} → ${_shown(change.after)}',
          style: DesktopChrome.metadata(),
        ),
      const SizedBox(height: _halfGap),
    ],
  );

  String _personName(String id) =>
      c.snapshot?.people.where((p) => p.id == id).firstOrNull?.shownName ??
      'a member';

  /// Who saved a revision: a person by name, the PM by its agent's name; `for <asker>` when it carries someone
  /// else's words.
  String _writer(SuperTabRulesRevision entry) {
    final by = entry.writtenBy;
    final name = by.kind == 'agent'
        ? c.snapshot?.agentName(by.id, fallback: 'The PM') ?? 'The PM'
        : _personName(by.id);
    final asker = entry.askedBy;
    if (asker == null || asker == by.id) return name;
    return '$name for ${_personName(asker)}';
  }
}

String _minutes(Object? value) {
  final minutes = (value as num?)?.toInt() ?? 0;
  if (minutes > 0 && minutes % 60 == 0) return '${minutes ~/ 60} h';
  return '$minutes min';
}

String _reads_(Object? value) {
  final reads = (value as num?)?.toInt() ?? 1;
  return reads == 1 ? '1 read' : '$reads reads';
}

/// A value in a change line: a switch as On or Off, nothing as None, a list or a section by its size.
String _shown(Object? value) => switch (value) {
  true => 'On',
  false => 'Off',
  null => 'None',
  final List list => list.length == 1 ? '1 entry' : '${list.length} entries',
  final Map _ => 'changed',
  _ => '$value',
};
