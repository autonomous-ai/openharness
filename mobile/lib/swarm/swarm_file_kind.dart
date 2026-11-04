import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'model.dart';

/// The largest chat file read into the text viewer (the desktop's
/// `kAttachmentTextMaxBytes`); a bigger one opens in the browser. Specs and
/// logs sit well under it, though a message's file may weigh up to 256 MB.
const swarmTextMaxBytes = 2 * 1024 * 1024;

/// What a chat file is, as far as which view opens it is concerned.
enum SwarmFileKind { text, markdown, other }

/// [name]'s kind, told by its extension, or by the whole name for the few
/// text files that have none (`Makefile`, `LICENSE`): the desktop's
/// `finderFileKind`, less the pictures, which a chat shows in place.
SwarmFileKind swarmFileKind(String name) {
  final lower = _base(name);
  final dot = lower.lastIndexOf('.');
  final extension = dot < 0 ? '' : lower.substring(dot + 1);
  if (_markdown.contains(extension)) return SwarmFileKind.markdown;
  if (_binary.contains(extension)) return SwarmFileKind.other;
  if (_text.contains(extension) || _textNames.contains(lower)) {
    return SwarmFileKind.text;
  }
  return SwarmFileKind.other;
}

/// Whether [file] opens in the text viewer: text by its name and small enough
/// to read in place (the desktop's `opensAsText`). Every other file opens in
/// the browser.
bool swarmOpensAsText(SuperTabAttachment file) =>
    file.size <= swarmTextMaxBytes &&
    swarmFileKind(file.name) != SwarmFileKind.other;

/// Whether [bytes] read as text: no NUL byte, and few enough control
/// characters that it is not a binary format (the desktop's `looksLikeText`).
bool swarmLooksLikeText(Uint8List bytes) {
  if (bytes.isEmpty) return true;
  var control = 0;
  for (final byte in bytes) {
    if (byte == 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control++;
  }
  return control * 100 < bytes.length * 2;
}

/// The mark for a file named [name], told by its extension, or for the few
/// build files that have none by the name itself; a kind this does not know
/// gets the plain file. The desktop's `fileTypeIcon`, mark for mark.
IconData swarmFileIcon(String name) {
  final lower = _base(name);
  final dot = lower.lastIndexOf('.');
  final key = dot < 0 ? lower : lower.substring(dot + 1);
  return _icons[key] ?? LucideIcons.file;
}

/// [name] without any folder a sender's row put before it, in lower case.
String _base(String name) {
  final lower = name.toLowerCase();
  final slash = lower.lastIndexOf(RegExp(r'[/\\]'));
  return slash < 0 ? lower : lower.substring(slash + 1);
}

const _markdown = {'md', 'markdown', 'mdx'};

/// Extensions never worth reading as text: they are binary even when their
/// first bytes happen to look like text.
const _binary = {
  'pdf', 'zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'zst', '7z', 'rar', //
  'dmg', 'iso', 'jar', 'apk', 'ipa', 'exe', 'dll', 'so', 'dylib', 'o', 'a',
  'class', 'wasm', 'mp3', 'mp4', 'mov', 'm4a', 'wav', 'flac', 'ogg', 'webm',
  'mkv', 'avi', 'heic', 'heif', 'avif', 'tif', 'tiff', 'psd', 'sketch',
  'fig', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'numbers',
  'pages', 'sqlite', 'sqlite3', 'db', 'ttf', 'otf', 'woff', 'woff2', //
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'wbmp', 'svg',
};

const _text = {
  'txt', 'log', 'rst', 'csv', 'tsv', 'diff', 'patch', //
  'json', 'jsonl', 'json5', 'yaml', 'yml', 'toml', 'xml', 'plist', 'ini',
  'env', 'lock', 'conf', 'cfg', 'properties', 'gradle', 'cmake',
  'dart', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java',
  'kt', 'kts', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'm', 'mm', 'cs', 'rb',
  'php', 'lua', 'r', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue',
  'svelte', 'sql', 'graphql', 'gql', 'proto', 'ipynb', 'sh', 'bash', 'zsh',
  'fish', 'ps1', 'bat', 'command', 'tf', 'hcl', 'nix', 'ex', 'exs', 'erl',
  'hs', 'ml', 'clj', 'scala', 'zig', 'v', 'sv', 'vhd', 'ino', 'gitignore',
  'gitattributes', 'editorconfig', 'npmrc', 'nvmrc', 'prettierrc',
  'eslintrc', 'babelrc', 'dockerignore', 'srt', 'vtt', 'tex', 'bib',
};

const _textNames = {
  'makefile', 'dockerfile', 'license', 'licence', 'readme', 'changelog', //
  'procfile', 'gemfile', 'rakefile', 'podfile', 'brewfile', 'justfile',
  'codeowners', 'authors', 'notice',
};

/// Each kind's mark, and the extensions that are of that kind.
const _kinds = <(IconData, List<String>)>[
  (
    LucideIcons.fileImage,
    [
      'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', //
      'heic', 'heif', 'avif', 'ico', 'svg', 'psd', 'fig', 'sketch',
    ],
  ),
  (LucideIcons.filePlay, ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi']),
  (LucideIcons.fileMusic, ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus']),
  (
    LucideIcons.fileArchive,
    [
      'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', //
      'dmg', 'iso', 'jar', 'apk', 'ipa',
    ],
  ),
  (LucideIcons.fileText, ['pdf', 'doc', 'docx', 'rtf', 'odt', 'pages', 'epub']),
  (LucideIcons.fileType, ['txt', 'md', 'markdown', 'mdx', 'rst', 'log']),
  (
    LucideIcons.fileSpreadsheet,
    ['csv', 'tsv', 'xls', 'xlsx', 'numbers', 'ods'],
  ),
  (LucideIcons.presentation, ['ppt', 'pptx', 'key', 'odp']),
  (
    LucideIcons.fileCode,
    [
      'dart', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', //
      'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'm', 'mm', //
      'cs', 'rb', 'php', 'lua', 'r', 'html', 'css', 'scss', 'vue', //
      'svelte', 'sql', 'ipynb', 'makefile', 'dockerfile',
    ],
  ),
  (
    LucideIcons.fileBraces,
    [
      'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'plist', 'ini', //
      'env', 'lock', 'conf',
    ],
  ),
  (
    LucideIcons.fileTerminal,
    ['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'command'],
  ),
  (LucideIcons.fileDiff, ['diff', 'patch']),
  (LucideIcons.database, ['db', 'sqlite', 'sqlite3']),
];

final _icons = <String, IconData>{
  for (final (icon, extensions) in _kinds)
    for (final extension in extensions) extension: icon,
};
