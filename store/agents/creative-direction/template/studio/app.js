(() => {
  'use strict';
  const $=id=>document.getElementById(id),initial=validateProject(JSON.parse($('brand-data').textContent));
  let source=clone(initial),project=clone(initial),view='collection',boardId=null,layerId=null,undo=[],redo=[],live=false,remoteRevision=null,busy=false,saving=false,polling=false,syncEpoch=0;
  const storage='forme:'+project.id,canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  const measure=(s,size,family,weight,tracking)=>{ctx.font=`${weight} ${size}px '${family}'`;return ctx.measureText(s).width+Math.max(0,[...s].length-1)*tracking;};
  const active=()=>direction(project),board=()=>active().boards.find(b=>b.id===boardId),layer=()=>board()?.layers.find(l=>l.id===layerId);
  let toastTimer;
  function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000);}
  function failure(error){console.error(error);toast(error.message||String(error));}
  function action(fn){return (...args)=>Promise.resolve().then(()=>fn(...args)).catch(failure);}
  function saveDraft(){try{localStorage.setItem(storage,JSON.stringify({sourceRevision:source.revision,project}));$('save-state').textContent=live?'Draft saved · save to workspace when ready':'Draft saved on this device';}catch{$('save-state').textContent='Storage full · save project to keep edits';}}
  function remember(){undo.push(clone(project));if(undo.length>30)undo.shift();redo=[];}
  function change(fn){const before=clone(project);try{fn(project);project=validateProject(project);}catch(e){project=before;throw e;}if(JSON.stringify(before)===JSON.stringify(project)){render();return;}undo.push(before);if(undo.length>30)undo.shift();redo=[];saveDraft();render();}
  function restore(stack,other){if(!stack.length)return;other.push(clone(project));project=stack.pop();saveDraft();render();}
  function updateFonts(){$('project-fonts').textContent=fontCSS(project);}
  async function loadFonts(){updateFonts();await Promise.all(project.fonts.flatMap(f=>[400,600,800].map(w=>document.fonts.load(`${w} 32px '${f.family}'`))));await document.fonts.ready;}
  function svgFor(p,id,options={}){return renderBoard(p,id,{embedFonts:false,measure,...options});}
  function render(){
    updateFonts();$('save-project').textContent=live?'Save to workspace':'Save project';$('native-picker').hidden=!live;const d=active();$('project-title').textContent=project.copy.name??project.title;$('project-description').textContent=project.copy.category??project.brief;
    $('directions').innerHTML=project.directions.map(x=>`<button data-direction="${xml(x.id)}" class="${x.id===d.id?'selected':''}"><i class="dot" style="background:${x.colors.accent}"></i>${xml(x.name)}</button>`).join('');
    $('directions').querySelectorAll('button').forEach(b=>b.onclick=action(()=>chooseDirection(b.dataset.direction)));
    $('rationale').textContent=d.rationale;$('undo').disabled=!undo.length;$('redo').disabled=!redo.length;
    document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
    document.querySelector('.workspace').classList.toggle('editing',view==='edit');$('inspector').hidden=view!=='edit';
    const names={collection:['YOUR IDENTITY, EVERYWHERE','One idea. A whole world.'],identity:['THE SOURCE OF TRUTH','Make it yours.'],website:['A PLACE TO LAUNCH','Your brand, on the web.'],guide:['MADE TO BE USED','A guide that travels with you.'],compare:['PRESERVE YOUR DECISIONS','See what changed.'],edit:['EDIT THE ACTUAL ARTWORK',board()?.name??'Layout']};
    [$('view-eyebrow').textContent,$('view-title').textContent]=names[view];$('view-actions').innerHTML='';$('issues').hidden=true;
    if(view==='collection')renderCollection();else if(view==='identity')renderIdentity();else if(view==='edit')renderEditor();else if(view==='compare')renderCompare().catch(failure);else renderDocument();
  }
  function renderCollection(){
    const d=active();$('content').innerHTML=`<div class="collection">${d.boards.map(b=>`<button class="board-card ${b.role==='logo'?'logo-card':''}" data-board="${b.id}"><div class="art">${svgFor(project,b.id).svg}</div><div class="board-caption">${xml(b.name)}<span>${b.width} × ${b.height} · Edit ↗</span></div></button>`).join('')}</div>`;
    $('content').querySelectorAll('[data-board]').forEach(b=>b.onclick=()=>{boardId=b.dataset.board;layerId=null;view='edit';render();});
    const warnings=d.boards.flatMap(b=>svgFor(project,b.id).warnings);showWarnings(warnings);
    $('view-actions').innerHTML=`<span class="muted">${d.boards.length} coordinated assets</span>`;
  }
  function showWarnings(warnings){$('issues').hidden=!warnings.length;$('issues').textContent=warnings.map(w=>w.message).join(' ');}
  const titleCase=k=>k.replace(/[-_]/g,' ').replace(/^./,s=>s.toUpperCase());
  function renderIdentity(){
    const d=active();$('content').innerHTML=`<div class="identity-grid"><section class="panel"><h3>The words people remember.</h3>${Object.entries(project.copy).map(([k,v])=>`<label>${xml(titleCase(k))}<textarea data-copy="${k}" rows="${v.length>100?3:1}">${xml(v)}</textarea></label>`).join('')}</section><div><section class="panel"><h3>The visual signature.</h3>${Object.entries(d.colors).map(([k,c])=>`<div class="color-row"><input type="color" value="${c}" data-color="${k}" aria-label="${xml(k)} color"><div><div>${xml(titleCase(k))}</div><span class="color-code">${c.toUpperCase()}</span></div></div>`).join('')}<div class="contrast-result">Ink / paper contrast: ${contrast(d.colors.ink,d.colors.paper).toFixed(2)}:1</div><div class="font-example" style="font-family:'${d.fonts.display}'"><small>DISPLAY · ${xml(d.fonts.display)}</small>${xml(project.copy.name??project.title)}</div><div class="font-example" style="font-family:'${d.fonts.body}'"><small>BODY · ${xml(d.fonts.body)}</small>Good things begin here.</div>${['display','body'].map(role=>`<label style="margin-top:16px">${titleCase(role)} font<select data-font="${role}">${project.fonts.map(f=>`<option${d.fonts[role]===f.family?' selected':''}>${xml(f.family)}</option>`).join('')}</select></label>`).join('')}</section><section class="panel" style="margin-top:24px"><h3>Voice & decisions.</h3><label>How this brand should speak and behave<textarea id="brand-notes" rows="8">${xml(project.notes)}</textarea></label><div class="asset-grid">${project.assets.map(a=>`<div class="asset-tile"><img src="${a.data}" alt="${xml(a.name)}">${xml(a.name)}</div>`).join('')}</div><p class="muted">Give the agent your logo, photographs or brand fonts in chat to add them to the project.</p></section></div></div>`;
    $('content').querySelectorAll('[data-copy]').forEach(el=>el.onchange=action(()=>change(p=>p.copy[el.dataset.copy]=el.value)));
    $('content').querySelectorAll('[data-color]').forEach(el=>el.onchange=action(()=>change(()=>active().colors[el.dataset.color]=el.value)));
    $('content').querySelectorAll('[data-font]').forEach(el=>el.onchange=action(()=>change(()=>active().fonts[el.dataset.font]=el.value)));
    $('brand-notes').onchange=action(()=>change(p=>p.notes=$('brand-notes').value));
  }
  function renderDocument(){
    const isSite=view==='website';if(isSite&&!project.website){$('content').innerHTML='<p class="empty">Ask the agent to create a launch website for this brief.</p>';return;}
    $('view-actions').innerHTML=`<button id="download-document">Download ${isSite?'website':'guide'} ↗</button>`;
    $('content').innerHTML=`${isSite?'<div class="frame-toolbar"><button id="desktop-preview">Desktop</button><button id="mobile-preview">Phone</button></div>':''}<div class="frame-wrap"><iframe class="preview-frame" title="${isSite?'Launch website':'Brand guide'}" sandbox="allow-same-origin"></iframe></div>`;
    const html=isSite?websiteHTML(project):guideHTML(project);$('content').querySelector('iframe').srcdoc=html;
    $('download-document').onclick=()=>download(isSite?'index.html':'brand-guide.html',html,'text/html');
    if(isSite){$('desktop-preview').onclick=()=>$('content').querySelector('.frame-wrap').classList.remove('mobile');$('mobile-preview').onclick=()=>$('content').querySelector('.frame-wrap').classList.add('mobile');}
  }
  async function renderCompare(){
    const saved=project.approvals.at(-1);if(!saved){$('content').innerHTML='<div class="empty"><h3>Keep a version you believe in.</h3><p>Save an approved version once the direction feels right. You can then compare later changes with that exact copy and artwork.</p></div>';return;}
    const previous=clone(project);previous.copy=clone(saved.copy);previous.assets=clone(saved.assets);previous.fonts=clone(saved.fonts??previous.fonts);previous.directions=[clone(saved.direction)];previous.active=saved.direction.id;
    const fontNames=new Map(previous.fonts.map(f=>[f.family,'Approved '+f.family]));for(const f of previous.fonts)f.family=fontNames.get(f.family);for(const role of ['display','body'])previous.directions[0].fonts[role]=fontNames.get(previous.directions[0].fonts[role]);
    $('content').innerHTML='<p class="muted">Opening the approved artwork…</p>';
    const approvedFonts=document.createElement('style');approvedFonts.textContent=fontCSS(previous);$('content').append(approvedFonts);
    await Promise.all(previous.fonts.flatMap(f=>[400,600,800].map(w=>document.fonts.load(`${w} 32px '${f.family}'`))));if(view!=='compare')return;
    const current=active(),old=saved.direction,shared=Object.keys(project.copy).filter(k=>project.copy[k]!==saved.copy[k]);
    $('content').innerHTML=`<p class="compare-summary">Saved ${xml(new Date(saved.at).toLocaleString())}. ${shared.length?`Changed shared copy: ${shared.map(xml).join(', ')}.`:'Shared copy matches the saved version.'}</p><div class="compare"><div><h3>APPROVED · ${xml(old.name)}</h3>${old.boards.map(b=>`<p class="muted">${xml(b.name)}</p>${svgFor(previous,b.id).svg}`).join('')}</div><div><h3>CURRENT · ${xml(current.name)}</h3>${current.boards.map(b=>`<p class="muted">${xml(b.name)}</p>${svgFor(project,b.id).svg}`).join('')}</div></div>`;$('content').prepend(approvedFonts);
    $('view-actions').innerHTML='<button id="restore-approved">Restore approved version</button>';
    $('restore-approved').onclick=action(()=>change(p=>Object.assign(p,restoreApproved(p,saved))));
  }
  function renderEditor(){
    const b=board();if(!b){view='collection';render();return;}
    $('content').innerHTML='<div class="editor-stage" id="stage"></div><p class="board-help">Click a layer to edit it. Drag to position, use arrow keys to nudge, and undo any change. Text linked to brand copy updates across every layout.</p>';
    renderStage();renderProperties();
    $('view-actions').innerHTML='<button id="download-svg">SVG</button><button id="download-png">PNG</button><button id="duplicate-board">Duplicate layout</button>';
    $('download-svg').onclick=action(()=>download(filename(b.id)+'.svg',renderBoard(project,b.id,{measure}).svg,'image/svg+xml'));
    $('download-png').onclick=action(async()=>download(filename(b.id)+'.png',dataBytes((await deliver(b.id,2)).png),'image/png'));
    $('duplicate-board').onclick=action(()=>change(()=>{const copy=clone(b);copy.id=uniqueId(b.id,active().boards.map(x=>x.id));copy.name=b.name+' copy';active().boards.push(copy);boardId=copy.id;layerId=null;}));
  }
  function renderStage(){
    const b=board(),result=svgFor(project,b.id,{interactive:true});$('stage').innerHTML=result.svg;showWarnings(result.warnings);
    const selected=layer();if(selected){const r=document.createElementNS('http://www.w3.org/2000/svg','rect');for(const [k,v]of Object.entries({x:selected.x,y:selected.y,width:selected.width,height:selected.height,class:'selection-box'}))r.setAttribute(k,v);$('stage').querySelector('svg').append(r);}
    const root=$('stage').querySelector('svg');root.onpointerdown=event=>{
      const target=event.target.closest('[data-layer]');if(!target){layerId=null;renderStage();renderProperties();return;}
      layerId=target.dataset.layer;renderProperties();const l=layer();if(l.locked){renderStage();return;}
      const before=clone(project),x=l.x,y=l.y,startX=event.clientX,startY=event.clientY,rect=root.getBoundingClientRect(),scaleX=b.width/rect.width,scaleY=b.height/rect.height;let moved=false;
      event.preventDefault();
      const move=e=>{l.x=Math.round(x+(e.clientX-startX)*scaleX);l.y=Math.round(y+(e.clientY-startY)*scaleY);moved||=Math.abs(e.clientX-startX)+Math.abs(e.clientY-startY)>2;renderStage();};
      const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);if(moved){undo.push(before);redo=[];saveDraft();}renderStage();renderProperties();$('undo').disabled=!undo.length;};
      window.addEventListener('pointermove',move);window.addEventListener('pointerup',up,{once:true});renderStage();
    };
  }
  function uniqueId(base,ids){let i=2,next=base+'-copy';while(ids.includes(next))next=base+'-'+i++;return next.slice(0,64);}
  function renderProperties(){
    const b=board(),l=layer();
    let fields=`<label>Layout name<input id="board-name" value="${xml(b.name)}"></label><div class="property-row"><label>Width<input id="board-width" type="number" min="64" max="6000" value="${b.width}"></label><label>Height<input id="board-height" type="number" min="64" max="6000" value="${b.height}"></label></div>`;
    if(l){const binding=l.type==='text'&&/^\{\{([a-z][a-z0-9_-]*)\}\}$/.exec(l.text);
      fields+=`<hr style="border:0;border-top:1px solid var(--line);margin:22px 0"><p class="muted">${xml(titleCase(l.id))} · ${xml(l.type)}</p>`;
      if(l.type==='text')fields+=`<label>${binding?'Shared '+xml(titleCase(binding[1])):'Text on this layout'}<textarea id="layer-text" rows="3">${xml(binding?project.copy[binding[1]]:l.text)}</textarea></label>${binding?'<p class="binding-note">This copy is linked across the collection. <button id="unlink-text">Edit only here</button></p>':''}`;
      fields+=`<div class="property-row">${['x','y','width','height'].map(k=>`<label>${titleCase(k)}<input type="number" data-number="${k}" value="${l[k]}"></label>`).join('')}</div>`;
      if(l.type==='text')fields+=`<div class="property-row"><label>Type size<input type="number" data-number="size" min="6" max="1200" value="${l.size}"></label><label>Min. fit size<input type="number" data-number="minSize" min="6" max="1200" value="${l.minSize??l.size}"></label></div><label>Typeface<select id="layer-font"><option value="display"${l.font==='display'?' selected':''}>Display</option><option value="body"${(l.font??'body')==='body'?' selected':''}>Body</option></select></label>`;
      if(l.type!=='image')fields+=`<label>Brand color<select id="layer-color">${Object.keys(active().colors).map(k=>`<option value="$${k}"${(l.fill??'$ink')==='$'+k?' selected':''}>${xml(titleCase(k))}</option>`).join('')}<option value="none"${l.fill==='none'?' selected':''}>None</option>${l.fill?.startsWith('#')?`<option value="${l.fill}" selected>${l.fill}</option>`:''}</select></label>`;
      fields+=`<label><input id="lock-layer" type="checkbox"${l.locked?' checked':''}> Lock position and edits</label><div class="layer-actions"><button id="duplicate-layer">Duplicate</button><button id="front-layer">Bring forward</button><button id="delete-layer">Delete</button></div>`;
    }else fields+='<p class="muted">Choose a layer on the canvas or below.</p>';
    fields+='<div class="layer-actions" style="margin-top:22px"><button id="add-text">+ Text</button><button id="add-shape">+ Shape</button></div><div class="layer-list">'+[...b.layers].reverse().map(x=>`<button data-layer-select="${x.id}" class="${x.id===layerId?'selected':''}">${x.locked?'▣ ':''}${xml(x.type==='text'?copyText(project,x.text).slice(0,40):titleCase(x.id))}</button>`).join('')+'</div>';
    $('properties').innerHTML=fields;
    $('board-name').onchange=action(()=>change(()=>b.name=$('board-name').value));for(const prop of ['width','height'])$('board-'+prop).onchange=action(()=>change(()=>b[prop]=Number($('board-'+prop).value)));
    $('properties').querySelectorAll('[data-layer-select]').forEach(el=>el.onclick=()=>{layerId=el.dataset.layerSelect;renderStage();renderProperties();});
    for(const type of ['text','shape'])$('add-'+type).onclick=action(()=>change(()=>{const added={id:uniqueId(type,b.layers.map(x=>x.id)),type:type==='text'?'text':'rect',x:Math.round(b.width*.1),y:Math.round(b.height*.1),width:Math.round(b.width*.6),height:Math.round(b.height*.15),fill:'$ink',...(type==='text'?{text:'Your words here',size:Math.round(b.width*.07),minSize:16,font:'display'}:{})};b.layers.push(added);layerId=added.id;}));
    if(!l)return;
    function edit(fn){if(l.locked)throw new Error('Unlock this layer before editing.');change(fn);}
    if($('layer-text'))$('layer-text').onchange=action(()=>{const value=$('layer-text').value,binding=/^\{\{([a-z][a-z0-9_-]*)\}\}$/.exec(l.text);edit(()=>{if(binding)project.copy[binding[1]]=value;else l.text=value;});});
    if($('unlink-text'))$('unlink-text').onclick=action(()=>edit(()=>l.text=copyText(project,l.text)));
    $('properties').querySelectorAll('[data-number]').forEach(el=>el.onchange=action(()=>edit(()=>l[el.dataset.number]=Number(el.value))));
    if($('layer-font'))$('layer-font').onchange=action(()=>edit(()=>l.font=$('layer-font').value));
    if($('layer-color'))$('layer-color').onchange=action(()=>edit(()=>l.fill=$('layer-color').value));
    $('lock-layer').onchange=action(()=>change(()=>l.locked=$('lock-layer').checked));
    $('duplicate-layer').onclick=action(()=>edit(()=>{const copy=clone(l);copy.id=uniqueId(l.id,b.layers.map(x=>x.id));copy.x+=20;copy.y+=20;b.layers.push(copy);layerId=copy.id;}));
    $('delete-layer').onclick=action(()=>edit(()=>{b.layers=b.layers.filter(x=>x.id!==l.id);layerId=null;}));
    $('front-layer').onclick=action(()=>edit(()=>{const i=b.layers.indexOf(l);if(i<b.layers.length-1)[b.layers[i],b.layers[i+1]]=[b.layers[i+1],b.layers[i]];}));
  }
  function chooseDirection(id){if(!project.directions.some(d=>d.id===id))throw new Error('Direction not found.');change(p=>p.active=id);if(view==='edit'){boardId=active().boards[0].id;layerId=null;render();}}
  function download(name,body,type='application/octet-stream'){const url=URL.createObjectURL(body instanceof Blob?body:new Blob([body],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  function dataBytes(data){return Uint8Array.from(atob(data.split(',')[1]),c=>c.charCodeAt(0));}
  async function rasterize(svg,scale=1){const root=new DOMParser().parseFromString(svg,'image/svg+xml').documentElement,width=Number(root.getAttribute('width')),height=Number(root.getAttribute('height'));if(![width,height].every(n=>Number.isFinite(n)&&n>0)||width*height*scale*scale>64000000)throw new Error('Use a smaller raster size.');const image=new Image(),url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));try{await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Could not render this artwork.'));image.src=url;});const c=document.createElement('canvas');c.width=Math.round(width*scale);c.height=Math.round(height*scale);c.getContext('2d').drawImage(image,0,0,c.width,c.height);return c.toDataURL('image/png');}finally{URL.revokeObjectURL(url);}}
  async function deliver(id,scale=2){if(![1,2].includes(scale))throw new Error('Choose 1× or 2× export.');await document.fonts.ready;const result=renderBoard(project,id,{measure});return {...result,png:await rasterize(result.svg,scale)};}

  function portable(){const doc=document.documentElement.cloneNode(true);doc.querySelector('#brand-data').textContent=JSON.stringify(project).replace(/</g,'\\u003c');doc.querySelector('#revision-notice').hidden=true;return '<!doctype html>\n'+doc.outerHTML;}
  function textFiles(){const files=[...identityFiles(project,{measure}),['project.forme.json',JSON.stringify(project,null,2)],['design-tokens.json',JSON.stringify(designTokens(project),null,2)],['brand-guide.html',guideHTML(project)],['studio.html',portable()],['README.txt',`${project.title}\n\nOpen studio.html to edit this brand. Open brand-guide.html for the identity guidelines.\nSVGs are editable vectors; PNGs are raster files. Fonts are embedded and their licenses follow.\nThe website is a static launch page. Its contact action is ${project.website?.href??'not configured'}.\nNo checkout, analytics or mailing-list backend is included.\nFor printer-specific CMYK, bleed or dielines, confirm the production specification.\n`]];if(project.website)files.push(['website/index.html',websiteHTML(project)]);for(const f of project.fonts)files.push(['fonts/'+filename(f.family)+'-LICENSE.txt',f.license]);return files;}
  async function exportKit(){if(busy)return;busy=true;$('export-kit').disabled=true;try{const files=textFiles(),warnings=[];for(const [name,svg]of files.filter(([n])=>n.startsWith('logos/')&&n.endsWith('.svg')))files.push([name.replace(/\.svg$/,'.png'),dataBytes(await rasterize(svg))]);for(const a of project.assets)files.push(['source-assets/'+filename(a.id)+'.'+({'image/svg+xml':'svg','image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[a.data.slice(5,a.data.indexOf(';'))]),dataBytes(a.data)]);for(const b of active().boards){$('save-state').textContent='Exporting '+b.name;const r=await deliver(b.id,2);warnings.push(...r.warnings);files.push(['artwork/'+filename(b.id)+'.svg',r.svg],['artwork/'+filename(b.id)+'.png',dataBytes(r.png)]);}if(warnings.length)throw new Error('Fix the layout warnings before exporting: '+warnings.map(w=>w.message).join(' '));for(const f of project.fonts)files.push(['fonts/'+filename(f.family)+'.'+f.data.match(/^data:font\/([^;]+)/)[1],dataBytes(f.data)]);download(filename(project.copy.name??project.title)+'-brand-kit.zip',zipFiles(files));toast('Brand kit downloaded. Your editable project is inside.');}finally{busy=false;$('export-kit').disabled=false;saveDraft();}}
  async function openProject(p){project=validateProject(p);undo=[];redo=[];boardId=null;layerId=null;view='collection';await loadFonts();saveDraft();$('open-dialog').close();render();toast('Project opened.');}
  async function saveProject(){
    if(!live){download(filename(project.title)+'.forme.json',JSON.stringify(project,null,2),'application/json');toast('Editable project saved.');return;}
    if(saving)return;saving=true;syncEpoch++;$('toast').hidden=true;$('save-state').textContent='Saving to workspace…';
    try{
      const response=await fetch('/api/project',{method:'PUT',headers:{'content-type':'application/json','if-match':remoteRevision},body:JSON.stringify(project)});const result=await response.json();
      if(response.status===409){source=result.project;$('revision-notice').hidden=false;throw new Error('The agent changed this project. Choose which version to keep before saving.');}
      if(!response.ok)throw new Error(result.error||'Could not save the workspace.');
      remoteRevision=result.project.revision;source=clone(result.project);project.revision=source.revision;$('revision-notice').hidden=true;saveDraft();$('save-state').textContent='Saved to workspace';toast('Saved. The agent can read your edits now.');
    }finally{saving=false;syncEpoch++;}
  }
  async function connect(){if(location.protocol==='file:')return;try{const response=await fetch('/api/project');if(!response.ok)return;const result=await response.json();if(!result.project)return;live=true;remoteRevision=result.project.revision;$('save-project').textContent='Save to workspace';$('native-picker').hidden=false;if(source.revision!==remoteRevision){source=result.project;$('revision-notice').hidden=false;}setInterval(checkSource,3500);}catch{}}
  async function checkSource(){if(!live||document.hidden||saving||polling)return;polling=true;const epoch=syncEpoch;try{const response=await fetch('/api/project');if(!response.ok)return;const result=await response.json();if(epoch!==syncEpoch)return;if(result.project.revision!==remoteRevision){source=result.project;$('revision-notice').hidden=false;}}catch{}finally{polling=false;}}
  $('use-source').onclick=action(async()=>{undo=[clone(project)];project=clone(source);remoteRevision=source.revision;redo=[];boardId=null;view='collection';$('revision-notice').hidden=true;saveDraft();await loadFonts();render();});
  $('keep-draft').onclick=()=>{remoteRevision=source.revision;$('revision-notice').hidden=true;saveDraft();toast('Your draft is retained. Save to workspace to replace the newer source.');};
  $('undo').onclick=()=>restore(undo,redo);$('redo').onclick=()=>restore(redo,undo);$('save-project').onclick=action(saveProject);$('export-kit').onclick=action(exportKit);
  $('approve').onclick=action(()=>{change(p=>p.approvals.push({at:new Date().toISOString(),copy:clone(p.copy),assets:clone(p.assets),fonts:clone(p.fonts),direction:clone(active())}));toast('Approved version saved for later comparison.');});
  $('close-editor').onclick=()=>{view='collection';render();};
  document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{view=b.dataset.view;render();});
  $('open-project').onclick=action(async()=>{$('open-dialog').showModal();if(live){const response=await fetch('/api/files');const result=await response.json();$('recent-files').innerHTML=(result.files??[]).map((f,i)=>`<button data-file="${i}">${xml(f.name)}<br><span class="muted">${xml(f.folder)}</span></button>`).join('');$('recent-files').querySelectorAll('button').forEach(b=>b.onclick=action(()=>openPath(result.files[Number(b.dataset.file)].path)));}});
  async function openPath(path){const response=await fetch('/api/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path})}),result=await response.json();if(!response.ok)throw new Error(result.error);await openProject(result.project);}
  $('open-path').onclick=action(()=>openPath($('project-path').value));
  $('project-file').onchange=action(async()=>{const f=$('project-file').files[0];if(!f)return;if(f.size>36000000)throw new Error('Keep projects under 36 MB.');await openProject(JSON.parse(await f.text()));$('project-file').value='';});
  $('open-dialog').ondragover=e=>e.preventDefault();$('open-dialog').ondrop=action(async e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(!f)return;if(f.size>36000000)throw new Error('Keep projects under 36 MB.');await openProject(JSON.parse(await f.text()));});
  window.addEventListener('keydown',e=>{if(e.target.closest('input,textarea,select'))return;if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();restore(e.shiftKey?redo:undo,e.shiftKey?undo:redo);}else if(view==='edit'&&layer()&&!layer().locked&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();change(()=>{const l=layer(),n=e.shiftKey?10:1;if(e.key==='ArrowLeft')l.x-=n;if(e.key==='ArrowRight')l.x+=n;if(e.key==='ArrowUp')l.y-=n;if(e.key==='ArrowDown')l.y+=n;});}});
  window.forme={getProject:()=>clone(project),chooseDirection,deliver,rasterize,textFiles,openProject,saveProject,getSVG:id=>renderBoard(project,id??active().boards[0].id,{measure}).svg};
  (async()=>{try{const saved=JSON.parse(localStorage.getItem(storage)||'null');if(saved?.project){project=validateProject(saved.project);if(saved.sourceRevision!==source.revision)$('revision-notice').hidden=false;}}catch{}await loadFonts();render();await connect();document.body.dataset.ready='true';saveDraft();})().catch(failure);
})();
