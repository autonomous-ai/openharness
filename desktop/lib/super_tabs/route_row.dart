import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import '../widgets/finger_target.dart';
import 'controller.dart';
import 'message_row.dart';
import 'model.dart';

/// A read-only routing note. Reassignment belongs in the conversation with the
/// lead, rather than a control attached to an earlier routing decision.
class SuperTabRouteRow extends StatefulWidget {
  const SuperTabRouteRow({
    super.key,
    required this.message,
    required this.route,
    required this.controller,
  });
  final SuperTabMessage message;
  final SuperTabRoute route;
  final SuperTabController controller;
  @override
  State<SuperTabRouteRow> createState() => _SuperTabRouteRowState();
}

class _SuperTabRouteRowState extends State<SuperTabRouteRow> {
  Map<String, dynamic>? _details;
  bool _expanded = false, _loading = false, _failed = false;

  String get _target {
    final title = widget.route.pick.title;
    // The CLI's titleOf writes "name · engine model effort · machine".
    // Preserve names containing separators, and unknown/legacy formats in full.
    final parts = RegExp(r'^(.*) · ((?:Claude|Codex) .*) · (.*)$')
        .firstMatch(title);
    if (parts == null) return title;
    final name = parts.group(1)!;
    return name == 'New agent'
        ? 'new ${parts.group(2)!.split(' ').first} agent'
        : name;
  }

  String get _how => switch (widget.route.via) {
    'jev' => 'Jev ${((widget.route.p ?? 0) * 100).round()}%',
    'only' => 'Only available candidate',
    // Task #2901 (Ken, 2026-11-04): the route names no pick; the coordinator
    // chose by the project's Routing instructions, and its start says which.
    'instructions' => 'Chosen by the project\'s Routing instructions',
    // An older backend's policy order too: it ranks, never refuses.
    _ => 'Ranked by strength, price and quota',
  };

  Future<void> _load() async {
    if (_loading || _details != null) return;
    setState(() {
      _loading = true;
      _failed = false;
    });
    try {
      final answer = await widget.controller.request(
        'GET',
        '/api/super-tabs/${widget.controller.tabId}/route-decisions/${widget.route.decisionId}',
      );
      if (mounted) setState(() => _details = answer);
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _toggle() {
    setState(() => _expanded = !_expanded);
    if (_expanded) unawaited(_load());
  }

  Widget _action(String label, VoidCallback onPressed) => TextButton(
    onPressed: onPressed,
    style:
        TextButton.styleFrom(
          foregroundColor: Theme.of(context).colorScheme.onSurfaceVariant,
          backgroundColor: Colors.transparent,
          side: BorderSide.none,
          // A phone's action is a finger's size.
          minimumSize: workspaceIsCompact(context)
              ? const Size.square(kFingerTarget)
              : const Size(0, 28),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          textStyle: DesktopChrome.metadata(),
        ).copyWith(
          side: WidgetStateProperty.resolveWith(
            (states) => states.contains(WidgetState.focused)
                ? TextButtonTheme.of(context).style?.side?.resolve(states)
                : BorderSide.none,
          ),
        ),
    child: Text(label),
  );

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final style = DesktopChrome.metadata(
      color: Theme.of(context).colorScheme.onSurfaceVariant,
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        SuperTabMessageRow.bodyInset,
        4,
        SuperTabMessageRow.horizontalInset,
        4,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text('Routed to $_target', style: style),
              Semantics(
                expanded: _expanded,
                child: _action(_expanded ? 'Hide details' : 'Details', _toggle),
              ),
            ],
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.only(top: 4, bottom: 4),
              child: DefaultTextStyle(style: style, child: _detailsView()),
            ),
        ],
      ),
    );
  }

  Widget _detailsView() {
    final r = widget.route;
    final record = superTabMap(_details?['record'] ?? const {});
    final candidates = (record['candidates'] as List? ?? const []).map(
      superTabMap,
    );
    final excluded = (record['excluded'] as List? ?? const []).map(superTabMap);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      spacing: 4,
      children: [
        Text(r.pick.title),
        if (r.why.isNotEmpty) Text(r.why),
        Text('Selection: $_how'),
        if (_loading) const Text('Loading details…'),
        if (_failed)
          Wrap(
            spacing: 4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              const Text('Could not load this decision.'),
              _action('Retry', () => unawaited(_load())),
            ],
          ),
        // The instructions the route read (phase 4 decision 12); a record
        // from before it says nothing of them.
        if (record['instructionsRevision'] case final num revision)
          Text(
            revision == 0
                ? 'Relied on the built-in instructions'
                : 'Relied on instructions revision ${revision.toInt()}',
          ),
        if (candidates.isNotEmpty) ...[
          const SizedBox(height: 4),
          const Text('Considered'),
          for (final c in candidates)
            if (c['title'] case final String title)
              Text(
                [
                  title,
                  if (c['label'] case final String label) label,
                ].join(' — '),
              ),
        ],
        for (final line in _unavailableLines(excluded)) Text(line),
      ],
    );
  }
}

/// The CLI's titleOf: "name · engine model effort · machine" (route.ts). The
/// engine part holds no " · ", so a machine named with one keeps it whole.
final _titled = RegExp(r'^(.*) · ((?:Claude|Codex) (?:(?! · ).)*) · (.*)$');

/// How route.ts starts a plug-in's refusal: its name, then ": ".
final _ruled = RegExp(r'^[A-Z][A-Za-z ]{0,40}: ');

/// What a route decision left out, a line each for Details. Task #3292 (Ken,
/// 2026-11-05): a line per excluded machine × agent × model made an offline
/// machine 17 lines and the grid limit for security work about 30, a hundred
/// lines before what the route weighed. So, as the PM's answer does (CLI
/// routeCommand.ts leftOut): one line per machine with its distinct reasons,
/// at most [_maxReasons]; a route rule's reason seen on several machines is
/// the decision's, said once; a row of no machine keeps its own line, once.
/// OFFLINE reads the same on every machine but is no rule (no "Name: "), so
/// each offline machine keeps its line.
List<String> _unavailableLines(Iterable<Map<String, dynamic>> excluded) {
  final byMachine = <String, List<String>>{};
  final others = <String>{};
  final machinesOf = <String, Set<String>>{};
  for (final e in excluded) {
    final title = '${e['title'] ?? ''}', reason = '${e['reason'] ?? ''}';
    final machine = _titled.firstMatch(title)?.group(3);
    if (machine == null) {
      others.add('Unavailable: $title — $reason');
      continue;
    }
    final reasons = byMachine.putIfAbsent(machine, () => []);
    if (!reasons.contains(reason)) reasons.add(reason);
    if (_ruled.hasMatch(reason)) {
      machinesOf.putIfAbsent(reason, () => {}).add(machine);
    }
  }
  final rules = {
    for (final MapEntry(key: reason, value: machines) in machinesOf.entries)
      if (machines.length > 1) reason: machines.length,
  };
  return [
    for (final MapEntry(key: reason, value: count) in rules.entries)
      'Unavailable on $count machines — $reason',
    for (final MapEntry(key: machine, value: all) in byMachine.entries)
      if (all.where((r) => !rules.containsKey(r)).toList() case final reasons
          when reasons.isNotEmpty)
        'Unavailable: $machine — ${_upTo(reasons)}',
    ...others,
  ];
}

const _maxReasons = 4;

/// A machine's distinct reasons, the first [_maxReasons] and how many more.
String _upTo(List<String> reasons) => [
  ...reasons.take(_maxReasons),
  if (reasons.length > _maxReasons)
    '(and ${reasons.length - _maxReasons} more)',
].join(' ');
