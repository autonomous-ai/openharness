import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_theme.dart' as grid;

/// A separate PR label: branch colour does not encode review state.
class PullRequestBadge extends StatefulWidget {
  const PullRequestBadge({
    super.key,
    required this.identity,
    required this.read,
    this.open,
    this.compact = false,
  });
  final Object identity;
  final bool compact;
  final Future<Map<String, dynamic>> Function() read;
  final Future<bool> Function(Uri)? open;
  @override
  State<PullRequestBadge> createState() => _PullRequestBadgeState();
}

class _PullRequestBadgeState extends State<PullRequestBadge> {
  Timer? _timer;
  int _revision = 0;
  Map<String, dynamic>? _result;
  @override
  void initState() {
    super.initState();
    _restart();
  }

  @override
  void didUpdateWidget(PullRequestBadge oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.identity != widget.identity) _restart();
  }

  void _restart() {
    _timer?.cancel();
    _result = null;
    final revision = ++_revision;
    unawaited(_refresh(revision));
  }

  Future<void> _refresh(int revision) async {
    Map<String, dynamic> result;
    try {
      result = await widget.read();
    } catch (_) {
      result = {'status': 'unavailable'};
    }
    if (!mounted || revision != _revision) return;
    setState(() => _result = result);
    _timer = Timer(const Duration(seconds: 60), () => _refresh(revision));
  }

  @override
  void dispose() {
    _revision++;
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final result = _result;
    if (result?['status'] == 'none') return const SizedBox.shrink();
    final number = result?['number'];
    final state = result?['state'];
    final uri = Uri.tryParse(
      result?['url'] is String ? result!['url'] as String : '',
    );
    final found =
        result?['status'] == 'found' &&
        number is int &&
        number > 0 &&
        const ['Draft', 'Open', 'Merged', 'Closed'].contains(state) &&
        uri?.scheme == 'https' &&
        uri?.host == 'github.com' &&
        uri!.userInfo.isEmpty &&
        uri.path.endsWith('/pull/$number');
    if (!found) return const SizedBox.shrink();
    final label = '${widget.compact ? '' : 'PR '}#$number · $state';
    return Tooltip(
      message: 'PR #$number · $state — Open on GitHub',
      child: TextButton(
        // The small folder line's height and type: it sits under the pane's name, beside the
        // folder and branch.
        style: TextButton.styleFrom(
          minimumSize: Size.zero,
          padding: const EdgeInsets.symmetric(horizontal: 4),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          visualDensity: VisualDensity.compact,
          // Room for descenders, as on the folder line beside it.
          textStyle: grid.AppType.monoLabel(height: 1.3).copyWith(fontSize: 10),
        ),
        onPressed: found
            ? () async {
                final opened =
                    await (widget.open?.call(uri) ??
                        launchUrl(uri, mode: LaunchMode.externalApplication));
                if (!opened && context.mounted) {
                  ScaffoldMessenger.maybeOf(context)?.showSnackBar(
                    const SnackBar(content: Text('Could not open GitHub.')),
                  );
                }
              }
            : null,
        child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis),
      ),
    );
  }
}
