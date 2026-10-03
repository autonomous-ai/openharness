import 'package:flutter/widgets.dart';

import 'app_icons.dart';

/// The mark for a file of this [name], told by its extension — or, for the
/// few build files that have none, by the name itself. A kind this does not
/// know gets the plain file.
IconData fileTypeIcon(String name) {
  final lower = name.toLowerCase();
  final dot = lower.lastIndexOf('.');
  final key = dot < 0 ? lower : lower.substring(dot + 1);
  return _icons[key] ?? AppIcons.file;
}

/// Each kind's mark, and the extensions that are of that kind.
const _kinds = <(IconData, List<String>)>[
  (
    AppIcons.fileImage,
    [
      'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', //
      'heic', 'heif', 'avif', 'ico', 'svg', 'psd', 'fig', 'sketch',
    ],
  ),
  (AppIcons.filePlay, ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi']),
  (AppIcons.fileMusic, ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus']),
  (
    AppIcons.fileArchive,
    [
      'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', //
      'dmg', 'iso', 'jar', 'apk', 'ipa',
    ],
  ),
  (AppIcons.fileText, ['pdf', 'doc', 'docx', 'rtf', 'odt', 'pages', 'epub']),
  (AppIcons.fileType, ['txt', 'md', 'markdown', 'mdx', 'rst', 'log']),
  (AppIcons.fileSpreadsheet, ['csv', 'tsv', 'xls', 'xlsx', 'numbers', 'ods']),
  (AppIcons.presentation, ['ppt', 'pptx', 'key', 'odp']),
  (
    AppIcons.fileCode,
    [
      'dart', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', //
      'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'm', 'mm', //
      'cs', 'rb', 'php', 'lua', 'r', 'html', 'css', 'scss', 'vue', //
      'svelte', 'sql', 'ipynb', 'makefile', 'dockerfile',
    ],
  ),
  (
    AppIcons.fileBraces,
    [
      'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'plist', 'ini', //
      'env', 'lock', 'conf',
    ],
  ),
  (
    AppIcons.fileTerminal,
    ['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'command'],
  ),
  (AppIcons.fileDiff, ['diff', 'patch']),
  (AppIcons.database, ['db', 'sqlite', 'sqlite3']),
];

final _icons = <String, IconData>{
  for (final (icon, extensions) in _kinds)
    for (final extension in extensions) extension: icon,
};
