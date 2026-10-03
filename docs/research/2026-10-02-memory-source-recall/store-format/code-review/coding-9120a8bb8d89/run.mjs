import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as candidate from './candidate.mjs';
const fixture=JSON.parse(readFileSync(new URL('./checks.json',import.meta.url),'utf8'));
const results=[];
for (const [index,check] of fixture.checks.entries()) { const args=structuredClone(check.args), before=structuredClone(args); try { const actual=candidate[fixture.function](...args); assert.deepEqual(actual,check.expected); assert.deepEqual(args,before); results.push({index,passed:true}); } catch(error) { results.push({index,passed:false,error:error.message}); } }
console.log(JSON.stringify({checks:results,passed:results.every(x=>x.passed)}));
