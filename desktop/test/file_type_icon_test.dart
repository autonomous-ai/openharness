import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/file_type_icon.dart';
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/widgets/new_harness_attachments.dart';

void main() {
  test('a file is marked by its kind', () {
    const kinds = {
      'photo.heic': AppIcons.fileImage,
      'logo.svg': AppIcons.fileImage,
      'demo.mov': AppIcons.filePlay,
      'voice.m4a': AppIcons.fileMusic,
      'build.tar.gz': AppIcons.fileArchive,
      'spec.pdf': AppIcons.fileText,
      'brief.docx': AppIcons.fileText,
      'README.md': AppIcons.fileType,
      'server.log': AppIcons.fileType,
      'users.csv': AppIcons.fileSpreadsheet,
      'q3.xlsx': AppIcons.fileSpreadsheet,
      'pitch.pptx': AppIcons.presentation,
      'main.dart': AppIcons.fileCode,
      'App.tsx': AppIcons.fileCode,
      'package.json': AppIcons.fileBraces,
      'pubspec.yaml': AppIcons.fileBraces,
      '.env': AppIcons.fileBraces,
      'deploy.sh': AppIcons.fileTerminal,
      'fix.patch': AppIcons.fileDiff,
      'app.sqlite': AppIcons.database,
    };
    for (final MapEntry(key: name, value: icon) in kinds.entries) {
      expect(fileTypeIcon(name), icon, reason: name);
    }
  });

  test('the extension is read whatever its case, and only the last one', () {
    expect(fileTypeIcon('REPORT.PDF'), AppIcons.fileText);
    expect(fileTypeIcon('notes.pdf.txt'), AppIcons.fileType);
  });

  test('build files with no extension are known by name', () {
    expect(fileTypeIcon('Makefile'), AppIcons.fileCode);
    expect(fileTypeIcon('Dockerfile'), AppIcons.fileCode);
  });

  test('a kind nobody listed is the plain file', () {
    for (final name in ['LICENSE', 'data.bin', 'archive.', '.gitignore', '']) {
      expect(fileTypeIcon(name), AppIcons.file, reason: name);
    }
  });

  testWidgets("an attached file's chip wears its kind's mark", (tester) async {
    final files = HarnessAttachments()
      ..add([
        HarnessAttachment('spec.pdf', Uint8List.fromList(utf8.encode('%PDF'))),
        HarnessAttachment('main.dart', Uint8List.fromList(utf8.encode('//'))),
      ]);
    addTearDown(files.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: NewHarnessAttachmentChips(attachments: files, enabled: true),
        ),
      ),
    );
    IconData? mark(String name) => tester
        .widget<Icon>(find.byKey(ValueKey('new-harness-attachment-icon:$name')))
        .icon;
    expect(mark('spec.pdf'), AppIcons.fileText);
    expect(mark('main.dart'), AppIcons.fileCode);
  });
}
