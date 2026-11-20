import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/widgets/setting_row.dart';
import '../widgets/desktop_chrome.dart';
import 'intern_dialog.dart';
import 'intern_page.dart';

/// Manage Intern 3 ▸ Computer use: on or off (off as installed). On, every agent Harness starts
/// there gets Playwright's browser tools and the desktop's (CLI osDevice.ts `computer_use`,
/// agentClient/computerUse.ts). An agent reads its tools when it starts, so the harnesses running
/// there are offered a restart. The phone's Computer use page (mobile computer_use_page.dart).
class InternComputerUsePage extends InternPage {
  const InternComputerUsePage({
    super.key,
    required super.app,
    required super.machineId,
    required super.onBack,
  });

  @override
  State<InternComputerUsePage> createState() => _InternComputerUsePageState();
}

class _InternComputerUsePageState extends State<InternComputerUsePage> {
  bool? _on;
  bool _busy = true;
  String _error = '';

  /// Turned on or off from here: the harnesses running there are offered a restart.
  bool _changed = false;

  /// Restarts asked from here and not answered: a click twice restarts once.
  final Set<String> _restarting = {};

  /// The engines that get them (CLI agentClient/computerUse.ts).
  static const _engines = {'claude', 'codex', 'opencode'};

  String get _id => widget.machineId;
  String get _name => widget.name;

  @override
  void initState() {
    super.initState();
    unawaited(_ask(null));
  }

  Future<void> _ask(String? state) async {
    setState(() {
      _busy = true;
      _error = '';
    });
    final reply = await widget.app.osDevice(_id, {
      'action': 'computer_use',
      'state': ?state,
    });
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (reply['on'] is bool) {
        _on = reply['on'] as bool;
        if (state != null) _changed = true;
      } else {
        _error =
            reply['message'] as String? ?? 'Could not reach $_name. Try again.';
      }
    });
  }

  Future<void> _restart(String agentId) async {
    if (!_restarting.add(agentId)) return;
    setState(() {});
    final result = await widget.app.restartAgent(_id, agentId);
    if (!mounted) return;
    setState(() {
      _restarting.remove(agentId);
      if (result.error case final error?) _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    final on = _on == true;
    final running = [
      for (final agent in widget.app.machineStates[_id]?.agents ?? const [])
        if (!agent.isStopped && _engines.contains(agent.engine)) agent,
    ];
    return InternDialogFrame(
      title: 'Computer use',
      message: _error.isNotEmpty
          ? _error
          : _busy && _on != null
          ? (on ? 'Turning off…' : 'Turning on…')
          : null,
      error: _error.isNotEmpty,
      actions: [
        internButton('Back', widget.onBack, key: const Key('intern-back')),
        if (_error.isNotEmpty && _on == null)
          internButton(
            'Retry',
            () => unawaited(_ask(null)),
            key: const Key('intern-computer-use-retry'),
          ),
      ],
      children: [
        InternText(
          'Tools for the agents on $_name to try what they build as a person would, and fix what '
          'they find. Claude Code, Codex and OpenCode agents get them, and ask you before they '
          'use them.',
        ),
        if (_on == null && _error.isEmpty)
          InternText('Asking $_name…')
        else if (_on != null) ...[
          SettingRow(
            title: 'Computer use',
            detail:
                'A browser and the desktop: clicks, typing and screenshots.',
            controlSemanticLabel: 'Computer use',
            inlineControl: true,
            control: Switch(
              key: const Key('intern-computer-use-switch'),
              value: on,
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              onChanged: _busy
                  ? null
                  : (value) => unawaited(_ask(value ? 'on' : 'off')),
            ),
          ),
          // An agent reads its tools when it starts: one running already gets them, or loses
          // them, only on a restart.
          if (_changed) ...[
            const SizedBox(height: 12),
            InternText(
              on
                  ? 'New harnesses get them. Restart a running one to give it them.'
                  : 'New harnesses don\'t get them. Restart a running one to take them away.',
              muted: false,
            ),
            for (final agent in running)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        agent.displayName,
                        overflow: TextOverflow.ellipsis,
                        style: DesktopChrome.text(size: 13),
                      ),
                    ),
                    internButton(
                      _restarting.contains(agent.id)
                          ? 'Restarting…'
                          : 'Restart',
                      _restarting.contains(agent.id)
                          ? null
                          : () => unawaited(_restart(agent.id)),
                      key: Key('intern-computer-use-restart:${agent.id}'),
                    ),
                  ],
                ),
              ),
          ],
        ],
      ],
    );
  }
}
