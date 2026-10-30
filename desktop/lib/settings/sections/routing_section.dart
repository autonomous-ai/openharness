import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/widgets/section_scaffold.dart';
import '../../state/app_state.dart';
import '../../super_tabs/routing_policy.dart';
import '../../super_tabs/routing_policy_form.dart';

/// Settings ▸ Routing: the account's routing default for every Swarm it
/// owns. A Swarm can override single fields from its own Routing dialog.
class RoutingSection extends StatefulWidget {
  const RoutingSection({super.key, required this.notifier});
  final AppNotifier notifier;

  @override
  State<RoutingSection> createState() => _RoutingSectionState();
}

class _RoutingSectionState extends State<RoutingSection> {
  RoutingPolicy? _policy;
  int _revision = 0;
  String? _error;
  bool _saving = false, _valid = true, _saved = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final answer = await widget.notifier.superTabs.map(
        'GET',
        '/api/super-tabs/routing-policy',
      );
      if (!mounted) return;
      setState(() {
        _policy = RoutingPolicy.fromJson(
          Map<String, dynamic>.from(answer['policy'] as Map),
        );
        _revision = (answer['revision'] as num).toInt();
        _error = null;
      });
    } catch (failure) {
      if (mounted) {
        setState(() => _error = 'Could not load the routing policy. $failure');
      }
    }
  }

  Future<void> _save() async {
    final policy = _policy;
    if (policy == null || _saving) return;
    setState(() {
      _saving = true;
      _saved = false;
    });
    try {
      final answer = await widget.notifier.superTabs.map(
        'POST',
        '/api/super-tabs/routing-policy',
        body: {'revision': _revision, 'policy': policy.toJson()},
      );
      if (mounted) {
        setState(() {
          _revision = (answer['revision'] as num).toInt();
          _error = null;
          _saved = true;
        });
      }
    } catch (failure) {
      if (mounted) setState(() => _error = 'Could not save. $failure');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final policy = _policy;
    final theme = Theme.of(context);
    return SectionScaffold(
      title: 'Routing',
      subtitle: 'How a Swarm Lead chooses who does each task. Each Swarm you own can override these.',
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(
                  _error!,
                  style: TextStyle(color: theme.colorScheme.error),
                ),
              ),
            if (policy == null && _error == null)
              const LinearProgressIndicator(),
            if (policy != null) ...[
              RoutingPolicyForm(
                value: policy,
                onChanged: (v) => setState(() {
                  _policy = v;
                  _saved = false;
                }),
                onValidChanged: (ok) => setState(() => _valid = ok),
              ),
              Row(
                children: [
                  FilledButton(
                    onPressed: _saving || !_valid
                        ? null
                        : () => unawaited(_save()),
                    child: const Text('Save'),
                  ),
                  if (_saved) ...[
                    const SizedBox(width: 12),
                    Text('Saved.', style: theme.textTheme.bodySmall),
                  ],
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}
