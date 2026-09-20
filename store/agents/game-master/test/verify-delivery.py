#!/usr/bin/env python3
"""Independent stdlib ZIP/XML/JSON plus Poppler PDF verification; no Relay imports."""
import json,sys,re,hashlib,subprocess,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
root=Path(sys.argv[1]);report=json.loads((root/'acceptance.json').read_text());results=[]
ns={'s':'http://www.w3.org/2000/svg'}
def canonical(x): return json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False)
def fail(ok,message):
 if not ok: raise AssertionError(message)
for row in report['results']:
 folder=Path(row['folder']);project=json.loads((folder/'project.relay.json').read_text());source=json.loads((folder/'source/project.json').read_text());fail(project['rules']==(folder/'source/rules.mjs').read_text(),'Rules source changed');fail({k:v for k,v in project.items() if k!='rules'}==source,'Bundled source differs')
 with zipfile.ZipFile(folder/'game-kit.zip') as archive:
  fail(archive.testzip() is None,'ZIP CRC failure')
  for name in archive.namelist(): fail(not Path(name).is_absolute() and '..' not in Path(name).parts,'Unsafe archive path')
  fail(archive.read('source/rules.mjs').decode()==project['rules'],'ZIP rules differ')
  for name in ['game.html','print/components.pdf','print/rulebook.pdf','project.relay.json']: fail(archive.read(name)==(folder/name).read_bytes(),'ZIP delivery differs: '+name)
 svg_count=0;copy_count=0
 for c in project['components']:
  svg=ET.parse(folder/'components'/f"{c['id']}.svg").getroot();fail(svg.attrib['width']==f"{c['widthMm']}mm" and svg.attrib['height']==f"{c['heightMm']}mm",'Component physical size differs');svg_count+=1
 for path in sorted((folder/'print').glob('sheet-*.svg')):
  svg=ET.parse(path).getroot();fail(svg.attrib['width']=='210mm' and svg.attrib['height']=='297mm','Print sheet is not A4')
  for group in svg.findall('s:g',ns):
   if 'transform' not in group.attrib: continue
   m=re.fullmatch(r'translate\(([\d.]+) ([\d.]+)\)',group.attrib['transform']);fail(m is not None,'Unknown component placement');x,y=map(float,m.groups());rect=group.find('s:rect',ns);w,h=float(rect.attrib['width']),float(rect.attrib['height']);fail(x>=10 and y>=10 and x+w<=200.001 and y+h<=287.001,'Component extends outside page');copy_count+=1
 fail(copy_count==sum(c['quantity'] for c in project['components']),'Printed inventory differs')
 if project['id']=='signal-garden':
  b=project['boards'][0]
  for c in project['components']:fail(b['widthMm']/b['cols']==c['widthMm'] and (b['heightMm']-12)/b['rows']==c['heightMm'],'Printed tile ports cannot meet across board cells')
 for b in project['boards']:
  svg=ET.parse(folder/'boards'/f"{b['id']}.svg").getroot();fail(svg.attrib['width']==f"{b['widthMm']}mm" and svg.attrib['height']==f"{b['heightMm']}mm",'Board size differs')
 pdfs=[]
 for path in sorted(folder.rglob('*.pdf')):
  info=subprocess.check_output(['pdfinfo',str(path)],text=True);pages=int(re.search(r'Pages:\s+(\d+)',info).group(1));fail(pages>0,'Empty PDF');box=subprocess.check_output(['pdftotext','-bbox-layout',str(path),'-']);doc=ET.fromstring(box)
  words=0
  for page in doc.iter():
   if page.tag.split('}')[-1]!='page':continue
   width,height=float(page.attrib['width']),float(page.attrib['height']);fail(abs(width-595.28)<1 and abs(height-841.89)<1 or abs(width-841.89)<1 and abs(height-595.28)<1,'Unexpected PDF paper size')
   for word in page.iter():
    if word.tag.split('}')[-1]!='word':continue
    words+=1;fail(float(word.attrib['xMin'])>=-.1 and float(word.attrib['yMin'])>=-.1 and float(word.attrib['xMax'])<=width+.1 and float(word.attrib['yMax'])<=height+.1,'PDF text outside page')
  fail(words>0,'PDF has no readable text');plain=subprocess.check_output(['pdftotext','-layout',str(path),'-'],text=True);flat=' '.join(plain.split())
  if path.name=='components.pdf':
   for c in project['components']:fail(c['name'] in flat,'Missing printed component '+c['name'])
  if path.name=='rulebook.pdf':
   for section in project['rulebook']:fail(section['heading'] in flat,'Missing rulebook section')
   for c in project['components']:fail(c['name'] in flat,'Missing inventory row')
  pdfs.append({'file':str(path.relative_to(folder)),'pages':pages,'words':words})
 replay=json.loads((folder/'human-input-replay.json').read_text());fail(replay['revision']==row['revision'],'Replay revision differs');fail(len(replay['actions'])==row['humanTurns'],'Human-input count differs');fail(json.loads(replay['state'])['player']<project['players'],'Invalid final player')
 for approved in row['approved']:
  c=next(c for c in project['components'] if c['id']==approved['id']);fail(hashlib.sha256(canonical(c).encode()).hexdigest()==approved['sha256'],'Approved component changed')
 results.append({'id':row['id'],'stage':row['stage'],'componentDesigns':svg_count,'physicalCopies':copy_count,'pdfs':pdfs,'verified':True})
for game,edited in [('pocket-conservatory','poppy'),('signal-garden','tile-0'),('night-ferry','silk')]:
 before=json.loads((root/game/'before/project.relay.json').read_text());after=json.loads((root/game/'after/project.relay.json').read_text())
 for c in before['components']:
  if c['id']!=edited:fail(c==next(x for x in after['components'] if x['id']==c['id']),'A targeted revision changed an unrelated component')
(root/'independent-verification.json').write_text(json.dumps({'reader':'Python stdlib ZIP/XML/JSON and Poppler pdfinfo/pdftotext','scope':'File integrity, source retention, print inventory/dimensions, PDF text bounds and approved component hashes. Does not measure fun or human balance.','results':results},indent=2)+'\n');print(json.dumps({'deliveries':len(results),'pdfs':sum(len(r['pdfs']) for r in results),'pages':sum(p['pages'] for r in results for p in r['pdfs']),'verified':True}))
