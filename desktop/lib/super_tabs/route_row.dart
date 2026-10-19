import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'model.dart';
import 'routing_policy.dart';
import 'routing_policy_form.dart';

/// One routing decision in the conversation: who was chosen, how, and why.
/// Writers can change it afterwards; the Lead is told to hand the task over.
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
  bool _expanded = false;
  // Kept in the row, not a snackbar: a refusal must stay readable until the
  // person tries again.
  String? _problem;

  String get _how => switch (widget.route.via) {
    'jev' => 'Jev ${((widget.route.p ?? 0) * 100).round()}%',
    'only' => 'only candidate',
    _ => switch (widget.route.fallback) {
      'unavailable' => 'by policy order (Jev unavailable)',
      'unsure' => 'by policy order (Jev unsure)',
      _ => 'by policy order',
    },
  };

  /// The recorded decision, loaded once; null when it cannot be read.
  Future<Map<String, dynamic>?> _load() async {
    if (_details != null) return _details;
    try {
      final answer = await widget.controller.request(
        'GET',
        '/api/super-tabs/${widget.controller.tabId}/route-decisions/${widget.route.decisionId}',
      );
      if (mounted) _details = answer;
      return answer;
    } catch (_) {
      return null;
    }
  }

  Future<void> _toggle() async {
    setState(() => _expanded = !_expanded);
    if (!_expanded || _details != null) return;
    final answer = await _load();
    if (mounted) setState(() => _details = answer ?? const {'error': true});
  }

  Future<void> _change() async {
    final c = widget.controller;
    final choice = await showAppDialog<(String, String)>(
      context: context,
      builder: (_) => SuperTabDialogScope(
        controller: c,
        child: _ChangeDialog(route: widget.route, load: _load),
      ),
    );
    if (choice == null || !mounted) return;
    setState(() => _problem = null);
    // command() answers null without trying when the controller is busy, so
    // that case must not be reported as a refusal.
    if (c.saving || c.hasPendingAction) {
      setState(() => _problem = 'Finish the pending action first.');
      return;
    }
    final result = await c.command({
      'type': 'route.override',
      'decisionId': widget.route.decisionId,
      'candidateId': choice.$1,
      'reason': choice.$2,
    });
    // An attempted command resets operationError first, so a value here is
    // this attempt's refusal.
    if (result == null && mounted) {
      setState(
        () => _problem = c.operationError ?? 'Could not change the route.',
      );
      return;
    }
    // The decision now names the new choice; a kept copy would offer it as an
    // alternative on the next Change.
    _details = null;
    if (_expanded && mounted) {
      final answer = await _load();
      if (mounted) setState(() => _details = answer ?? const {'error': true});
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.route;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              InkWell(
                onTap: _toggle,
                child: Text(
                  'Routed to ${r.pick.title} — $_how · "${r.why}"',
                  style: DesktopChrome.metadata(),
                ),
              ),
              if (r.belowFloor)
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 6,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: grid.AppPalette.warn.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    'Below quality floor',
                    style: DesktopChrome.metadata(color: grid.AppPalette.warn),
                  ),
                ),
              if (widget.controller.canWrite && r.alternatives.isNotEmpty)
                TextButton(
                  onPressed: () => unawaited(_change()),
                  child: const Text('Change'),
                ),
            ],
          ),
          if (_problem != null)
            Text(_problem!, style: DesktopChrome.metadata()),
          if (_expanded) _detailsView(),
        ],
      ),
    );
  }

  Widget _detailsView() {
    final d = _details;
    if (d == null) {
      return const Padding(
        padding: EdgeInsets.all(8),
        child: LinearProgressIndicator(),
      );
    }
    if (d['error'] == true) {
      return Text(
        'Could not load this decision.',
        style: DesktopChrome.metadata(),
      );
    }
    final record = superTabMap(d['record'] ?? const {});
    final candidates = (record['candidates'] as List? ?? const []).map(
      superTabMap,
    );
    final excluded = (record['excluded'] as List? ?? const []).map(superTabMap);
    return Padding(
      padding: const EdgeInsets.only(left: 12, top: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Quality floor ${record['floor']}${record['notes'] == true ? ' · policy notes applied' : ''}',
            style: DesktopChrome.metadata(),
          ),
          for (final c in candidates)
            Text('${c['id']}: ${c['label']}', style: DesktopChrome.metadata()),
          for (final e in excluded)
            Text(
              'Not possible: ${e['title']} — ${e['reason']}',
              style: DesktopChrome.metadata(),
            ),
        ],
      ),
    );
  }
}

class _Option {
  const _Option(this.id, this.title, this.label);
  final String id, title;
  final String? label;
}

class _ChangeDialog extends StatefulWidget {
  const _ChangeDialog({required this.route, required this.load});
  final SuperTabRoute route;
  final Future<Map<String, dynamic>?> Function() load;
  @override
  State<_ChangeDialog> createState() => _ChangeDialogState();
}

class _ChangeDialogState extends State<_ChangeDialog> {
  String? _choice;
  List<_Option>? _options;
  bool _failed = false;
  final _reason = TextEditingController();

  @override
  void initState() {
    super.initState();
    unawaited(_open());
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _open() async {
    final d = await widget.load();
    if (!mounted) return;
    if (d == null) {
      setState(() => _failed = true);
      return;
    }
    final record = superTabMap(d['record'] ?? const {});
    final candidates = [
      for (final c in record['candidates'] as List? ?? const [])
        if (c is Map && c['id'] is String) superTabMap(c),
    ];
    final pick = record['pick'];
    final current =
        superTabMap(d['override'] ?? const {})['candidateId'] ??
        (pick is Map ? pick['id'] : pick);
    String? labelOf(String id) => candidates
        .where((c) => c['id'] == id)
        .map((c) => c['label'])
        .whereType<String>()
        .firstOrNull;
    final options = <_Option>[
      for (final a in widget.route.alternatives)
        if (a.id != current) _Option(a.id, a.title, labelOf(a.id)),
    ];
    for (final c in candidates) {
      final id = c['id'] as String;
      if (id == current || options.any((o) => o.id == id)) continue;
      options.add(
        _Option(
          id,
          c['title'] as String? ?? id,
          c['label'] is String ? c['label'] as String : null,
        ),
      );
    }
    setState(() => _options = options);
  }

  @override
  Widget build(BuildContext context) {
    final reason = _reason.text.trim();
    final ready = _choice != null && reason.isNotEmpty && reason.length <= 300;
    final options = _options;
    return AlertDialog(
      title: const Text('Change who does this task'),
      content: SizedBox(
        width: 480,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (_failed)
              Text(
                'Could not load this decision. Close and try again.',
                style: DesktopChrome.control(),
              )
            else if (options == null)
              const LinearProgressIndicator()
            else
              RadioGroup<String>(
                groupValue: _choice,
                onChanged: (v) => setState(() => _choice = v),
                child: Column(
                  children: [
                    for (final o in options)
                      RadioListTile<String>(
                        value: o.id,
                        title: Text(o.title),
                        subtitle: o.label == null ? null : Text(o.label!),
                      ),
                  ],
                ),
              ),
            TextField(
              controller: _reason,
              maxLength: 300,
              decoration: const InputDecoration(labelText: 'Reason'),
              onChanged: (_) => setState(() {}),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: ready
              ? () => Navigator.of(context).pop((_choice!, reason))
              : null,
          child: const Text('Change'),
        ),
      ],
    );
  }
}

/// Opens this Super Tab's routing policy: the effective policy, with the
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
  // The fields this Super Tab overrides; the rest follow the account default.
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
        title: const Text('Routing for this Super Tab'),
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
