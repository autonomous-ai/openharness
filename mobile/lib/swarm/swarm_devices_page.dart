import 'package:flutter/material.dart';

import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_start.dart';
import 'swarm_style.dart';

/// Your devices, from the drawer: the account's computers, each online or
/// not, from the list Swarm's start screens read ([SwarmComputers]). Read
/// only. Desktop's Your devices shows the hardware plugged into computers;
/// the phone has no read of that, so it lists the computers (Tony,
/// 2026-10-28).
class SwarmDevicesPage extends StatelessWidget {
  const SwarmDevicesPage({super.key});

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final computers = SwarmScope.computersOf(context);
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SwarmTopBar(
              leading: SwarmBackButton(
                onPressed: () => Navigator.of(context).maybePop(),
              ),
              title: 'Your devices',
            ),
            Expanded(
              child: computers == null
                  ? const SizedBox.shrink()
                  : ListenWhileInSight(
                      listenable: computers,
                      builder: (context) => RefreshIndicator(
                        onRefresh: computers.recheck,
                        child: ListView(
                          physics: const AlwaysScrollableScrollPhysics(),
                          padding: EdgeInsets.fromLTRB(
                            12,
                            0,
                            12,
                            MediaQuery.paddingOf(context).bottom + 28,
                          ),
                          children: [
                            const SwarmCaption('Your computers', first: true),
                            switch (computers.computers) {
                              null => SwarmSkeletonRows(
                                id: 'swarm-devices-loading',
                                rows: 3,
                                round: true,
                              ),
                              [] => const _NoComputer(),
                              final list => SwarmGroup(
                                children: [
                                  for (final (i, computer) in list.indexed)
                                    _ComputerRow(
                                      key: ValueKey('swarm-device-$i'),
                                      computer,
                                    ),
                                ],
                              ),
                            },
                          ],
                        ),
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

/// One computer, as a Home row: a dot, its name, and Online or Offline at
/// its right.
class _ComputerRow extends StatelessWidget {
  const _ComputerRow(this.computer, {super.key});

  final SwarmComputer computer;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final online = !computer.away;
    return SwarmRow(
      leading: Container(
        width: 9,
        height: 9,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: online ? AppColors.success : null,
          border: online
              ? null
              : Border.all(color: AppPalette.textFaint, width: 1.5),
        ),
      ),
      title: computer.name,
      trailing: SwarmRow.line(online ? 'Online' : 'Offline'),
      onTap: null,
    );
  }
}

/// No computer: a line under the caption, as Home's empty states are.
class _NoComputer extends StatelessWidget {
  const _NoComputer();

  @override
  Widget build(BuildContext context) => Padding(
    key: const ValueKey('swarm-devices-none'),
    padding: const EdgeInsets.symmetric(horizontal: 4),
    child: SwarmRow.line('No computers on your account yet.', lines: 2),
  );
}
