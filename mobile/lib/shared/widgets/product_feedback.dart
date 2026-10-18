import 'dart:math';

import 'package:flutter/material.dart';

typedef ProductFeedbackRequest = Future<void> Function(
  String answer,
  String receipt,
);

/// A voluntary, fixed-choice response. It carries no task, account or session context.
class ProductFeedback extends StatefulWidget {
  const ProductFeedback({super.key, required this.send, this.outcome = false});
  final ProductFeedbackRequest send;
  final bool outcome;
  @override
  State<ProductFeedback> createState() => _ProductFeedbackState();
}

class _ProductFeedbackState extends State<ProductFeedback> {
  static const choices = {
    'useful': 'Useful',
    'could_not_finish': 'Couldn’t finish',
    'slow': 'Slow',
    'confusing': 'Confusing',
    'missing_feature': 'Missing a feature',
  };
  static const outcomes = {
    'completed': 'Completed',
    'partly_completed': 'Partly completed',
    'not_completed': 'Not completed',
  };
  final String _receipt = _newReceipt();
  String? _answer, _status;
  bool _busy = false, _sent = false;

  static String _newReceipt() {
    final random = Random.secure();
    final bytes = List.generate(16, (_) => random.nextInt(256));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    final h = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
  }

  Future<void> _send(String answer) async {
    setState(() {
      _busy = true;
      _answer = answer;
      _status = null;
    });
    try {
      await widget.send(answer, _receipt);
      if (mounted) {
        setState(() {
          _sent = true;
          _status = 'Feedback sent. Thank you.';
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _status = 'Couldn’t confirm receipt. You can retry the same answer.';
        });
      }
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
        });
      }
    }
  }

  static ButtonStyle _chosen(BuildContext context) {
    final primary = Theme.of(context).colorScheme.primary;
    return OutlinedButton.styleFrom(
      foregroundColor: primary,
      disabledForegroundColor: primary,
      side: BorderSide(color: primary),
    );
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 24),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          widget.outcome
              ? 'Did you finish what you wanted?'
              : 'How did your latest task go?',
          style: Theme.of(context).textTheme.titleSmall,
        ),
        const SizedBox(height: 8),
        const Text(
          'Optional feedback. Select an answer to share only that choice, without your task or its contents.',
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final choice in (widget.outcome ? outcomes : choices).entries)
              OutlinedButton(
                // The answer given stays marked after it is sent; the others step back.
                style: _answer == choice.key ? _chosen(context) : null,
                onPressed:
                    _busy || _sent || (_answer != null && _answer != choice.key)
                    ? null
                    : () => _send(choice.key),
                child: Text(choice.value),
              ),
          ],
        ),
        if (_status != null) ...[
          const SizedBox(height: 8),
          Text(_status!),
        ],
      ],
    ),
  );
}
