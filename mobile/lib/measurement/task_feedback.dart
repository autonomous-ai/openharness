import 'package:flutter/material.dart';

import '../shared/widgets/product_feedback.dart';
import '../terminal/terminal_look.dart';

Future<void> showTaskFeedback(
  BuildContext context, {
  required Future<Map<String, dynamic>> Function() choice,
  required ProductFeedbackRequest send,
}) async {
  final permitted = choice();
  await showDialog<void>(
    // The app's dialog even from a terminal's menu — see [TerminalLook.outside].
    context: TerminalLook.outside(context),
    builder: (context) => AlertDialog(
      title: const Text('Rate task outcome'),
      content: SingleChildScrollView(
        child: FutureBuilder(
          future: permitted,
          builder: (context, snapshot) =>
              snapshot.connectionState != ConnectionState.done
              ? const Text('Checking your sharing preference…')
              : snapshot.hasError
              ? const Text('Couldn’t check your sharing preference. Try again.')
              : snapshot.data?['enabled'] != true
              ? const Text(
                  'Product usage sharing is off. You can change it in Settings → Privacy.',
                )
              : Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    ProductFeedback(
                      key: const ValueKey('outcome'),
                      send: send,
                      outcome: true,
                    ),
                    ProductFeedback(key: const ValueKey('reason'), send: send),
                  ],
                ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Close'),
        ),
      ],
    ),
  );
}
