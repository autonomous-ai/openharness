import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/models.dart' show Agent;
import 'package:harness_mobile/state/app_state.dart';

import 'phone_navigation.dart' show openAgent;
import 'phone_search_catalog.dart' show phoneAgentId;
import 'settings_row.dart';
import 'tty.dart';
import 'tty_controls.dart';

/// Computers ▸ a Harness OS computer ▸ Test tools: on or off (off as installed). On, every agent Harness starts
/// there gets Playwright's browser tools and the desktop's (CLI osDevice.ts `test_tools`, agentClient/testTools.ts),
/// to try what it builds as a person would. An agent reads its tools when it starts, so the harnesses running there
/// are listed to restart, as Connections does for a new connection.
class ComputerTestToolsPage extends StatefulWidget {
  const ComputerTestToolsPage({
    super.key,
    required this.notifier,
    required this.machineId,
  });

  final AppNotifier notifier;
  final String machineId;

  @override
  State<ComputerTestToolsPage> createState() => _ComputerTestToolsPageState();
}

class _ComputerTestToolsPageState extends State<ComputerTestToolsPage> {
  bool? _on;
  bool _busy = true;
  String _error = '';

  /// Turned on or off from here: the harnesses running there are offered a restart.
  bool _changed = false;

  /// The engines that get them (CLI agentClient/testTools.ts): Claude Code and Codex at launch, OpenCode
  /// through its own config.
  static const _engines = {'claude', 'codex', 'opencode'};

  /// A restart takes seconds and the daemon queues each one: tapped twice, restarted twice.
  static final Set<String> _restarting = {};

  AppNotifier get _app => widget.notifier;
  String get _id => widget.machineId;
  String get _name => _app.stateOf(_id)?.machine.displayName ?? 'The computer';

  @override
  void initState() {
    super.initState();
    _app.addListener(_listChanged);
    unawaited(_ask(null));
  }

  @override
  void dispose() {
    _app.removeListener(_listChanged);
    super.dispose();
  }

  void _listChanged() {
    if (mounted) setState(() {});
  }

  Future<void> _ask(String? state) async {
    setState(() {
      _busy = true;
      _error = '';
    });
    final reply = await _app.osDevice(_id, {
      'action': 'test_tools',
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
            reply['message'] as String? ??
            'Could not reach $_name. Pull down to try again.';
      }
    });
  }

  /// The harnesses running there on an engine that gets the tools, the one last opened on this phone first.
  List<Agent> get _running {
    final agents = [
      for (final agent in _app.stateOf(_id)?.agents ?? const <Agent>[])
        if (!agent.isStopped && _engines.contains(agent.engine)) agent,
    ];
    final recent = _app.searchHistory.recent.toList();
    int rank(Agent agent) {
      final at = recent.indexOf(phoneAgentId(_id, agent.id));
      return at < 0 ? recent.length : at;
    }

    agents.sort((a, b) => rank(a).compareTo(rank(b)));
    return agents;
  }

  /// Opens the harness, then restarts it there, so the person watches it come back with (or without) the tools.
  void _restart(Agent agent) {
    final key = phoneAgentId(_id, agent.id);
    if (!_restarting.add(key)) return;
    final messenger = ScaffoldMessenger.maybeOf(context);
    openAgent(context, _app, _id, agent.id);
    unawaited(
      _app
          .restartAgent(_id, agent.id)
          .then((result) {
            final error = result.error;
            if (error != null) {
              messenger?.showSnackBar(SnackBar(content: Text(error)));
            }
          })
          .whenComplete(() => _restarting.remove(key)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    Text say(String text, {Color? color}) =>
        Text(text, style: tty.style(color: color ?? tty.dim));
    final on = _on == true;
    final running = _running;
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: TtyBackButton(
                onPressed: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: () => _ask(null),
                child: ListView(
                  padding: EdgeInsets.fromLTRB(
                    Tty.origin,
                    8,
                    Tty.origin,
                    MediaQuery.paddingOf(context).bottom + 24,
                  ),
                  children: [
                    const TtyText(
                      'Test tools',
                      size: TtySize.display,
                      weight: FontWeight.w600,
                    ),
                    const SizedBox(height: 8),
                    say(
                      'Tools for the agents on $_name to try what they build as a person would, '
                      'and fix what they find. Off until you turn them on.',
                    ),
                    const SizedBox(height: 12),
                    if (_error.isNotEmpty)
                      say(_error, color: tty.red)
                    else if (_on == null)
                      const Center(
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    else ...[
                      SettingsGroup(
                        children: [
                          SettingsRow(
                            key: const Key('test-tools-state'),
                            title: 'Test tools',
                            value: on ? 'On' : 'Off',
                          ),
                          const SettingsRow(
                            leading: Icon(LucideIcons.globe300, size: 20),
                            title: 'Browser',
                            detail: 'A website: opens it in a Chromium window, clicks, types, reads the page and its console.',
                          ),
                          const SettingsRow(
                            leading: Icon(LucideIcons.monitor300, size: 20),
                            title: 'Desktop',
                            detail: 'A desktop app: screenshots of the screen, and the mouse and keyboard on them.',
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      say(
                        'Claude Code, Codex and OpenCode agents get them, and ask you before they use them.',
                      ),
                      const SizedBox(height: 20),
                      TtyPrimaryButton(
                        key: const Key('test-tools-toggle'),
                        label: on
                            ? 'Turn test tools off'
                            : 'Turn test tools on',
                        busy: _busy,
                        busyLabel: on ? 'Turning off…' : 'Turning on…',
                        onPressed: () => unawaited(_ask(on ? 'off' : 'on')),
                      ),
                      // An agent reads its tools when it starts: one running already gets them, or loses
                      // them, only on a restart.
                      if (_changed) ...[
                        const SizedBox(height: 20),
                        say(
                          on
                              ? 'New harnesses get them. Restart a running one to give it them.'
                              : 'New harnesses don\'t get them. Restart a running one to take them away.',
                          color: tty.text,
                        ),
                        if (running.isNotEmpty) ...[
                          const SizedBox(height: 12),
                          SettingsGroup(
                            children: [
                              for (final agent in running)
                                SettingsRow(
                                  key: ValueKey(
                                    'test-tools-restart-${agent.id}',
                                  ),
                                  leading: const Icon(
                                    LucideIcons.refreshCw300,
                                    size: 20,
                                  ),
                                  title: 'Restart "${agent.displayName}"',
                                  detail: on
                                      ? 'Restart to use the test tools.'
                                      : 'Restart without the test tools.',
                                  onTap: () => _restart(agent),
                                ),
                            ],
                          ),
                        ],
                      ],
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
