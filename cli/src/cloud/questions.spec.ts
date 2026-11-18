import { expect, it } from 'vitest'
import { cloudQuestionClose, prepareCloudQuestion } from './questions.js'

it('keeps the legacy public question/close bytes, clips text and choices, and excludes free text from the dial', () => {
  expect(prepareCloudQuestion('cloud_1', 'cloud_q_1', { text: 'Which?', choices: ['main', '', 3, 'dev'] as never })).toEqual({
    frame: { type: 'commander_question', agentId: 'cloud_1', dbSessionId: 'cloud_1', payload: { requestId: 'cloud_q_1',
      questions: [{ key: 'answer', q: 'Which?', options: ['main', 'dev'], multi: false, canText: true }], notification: { id: 'cloud_q_1', kind: 'needsYou' } } },
    close: cloudQuestionClose('cloud_1', 'cloud_q_1'), dial: true,
  })
  const ordinary = prepareCloudQuestion('cloud_1', 'cloud_q_1', { text: 'Which?', choices: ['main', 'dev'] })
  expect(JSON.stringify(ordinary.frame)).toBe('{"type":"commander_question","agentId":"cloud_1","dbSessionId":"cloud_1","payload":{"requestId":"cloud_q_1","questions":[{"key":"answer","q":"Which?","options":["main","dev"],"multi":false,"canText":true}],"notification":{"id":"cloud_q_1","kind":"needsYou"}}}')
  expect(JSON.stringify(ordinary.close)).toBe('{"type":"commander_question_close","agentId":"cloud_1","dbSessionId":"cloud_1","payload":{"requestId":"cloud_q_1"}}')
  const clipped = prepareCloudQuestion('cloud_1', 'cloud_q_1', { text: 'x'.repeat(501), choices: Array(8).fill('y'.repeat(501)) })
  expect(clipped.frame.payload.questions[0]).toMatchObject({ q: 'x'.repeat(500), options: Array(6).fill('y'.repeat(500)) })
  expect(prepareCloudQuestion('cloud_1', 'cloud_q_1', { text: 'Why?', choices: null as never })).toMatchObject({ dial: false,
    frame: { payload: { questions: [{ options: [] }] } } })
})
