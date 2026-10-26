import 'package:flutter/material.dart';

import 'computer_row.dart';
import 'saved_computers.dart';

/// The computers this browser kept, while the machine list is read: their
/// names only, each checking, and nothing to press until the list answers.
class SavedComputerRows extends StatelessWidget {
  const SavedComputerRows(this.computers, {super.key});

  final List<SavedComputer> computers;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (final computer in computers) ...[
        ComputerRow(
          name: computer.name,
          status: 'Checking…',
          trailing: const ComputerRowSpinner(),
        ),
        const SizedBox(height: 10),
      ],
    ],
  );
}
