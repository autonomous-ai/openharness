import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'controller.dart';

/// What a Decisions prompt row shows of its agent's terminal (task #3029):
/// its last lines, read once through the terminal read the backend checks
/// (terminal.ts mayDrive), so nobody sees a screen here they could not watch
/// in its terminal. The read writes nothing to any chat.
class SuperTabPromptLines extends StatefulWidget {
  const SuperTabPromptLines({
    super.key,
    required this.controller,
    required this.agentId,
  });
  final SuperTabController controller;
  final String agentId;

  /// How many of its last lines with text show.
  static const lines = 6;

  /// Said when the reader may not read this terminal (a Harness Team
  /// account's agent, for anyone but its project's owner).
  static const refused =
      'Its terminal isn\'t shown to you. Open the task to answer it.';

  /// Said when its machine did not answer.
  static const failed = 'Its last lines could not be read.';

  /// The last [count] lines of [screen] with text, right-trimmed.
  static String lastLines(String screen, {int count = lines}) {
    final kept = [
      for (final line in screen.split('\n'))
        if (line.trimRight().isNotEmpty) line.trimRight(),
    ];
    return kept.skip(kept.length > count ? kept.length - count : 0).join('\n');
  }

  @override
  State<SuperTabPromptLines> createState() => _PromptLinesState();
}

enum _Read { reading, shown, refused, failed }

class _PromptLinesState extends State<SuperTabPromptLines> {
  _Read _read = _Read.reading;
  String _text = '';

  String get _path =>
      '/api/super-tabs/${Uri.encodeComponent(widget.controller.tabId)}';

  /// Which read is current: an answer for an earlier controller or agent is
  /// dropped.
  int _turn = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(SuperTabPromptLines old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller || old.agentId != widget.agentId) {
      _read = _Read.reading;
      _load();
    }
  }

  Future<void> _load() async {
    final turn = ++_turn;
    void show(_Read read) {
      if (turn == _turn) _show(read);
    }

    try {
      final sent = await widget.controller.request(
        'POST',
        '$_path/commands',
        body: {
          'operationId': superTabOperationId(),
          'command': {'type': 'agent.screen', 'agentId': widget.agentId},
        },
      );
      final id = (sent['result'] as Map?)?['requestId'] as String?;
      if (id == null) return show(_Read.failed);
      // The backend waits about 20 seconds per read; a request still pending
      // then is read once more before the row gives up.
      for (var i = 0; i < 2; i++) {
        final answer = await widget.controller.request(
          'GET',
          '$_path/terminal/${Uri.encodeComponent(id)}',
        );
        if (answer['pending'] == true) continue;
        final text = answer['ok'] == true ? answer['text'] as String? : null;
        if (text == null) return show(_Read.failed);
        if (turn != _turn) return;
        _text = SuperTabPromptLines.lastLines(text);
        return show(_text.isEmpty ? _Read.failed : _Read.shown);
      }
      show(_Read.failed);
    } on SuperTabFailure catch (failure) {
      show(failure.statusCode == 403 ? _Read.refused : _Read.failed);
    } catch (_) {
      show(_Read.failed);
    }
  }

  void _show(_Read read) {
    if (mounted) setState(() => _read = read);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.only(top: grid.AppDesktop.controlGap),
      child: switch (_read) {
        _Read.reading => const SizedBox.shrink(),
        _Read.refused => Text(
          SuperTabPromptLines.refused,
          style: DesktopChrome.metadata(),
        ),
        _Read.failed => Text(
          SuperTabPromptLines.failed,
          style: DesktopChrome.metadata(),
        ),
        _Read.shown => Container(
          key: ValueKey('super-prompt-lines:${widget.agentId}'),
          width: double.infinity,
          padding: const EdgeInsets.symmetric(
            horizontal: grid.AppDesktop.controlGap,
            vertical: grid.AppDesktop.listRowGap,
          ),
          decoration: BoxDecoration(
            color: grid.AppSurface.recess,
            borderRadius: BorderRadius.circular(grid.AppDesktop.fieldRadius),
          ),
          child: Text(
            _text,
            style: grid.AppType.mono(color: DesktopChrome.foreground),
          ),
        ),
      },
    );
  }
}
