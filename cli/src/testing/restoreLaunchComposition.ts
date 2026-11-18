/** Exercise main's actual final restore factory, without starting its daemon composition. */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { buildEngineCommandArgv, buildEngineLaunchArgv, engineLaunchEnv, supportsFirstPrompt, typedFirstPrompt } from '../lib/engineLaunch.js'
import { launchSettingsArgs } from '../engines/kit/launchValues.js'
import { isWindowsHeldPane, windowsPaneLaunch } from '../lib/windows/engineStart.js'
import type { createRestoreLaunch } from '../core/agents/restoreLaunch.js'

const source = ts.createSourceFile('main.ts', readFileSync(new URL('../core/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
let factory: ts.Expression | undefined
const visit = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'restoreLaunch'
    && node.initializer && ts.isCallExpression(node.initializer)) {
    const argument = node.initializer.arguments[0]
    if (argument && ts.isObjectLiteralExpression(argument)) {
      const property = argument.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'launch')
      if (property && ts.isPropertyAssignment(property)) factory = property.initializer
    }
  }
  ts.forEachChild(node, visit)
}
visit(source)
if (!factory) throw new Error('The actual restore launch factory is missing')
const compiled = ts.transpileModule(`(${factory.getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText

export const restoreLaunchComposition = runInNewContext(compiled, {
  process, buildEngineCommandArgv, buildEngineLaunchArgv, engineLaunchEnv, supportsFirstPrompt, typedFirstPrompt,
  launchSettingsArgs, isWindowsHeldPane, windowsPaneLaunch,
}, { timeout: 1000 }) as Parameters<typeof createRestoreLaunch>[0]['launch']
