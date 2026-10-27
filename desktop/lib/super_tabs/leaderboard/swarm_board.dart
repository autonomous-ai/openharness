import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/widgets/app_dialog.dart';
import '../../widgets/desktop_chrome.dart';
import '../controller.dart';
import '../identity.dart';
import 'column.dart';
import 'reader.dart';

/// The leaderboard of the Swarm a [SuperTabController] shows: the project of
/// the selected conversation, people named as the roster names them, Answer
/// opening the waiting conversation.
class SuperTabSwarmBoard {
  SuperTabSwarmBoard(this.controller)
    : reader = SuperTabLeaderboardReader(
        tabId: controller.tabId,
        request: controller.request,
      );

  final SuperTabController controller;
  final SuperTabLeaderboardReader reader;

  /// A window this wide, scaled, has room for the column beside People.
  static const columnFrom = 1380.0;

  String get _projectId =>
      controller.snapshot?.projectFor(controller.selectedId)?.id ?? 'lead';

  String _name(String personId) {
    final person = controller.snapshot?.people
        .where((p) => p.id == personId)
        .firstOrNull;
    return person == null ? 'Former member' : superTabPersonName(person.email);
  }

  Widget column({required ValueChanged<String> onAnswer}) =>
      SuperTabLeaderboardColumn(
        reader: reader,
        projectId: _projectId,
        viewerId: controller.accountId,
        nameOf: _name,
        onAnswer: onAnswer,
      );

  /// For a window without room for the column.
  Future<void> showDialog(BuildContext context) => showAppDialog<void>(
    context: context,
    builder: (dialog) => Dialog(
      shape: DesktopChrome.shape(),
      child: SizedBox(
        width: SuperTabLeaderboardColumn.width,
        height: (MediaQuery.sizeOf(dialog).height - 120).clamp(320, 640),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(DesktopChrome.dialogRadius),
          child: column(
            onAnswer: (id) {
              Navigator.of(dialog).pop();
              unawaited(controller.select(id));
            },
          ),
        ),
      ),
    ),
  );

  void dispose() => reader.dispose();
}
