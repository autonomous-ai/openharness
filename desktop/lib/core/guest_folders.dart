/// Where a guest may start a harness on a machine shared with it (CLI services/sharedMachines.ts
/// `guest_folders`, docs/plans/2026-10-19-guest-machine-sharing-plan.md): its own workspace, and the
/// folders the machine's owner shares with guests, read only or editable.
library;

import 'package:flutter/foundation.dart';

@immutable
class GuestFolder {
  const GuestFolder({required this.path, required this.write});
  final String path;

  /// Whether the guest may change what is in it, not only read it.
  final bool write;
}

@immutable
class GuestFolders {
  const GuestFolders({this.workspace, this.folders = const []});

  /// The guest's own folder there, where a harness starts unless it picks a shared one.
  final String? workspace;
  final List<GuestFolder> folders;

  /// The machine's answer; what is not a folder in it is left out.
  factory GuestFolders.fromJson(Map<String, dynamic> json) => GuestFolders(
    workspace: json['workspace'] is String ? json['workspace'] as String : null,
    folders: [
      for (final folder in json['folders'] as List? ?? const [])
        if (folder is Map &&
            folder['path'] is String &&
            (folder['path'] as String).startsWith('/'))
          GuestFolder(
            path: folder['path'] as String,
            write: folder['write'] == true,
          ),
    ],
  );
}
