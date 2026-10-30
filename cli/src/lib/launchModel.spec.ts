import { describe, expect, it } from 'vitest'
import { launchModelArgs, launchModelEngines, parseLaunchModel } from './launchModel.js'

describe('parseLaunchModel', () => {
  it('is absent when neither field is sent, or both are null', () => {
    expect(parseLaunchModel('claude', {})).toStrictEqual({ state: 'absent' })
    expect(parseLaunchModel('claude', { model: null, effort: null })).toStrictEqual({ state: 'absent' })
  })

  it('accepts a Claude model and effort', () => {
    expect(parseLaunchModel('claude', { model: 'opus', effort: 'high' })).toStrictEqual({ state: 'ok', launchModel: { model: 'opus', effort: 'high' } })
    expect(parseLaunchModel('claude', { model: ' claude-opus-5[1m] ' })).toStrictEqual({ state: 'ok', launchModel: { model: 'claude-opus-5[1m]', effort: null } })
    expect(parseLaunchModel('claude', { effort: 'max' })).toStrictEqual({ state: 'ok', launchModel: { model: null, effort: 'max' } })
  })

  it('treats default (and an automatic effort) as nothing to launch with', () => {
    expect(parseLaunchModel('claude', { model: 'default', effort: 'default' })).toStrictEqual({ state: 'absent' })
    expect(parseLaunchModel('claude', { model: 'opus', effort: 'auto' })).toStrictEqual({ state: 'ok', launchModel: { model: 'opus', effort: null } })
    expect(parseLaunchModel('claude', { model: 'default', effort: 'low' })).toStrictEqual({ state: 'ok', launchModel: { model: null, effort: 'low' } })
    // The same answer for an engine without support: nothing is asked of it.
    expect(parseLaunchModel('codex', { model: 'default', effort: 'default' })).toStrictEqual({ state: 'absent' })
  })

  it.each([
    { model: 7 }, { model: '' }, { model: '   ' }, { model: 'opus; rm -rf ~' }, { model: '--settings' }, { model: '$(id)' },
    { model: 'a b' }, { model: 'x'.repeat(65) }, { model: 'opus\nsonnet' },
    { effort: 3 }, { effort: 'enormous' }, { effort: 'high; ls' }, { effort: '--model' }, { effort: '' },
  ])('refuses %j as invalid', (payload) => {
    expect(parseLaunchModel('claude', payload)).toMatchObject({ state: 'invalid', detail: expect.any(String) })
  })

  it('refuses an engine that cannot take a launch model', () => {
    expect(parseLaunchModel('codex', { model: 'gpt-5', effort: 'high' })).toMatchObject({ state: 'unsupported', detail: expect.stringContaining('codex') })
    expect(parseLaunchModel('terminal', { model: 'opus' })).toMatchObject({ state: 'unsupported' })
  })

  it('checks the shape before the engine, so a malformed value is never called unsupported', () => {
    expect(parseLaunchModel('codex', { model: 'a b' })).toMatchObject({ state: 'invalid' })
  })
})

describe('launchModelArgs', () => {
  it('is the model alone', () => {
    expect(launchModelArgs('claude', { model: 'opus', effort: null })).toStrictEqual(['--model', 'opus'])
  })

  it('is the model and the effort, each its own argv item', () => {
    expect(launchModelArgs('claude', { model: 'claude-opus-5[1m]', effort: 'xhigh' })).toStrictEqual(['--model', 'claude-opus-5[1m]', '--effort', 'xhigh'])
  })

  it('is the effort alone', () => {
    expect(launchModelArgs('claude', { model: null, effort: 'low' })).toStrictEqual(['--effort', 'low'])
  })

  it('skips default and keeps a value with a replacement pattern as written', () => {
    expect(launchModelArgs('claude', { model: 'default', effort: 'default' })).toStrictEqual([])
    expect(launchModelArgs('claude', { model: 'a$&b', effort: null })).toStrictEqual(['--model', 'a$&b'])
  })

  it('names nothing for an engine without support', () => {
    expect(launchModelArgs('codex', { model: 'gpt-5', effort: 'high' })).toStrictEqual([])
  })
})

it('names the engines that take a launch model', () => {
  expect(launchModelEngines()).toStrictEqual(['claude'])
})
