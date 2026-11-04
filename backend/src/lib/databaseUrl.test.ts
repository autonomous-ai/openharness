import { describe, expect, it } from 'vitest'
import { secondaryReadsUrl, withPoolDefaults } from './databaseUrl.js'

const defaults = { maxPoolSize: 20, serverSelectionTimeoutMS: 10000 }

describe('withPoolDefaults', () => {
  it('adds the pool size and server selection timeout to a connection string with other options', () => {
    expect(withPoolDefaults('mongodb://localhost:27017/harness?replicaSet=rs0', defaults))
      .toBe('mongodb://localhost:27017/harness?replicaSet=rs0&maxPoolSize=20&serverSelectionTimeoutMS=10000')
  })

  it('adds them to one with no options, after the database', () => {
    expect(withPoolDefaults('mongodb+srv://user:p%40ss@cluster.example.net/harness', defaults))
      .toBe('mongodb+srv://user:p%40ss@cluster.example.net/harness?maxPoolSize=20&serverSelectionTimeoutMS=10000')
  })

  it('adds the path the options need to one with no database', () => {
    expect(withPoolDefaults('mongodb://a.example:27017,b.example:27017', defaults))
      .toBe('mongodb://a.example:27017,b.example:27017/?maxPoolSize=20&serverSelectionTimeoutMS=10000')
  })

  it('keeps what the connection string already sets, in any letter case', () => {
    expect(withPoolDefaults('mongodb://h/db?maxpoolsize=50&ServerSelectionTimeoutMS=3000', defaults)).toBe('mongodb://h/db?maxpoolsize=50&ServerSelectionTimeoutMS=3000')
    expect(withPoolDefaults('mongodb://h/db?maxPoolSize=50', defaults)).toBe('mongodb://h/db?maxPoolSize=50&serverSelectionTimeoutMS=10000')
  })
})

describe('secondaryReadsUrl', () => {
  const set = 'readPreference=secondaryPreferred&maxStalenessSeconds=90&appName=autonomous-code-prod-secondary'

  it('adds the three options to a connection string with none, after the database', () => {
    expect(secondaryReadsUrl('mongodb+srv://user:p%40ss@cluster.example.net/harness')).toBe(`mongodb+srv://user:p%40ss@cluster.example.net/harness?${set}`)
  })

  it('adds the path the options need to one with no database', () => {
    expect(secondaryReadsUrl('mongodb+srv://user:pw@cluster.example.net')).toBe(`mongodb+srv://user:pw@cluster.example.net/?${set}`)
  })

  it('keeps every other option and replaces its own, in any letter case, where they stood', () => {
    expect(secondaryReadsUrl('mongodb+srv://u:pw@c.example.net/harness?retryWrites=true&w=majority&appname=autonomous-code-prod&ReadPreference=primary'))
      .toBe('mongodb+srv://u:pw@c.example.net/harness?retryWrites=true&w=majority&appName=autonomous-code-prod-secondary&readPreference=secondaryPreferred&maxStalenessSeconds=90')
    expect(secondaryReadsUrl('mongodb://localhost:27017/harness?replicaSet=rs0&maxStalenessSeconds=120'))
      .toBe('mongodb://localhost:27017/harness?replicaSet=rs0&maxStalenessSeconds=90&readPreference=secondaryPreferred&appName=autonomous-code-prod-secondary')
  })

  it('leaves the main string as it is', () => {
    const main = 'mongodb://localhost:27017/harness?replicaSet=rs0'
    secondaryReadsUrl(main)
    expect(main).toBe('mongodb://localhost:27017/harness?replicaSet=rs0')
  })
})
