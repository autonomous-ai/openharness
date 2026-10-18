import { describe, expect, it } from 'vitest';
import { secretsInConversation, secretsInFiles } from './secrets';

describe('secret review', () => {
  it('names where a credential appears in the files and the conversation', () => {
    expect(secretsInFiles([
      { path: 'index.html', content: '<h1>Fine</h1>' },
      { path: 'config.json', content: '{ "apiKey": "abcd1234efgh5678" }' },
      { path: 'deploy.md', content: 'AKIAIOSFODNN7EXAMPLE' },
      { path: 'photo.png', content: 'c2stYW50LXNlY3JldA==', encoding: 'base64' },
    ])).toEqual([
      { where: 'config.json', kind: 'a password or secret' },
      { where: 'deploy.md', kind: 'an AWS access key' },
    ]);
    expect(secretsInConversation([{ role: 'user', text: 'Use sk-ant-api03-abcdefghijklmnopqrstuvwxyz' }, { role: 'assistant', text: 'Done.' }]))
      .toEqual([{ where: 'Message 1', kind: 'an AI provider key' }]);
  });
  it('leaves ordinary code alone', () => {
    expect(secretsInFiles([{ path: 'app.js', content: 'const password = input.value; // sk-short' }])).toEqual([]);
  });
});
