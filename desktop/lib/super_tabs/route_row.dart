import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/finger_target.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'message_row.dart';
import 'model.dart';
import 'routing_policy.dart';
import 'routing_policy_form.dart';

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
    _ => switch (widget.route.fallback) {
      'unavailable' => 'Policy order (Jev unavailable)',
      'unsure' => 'Policy order (Jev unsure)',
      _ => 'Policy order',
    },
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
    final r = widget.route;
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
              if (r.belowFloor)
                Padding(
                  padding: const EdgeInsets.only(left: 8),
                  child: Text(
                    'Below quality floor',
                    style: style.copyWith(color: grid.AppPalette.warn),
                  ),
                ),
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
        if (record['floor'] case final num floor) Text('Quality floor $floor'),
        if (record['notes'] == true) const Text('Policy notes applied'),
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

/// Opens this Swarm's routing policy: the effective policy, with the
/// fields it overrides marked. Only the owner can change it.
Future<void> showSuperTabRouting(BuildContext context, SuperTabController c) =>
    showAppDialog<void>(
      context: context,
      builder: (_) => SuperTabDialogScope(
        controller: c,
        requireWrite: false,
        child: _RoutingDialog(controller: c),
      ),
    );

class _RoutingDialog extends StatefulWidget {
  const _RoutingDialog({required this.controller});
  final SuperTabController controller;
  @override
  State<_RoutingDialog> createState() => _RoutingDialogState();
}

class _RoutingDialogState extends State<_RoutingDialog> {
  RoutingPolicy? _policy;
  // The owner's account policy: what a field shows after Use account default.
  RoutingPolicy? _account;
  // The fields this Swarm overrides; the rest follow the account default.
  final _overridden = <String>{};
  List<String> _warnings = const [];
  String? _problem;
  bool _valid = true;

  SuperTabController get _c => widget.controller;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final answer = await _c.request(
        'GET',
        '/api/super-tabs/${_c.tabId}/routing-policy',
      );
      if (!mounted) return;
      setState(() {
        _policy = RoutingPolicy.fromJson(superTabMap(answer['policy']));
        if (answer['account'] is Map) {
          _account = RoutingPolicy.fromJson(superTabMap(answer['account']));
        }
        _overridden.addAll((answer['overridden'] as List? ?? const []).cast());
        _warnings = (answer['warnings'] as List? ?? const [])
            .whereType<String>()
            .toList();
      });
    } catch (failure) {
      if (mounted) {
        setState(
          () => _problem = 'Could not load the routing policy. $failure',
        );
      }
    }
  }

  Future<void> _save() async {
    final policy = _policy;
    if (policy == null) return;
    setState(() => _problem = null);
    // command() answers null without trying when the controller is busy, so
    // that case must not be reported as a refusal.
    if (_c.saving || _c.hasPendingAction) {
      setState(() => _problem = 'Finish the pending action first.');
      return;
    }
    final result = await _c.command({
      'type': 'tab.routingPolicy',
      'policy': _overridden.isEmpty ? null : policy.fields(_overridden),
    });
    if (!mounted) return;
    if (result == null) {
      setState(
        () => _problem = _c.operationError ?? 'Could not save the routing.',
      );
      return;
    }
    Navigator.of(context).pop();
  }

  /// The fields [next] differs in, so editing one marks it as overridden.
  Set<String> _changed(RoutingPolicy a, RoutingPolicy b) {
    final x = a.toJson(), y = b.toJson();
    return {
      for (final k in const ['models', 'floor', 'quotaReserve', 'notes'])
        if (x[k].toString() != y[k].toString()) k,
    };
  }

  @override
  Widget build(BuildContext context) {
    final policy = _policy;
    final owner = _c.isOwner;
    return ListenableBuilder(
      listenable: _c,
      builder: (context, _) => AlertDialog(
        title: const Text('Routing for this Swarm'),
        content: SizedBox(
          width: 560,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (policy == null && _problem == null)
                  const LinearProgressIndicator(),
                for (final warning in _warnings)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Text(warning, style: DesktopChrome.metadata()),
                  ),
                if (policy != null)
                  RoutingPolicyForm(
                    value: policy,
                    readOnly: !owner,
                    overridden: _overridden,
                    onValidChanged: (ok) => setState(() => _valid = ok),
                    onChanged: (next) => setState(() {
                      _overridden.addAll(_changed(policy, next));
                      _policy = next;
                    }),
                    onUseDefault: (field) => setState(() {
                      _overridden.remove(field);
                      final account = _account;
                      if (account != null) {
                        _policy = policy.takeField(field, account);
                      }
                    }),
                  ),
                if (_problem != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      _problem!,
                      style: DesktopChrome.control(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: Text(owner ? 'Cancel' : 'Close'),
          ),
          if (owner)
            FilledButton(
              onPressed: policy == null || !_valid || _c.saving
                  ? null
                  : () => unawaited(_save()),
              child: const Text('Save'),
            ),
        ],
      ),
    );
  }
}
