import type { ConversationTurn, SourceFile } from './types';

export type SecretFinding = { where: string; kind: string };

/** Shapes a credential has when someone pastes or prints one. A hint for review, not a guarantee. */
const patterns: { kind: string; pattern: RegExp }[] = [
  { kind: 'a private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'an AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'a GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { kind: 'an AI provider key', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  { kind: 'a Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'a Stripe key', pattern: /\b[rs]k_live_[0-9A-Za-z]{20,}/ },
  { kind: 'a sign-in token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { kind: 'a password or secret', pattern: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i },
];

/** Where the text files and the conversation look like they hold a credential. */
export function findSecrets(files: SourceFile[], conversation: ConversationTurn[]): SecretFinding[] {
  const places = [
    ...files.filter(file => !file.encoding).map(file => ({ where: file.path, text: file.content })),
    ...conversation.map((turn, index) => ({ where: `Message ${index + 1}`, text: turn.text })),
  ];
  return places.flatMap(({ where, text }) => patterns.filter(({ pattern }) => pattern.test(text)).map(({ kind }) => ({ where, kind })));
}
