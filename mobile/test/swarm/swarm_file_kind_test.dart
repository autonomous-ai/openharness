import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_file_kind.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// A chat file's kind, as the desktop tells it: the mark its chip wears, and
/// whether it opens in the app's text viewer or in the browser.
void main() {
  SuperTabAttachment file(String name, {int size = 2048}) =>
      SuperTabAttachment.fromJson({
        'id': 'f1',
        'name': name,
        'mime': 'application/octet-stream',
        'size': size,
        'url': '',
      });

  test('each kind wears the desktop mark', () {
    final marks = {
      'shot.PNG': LucideIcons.fileImage,
      'clip.mov': LucideIcons.filePlay,
      'note.m4a': LucideIcons.fileMusic,
      'build.tar.gz': LucideIcons.fileArchive,
      'plan.pdf': LucideIcons.fileText,
      'notes.txt': LucideIcons.fileType,
      'README.md': LucideIcons.fileType,
      'numbers.csv': LucideIcons.fileSpreadsheet,
      'deck.pptx': LucideIcons.presentation,
      'main.dart': LucideIcons.fileCode,
      'Makefile': LucideIcons.fileCode,
      'Dockerfile': LucideIcons.fileCode,
      'package.json': LucideIcons.fileBraces,
      'run.sh': LucideIcons.fileTerminal,
      'fix.patch': LucideIcons.fileDiff,
      'app.sqlite': LucideIcons.database,
    };
    for (final MapEntry(key: name, value: mark) in marks.entries) {
      expect(swarmFileIcon(name), mark, reason: name);
    }
  });

  test('a kind it does not know, or no name, is the plain file', () {
    for (final name in ['thing.xyz', 'LICENSE', '', 'archive.', '.']) {
      expect(swarmFileIcon(name), LucideIcons.file, reason: '"$name"');
    }
  });

  test('a folder in the name is not its kind', () {
    expect(swarmFileIcon('docs.md/plan.pdf'), LucideIcons.fileText);
    expect(swarmFileKind(r'logs\run.log'), SwarmFileKind.text);
  });

  test('text and Markdown by name, everything else not', () {
    expect(swarmFileKind('spec.md'), SwarmFileKind.markdown);
    expect(swarmFileKind('SPEC.MARKDOWN'), SwarmFileKind.markdown);
    expect(swarmFileKind('page.mdx'), SwarmFileKind.markdown);
    for (final name in [
      'notes.txt',
      'server.log',
      'data.csv',
      'config.yaml',
      'main.dart',
      'LICENSE',
      'Makefile',
      '.gitignore',
    ]) {
      expect(swarmFileKind(name), SwarmFileKind.text, reason: name);
    }
    for (final name in [
      'plan.pdf',
      'shot.png',
      'logo.svg',
      'build.zip',
      'deck.pptx',
      'thing.xyz',
      'noextension',
    ]) {
      expect(swarmFileKind(name), SwarmFileKind.other, reason: name);
    }
  });

  test('only text up to 2 MB opens in the viewer', () {
    expect(swarmOpensAsText(file('notes.txt')), isTrue);
    expect(swarmOpensAsText(file('spec.md', size: swarmTextMaxBytes)), isTrue);
    expect(
      swarmOpensAsText(file('spec.md', size: swarmTextMaxBytes + 1)),
      isFalse,
    );
    expect(swarmOpensAsText(file('plan.pdf')), isFalse);
    expect(swarmOpensAsText(file('shot.png')), isFalse);
    expect(swarmTextMaxBytes, 2 * 1024 * 1024, reason: "the desktop's limit");
  });

  test('reads as text: no NUL, and few control characters', () {
    Uint8List bytes(List<int> list) => Uint8List.fromList(list);
    expect(swarmLooksLikeText(bytes([])), isTrue);
    expect(swarmLooksLikeText(utf8.encode('# Plan\n\tTiếng Việt\r\n')), isTrue);
    expect(swarmLooksLikeText(bytes([0x50, 0x4b, 0x03, 0x04, 0])), isFalse);
    // One control character in a hundred passes; one in ten does not.
    expect(swarmLooksLikeText(bytes([...List.filled(99, 0x41), 1])), isTrue);
    expect(swarmLooksLikeText(bytes([...List.filled(9, 0x41), 1])), isFalse);
  });
}
