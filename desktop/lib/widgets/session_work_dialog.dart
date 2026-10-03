import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/agent_git_context.dart';
import '../core/models.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/pull_request_icon.dart';
import 'desktop_chrome.dart';

/// Inspection only. This surface never sends terminal input or mutates a checkout.
class SessionWorkDialog extends StatefulWidget {
  const SessionWorkDialog({
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
  State<SessionWorkDialog> createState() => _SessionWorkDialogState();
}

class _SessionWorkDialogState extends State<SessionWorkDialog> {
  AgentGitContext? _data;
  bool _loading = false, _branches = false;
  String? _error;
  int? _nextOffset;
  int _revision = 0;
  final _unavailable = <String>{};
  final _prScroll = ScrollController(), _branchScroll = ScrollController();
  final _prTab = FocusNode(), _branchTab = FocusNode();

  @override
  void initState() {
    super.initState();
    _data = widget.agent.gitContext;
    if (widget.online) unawaited(_refresh(0));
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
      final raw = result['gitContext'];
      if (raw is Map && result['history'] is Map) {
        _nextOffset = result['nextOffset'] is int
            ? result['nextOffset'] as int
            : null;
        _data =
            AgentGitContext.fromJson({...raw, 'history': result['history']}) ??
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
        _error = 'Could not refresh';
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
    if (mounted && !opened) setState(() => _error = 'Could not open GitHub');
  }

  void _page(int direction) {
    final scroll = _branches ? _branchScroll : _prScroll;
    if (!scroll.hasClients) return;
    final position = scroll.position;
    scroll.jumpTo(
      (position.pixels + direction * position.viewportDimension * .9).clamp(
        position.minScrollExtent,
        position.maxScrollExtent,
      ),
    );
  }

  @override
  void dispose() {
    _revision++;
    _prScroll.dispose();
    _branchScroll.dispose();
    _prTab.dispose();
    _branchTab.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final data = _data;
    final branches = [...?data?.branchRows]
      ..sort((a, b) {
        final checked = (b.checkedOut ? 1 : 0) - (a.checkedOut ? 1 : 0);
        return checked != 0 ? checked : a.branch.compareTo(b.branch);
      });
    final prs = [...?data?.pullRequests];
    int rank(AgentWorkPr pr) => switch (pr.state) {
      'Open' || 'Draft' => 0,
      'Merged' || 'Closed' => 2,
      _ => 1,
    };
    prs.sort((a, b) {
      final state = rank(a).compareTo(rank(b));
      final time = (pullRequestTime(b) ?? b.at).compareTo(
        pullRequestTime(a) ?? a.at,
      );
      return state != 0
          ? state
          : time != 0
          ? time
          : a.url.toString().compareTo(b.url.toString());
    });
    String repoName(String repository) =>
        repository.replaceFirst(RegExp(r'^github\.com/'), '');
    final repositories = {
      ...branches.map(
        (b) => b.repository == null ? null : repoName(b.repository!),
      ),
      ...prs.map((pr) => pr.url.pathSegments.take(2).join('/')),
    };
    final repository = repositories.length == 1 ? repositories.single : null;
    final items = _branches ? branches.length : prs.length;
    final prIndices = {
      for (var i = 0; i < prs.length; i++) ValueKey('pr-${prs[i].url}'): i,
    };
    final status = !widget.online
        ? 'Offline'
        : _error ??
              (data?.state == 'unavailable' || data?.state == 'uncertain'
                  ? 'Git unavailable'
                  : _unavailable.isNotEmpty
                  ? 'GitHub unavailable'
                  : null);
    Widget tab(String label, bool branches) => DesktopPill(
      key: ValueKey(branches ? 'git-branches-tab' : 'git-prs-tab'),
      label: label,
      selected: _branches == branches,
      focusNode: branches ? _branchTab : _prTab,
      onPressed: () => setState(() => _branches = branches),
    );

    return DesktopChrome(
      child: Dialog(
        backgroundColor: Colors.transparent,
        elevation: 0,
        insetPadding: const EdgeInsets.all(16),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: math.max(
              0,
              math.min(MediaQuery.sizeOf(context).height - 32, 620),
            ),
          ),
          child: SizedBox(
            key: const ValueKey('work-dialog-surface'),
            width: 720,
            child: DesktopDialogSurface(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Focus(
                  autofocus: true,
                  onKeyEvent: (node, event) {
                    final keys = HardwareKeyboard.instance;
                    if ((event is KeyDownEvent || event is KeyRepeatEvent) &&
                        !keys.isAltPressed &&
                        !keys.isControlPressed &&
                        !keys.isMetaPressed &&
                        !keys.isShiftPressed &&
                        (event.logicalKey == LogicalKeyboardKey.pageDown ||
                            event.logicalKey == LogicalKeyboardKey.pageUp)) {
                      _page(
                        event.logicalKey == LogicalKeyboardKey.pageDown
                            ? 1
                            : -1,
                      );
                      return KeyEventResult.handled;
                    }
                    if (event is! KeyDownEvent) return KeyEventResult.ignored;
                    if (event.logicalKey == LogicalKeyboardKey.arrowDown) {
                      FocusScope.of(context).nextFocus();
                      return KeyEventResult.handled;
                    }
                    if (event.logicalKey == LogicalKeyboardKey.arrowUp) {
                      FocusScope.of(context).previousFocus();
                      return KeyEventResult.handled;
                    }
                    return KeyEventResult.ignored;
                  },
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Semantics(
                        header: true,
                        child: Tooltip(
                          message: widget.agent.displayName,
                          child: Text(
                            widget.agent.displayName,
                            style: DesktopChrome.heading(),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ),
                      if (repository != null) ...[
                        const SizedBox(height: 4),
                        Tooltip(
                          message: repository,
                          child: Text(
                            repository,
                            style: DesktopChrome.metadata(),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                      const SizedBox(height: 16),
                      Focus(
                        onKeyEvent: (node, event) {
                          if (event is! KeyDownEvent ||
                              !const [
                                LogicalKeyboardKey.arrowLeft,
                                LogicalKeyboardKey.arrowRight,
                              ].contains(event.logicalKey)) {
                            return KeyEventResult.ignored;
                          }
                          final branches =
                              event.logicalKey == LogicalKeyboardKey.arrowRight;
                          setState(() => _branches = branches);
                          (branches ? _branchTab : _prTab).requestFocus();
                          return KeyEventResult.handled;
                        },
                        child: Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: [
                            tab(
                              data == null
                                  ? 'Pull requests'
                                  : 'Pull requests (${prs.length})',
                              false,
                            ),
                            tab(
                              data == null
                                  ? 'Branches'
                                  : 'Branches (${branches.length})',
                              true,
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 12),
                      Divider(
                        height: 1,
                        thickness: 1,
                        color: DesktopChrome.rim,
                      ),
                      const SizedBox(height: 8),
                      Flexible(
                        child: items == 0
                            ? Padding(
                                padding: const EdgeInsets.symmetric(
                                  vertical: 20,
                                ),
                                child: Text(
                                  _loading
                                      ? 'Loading…'
                                      : data == null
                                      ? 'Work history is unavailable'
                                      : _branches
                                      ? 'No branches'
                                      : 'No pull requests',
                                  style: DesktopChrome.control(
                                    color: DesktopChrome.muted,
                                  ),
                                ),
                              )
                            : ListView.builder(
                                key: ValueKey(
                                  _branches
                                      ? 'git-branches-list'
                                      : 'git-prs-list',
                                ),
                                controller: _branches
                                    ? _branchScroll
                                    : _prScroll,
                                shrinkWrap: true,
                                padding: EdgeInsets.zero,
                                itemCount: items,
                                findChildIndexCallback: _branches
                                    ? null
                                    : (key) => prIndices[key],
                                itemBuilder: (context, index) {
                                  if (_branches) {
                                    final branch = branches[index];
                                    return _BranchRow(
                                      branch: branch,
                                      repository: repository == null
                                          ? branch.repository
                                          : null,
                                    );
                                  }
                                  final pr = prs[index];
                                  return _PullRequestRow(
                                    key: ValueKey('pr-${pr.url}'),
                                    pr: pr,
                                    showRepository: repository == null,
                                    unavailable: _unavailable.contains(
                                      pr.url.toString(),
                                    ),
                                    onPressed: () => unawaited(_open(pr.url)),
                                  );
                                },
                              ),
                      ),
                      if (_nextOffset != null && widget.online) ...[
                        const SizedBox(height: 8),
                        Align(
                          alignment: Alignment.centerLeft,
                          child: DesktopPill(
                            label: 'Load more',
                            onPressed: _loading
                                ? null
                                : () => unawaited(_refresh(_nextOffset!)),
                          ),
                        ),
                      ],
                      if (status != null) ...[
                        const SizedBox(height: 12),
                        Semantics(
                          liveRegion: _error != null,
                          child: Text(
                            status,
                            style: DesktopChrome.control(
                              color: widget.online && _error != null
                                  ? Theme.of(context).colorScheme.error
                                  : DesktopChrome.muted,
                            ),
                          ),
                        ),
                      ],
                      if (data?.truncated == true) ...[
                        const SizedBox(height: 8),
                        Tooltip(
                          message: 'Only recorded branches and pull requests are available.',
                          child: Text(
                            'Partial history',
                            style: DesktopChrome.metadata(),
                          ),
                        ),
                      ],
                      const SizedBox(height: 16),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          if (widget.online)
                            DesktopPill(
                              label: _loading ? 'Refreshing…' : 'Refresh',
                              onPressed: _loading
                                  ? null
                                  : () => unawaited(_refresh(0)),
                            )
                          else
                            const SizedBox.shrink(),
                          DesktopPill(
                            label: 'Close',
                            onPressed: () => Navigator.of(context).pop(),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PullRequestRow extends StatelessWidget {
  const _PullRequestRow({
    super.key,
    required this.pr,
    required this.showRepository,
    required this.unavailable,
    required this.onPressed,
  });
  final AgentWorkPr pr;
  final bool showRepository, unavailable;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final number = '#${pr.url.pathSegments.last}';
    final state = pr.state ?? 'Unknown';
    final title = pr.title ?? number;
    final at = pullRequestTime(pr);
    final date = at == null ? null : localWorkTime(at).split(' ').first;
    final metadata = [
      if (pr.title != null) number,
      if (showRepository) pr.url.pathSegments.take(2).join('/'),
      if (pr.headBranch != null)
        '${pr.headBranch}${pr.baseBranch == null ? '' : ' → ${pr.baseBranch}'}',
    ].join(' · ');
    final details = [
      '$number · $title · $state',
      pr.url.pathSegments.take(2).join('/'),
      if (pr.headBranch != null)
        '${pr.headBranch}${pr.baseBranch == null ? '' : ' → ${pr.baseBranch}'}',
      if (at != null)
        '${state == 'Merged' || state == 'Closed' ? state : 'Updated'} ${localWorkTime(at)}',
      if (unavailable) 'GitHub unavailable',
      if (pr.checkedAt != null) 'Checked ${localWorkTime(pr.checkedAt!)}',
      'Open on GitHub',
    ].join('\n');
    final color = pullRequestIconColor(
      state,
      null,
      brightness: grid.AppTheme.brightness.value,
    );
    final highContrast = MediaQuery.highContrastOf(context);
    Widget text(String value, TextStyle style) =>
        Text(value, style: style, maxLines: 1, overflow: TextOverflow.ellipsis);
    return Tooltip(
      message: details,
      child: TextButton(
        key: ValueKey('work-pr-${pr.url}'),
        onPressed: onPressed,
        style:
            TextButton.styleFrom(
              alignment: Alignment.centerLeft,
              foregroundColor: DesktopChrome.foreground,
              backgroundColor: Colors.transparent,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
              minimumSize: const Size(0, 48),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(
                  DesktopChrome.controlRadius,
                ),
              ),
              splashFactory: NoSplash.splashFactory,
            ).copyWith(
              side: WidgetStateProperty.resolveWith(
                (states) => BorderSide(
                  width: 1.5,
                  color: states.contains(WidgetState.focused)
                      ? (highContrast
                            ? DesktopChrome.accent
                            : DesktopChrome.focusRing)
                      : Colors.transparent,
                ),
              ),
              overlayColor: WidgetStateProperty.resolveWith(
                (states) => states.contains(WidgetState.pressed)
                    ? DesktopChrome.foreground.withValues(alpha: .12)
                    : states.contains(WidgetState.hovered)
                    ? DesktopChrome.foreground.withValues(
                        alpha: highContrast ? .10 : .05,
                      )
                    : Colors.transparent,
              ),
            ),
        child: Semantics(
          label: details.replaceAll('\n', ' · '),
          excludeSemantics: true,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: text(title, DesktopChrome.control(medium: true)),
                  ),
                  const SizedBox(width: 12),
                  SvgPicture.asset(
                    pullRequestIconAsset(state),
                    width: 16,
                    height: 16,
                    colorFilter: ColorFilter.mode(color, BlendMode.srcIn),
                  ),
                  const SizedBox(width: 6),
                  text(
                    state,
                    DesktopChrome.metadata(color: DesktopChrome.foreground),
                  ),
                ],
              ),
              if (metadata.isNotEmpty || date != null) ...[
                const SizedBox(height: 4),
                Row(
                  children: [
                    Expanded(child: text(metadata, DesktopChrome.metadata())),
                    if (date != null) ...[
                      const SizedBox(width: 12),
                      text(date, DesktopChrome.metadata()),
                    ],
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _BranchRow extends StatelessWidget {
  const _BranchRow({required this.branch, required this.repository});
  final AgentBranchRow branch;
  final String? repository;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final compact =
          constraints.maxWidth < MediaQuery.textScalerOf(context).scale(400);
      final status = branch.checkedOut ? 'Checked out' : null;
      return Tooltip(
        message: [branch.branch, ?repository, ?status].join('\n'),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      branch.branch,
                      style: DesktopChrome.control(medium: true),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (!compact && status != null) ...[
                    const SizedBox(width: 12),
                    Text(status, style: DesktopChrome.metadata()),
                  ],
                ],
              ),
              if (repository != null || compact && status != null) ...[
                const SizedBox(height: 4),
                Text(
                  [?repository, if (compact) ?status].join(' · '),
                  style: DesktopChrome.metadata(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ],
          ),
        ),
      );
    },
  );
}
