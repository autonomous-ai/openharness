import 'package:flutter/material.dart';

import 'swarm_reader.dart';

bool swarmHasWorkDetails(SwarmReader reader, String chatId) => true;

class SwarmWorkDetailsPage extends StatelessWidget {
  const SwarmWorkDetailsPage({
    super.key,
    required this.reader,
    required this.chatId,
  });

  final SwarmReader reader;
  final String chatId;

  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}
