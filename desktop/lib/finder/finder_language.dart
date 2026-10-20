import 'package:path/path.dart' as p;

/// The highlighter's language for a file, told the way Orca's
/// `detectLanguage` tells it: an exact file name first (`Dockerfile`,
/// `.gitignore`), then its extension. Null is plain text.
///
/// Ids are re_highlight's (`builtinAllLanguages`), so a value here always
/// names a grammar the editor has.
String? finderLanguageOf(String path) {
  final name = p.basename(path);
  final lower = name.toLowerCase();
  final byName = _byName[name] ?? _byName[lower];
  if (byName != null) return byName;
  if (lower.startsWith('.env')) return 'ini';
  if (lower.startsWith('dockerfile')) return 'dockerfile';
  final dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  return _byExtension[lower.substring(dot + 1)];
}

const _byName = {
  'Dockerfile': 'dockerfile',
  'Makefile': 'makefile',
  'makefile': 'makefile',
  'GNUmakefile': 'makefile',
  'CMakeLists.txt': 'cmake',
  'Gemfile': 'ruby',
  'Rakefile': 'ruby',
  'Podfile': 'ruby',
  'Brewfile': 'ruby',
  'Vagrantfile': 'ruby',
  'Justfile': 'makefile',
  'justfile': 'makefile',
  '.gitignore': 'bash',
  '.dockerignore': 'bash',
  '.gitattributes': 'bash',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash',
  'nginx.conf': 'nginx',
};

const _byExtension = {
  'dart': 'dart',
  'ts': 'typescript', 'tsx': 'typescript', 'mts': 'typescript', //
  'cts': 'typescript',
  'js': 'javascript', 'jsx': 'javascript', 'mjs': 'javascript',
  'cjs': 'javascript',
  'json': 'json', 'jsonc': 'json', 'json5': 'json', 'jsonl': 'json',
  'ipynb': 'json', 'lock': 'json',
  'py': 'python', 'pyi': 'python', 'pyw': 'python',
  'go': 'go', 'rs': 'rust', 'swift': 'swift', 'kt': 'kotlin', 'kts': 'kotlin',
  'java': 'java', 'scala': 'scala', 'groovy': 'groovy', 'gradle': 'gradle',
  'c': 'c', 'h': 'c', 'cc': 'cpp', 'cpp': 'cpp', 'cxx': 'cpp', 'hpp': 'cpp',
  'hh': 'cpp', 'ino': 'arduino', 'm': 'objectivec', 'mm': 'objectivec',
  'cs': 'csharp', 'fs': 'fsharp', 'vb': 'vbnet',
  'rb': 'ruby', 'erb': 'erb', 'php': 'php', 'pl': 'perl', 'lua': 'lua',
  'r': 'r', 'jl': 'julia', 'ex': 'elixir', 'exs': 'elixir', 'erl': 'erlang',
  'hs': 'haskell', 'ml': 'ocaml', 'clj': 'clojure', 'elm': 'elm',
  'zig': 'c', 'nim': 'nim', 'nix': 'nix', 'v': 'verilog', 'sv': 'verilog',
  'vhd': 'vhdl', 'vhdl': 'vhdl', 'glsl': 'glsl', 'wgsl': 'glsl',
  'html': 'xml', 'htm': 'xml', 'xhtml': 'xml', 'xml': 'xml', 'svg': 'xml',
  'plist': 'xml', 'xsd': 'xml', 'vue': 'vue', 'svelte': 'xml',
  'css': 'css', 'scss': 'scss', 'sass': 'scss', 'less': 'less',
  'styl': 'stylus',
  'md': 'markdown', 'markdown': 'markdown', 'mdx': 'markdown',
  'yaml': 'yaml', 'yml': 'yaml', 'toml': 'ini', 'ini': 'ini', 'cfg': 'ini',
  'conf': 'ini', 'properties': 'properties', 'env': 'ini',
  'sh': 'bash', 'bash': 'bash', 'zsh': 'bash', 'fish': 'bash',
  'command': 'bash', 'ps1': 'powershell', 'bat': 'dos', 'cmd': 'dos',
  'sql': 'sql', 'graphql': 'graphql', 'gql': 'graphql', 'prisma': 'graphql',
  'proto': 'protobuf', 'thrift': 'thrift', 'tf': 'ini', 'hcl': 'ini',
  'diff': 'diff', 'patch': 'diff', 'tex': 'latex', 'cmake': 'cmake',
  'mk': 'makefile', 'scad': 'openscad', 'wat': 'wasm', 'asm': 'x86asm',
  's': 'armasm',
};
