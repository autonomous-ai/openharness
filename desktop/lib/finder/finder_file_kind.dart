import 'dart:typed_data';

import 'package:path/path.dart' as p;

/// What a file is, as far as which view opens it is concerned.
enum FinderFileKind { text, markdown, image, svg, other }

/// What the preview can draw, told by the name. [FinderFileKind.other] is not
/// "unsupported" yet: a file with no known extension is read and SNIFFED
/// ([looksLikeText]), because `LICENSE`, `Makefile` and `.env` are text.
FinderFileKind finderFileKind(String path) {
  final name = p.basename(path).toLowerCase();
  final dot = name.lastIndexOf('.');
  final extension = dot < 0 ? '' : name.substring(dot + 1);
  if (_markdown.contains(extension)) return FinderFileKind.markdown;
  if (extension == 'svg') return FinderFileKind.svg;
  if (_images.contains(extension)) return FinderFileKind.image;
  if (_binary.contains(extension)) return FinderFileKind.other;
  if (_text.contains(extension) || _textNames.contains(name)) {
    return FinderFileKind.text;
  }
  return FinderFileKind.other;
}

/// Whether [head] — a file's first bytes — reads as text: no NUL byte, and
/// few enough control characters that it is not a binary format.
bool looksLikeText(Uint8List head) {
  if (head.isEmpty) return true;
  var control = 0;
  for (final byte in head) {
    if (byte == 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control++;
  }
  return control * 100 < head.length * 2;
}

const _markdown = {'md', 'markdown', 'mdx'};

/// The formats Flutter's own image codecs decode on every desktop target.
const _images = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'wbmp'};

/// Extensions never worth sniffing: they are binary even when their first
/// bytes happen to look like text.
const _binary = {
  'pdf', 'zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'zst', '7z', 'rar', //
  'dmg', 'iso', 'jar', 'apk', 'ipa', 'exe', 'dll', 'so', 'dylib', 'o', 'a',
  'class', 'wasm', 'mp3', 'mp4', 'mov', 'm4a', 'wav', 'flac', 'ogg', 'webm',
  'mkv', 'avi', 'heic', 'heif', 'avif', 'tif', 'tiff', 'psd', 'sketch',
  'fig', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'numbers',
  'pages', 'sqlite', 'sqlite3', 'db', 'ttf', 'otf', 'woff', 'woff2',
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
