import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'swarm_machines.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_start.dart';
import 'swarm_style.dart';

/// Your devices, from You: the account's computers, each online or
/// not, from the list Swarm's start screens read ([SwarmComputers]); then
/// each Swarm's machines, which its people lend it, with what each can do
/// and runs ([SwarmMachinesSection]) — the drawer's until it went slim (Lead,
/// 2026-10-29). Read only. Desktop's Your devices shows the hardware plugged
/// into computers; the phone has no read of that, so it lists the computers
/// (Tony, 2026-10-28).
class SwarmDevicesPage extends StatelessWidget {
  const SwarmDevicesPage({super.key});

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final computers = SwarmScope.computersOf(context);
    final session = SwarmScope.of(context);
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
              child: ListenWhileInSight(
                listenable: Listenable.merge([?computers, ?session?.inbox]),
                builder: (context) => RefreshIndicator(
                  onRefresh: () async {
                    await Future.wait([
                      ?computers?.recheck(),
                      ?session?.inbox.refresh(),
                    ]);
                  },
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: EdgeInsets.fromLTRB(
                      AppSpace.m,
                      0,
                      AppSpace.m,
                      MediaQuery.paddingOf(context).bottom + 28,
                    ),
                    children: [
                      if (computers != null) ...[
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
                      ..._machines(context, session, first: computers == null),
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

  /// Each Swarm's machines, under its name where there are several.
  List<Widget> _machines(
    BuildContext context,
    SwarmSession? session, {
    required bool first,
  }) {
    final inbox = session?.inbox;
    final swarms = inbox?.swarms ?? const [];
    return [
      for (final (i, swarm) in swarms.indexed)
        if (inbox!.reader(swarm.id) case final reader?)
          Padding(
            padding: EdgeInsets.only(
              top: first && i == 0 ? AppSpace.s : AppSpace.l,
            ),
            child: SwarmMachinesSection(
              key: ValueKey('swarm-machine-section-${swarm.id}'),
              reader: reader,
              swarmName: swarms.length > 1 ? swarm.name : null,
              open: (id) => unawaited(showSwarmMachine(context, reader, id)),
            ),
          ),
    ];
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
    padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
    child: SwarmRow.line('No computers on your account yet.', lines: 2),
  );
}
