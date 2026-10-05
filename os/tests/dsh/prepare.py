#!/usr/bin/env python3
"""Create disposable DSHs from the repository's real shared components."""
import json
from pathlib import Path
import shutil
import sys

components, root = map(Path, sys.argv[1:])
packages = root / 'packages'
packages.mkdir(parents=True, exist_ok=True)


def write(folder, name, text):
    path = folder / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def manifest(name, title, viewer=None):
    # A disposable guest has no provider credentials. Leave model selection to
    # upstream defaults. OpenCode 2's interactive command rejects --agent;
    # these tasks need no custom primary agent, only bounded test permissions.
    config = {'permission': {'question': 'deny', 'task': 'deny'}}
    result = {'spec': 1, 'id': f'os-lab/{name}', 'name': title, 'category': 'OS acceptance',
              'author': 'Harness OS test', 'engine': 'opencode',
              'workspace': {'template': 'template', 'marker': 'TASK.txt'},
              'agent': {'instructions': 'AGENTS.md',
                        'env': {'DSH_PERMISSION_MODE': 'auto', 'OPENCODE_CONFIG_CONTENT': json.dumps(config)}}}
    if viewer:
        result['viewer'] = {'use': viewer}
    return result


hello = packages / 'hello'
shutil.copytree(components / 'examples/hello-world', hello, dirs_exist_ok=True)
write(hello, 'harness.json', json.dumps(manifest('hello', 'Hello Harness', 'autonomous/web-viewer')))
write(hello, 'template/TASK.txt', 'Change the existing heading in index.html to Hello, Ada! Preserve the rest of the page. Read the saved file back. Do not ask questions or use subagents.\n')

logs = packages / 'logs'
write(logs, 'harness.json', json.dumps(manifest('logs', 'Terminal Log Counter')))
write(logs, 'AGENTS.md', 'Build small Python command-line tools. Use the standard library, run tests, and report real results. Read TASK.txt and work inside this project. No questions or subagents.\n')
write(logs, 'template/TASK.txt', 'Create count.py accepting a CSV path (or - for stdin). Count rows by the kind column and print a JSON object. Write unittest tests for empty input and aggregation and run them. Run count.py sample.csv and save the output to result.json. Do not modify sample.csv.\n')
write(logs, 'template/sample.csv', 'kind,title\nbug,Missing focus\nfeature,Keyboard shortcut\nbug,Wrong count\n')

game = packages / 'game'
spec = manifest('game', 'Packet Step', 'autonomous/game-viewer')
spec['verdict'] = '.harness/verdict.json'
spec['toolchain'] = {'setup': 'npm install --no-audit --no-fund',
                     'doctor': 'node -e "require.resolve(\'vite\')"'}
write(game, 'harness.json', json.dumps(spec))
write(game, 'package.json', json.dumps({'private': True, 'type': 'module', 'dependencies': {'vite': '6.4.3'}}))
write(game, 'AGENTS.md', 'You maintain a small keyboard game. Preserve the harnessGame bridge and its state schema. Test changes with node --test. Work only inside the project; no questions or subagents.\n')
write(game, 'template/TASK.txt', 'Extend the starter game: pressing R must call the existing restart() function and reset score and position. Add exported resetState() in state.mjs returning {x:1,y:1,score:0}, use it in game.mjs, and add meaningful node:test tests in test.mjs. Run node --test test.mjs and save a short result in agent-result.txt. Keep the viewer bridge, readiness event and existing arrow keys working.\n')
write(game, 'template/index.html', '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Packet Step</title>
<style>*{box-sizing:border-box}body{height:100dvh;margin:0;padding:8px;background:#111821;color:#d3e8ed;font:18px monospace;text-align:center;display:flex;flex-direction:column;align-items:center;gap:6px}canvas{min-height:0;flex:1;width:100%;max-width:600px;object-fit:contain;background:#18232e}h1{font-size:24px;margin:0}p{font-size:15px;margin:0}</style>
<h1>Packet Step</h1><p>Arrow keys move · R restarts · collect the green packet</p><canvas width="600" height="400" tabindex="0" aria-label="Packet Step game"></canvas><p id="score">Score 0</p><script type="module" src="./game.mjs"></script></html>''')
write(game, 'template/studio.json', json.dumps({'title': 'Packet Step', 'description': 'A tiny keyboard game built inside Harness.', 'controls': 'Arrow keys move · R restarts'}))
write(game, 'template/game.mjs', '''const canvas=document.querySelector('canvas'), ctx=canvas.getContext('2d');
let state={x:1,y:1,score:0}, paused=false, mode='explore';
function draw(){ctx.fillStyle='#18232e';ctx.fillRect(0,0,600,400);ctx.strokeStyle='#263746';for(let x=0;x<15;x++)for(let y=0;y<10;y++)ctx.strokeRect(x*40,y*40,40,40);ctx.fillStyle='#73e0a8';ctx.fillRect(3*40+10,50,20,20);ctx.fillStyle='#70bdff';ctx.fillRect(state.x*40+6,state.y*40+6,28,28);document.querySelector('#score').textContent='Score '+state.score;}
function restart(){state={x:1,y:1,score:0};draw();window.dispatchEvent(new CustomEvent('harness:timeline-reset'));}
window.addEventListener('keydown',event=>{if(paused||mode!=='play')return;const delta={ArrowRight:[1,0],ArrowLeft:[-1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];if(!delta)return;event.preventDefault();state.x=Math.max(0,Math.min(14,state.x+delta[0]));state.y=Math.max(0,Math.min(9,state.y+delta[1]));if(state.x===3&&state.y===1)state.score++;draw();});
window.harnessGame={setMode(value){mode=value;canvas.focus();},setPaused(value){paused=value;},restart,stats(){return{score:state.score,player:{x:state.x,y:state.y},paused,objects:2,running:true};},captureState(){return{schema:'packet-step/1',...state};},restoreState(value){if(value.schema!=='packet-step/1'||![value.x,value.y,value.score].every(Number.isFinite))throw Error('Invalid snapshot');state={x:value.x,y:value.y,score:value.score};draw();}};
draw();requestAnimationFrame(()=>window.dispatchEvent(new CustomEvent('harness:ready')));
''')
print(packages)
