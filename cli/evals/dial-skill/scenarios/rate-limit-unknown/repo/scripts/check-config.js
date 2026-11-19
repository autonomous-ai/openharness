import { loadPartners, validate } from '../src/partners.js'

const problems = validate(loadPartners())
for (const problem of problems) console.error(`config/partners.yml: ${problem}`)
if (problems.length > 0) process.exit(1)
console.log('config/partners.yml: ok')
