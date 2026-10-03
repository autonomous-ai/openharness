import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/agent_git_context.dart';
import '../core/models.dart';
import '../terminal/terminal_font_store.dart';
import '../terminal/terminal_theme_store.dart';
import 'tty.dart';
import 'tty_controls.dart';

class SessionWorkPage extends StatefulWidget {
  const SessionWorkPage({
    super.key,
    required this.agent,
    required this.read,
    this.online = true,
    this.open,
  });
  final Agent agent;
  final Future<Map<String, dynamic>> Function(int offset) read;
  final bool online;
  final Future<bool> Function(Uri)? open;
  @override
  State<SessionWorkPage> createState() => _SessionWorkPageState();
}

class _SessionWorkPageState extends State<SessionWorkPage> {
  AgentGitContext? _data;
  bool _loading = false;
  String? _error;
  int _revision = 0, _visible = 4;
  final _unavailable = <String>{};
  @override
  void initState() {
    super.initState();
    _data = widget.agent.gitContext;
    if (widget.online) unawaited(_refresh(0));
  }

  @override
  void dispose() {
    _revision++;
    super.dispose();
  }

  Future<void> _refresh(int offset) async {
    final revision = ++_revision;
    setState(() {
      _loading = true;
      _error = null;
    });
    Map<String, dynamic> result;
    try {
      result = await widget.read(offset);
    } catch (_) {
      result = {'status': 'unavailable'};
    }
    if (!mounted || revision != _revision) return;
    setState(() {
      _loading = false;
      final context = result['gitContext'];
      if (context is Map && result['history'] is Map) {
        _data =
            AgentGitContext.fromJson({
              ...context,
              'history': result['history'],
            }) ??
            _data;
        for (final lookup
            in result['lookups'] is List
                ? result['lookups'] as List
                : const []) {
          if (lookup is! Map || lookup['url'] is! String) continue;
          if (lookup['status'] == 'unavailable') {
            _unavailable.add(lookup['url']);
          } else {
            _unavailable.remove(lookup['url']);
          }
        }
      } else {
        _error = 'Work history is unavailable. Showing saved observations.';
      }
    });
  }

  Future<void> _open(Uri uri) async {
    bool opened;
    try {
      opened =
          await (widget.open?.call(uri) ??
              launchUrl(uri, mode: LaunchMode.externalApplication));
    } catch (_) {
      opened = false;
    }
    if (mounted && !opened) setState(() => _error = 'Could not open GitHub.');
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([terminalFontStore, terminalThemeStore]),
    builder: (context, _) {
      final tty = Tty.of(context), data = _data;
      final current =
          data?.current ?? (data == null ? widget.agent.project : null);
      final prs = [...?data?.pullRequests];
      int rank(AgentWorkPr pr) => switch (pr.state) {
        'Open' || 'Draft' => 0,
        'Merged' || 'Closed' => 2,
        _ => 1,
      };
      prs.sort((a, b) {
        final order = rank(a).compareTo(rank(b));
        if (order != 0) return order;
        final recency = b.at.compareTo(a.at);
        return recency != 0
            ? recency
            : a.url.toString().compareTo(b.url.toString());
      });
      Widget text(String value, {bool dim = false}) => SelectableText(
        value,
        style: tty.style(color: dim ? tty.faint : tty.text),
      );
      Widget action(String label, VoidCallback? pressed, {Key? key}) =>
          TextButton(
            key: key,
            style: TextButton.styleFrom(
              alignment: Alignment.centerLeft,
              foregroundColor: tty.text,
              minimumSize: Size(0, tty.tapRow),
              padding: EdgeInsets.zero,
              textStyle: tty.style(),
              shape: const RoundedRectangleBorder(),
              splashFactory: NoSplash.splashFactory,
            ),
            onPressed: pressed,
            child: Text(label),
          );
      return Scaffold(
        backgroundColor: tty.ground,
        body: SafeArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  TtyBackButton(
                    onPressed: () => Navigator.of(context).maybePop(),
                  ),
                  Expanded(
                    child: TtyText(
                      '${widget.agent.displayName} · Work',
                      size: TtySize.title,
                    ),
                  ),
                ],
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.symmetric(horizontal: Tty.origin),
                  children: [
                    text(
                      widget.online
                          ? data?.explanation ?? 'Harness workspace'
                          : 'Offline · last known work',
                      dim: true,
                    ),
                    SizedBox(height: tty.row),
                    text(
                      current?.branch ??
                          data?.branchLabel ??
                          'No branch observed',
                    ),
                    if (current != null)
                      text(current.root ?? current.cwd, dim: true),
                    if (data?.observedAt case final at?)
                      text('Work observed ${localWorkTime(at)}', dim: true),
                    SizedBox(height: tty.row),
                    text('Launch workspace', dim: true),
                    text(widget.agent.project?.cwd ?? 'Unavailable'),
                    SizedBox(height: tty.row),
                    text('Pull requests (${prs.length})'),
                    if (prs.isEmpty)
                      text(
                        'No pull requests observed for this harness.',
                        dim: true,
                      ),
                    for (final pr in prs.take(_visible)) ...[
                      action(
                        '#${pr.url.pathSegments.last}  ${pr.state ?? 'State unknown'}  ${pr.title ?? pr.url.pathSegments.take(2).join('/')}',
                        () => unawaited(_open(pr.url)),
                        key: ValueKey('work-pr-${pr.url}'),
                      ),
                      if (pr.headBranch case final branch?)
                        text(
                          '${pr.url.pathSegments.take(2).join('/')} · $branch${pr.baseBranch == null ? '' : ' → ${pr.baseBranch}'}',
                          dim: true,
                        ),
                      if (_unavailable.contains(pr.url.toString()))
                        text(
                          'GitHub unavailable · showing last known state',
                          dim: true,
                        )
                      else if (pr.checkedAt case final at?)
                        text('Checked ${localWorkTime(at)}', dim: true),
                    ],
                    if (prs.length > _visible)
                      action(
                        'Show more',
                        _loading
                            ? null
                            : () {
                                final offset = _visible;
                                setState(() => _visible += 4);
                                if (widget.online) unawaited(_refresh(offset));
                              },
                      ),
                    SizedBox(height: tty.row),
                    text('Observed branches'),
                    if (data?.branches.isEmpty ?? true)
                      text('No branch history observed yet.', dim: true),
                    for (final branch
                        in data?.branches ?? <AgentWorkBranch>[]) ...[
                      text(
                        '${branch.branch}${branch.cwd == current?.root && branch.branch == current?.branch ? ' · current' : ''}',
                      ),
                      text(branch.cwd, dim: true),
                      SizedBox(height: tty.row),
                    ],
                    if (data?.state == 'multiple' ||
                        data?.state == 'uncertain' ||
                        data?.state == 'unavailable') ...[
                      text('Recent work locations'),
                      for (final location
                          in data?.locations ?? <AgentWorkLocation>[])
                        text(location.cwd, dim: true),
                    ],
                    SizedBox(height: tty.row),
                    text(
                      data?.truncated == true
                          ? 'Older observations are omitted.'
                          : 'History includes observed work; earlier work may be missing.',
                      dim: true,
                    ),
                    if (_error != null) text(_error!),
                    if (widget.online)
                      action(
                        _loading ? 'Refreshing…' : 'Refresh',
                        _loading ? null : () => unawaited(_refresh(0)),
                      ),
                    SizedBox(height: tty.row),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}
