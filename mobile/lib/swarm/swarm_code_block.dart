import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'swarm_message_row.dart'
    show swarmChatCard, swarmChatHair, swarmChatText;

/// A piece of a message's text: prose, or a fenced code block with the
/// fence's [name] (`dart`, `main.dart`), null without one.
typedef SwarmTextPart = ({String text, bool code, String? name});

/// A fence on lines of its own: ```name, the code, then ```.
final _fence = RegExp(
  r'^```([^\n`]*)\n([\s\S]*?)\n?```[ \t]*$',
  multiLine: true,
);

/// [text] as prose and fenced code blocks, in order. Prose loses only the
/// line breaks that held a fence; an unclosed fence stays prose.
List<SwarmTextPart> swarmTextParts(String text) {
  final parts = <SwarmTextPart>[];
  void prose(String value) {
    final trimmed = value.replaceAll(RegExp(r'^\n+|\n+$'), '');
    if (trimmed.isNotEmpty) parts.add((text: trimmed, code: false, name: null));
  }

  var from = 0;
  for (final fence in _fence.allMatches(text)) {
    prose(text.substring(from, fence.start));
    final name = fence[1]!.trim();
    parts.add((text: fence[2]!, code: true, name: name.isEmpty ? null : name));
    from = fence.end;
  }
  prose(text.substring(from));
  return parts;
}

/// A fenced code block in a message, as Slack shows one: monospace, the
/// fence's name over it, Copy beside that, and a long one folded to its first
/// [foldedLines] lines behind Show more (the desktop's `SuperTabCodeBlock`).
class SwarmCodeBlock extends StatefulWidget {
  const SwarmCodeBlock({super.key, required this.code, this.name, this.onTap});

  static const foldedLines = 12;

  final String code;
  final String? name;

  /// The message's own tap (it shows Reply), anywhere in the block but Copy
  /// and Show more, which keep theirs; null where the message has none.
  final VoidCallback? onTap;

  @override
  State<SwarmCodeBlock> createState() => _SwarmCodeBlockState();
}

class _SwarmCodeBlockState extends State<SwarmCodeBlock> {
  bool _unfolded = false;

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.code));
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      const SnackBar(content: Text('Code copied'), duration: Durations.long4),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final lines = widget.code.split('\n');
    final long = lines.length > SwarmCodeBlock.foldedLines;
    final shown = long && !_unfolded
        ? lines.take(SwarmCodeBlock.foldedLines).join('\n')
        : widget.code;
    final block = Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: AppSpace.s),
      padding: const EdgeInsets.only(left: AppSpace.m, bottom: AppSpace.m),
      decoration: BoxDecoration(
        color: swarmChatCard(tty),
        border: Border.all(color: swarmChatHair(tty)),
        borderRadius: BorderRadius.circular(AppControl.radius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  widget.name ?? '',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: tty.style(color: AppPalette.textFaint, size: 12.5),
                ),
              ),
              _Action(icon: LucideIcons.copy, label: 'Copy', onTap: _copy),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(right: AppSpace.m),
            child: Text(shown, softWrap: true, style: tty.style(size: 14)),
          ),
          if (long)
            _Action(
              label: _unfolded ? 'Show less' : 'Show more',
              onTap: () => setState(() => _unfolded = !_unfolded),
            ),
        ],
      ),
    );
    final tap = widget.onTap;
    if (tap == null) return block;
    return Semantics(
      hint: 'Reply to this message',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: tap,
        child: block,
      ),
    );
  }
}

/// A phone control's least height and width (design system, Phone: 44-point
/// targets).
const _finger = 44.0;

/// A quiet action in the block: its words in the link colour, a finger tall.
class _Action extends StatelessWidget {
  const _Action({required this.label, required this.onTap, this.icon});

  final String label;
  final VoidCallback onTap;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => unawaited(Future.sync(onTap)),
        child: ConstrainedBox(
          constraints: const BoxConstraints(
            minHeight: _finger,
            minWidth: _finger,
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpace.m),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (icon case final icon?) ...[
                  Icon(icon, size: 16, color: tty.blue),
                  const SizedBox(width: AppSpace.xs),
                ],
                Text(label, style: swarmChatText(14, color: tty.blue)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
