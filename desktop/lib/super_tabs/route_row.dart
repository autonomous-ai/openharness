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
        for (final e in excluded)
          Text('Unavailable: ${e['title']} — ${e['reason']}'),
      ],
    );
  }
}
