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
  });
  final Object identity;
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
    final label = found
        ? 'PR #$number · $state'
        : result == null
        ? 'PR …'
        : 'PR unavailable';
    return Tooltip(
      message: found
          ? 'Open pull request on GitHub'
          : result == null
          ? 'Checking pull request status'
          : 'Could not check GitHub. Check gh installation, sign-in and repository access on the agent’s machine. This does not mean there is no PR.',
      child: TextButton(
        style: TextButton.styleFrom(
          minimumSize: const Size(0, 28),
          padding: const EdgeInsets.symmetric(horizontal: 6),
          textStyle: grid.AppType.monoLabel(),
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
