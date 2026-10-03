import 'package:flutter/material.dart';

import '../shortcuts/app_keymap.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'desktop_chrome.dart';
import 'desktop_prompt_surface.dart';
import 'terminal_prompt.dart';

class SessionCloseItem {
  const SessionCloseItem({
    required this.name,
    required this.activity,
    this.machineName,
  });

  final String name;
  final String activity;
  final String? machineName;

  bool get completed => activity == 'stopped' || activity == 'deferred';
}

/// One decision covers the captured sessions. Cancel is the default.
Future<String?> showSessionCloseDialog(
  BuildContext context,
  List<SessionCloseItem> sessions, {
  String? tabName,
  AppKeymap? keymap,
  String? error,
}) => showTerminalPrompt<String>(
  context,
  keymap: keymap,
  builder: (_) => _SessionClosePrompt(
    sessions: List.unmodifiable(sessions),
    tabName: tabName,
    error: error,
  ),
);

class _SessionClosePrompt extends StatefulWidget {
  const _SessionClosePrompt({required this.sessions, this.tabName, this.error});
  final List<SessionCloseItem> sessions;
  final String? tabName;
  final String? error;
  @override
  State<_SessionClosePrompt> createState() => _SessionClosePromptState();
}

class _SessionClosePromptState extends State<_SessionClosePrompt> {
  final _cancel = FocusNode(debugLabel: 'Cancel session close');
  final _keys = FocusNode(debugLabel: 'Session close');
  final _scroll = ScrollController();
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _cancel.requestFocus();
    });
  }

  @override
  void dispose() {
    _cancel.dispose();
    _keys.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _choose([String? choice]) => Navigator.pop(context, choice);

  String _summary(List<SessionCloseItem> attention) {
    final count = attention.length;
    final subject = count == 1 ? '1 session' : '$count sessions';
    final activities = attention.map((item) => item.activity).toSet();
    if (activities.length != 1) {
      return '$subject ${count == 1 ? 'needs' : 'need'} attention.';
    }
    return switch (activities.single) {
      'working' => '$subject ${count == 1 ? 'is' : 'are'} still working.',
      'needs_input' =>
        '$subject ${count == 1 ? 'is' : 'are'} waiting for input.',
      'draft' => '$subject ${count == 1 ? 'has' : 'have'} unsent text.',
      _ => '$subject may still be working.',
    };
  }

  String _activityLabel(String activity) => switch (activity) {
    'working' => 'Working',
    'needs_input' => 'Waiting for input',
    'draft' => 'Unsent text',
    'idle' => 'Idle',
    'stopped' => 'Stopped',
    'deferred' => 'Stopping after work finishes',
    'unconfirmed' => 'Stop not confirmed',
    _ => 'Activity unknown',
  };

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final pending = widget.sessions.where((item) => !item.completed).toList();
    final attention = pending.where((item) => item.activity != 'idle').toList();
    final count = pending.length;
    final scope = widget.tabName == null
        ? 'this pane'
        : 'the tab “${widget.tabName}”';
    final description = widget.error ?? _summary(attention);
    final visible = widget.error == null ? attention : widget.sessions;
    final completed = widget.sessions.where((item) => item.completed).length;
    return TerminalPromptKeys(
      focusNode: _keys,
      cancel: _choose,
      child: Semantics(
        namesRoute: true,
        label: widget.tabName ?? widget.sessions.first.name,
        child: DesktopPromptSurface(
          body: DesktopPromptScrollBody(
            controller: _scroll,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(description, style: DesktopChrome.text(size: 13)),
                const SizedBox(height: DesktopChrome.controlGap),
                Text(
                  widget.error == null
                      ? 'Stopping ${count == 1 ? 'this session' : 'all $count sessions'} will close $scope. History will be saved.'
                      : '${widget.tabName == null ? 'This pane' : 'The tab'} stays open.',
                  style: DesktopChrome.text(size: 13),
                ),
                const SizedBox(height: DesktopChrome.groupGap),
                for (final item in visible)
                  Padding(
                    padding: const EdgeInsets.only(
                      bottom: DesktopChrome.controlGap,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          item.name,
                          style: DesktopChrome.text(size: 13, medium: true),
                        ),
                        Text(
                          [
                            if (item.machineName != null) item.machineName!,
                            _activityLabel(item.activity),
                          ].join(' · '),
                          style: DesktopChrome.text(size: 12),
                        ),
                      ],
                    ),
                  ),
                if (completed > 0 && widget.error == null) ...[
                  const SizedBox(height: DesktopChrome.controlGap),
                  Text(
                    '$completed ${completed == 1 ? 'session has' : 'sessions have'} already closed.',
                    style: DesktopChrome.text(size: 13),
                  ),
                ],
              ],
            ),
          ),
          actions: [
            TextButton(
              focusNode: _cancel,
              onPressed: _choose,
              child: Text(widget.error == null ? 'Cancel' : 'OK'),
            ),
            if (widget.error == null) ...[
              FilledButton(
                key: const Key('session-close-now'),
                style: grid.dangerButtonStyle(),
                onPressed: () => _choose('now'),
                child: const Text('Stop'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
