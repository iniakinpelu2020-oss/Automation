let fbApp, auth, googleProvider;
let initializeApp, getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, signOut;

const firebaseConfig = {
  apiKey: "AIzaSyBaK5EOnATL7D5zVexeQHGp7fuyq8KJBP8",
  authDomain: "apexaiautomation.firebaseapp.com",
  projectId: "apexaiautomation",
  storageBucket: "apexaiautomation.firebasestorage.app",
  messagingSenderId: "932730992269",
  appId: "1:932730992269:web:fbbfce99bdd3857054d4c4",
  measurementId: "G-Q4YXEWS8HS"
};

const state = {
  user:null, token:null,
  nav:'assistant', view:'split', // nav: assistant|workflows|templates|settings
  settingsTab:'ai', // ai | vault | general
  sidebarCollapsed:false,
  chats:[], activeChatId:null, chatMessages:[], chatInput:'', chatSending:false,
  requiredCredentials:[],
  vault:[], logs:[], workflows:[],
  workflow:{ id:null, name:'Untitled workflow', nodes:[], edges:[], groups:[], triggerType:'manual' },
  selectedNodeId:null, connectingFrom:null,
  pan:{x:40,y:40}, zoom:1,
  execOpen:true, drawerOpen:false,
  runStatus:{},
  isPointerDown:false, panStart:null, dragNode:null,
  error:'',
  aiSettings:{ provider:'auto', customModelId:'', geminiKey:'', groqKey:'', openrouterKey:'' },
  chatProvider:'auto', chatCustomModel:'',
  vaultFocusService:null,
  returnTo:null,
  searxngTest:null,
  inspectorTab: 'config',
  autoFitOnNext: false,
  activeExecutionId: null,
};

const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>Array.from(r.querySelectorAll(s));

// Anything the Worker hands back can be a string, an object, a chunk array or a
// provider envelope ({ response }, { result }, { choices }). String() on those
// is what printed "[object Object]" in the chat, so every value goes through
// toText() before it reaches the DOM.
const TEXT_KEYS=['message','text','explanation','response','content','output','result','summary','error','raw','value'];
const isPlaceholderText=(v)=>!v || ['[object Object]','undefined','null','NaN'].includes(String(v).trim());
function toText(v, depth=0){
  if(v===null||v===undefined) return '';
  if(typeof v==='string') return v;
  if(typeof v==='number'||typeof v==='boolean') return String(v);
  if(depth>4) return '';
  if(Array.isArray(v)){
    const parts=v.map(x=>toText(x,depth+1)).filter(s=>String(s).trim());
    if(!parts.length) return '';
    const joined=parts.join('');
    return joined.trim()?joined:parts.join('\n');
  }
  if(typeof v==='object'){
    for(const k of TEXT_KEYS){
      if(!(k in v)) continue;
      const t=toText(v[k],depth+1);
      if(t && !isPlaceholderText(t)) return t;
    }
    try{ const s=JSON.stringify(v,null,2); return s===undefined?'':s; }catch{ return ''; }
  }
  return '';
}
const esc=(s='')=>{
  const t=(s && typeof s==='object') ? toText(s) : (s===null||s===undefined ? '' : String(s));
  return t.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
};
const uid=()=>crypto.randomUUID?crypto.randomUUID():'id-'+Math.random().toString(36).slice(2,10);

async function api(path, opts={}){
  const headers=Object.assign({'Content-Type':'application/json'}, opts.headers||{});
  if(state.token) headers['Authorization']=`Bearer ${state.token}`;
  const res=await fetch(path,{...opts,headers});
  const text=await res.text(); let data=null; try{data=text?JSON.parse(text):null;}catch{data={raw:text};}
  if(!res.ok) throw new Error((data&&(data.error||data.message))||`Request failed (${res.status})`);
  return data;
}

function isEditing(){
  const ae=document.activeElement;
  if(ae && (ae.tagName==='INPUT'||ae.tagName==='TEXTAREA'||ae.tagName==='SELECT'||ae.isContentEditable)) return true;
  return state.drawerOpen;
}

async function refreshVault(){ try{ state.vault = await api('/api/vault'); }catch{} }
async function refreshLogs(){
  try{
    const d=await api('/api/agent/logs'); state.logs=d.logs||[];
    const latest=state.logs[0];
    if(latest&&latest.nodeLogs){ try{ const map={}; for(const nl of JSON.parse(latest.nodeLogs)) map[nl.nodeId]=nl.status; state.runStatus=map; }catch{} }
    renderLogsOnly(); renderCanvasStatus();
  }catch{}
}
async function refreshWorkflows(){ try{ const d=await api('/api/agent/workflows'); state.workflows=d.workflows||[]; }catch{} }
async function refreshChats(){ try{ const d=await api('/api/agent/chats'); state.chats=d.chats||[]; renderSidebar(); }catch{} }
async function refreshSettings(){
  try{
    const d=await api('/api/agent/settings'); const s=d.settings||{};
    state.aiSettings.provider = s.provider || state.aiSettings.provider || 'auto';
    state.aiSettings.customModelId = s.customModelId || '';
  }catch{}
}

async function loadChat(id){
  try{
    const d=await api(`/api/agent/chats/${encodeURIComponent(id)}`); state.activeChatId=d.id; state.chatMessages=d.messages||[];
    const lastA=[...state.chatMessages].reverse().find(m=>m.role==='assistant'&&m.data);
    if(lastA&&lastA.data){ if(lastA.data.workflowGraph) applyWorkflowGraph(lastA.data.workflowGraph); if(Array.isArray(lastA.data.requiredCredentials)) state.requiredCredentials=lastA.data.requiredCredentials; }
    renderChatPanel();
  }catch(e){ console.error(e); }
}

function defaultNode(type,subtype){
  const base={id:uid(),type,subtype,name:'',position:{x:120,y:120},config:{},credentialId:''};
  if(type==='trigger'){ base.name=subtype==='cron'?'Cron Schedule':subtype==='webhook'?'Webhook':'Manual Trigger'; if(subtype==='cron') base.config={cron:'0 9 * * *'}; }
  else if(type==='ai'){ base.name='AI Agent'; base.config={prompt:'{{ $json.output }}',provider:'auto',customModelId:'',model:'gemini-3-flash-preview',system:'You are a helpful automation agent.'}; }
  else if(type==='code'){ base.name='Code / JS Transform'; base.config={code:'// $input = previous node output, $secrets = attached credential\nreturn $input;'}; }
  else { const names={twitter:'X/Twitter',youtube:'YouTube',gmail:'Gmail',drive:'Drive',sheets:'Sheets',telegram:'Telegram',discord:'Discord',http:'HTTP Request',webhook:'Custom Webhook'}; base.name=names[subtype]||'Action'; base.config=(subtype==='http'||subtype==='webhook')?{url:'',method:'POST',body:'{"text":"{{ $json.output }}"}'}:{message:'{{ $json.output }}'}; }
  return base;
}
function addNode(type,subtype){ const n=defaultNode(type,subtype); const wrap=$('#canvas-wrap'); if(wrap){ const r=wrap.getBoundingClientRect(); n.position={x:(r.width/2-state.pan.x)/state.zoom-90,y:(r.height/2-state.pan.y)/state.zoom-40}; } state.workflow.nodes.push(n); renderCanvas(); }
function deleteNode(id){ state.workflow.nodes=state.workflow.nodes.filter(n=>n.id!==id); state.workflow.edges=state.workflow.edges.filter(e=>e.source!==id&&e.target!==id); if(state.selectedNodeId===id){state.selectedNodeId=null;state.drawerOpen=false;} renderCanvas(); renderNodeDrawer(); }
function connectNodes(s,t){ if(s===t) return; if(state.workflow.edges.some(e=>e.source===s&&e.target===t)) return; state.workflow.edges.push({id:uid(),source:s,target:t}); }
function getNode(id){ return state.workflow.nodes.find(n=>n.id===id); }
function nodeStatus(id){ return state.runStatus[id]||'idle'; }
function fitWorkflowToView(){
  const wrap = $('#canvas-wrap');
  const nodes = state.workflow.nodes || [];
  if(!wrap || !nodes.length) return;
  const rect = wrap.getBoundingClientRect();
  if(rect.width < 50 || rect.height < 50) return;
  const xs = nodes.map(n => (n.position && n.position.x) || 0);
  const ys = nodes.map(n => (n.position && n.position.y) || 0);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const maxX = Math.max(...xs.map(x=>x+180));
  const maxY = Math.max(...ys.map(y=>y+120));
  const pad = 80;
  const w = Math.max(200, maxX-minX+pad*2);
  const h = Math.max(200, maxY-minY+pad*2);
  const z = Math.max(0.3, Math.min(1.2, Math.min(rect.width/w, rect.height/h)));
  state.zoom = z;
  state.pan.x = (rect.width - (maxX-minX)*z)/2 - minX*z + pad*z/4;
  state.pan.y = (rect.height - (maxY-minY)*z)/2 - minY*z + pad*z/4;
}

// The chat assistant can hand back a graph whose nodes are missing positions,
// whose edges point at ids that do not exist, or whose groups reference nodes
// that were dropped. Everything is sanitised here so a messy generation can
// never throw a state error on the canvas.
const GRAPH_NODE_TYPES = new Set(['trigger','ai','action','code','condition','dialogue','script','branch','switch']);

// Node type/subtype must be a single identifier token: a model that answers
// with {"type": {...}} previously produced a JSON blob as the node type.
function graphToken(value, fallback=''){
  const s = String(toText(value)).trim().split('\n')[0].replace(/[^a-zA-Z0-9_-]/g,'').toLowerCase();
  return (s || fallback).slice(0,32);
}

function sanitizeGraphNode(n, i){
  if(!n || typeof n !== 'object' || Array.isArray(n)) return null;
  const pos = (n.position && typeof n.position === 'object') ? n.position : null;
  const x = pos ? Number(pos.x) : NaN;
  const y = pos ? Number(pos.y) : NaN;
  const typeToken = graphToken(n.type);
  const type = GRAPH_NODE_TYPES.has(typeToken) ? typeToken : 'action';
  const subtype = graphToken(n.subtype);
  let name = toText(n.name ?? n.label ?? n.title).trim();
  if(!name || name.startsWith('{') || name.startsWith('[')) name = subtype || type;
  name = name.split('\n')[0].trim().slice(0,120) || type;
  const config = (n.config && typeof n.config === 'object' && !Array.isArray(n.config)) ? n.config : {};
  return {
    id: toText(n.id).trim() || ('n'+(i+1)),
    type,
    subtype,
    name,
    position: (Number.isFinite(x) && Number.isFinite(y)) ? { x, y } : { x: 80 + (i%4)*260, y: 120 + Math.floor(i/4)*180 },
    config,
    credentialId: toText(n.credentialId).trim()
  };
}

function applyWorkflowGraph(graph){
  if(!graph || typeof graph !== 'object') return false;
  try{
    const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const nodes = rawNodes.map(sanitizeGraphNode).filter(Boolean);
    const seen = new Set();
    for(const n of nodes){ if(seen.has(n.id)) n.id = n.id+'-'+Math.random().toString(36).slice(2,6); seen.add(n.id); }
    const ids = new Set(nodes.map(n=>n.id));

    const edges = (Array.isArray(graph.edges) ? graph.edges : []).map((e,i)=>{
      if(!e || typeof e !== 'object') return null;
      const source = toText(e.source).trim();
      const target = toText(e.target).trim();
      if(!ids.has(source) || !ids.has(target) || source===target) return null;
      const out = { id: toText(e.id).trim() || ('e'+(i+1)), source, target };
      // Branch routing on the server reads sourceHandle/label, so keep them.
      const handle = toText(e.sourceHandle ?? e.label ?? e.condition).trim();
      if(handle) out.sourceHandle = handle;
      const label = toText(e.label).trim();
      if(label) out.label = label;
      return out;
    }).filter(Boolean);

    const groups = (Array.isArray(graph.groups) ? graph.groups : []).map((g,i)=>{
      if(!g || typeof g !== 'object') return null;
      const nodeIds = (Array.isArray(g.nodeIds) ? g.nodeIds : []).map(id=>toText(id).trim()).filter(id=>ids.has(id));
      if(!nodeIds.length) return null;
      return { id: toText(g.id).trim() || ('g'+(i+1)), label: toText(g.label).trim() || 'Group', nodeIds, color: toText(g.color).trim() || undefined };
    }).filter(Boolean);

    if(nodes.length){
      state.workflow.nodes = nodes;
      state.workflow.edges = edges;
      state.workflow.groups = groups;
    }
    const graphName = toText(graph.name).trim();
    if(graphName) state.workflow.name = graphName;
    if(toText(graph.id).trim()) state.workflow.id = toText(graph.id).trim();

    // A selected node that no longer exists would leave a stale inspector open.
    if(state.selectedNodeId && !state.workflow.nodes.some(n=>n.id===state.selectedNodeId)){
      state.selectedNodeId = null; state.drawerOpen = false;
    }

    state.autoFitOnNext = nodes.length > 0;
    renderCanvas();
    if(state.autoFitOnNext){
      setTimeout(()=>{
        try{ fitWorkflowToView(); renderCanvas(); }catch(err){ console.warn('fit workflow failed', err); }
        state.autoFitOnNext = false;
      }, 0);
    }
    return true;
  }catch(err){
    // A malformed graph must never break the chat: keep the canvas as it was.
    console.warn('applyWorkflowGraph failed', err);
    return false;
  }
}

function connectedServices(){ return new Set((state.vault||[]).map(v=>v.serviceId)); }
function isCredConnected(req){ const set=connectedServices(); const r=(req||'').toLowerCase(); const aliases={youtube:['google_youtube','youtube'],gmail:['google_gmail','gmail'],drive:['google_drive','drive'],sheets:['google_sheets','sheets'],twitter:['twitter','x'],openai:['openai'],webhook:['webhook','custom-webhook'],gemini:['gemini','google_ai'],groq:['groq'],openrouter:['openrouter'],github:['github']}; const keys=aliases[r]||[r,`google_${r}`]; return keys.some(k=>set.has(k)); }

function providerLabel(p){ return ({auto:'Auto (Gemini → Groq → Cloudflare)','gemini-flash':'Gemini 3 Flash','gemini-pro':'Gemini 3.1 Pro',groq:'Groq (Llama 3.3 70B)',openrouter:'OpenRouter',cloudflare:'Cloudflare Workers AI',custom:'Custom Model ID...'})[p]||p; }
function providerBadge(meta){ if(!meta) return ''; return `<span class="ai-badge">${esc(meta.badge||meta.provider||'AI')}</span>`; }

function renderAuth(){
  return `<div class="min-h-screen flex items-center justify-center p-4" style="background:var(--bg)">
    <div class="w-full max-w-md rounded-2xl p-6 md:p-8" style="background:var(--bg2);border:1px solid var(--border)">
      <h1 class="text-2xl font-semibold mb-1">Automation Builder</h1>
      <p class="text-sm mb-5" style="color:var(--muted)">Sign in to build AI-powered workflows.</p>
      ${state.error?`<div class="mb-3 rounded-lg px-3 py-2 text-sm" style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#fca5a5">${esc(state.error)}</div>`:''}
      <form id="auth-form" class="space-y-3">
        <input id="email" type="email" required placeholder="Email" class="input" />
        <input id="password" type="password" required placeholder="Password" class="input" />
        <div class="grid grid-cols-2 gap-2"><button class="btn btn-primary" type="submit">Sign in</button><button id="signup-btn" class="btn" type="button">Sign up</button></div>
      </form>
      <div class="my-4 flex items-center gap-3 text-xs" style="color:var(--muted)"><div class="h-px flex-1" style="background:var(--border)"></div>OR<div class="h-px flex-1" style="background:var(--border)"></div></div>
      <button id="google-btn" class="w-full btn">Continue with Google</button>
    </div></div>`;
}

function renderSidebar(){
  if(!$('#sidebar')) return;
  const navs=[['assistant','✨','Assistant'],['workflows','🗂','Workflows / Overview'],['templates','📦','Templates']];
  const bottom=[['settings','⚙️','Settings']];
  const collapsed=state.sidebarCollapsed;
  $('#sidebar').className = `sidebar ${collapsed?'collapsed':''} h-full`;
  $('#sidebar').innerHTML = `
    <div class="p-3 border-b" style="border-color:var(--border)">
      <div class="flex items-center justify-between mb-2">${collapsed?'':`<div class="font-semibold text-sm">Automation</div>`}<button id="sb-toggle" class="btn !px-2 !py-1 text-xs">${collapsed?'»':'«'}</button></div>
      <button id="new-chat" class="w-full btn btn-primary text-sm ${collapsed?'!px-1':''}">${collapsed?'+':' + New Chat'}</button>
    </div>
    <nav class="p-2 space-y-1">${navs.map(([k,ic,l])=>`<div data-nav="${k}" class="nav-item ${state.nav===k?'active':''}"><span>${ic}</span>${collapsed?'':`<span>${l}</span>`}</div>`).join('')}</nav>
    ${collapsed?'':`<div class="px-3 pt-2 pb-1 text-xs" style="color:var(--muted)">Chats</div>
    <div class="flex-1 overflow-auto scrollbar p-2 space-y-1">${state.chats.length?state.chats.map(c=>`<div data-chat="${c.id}" class="nav-item ${state.activeChatId===c.id?'active':''} text-sm"><span>💬</span><span class="truncate">${esc(c.title||'Chat')}</span></div>`).join(''):`<div class="text-xs px-2" style="color:var(--muted)">No chats yet</div>`}</div>`}
    <div class="mt-auto p-2 border-t space-y-1" style="border-color:var(--border)">
      ${bottom.map(([k,ic,l])=>`<div data-nav="${k}" class="nav-item ${state.nav===k?'active':''}"><span>${ic}</span>${collapsed?'':`<span>${l}</span>`}</div>`).join('')}
      <a href="https://kilo.ai/docs" target="_blank" class="nav-item"><span>❓</span>${collapsed?'':`<span>Help</span>`}</a>
      ${collapsed?'':`<div data-nav="settings" data-settings-tab="vault" class="nav-item"><span>🚪</span><span class="text-xs" style="color:var(--muted)">${esc(state.user?.email||'')}</span></div>`}
    </div>`;
}

function normalizeCodeBlocks(blocks){
  if(!Array.isArray(blocks)) return [];
  return blocks.map(b=>{
    if(!b || typeof b !== 'object') return null;
    const code = toText(b.code ?? b.snippet ?? b.source ?? b.content);
    if(!String(code).trim()) return null;
    return { language: toText(b.language).trim() || 'code', title: toText(b.title || b.language).trim() || 'code', code: String(code) };
  }).filter(Boolean);
}

function renderCodeBlocks(blocks, msgIdx){
  const list = normalizeCodeBlocks(blocks);
  if(!list.length) return '';
  return list.map((b,i)=>{
    const encoded = encodeURIComponent(b.code || '');
    return `<div class="code-card mt-2"><div class="flex items-center justify-between gap-2 px-3 py-2 border-b" style="border-color:#2f2f35"><span class="text-xs truncate" style="color:var(--muted)">${esc(b.title||b.language||'code')}</span><div class="flex items-center gap-1"><button data-copy-code="${encoded}" class="btn !py-1 !px-2 text-xs">Copy</button><button data-insert-code="${msgIdx}" data-code-idx="${i}" class="btn !py-1 !px-2 text-xs">Insert</button></div></div><pre class="p-3 text-xs overflow-auto scrollbar" style="color:#d4d4d8;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${esc(b.code||'')}</pre></div>`;
  }).join('');
}

function extractAssistantDisplay(m){
  const data = (m && typeof m.data === 'object' && m.data) ? m.data : null;
  // content, data.explanation, data.message and data.text can each arrive as a
  // string, an object or a provider envelope; toText() unwraps all of them and
  // never yields "[object Object]".
  const contentObj = (m && m.content && typeof m.content === 'object' && !Array.isArray(m.content)) ? m.content : null;
  let explanation = toText(m && m.content).trim();
  let blocks = normalizeCodeBlocks((data && data.codeBlocks) || (contentObj && contentObj.codeBlocks));
  if(!explanation && data) explanation = toText(data.explanation ?? data.message ?? data.text ?? data.result).trim();
  const looksJson = explanation.startsWith('{') && explanation.includes('"explanation"');
  if(looksJson){
    try {
      const cleaned = explanation.replace(/^```(?:json)?/i,'').replace(/```$/i,'').trim();
      const mobj = JSON.parse(cleaned);
      if(mobj && typeof mobj === 'object'){
        const fromObj = toText(mobj.explanation ?? mobj.message).trim();
        if(fromObj) explanation = fromObj;
        if(!blocks.length) blocks = normalizeCodeBlocks(mobj.codeBlocks);
      }
    } catch {}
  }
  if(isPlaceholderText(explanation)) explanation = '';
  return { explanation, blocks };
}

function renderChatMessages(){
  const c=$('#chat-messages'); if(!c) return;
  if(!state.chatMessages.length){
    c.innerHTML = `<div class="h-full flex flex-col items-center justify-center text-center p-6"><h2 class="text-2xl md:text-3xl font-semibold mb-4">What do you want to automate?</h2>
      <div class="w-full max-w-2xl rounded-2xl p-3" style="background:var(--bg2);border:1px solid var(--border)"><textarea id="hero-input" rows="3" class="input !bg-transparent !border-0" placeholder="Tell me what to build or ask a question"></textarea><div class="flex justify-end mt-2"><button id="hero-send" class="btn btn-primary">Build</button></div></div>
      <div class="flex flex-wrap gap-2 justify-center mt-4 max-w-3xl">${['Schedule social posts','Daily YouTube uploader','AI webhook responder','Telegram / Discord bot'].map(t=>`<button class="pill" data-pill="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>`;
    return;
  }
  c.innerHTML = state.chatMessages.map((m, idx)=>{
    if(m.role==='user') return `<div class="chat-msg user"><div class="text-sm whitespace-pre-wrap">${esc(m.content||'')}</div></div>`;
    const { explanation, blocks } = extractAssistantDisplay(m);
    const meta = m.aiMeta || m.data?.aiMeta;
    return `<div class="chat-msg"><div class="flex items-center justify-between gap-2 mb-1"><div></div>${providerBadge(meta)}</div><div class="text-sm whitespace-pre-wrap" style="line-height:1.55">${esc(explanation)}</div>${renderCodeBlocks(blocks, idx)}</div>`;
  }).join('') + (state.chatSending?`<div class="chat-msg"><div class="text-sm" style="color:var(--muted)">Generating workflow...</div></div>`:'');
  c.scrollTop = c.scrollHeight;
}

function renderCredentialRows(){
  const c=$('#cred-rows'); if(!c) return;
  const req = Array.isArray(state.requiredCredentials) ? state.requiredCredentials.filter(Boolean) : [];
  if(!req.length){ c.innerHTML=''; return; }
  const unique=[...new Set(req)];
  c.innerHTML = `<div class="p-2 space-y-2 border-t" style="border-color:var(--border);background:#1e1e22"><div class="text-xs px-1 font-medium" style="color:var(--muted)">Connections required</div>
    ${unique.map(r=>{ const ok=isCredConnected(r); const svc=(r||'').toLowerCase().replace(/^google_/,''); const aiSvc=['gemini','groq','openrouter'].includes(svc); return `<div class="cred-row"><div class="flex items-center gap-2 text-sm"><span>${ok?'🟢':'🔴'}</span><span>${esc(r)}</span>${ok?`<span class="badge b-success">Complete</span>`:''}</div><button data-cred-fix="${esc(r)}" data-ai="${aiSvc?'1':'0'}" class="text-sm font-medium" style="color:${ok?'#86efac':'#fca5a5'}">${ok?'Complete >':'Add connection >'}</button></div>`; }).join('')}
  </div>`;
}

function renderChatPanel(){
  renderChatMessages(); renderCredentialRows();
  const inp=$('#chat-input'); if(inp && document.activeElement!==inp) inp.value = state.chatInput || '';
  const prov=$('#chat-provider'); if(prov && document.activeElement!==prov) prov.value = state.chatProvider || 'auto';
  const cm=$('#chat-custom-model'); if(cm && document.activeElement!==cm) cm.value = state.chatCustomModel || '';
}

function nodeIcon(n){ if(n.type==='trigger') return '⚡'; if(n.type==='ai') return '🧠'; if(n.type==='code') return '</>'; const m={twitter:'𝕏',youtube:'▶',gmail:'✉',drive:'△',sheets:'▦',telegram:'✈',discord:'💬',http:'⇄',webhook:'⇄'}; return m[n.subtype]||'⚙'; }
function badge(status){ const c={idle:'b-idle',running:'b-running',success:'b-success',error:'b-error'}[status]||'b-idle'; const l={idle:'Idle',running:'Running',success:'Success',error:'Error'}[status]||'Idle'; return `<span class="badge ${c}">${l}</span>`; }

function renderCanvas(){
  const world=$('#canvas-world'); if(!world) return;
  world.style.transform=`translate(${state.pan.x}px,${state.pan.y}px) scale(${state.zoom})`;
  const groups=(state.workflow.groups||[]).map(g=>{ const nodes=(g.nodeIds||[]).map(id=>getNode(id)).filter(Boolean); if(!nodes.length) return ''; const xs=nodes.map(n=>n.position.x), ys=nodes.map(n=>n.position.y); const x=Math.min(...xs)-20, y=Math.min(...ys)-30, w=Math.max(...xs)+210-x, h=Math.max(...ys)+120-y; return `<div class="group-frame" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"><div class="group-label">${esc(g.label||'Group')}</div></div>`; }).join('');
  const nodes=state.workflow.nodes.map(n=>{ const st=nodeStatus(n.id), sel=state.selectedNodeId===n.id?'selected':''; const border = st==='running'?'border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.25),0 10px 30px rgba(0,0,0,.35)': st==='success'?'border-color:#10b981;box-shadow:0 0 0 2px rgba(16,185,129,.2),0 10px 30px rgba(0,0,0,.35)': st==='error'?'border-color:#ef4444;box-shadow:0 0 0 2px rgba(239,68,68,.2),0 10px 30px rgba(0,0,0,.35)':''; const icon = st==='running'?'<span class="inline-block animate-spin">⟳</span>': st==='success'?'✓': st==='error'?'!':nodeIcon(n); return `<div class="node ${sel}" data-node-id="${n.id}" style="left:${n.position?.x||0}px;top:${n.position?.y||0}px;${border}"><div class="port in"></div><div class="port out" data-port-out="${n.id}"></div><div data-drag-handle="${n.id}" class="cursor-grab active:cursor-grabbing"><div class="icon">${icon}</div><div class="text-sm font-medium truncate">${esc(n.name||n.type)}</div><div class="text-[11px] truncate" style="color:var(--muted)">${esc(n.subtype||n.type)}</div><div class="mt-1">${badge(st)}</div></div></div>`; }).join('');
  world.innerHTML = renderEdgesSvg()+groups+nodes;
  bindCanvasEvents();
}
function renderCanvasStatus(){
  $('#canvas-world .node').forEach(el=>{
    const id=el.getAttribute('data-node-id'); const st=nodeStatus(id);
    const b=el.querySelector('.badge'); if(b){ const tmp=document.createElement('div'); tmp.innerHTML=badge(st); b.replaceWith(tmp.firstChild); }
    const iconWrap=el.querySelector('.icon'); if(iconWrap){ iconWrap.innerHTML = st==='running'?'<span class="inline-block animate-spin">⟳</span>': st==='success'?'✓': st==='error'?'!':nodeIcon(getNode(id)||{}); }
    el.style.borderColor = st==='running'?'#3b82f6': st==='success'?'#10b981': st==='error'?'#ef4444':'';
  });
}
function renderEdgesSvg(){
  const paths=state.workflow.edges.map(e=>{ const s=getNode(e.source),t=getNode(e.target); if(!s||!t) return ''; const x1=(s.position?.x||0)+180,y1=(s.position?.y||0)+50,x2=(t.position?.x||0),y2=(t.position?.y||0)+50; const dx=Math.max(60,Math.abs(x2-x1)*0.5); const d=`M ${x1} ${y1} C ${x1+dx} ${y1}, ${x2-dx} ${y2}, ${x2} ${y2}`; const st=nodeStatus(e.target); const color=st==='success'?'#10b981':st==='error'?'#ef4444':st==='running'?'#3b82f6':'#52525b'; return `<path d="${d}" stroke="${color}" stroke-width="2.5" fill="none" marker-end="url(#arrow-${st||'idle'})" />`; }).join('');
  return `<svg id="edges-svg" width="5000" height="4000"><defs>${['idle','running','success','error'].map(s=>{const c={idle:'#52525b',running:'#3b82f6',success:'#10b981',error:'#ef4444'}[s]; return `<marker id="arrow-${s}" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="${c}" /></marker>`;}).join('')}</defs>${paths}</svg>`;
}

function renderLogsOnly(){
  const c=$('#logs-list'); if(!c) return;
  if(!state.logs.length){ c.innerHTML=`<div class="text-sm p-2" style="color:var(--muted)">No executions yet.</div>`; return; }
  c.innerHTML = state.logs.slice(0,20).map(l=>{ let nodeHtml=''; if(l.nodeLogs){ try{ const nls=JSON.parse(l.nodeLogs); nodeHtml=`<div class="mt-2 flex flex-wrap gap-1">${nls.map(n=>`<span class="badge ${n.status==='success'?'b-success':n.status==='error'?'b-error':n.status==='running'?'b-running':'b-idle'}">${esc(n.name)}:${esc(n.status)}</span>`).join('')}</div>`;}catch{} } const bc=l.status==='completed'?'b-success':l.status==='failed'?'b-error':l.status==='running'?'b-running':'b-idle'; return `<div class="rounded-lg p-2 mb-2" style="background:#222226;border:1px solid var(--border)"><div class="flex items-center justify-between gap-2"><div class="text-sm font-medium truncate">${esc(l.workflowName||l.prompt||'Run')}</div><span class="badge ${bc}">${esc(l.status)}</span></div><div class="text-[11px]" style="color:var(--muted)">${esc(l.updatedAt||l.createdAt||'')}</div>${nodeHtml}${l.error?`<pre class="mt-2 text-xs p-2 rounded" style="background:rgba(239,68,68,.08);color:#fca5a5;white-space:pre-wrap">${esc(l.error)}</pre>`:''}</div>`; }).join('');
}

function providerOptions(selected){ const opts=[['auto','Auto (Gemini → Groq → Cloudflare)'],['gemini-flash','Gemini 3 Flash'],['gemini-pro','Gemini 3.1 Pro'],['groq','Groq (Llama 3.3 70B)'],['openrouter','OpenRouter'],['cloudflare','Cloudflare Workers AI'],['custom','Custom Model ID...']]; return opts.map(([v,l])=>`<option value="${v}" ${selected===v?'selected':''}>${l}</option>`).join(''); }

function getLatestNodeOutput(nodeId){
  for(const l of (state.logs||[])){
    if(!l || !l.nodeLogs) continue;
    try {
      const nls = typeof l.nodeLogs === 'string' ? JSON.parse(l.nodeLogs) : l.nodeLogs;
      const nl = Array.isArray(nls) ? nls.find(x=>x && x.nodeId===nodeId) : null;
      if(nl) return nl.output !== undefined ? nl.output : nl;
    } catch {}
  }
  return undefined;
}

function renderNodeDrawer(){
  const drawer=$('#node-drawer'); if(!drawer) return; const n=getNode(state.selectedNodeId);
  if(!n||!state.drawerOpen){ drawer.classList.remove('open'); drawer.innerHTML=''; return; }
  drawer.classList.add('open');
  const tab = state.inspectorTab || 'config';
  const credOpts=`<option value="">— None —</option>`+state.vault.map(v=>`<option value="${esc(v.serviceId)}" ${n.credentialId===v.serviceId?'selected':''}>${esc(v.label||v.serviceId)}</option>`).join('');
  let fields='';
  if(n.type==='trigger'){ fields=`<label class="block mb-3"><span class="label">Trigger Type</span><select id="nd-subtype" class="select"><option value="manual" ${n.subtype==='manual'?'selected':''}>Manual Run</option><option value="webhook" ${n.subtype==='webhook'?'selected':''}>Webhook URL</option><option value="cron" ${n.subtype==='cron'?'selected':''}>Cron Schedule</option></select></label>${n.subtype==='cron'?`<label class="block mb-3"><span class="label">Cron Expression</span><input id="nd-cron" class="input" value="${esc(n.config?.cron||'0 9 * * *')}" /></label>`:''}`; }
  else if(n.type==='ai'){ fields=`<label class="block mb-3"><span class="label">Provider / Model</span><select id="nd-provider" class="select">${providerOptions(n.config?.provider||'auto')}</select></label><label class="block mb-3"><span class="label">Custom Model ID (optional)</span><input id="nd-custom-model" class="input" placeholder="e.g. gemini-3.1-pro-preview" value="${esc(n.config?.customModelId||'')}" /></label><label class="block mb-3"><span class="label">System Prompt</span><textarea id="nd-system" rows="2" class="input">${esc(n.config?.system||'')}</textarea></label><label class="block mb-3"><span class="label">Prompt ({{ $json.output }}, {{nodeId.output}})</span><textarea id="nd-prompt" rows="6" class="input">${esc(n.config?.prompt||'')}</textarea></label>`; }
  else if(n.type==='code'){ fields=`<label class="block mb-3"><span class="label">JavaScript ($input, $secrets)</span><textarea id="nd-code" rows="12" class="input" style="font-family:ui-monospace,monospace">${esc(n.config?.code||'return $input;')}</textarea></label>`; }
  else { fields=`<label class="block mb-3"><span class="label">Action Type</span><select id="nd-subtype" class="select">${[['twitter','X/Twitter'],['youtube','YouTube'],['gmail','Gmail'],['drive','Drive'],['sheets','Sheets'],['http','HTTP Request'],['webhook','Custom Webhook'],['telegram','Telegram'],['discord','Discord']].map(([v,l])=>`<option value="${v}" ${n.subtype===v?'selected':''}>${l}</option>`).join('')}</select></label><label class="block mb-3"><span class="label">HTTP Method</span><select id="nd-method" class="select">${['POST','GET','PUT','PATCH','DELETE'].map(m=>`<option ${String(n.config?.method||'POST').toUpperCase()===m?'selected':''}>${m}</option>`).join('')}</select></label><label class="block mb-3"><span class="label">URL / Endpoint</span><input id="nd-url" class="input" placeholder="https://..." value="${esc(n.config?.url||'')}" /></label><label class="block mb-3"><span class="label">Body / Message</span><textarea id="nd-body" rows="5" class="input">${esc(typeof n.config?.body==='string'?n.config.body:(n.config?.body?JSON.stringify(n.config.body,null,2):(n.config?.message||'')))}</textarea></label>`; }
  const out = getLatestNodeOutput(n.id);
  let outStr = 'No output yet. Run the workflow to see this node\'s latest output.';
  if(out!==undefined){
    if(typeof out==='string') outStr = out;
    else { try{ outStr = JSON.stringify(out, null, 2) ?? toText(out); }catch{ outStr = toText(out); } }
    if(!outStr) outStr = 'No output yet. Run the workflow to see this node\'s latest output.';
  }
  const configHtml = `<label class="block mb-3"><span class="label">Node Name</span><input id="nd-name" class="input" value="${esc(n.name||'')}" /></label>${fields}
      <label class="block mb-3"><span class="label">Attached Vault Credential</span><div class="flex gap-2"><select id="nd-cred" class="select flex-1">${credOpts}</select><button id="nd-add-cred" class="btn text-xs">+ Add</button></div></label>
      <div class="text-xs p-2 rounded" style="background:#18181b;border:1px solid var(--border);color:var(--muted)">Variables: <code>{{ $json.output }}</code>, <code>{{$input}}</code>, <code>{{nodeId.output}}</code>. Code nodes receive <code>$input</code> and <code>$secrets</code>.</div>`;
  const outputHtml = `<div class="mb-2 text-xs" style="color:var(--muted)">Latest execution output for this node (read-only).</div><pre class="text-xs p-3 rounded overflow-auto scrollbar" style="background:#0f0f12;border:1px solid #2f2f35;white-space:pre-wrap;max-height:60vh">${esc(outStr)}</pre>`;
  drawer.innerHTML = `<div class="h-full flex flex-col" style="background:var(--bg2);border-left:1px solid var(--border)">
    <div class="p-4 border-b" style="border-color:var(--border)"><div class="flex items-center justify-between"><div><div class="text-xs" style="color:var(--muted)">Node Inspector</div><div class="font-semibold">${esc(n.name)}</div></div><button id="nd-close" class="text-xl">&times;</button></div>
      <div class="flex gap-2 mt-3"><button data-nd-tab="config" class="btn text-xs ${tab==='config'?'btn-primary':''}">Parameters / Config</button><button data-nd-tab="output" class="btn text-xs ${tab==='output'?'btn-primary':''}">Output JSON</button></div>
    </div>
    <div class="flex-1 overflow-auto scrollbar p-4">${tab==='output'?outputHtml:configHtml}</div>
    ${tab==='output'?`<div class="p-4 border-t" style="border-color:var(--border)"><button id="nd-close2" class="btn w-full">Close</button></div>`:`<div class="p-4 border-t flex gap-2" style="border-color:var(--border)"><button id="nd-save" class="btn btn-primary flex-1">Save</button><button id="nd-delete" class="btn" style="color:#fca5a5">Delete</button></div>`}
  </div>`;
  bindDrawerEvents();
}

function renderSettings(){
  const tab=state.settingsTab||'ai';
  const connected=(id)=>isCredConnected(id.replace(/^google_/,''));
  const presetList = [
    {name:'Google Gemini (AQ./AIza)',serviceId:'gemini',label:'Gemini API',fields:[['apiKey','']]},
    {name:'Groq',serviceId:'groq',label:'Groq',fields:[['apiKey','']]},
    {name:'OpenRouter',serviceId:'openrouter',label:'OpenRouter',fields:[['apiKey','']]},
    {name:'GitHub',serviceId:'github',label:'GitHub',fields:[['token','']]},
    {name:'X/Twitter',serviceId:'twitter',label:'X/Twitter',fields:[['apiKey',''],['apiSecret',''],['accessToken',''],['accessSecret',''],['bearerToken','']]},
    {name:'OpenAI',serviceId:'openai',label:'OpenAI',fields:[['apiKey','']]},
    {name:'searxng (SearXNG Instance)',serviceId:'searxng',label:'SearXNG Instance',fields:[['instanceUrl','https://searxng-6mmb.onrender.com'],['authHeaderName',''],['authHeaderValue','']]},
    {name:'Custom Webhook/API Key',serviceId:'custom-webhook',label:'Custom Webhook',fields:[['url','https://'],['method','POST'],['authorization','Bearer ']]}
  ];
  const googleSvcs=['youtube','gmail','drive','sheets'];
  return `<div class="flex-1 min-h-0 flex flex-col" style="background:var(--bg)">
    <div class="px-4 pt-4 border-b" style="border-color:var(--border);background:#1e1e22"><h1 class="text-xl font-semibold mb-2">Settings</h1>
      <div class="flex gap-4 text-sm"><div data-stab="ai" class="tab ${tab==='ai'?'active':''}">AI Models & Routing</div><div data-stab="vault" class="tab ${tab==='vault'?'active':''}">Credentials Vault</div><div data-stab="general" class="tab ${tab==='general'?'active':''}">General / Account</div></div>
    </div>
    <div class="flex-1 overflow-auto scrollbar p-4 md:p-6">
      ${tab==='ai'?`<div class="max-w-3xl space-y-4">
        <div class="rounded-xl p-4" style="background:var(--bg2);border:1px solid var(--border)"><div class="font-medium mb-3">Default AI Provider & Routing</div>
          <label class="block mb-3"><span class="label">Provider</span><select id="set-provider" class="select">${providerOptions(state.aiSettings.provider||'auto')}</select></label>
          <label class="block mb-3"><span class="label">Custom Model ID override (optional, e.g. gemini-3.1-pro-preview, llama-3.3-70b-versatile)</span><input id="set-custom-model" class="input" value="${esc(state.aiSettings.customModelId||'')}" placeholder="Leave blank to use provider defaults" /></label>
          <div class="text-xs" style="color:var(--muted)">Auto chain: Gemini 3 Flash → Groq → OpenRouter → Cloudflare Workers AI (with automatic failover on 404/429/401/403/503). Google keys (AQ. or AIza) are sent via <code>x-goog-api-key</code>.</div>
        </div>
        <div class="rounded-xl p-4" style="background:var(--bg2);border:1px solid var(--border)"><div class="font-medium mb-3">API Keys (stored encrypted in Vault)</div>
          <label class="block mb-3"><span class="label">Google Gemini API Key (AQ. or AIza)</span><input id="set-gemini-key" class="input" placeholder="AQ... or AIza..." value="${esc(state.aiSettings.geminiKey||'')}" /></label>
          <label class="block mb-3"><span class="label">Groq API Key</span><input id="set-groq-key" class="input" placeholder="gsk_..." value="${esc(state.aiSettings.groqKey||'')}" /></label>
          <label class="block mb-3"><span class="label">OpenRouter API Key</span><input id="set-openrouter-key" class="input" placeholder="sk-or-..." value="${esc(state.aiSettings.openrouterKey||'')}" /></label>
          <button id="save-ai-settings" class="btn btn-primary">Save AI Settings & Keys</button>
        </div>
      </div>`:''}
      ${tab==='vault'?`<div class="grid lg:grid-cols-2 gap-4 max-w-6xl">
        <div class="rounded-xl p-4 space-y-4" style="background:var(--bg2);border:1px solid var(--border)">
          <div><div class="font-medium mb-2">1-Click Google OAuth Connections</div>
            <div class="grid grid-cols-2 gap-2">${googleSvcs.map(s=>`<button data-gconn="${s}" class="btn text-sm ${state.vaultFocusService===`google_${s}`?'ring-2 ring-pink-500':''}">Sign in with Google<br><span style="color:var(--muted);font-weight:400">${s.charAt(0).toUpperCase()+s.slice(1)}</span> ${connected(`google_${s}`)?'<span class="badge b-success">Connected</span>':''}</button>`).join('')}</div>
            <div class="text-xs mt-2 p-2 rounded" style="background:#18181b;border:1px solid var(--border);color:var(--muted)">Requires Worker secrets <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>. Redirect URI: <code>https://automation.iniakinpelu2020.workers.dev/api/oauth/google/callback</code>. If not configured, the start endpoint returns setup instructions.</div>
          </div>
          <div><div class="font-medium mb-2">Presets</div><div class="flex flex-wrap gap-2">${presetList.map((p,i)=>`<button data-preset="${i}" class="pill">${esc(p.name)}</button>`).join('')}</div></div>
          <div class="rounded-lg p-3 space-y-2" style="background:#18181b;border:1px solid var(--border)">
            <div class="flex items-center justify-between gap-2 flex-wrap"><div class="font-medium text-sm">SearXNG Web Search</div>${state.searxngTest && state.searxngTest.ok ? '<span class="badge b-success">Connected</span>' : ''}</div>
            <div class="text-xs" style="color:var(--muted)">Default endpoint: <code>https://searxng-6mmb.onrender.com</code>. Save a custom <code>searxng</code> credential in Vault to override (instanceUrl, optional authHeaderName/authHeaderValue).</div>
            <div class="flex items-center gap-2 flex-wrap"><button id="test-searxng" type="button" class="btn text-sm">Test Connection</button>${state.searxngTest && state.searxngTest.loading ? '<span class="text-xs" style="color:var(--muted)">Testing...</span>' : ''}</div>
            ${state.searxngTest && state.searxngTest.msg ? `<div class="text-xs p-2 rounded" style="${state.searxngTest.ok ? 'background:rgba(16,185,129,.12);color:#6ee7b7;border:1px solid rgba(16,185,129,.3)' : 'background:rgba(239,68,68,.08);color:#fca5a5;border:1px solid rgba(239,68,68,.25)'}">${esc(state.searxngTest.msg)}</div>` : ''}
          </div>
          <form id="vault-form" class="space-y-3 pt-2 border-t" style="border-color:var(--border)"><div class="font-medium">Add / Update Credential</div>
            <div class="grid grid-cols-2 gap-2"><label class="block"><span class="label">Service ID</span><input id="v-serviceId" class="input" required /></label><label class="block"><span class="label">Label</span><input id="v-label" class="input" required /></label></div>
            <div class="flex items-center justify-between"><span class="label mb-0">Secret fields</span><button type="button" id="v-add" class="text-sm" style="color:#fda4af">+ Add field</button></div>
            <div id="v-kv" class="space-y-2">${(state._vaultKV||[{key:'',value:''}]).map((p,i)=>`<div class="grid grid-cols-12 gap-2"><input data-i="${i}" data-k="key" class="input col-span-5 text-sm" placeholder="Key" value="${esc(p.key)}" /><input data-i="${i}" data-k="value" class="input col-span-6 text-sm" placeholder="Value" value="${esc(p.value)}" /><button type="button" data-rm="${i}" class="col-span-1 btn">×</button></div>`).join('')}</div>
            <button class="btn btn-primary w-full">Save Credential</button>
          </form>
        </div>
        <div class="rounded-xl p-4" style="background:var(--bg2);border:1px solid var(--border)">
          <div class="flex items-center justify-between mb-3"><div class="font-medium">Connected Credentials</div><button id="v-refresh" class="btn text-sm">Refresh</button></div>
          <div class="space-y-2 max-h-[70vh] overflow-auto scrollbar pr-1">${state.vault.length?state.vault.map(v=>`<div class="rounded-lg p-3 flex items-center justify-between gap-3" style="background:#18181b;border:1px solid var(--border)"><div class="min-w-0"><div class="font-medium truncate">${esc(v.label||v.serviceId)}</div><div class="text-xs truncate" style="color:var(--muted)">ID: ${esc(v.serviceId)} · ${esc(v.updatedAt||'')}</div></div><div class="flex gap-2"><button data-vtest="${esc(v.serviceId)}" class="btn text-xs">Test</button><button data-vdel="${esc(v.serviceId)}" class="btn text-xs" style="color:#fca5a5">Delete</button></div></div>`).join(''):`<div class="text-sm" style="color:var(--muted)">No credentials saved.</div>`}</div>
        </div>
      </div>`:''}
      ${tab==='general'?`<div class="max-w-2xl space-y-4"><div class="rounded-xl p-4" style="background:var(--bg2);border:1px solid var(--border)"><div class="font-medium mb-3">Account</div>
        <div class="grid gap-2 text-sm"><div><span style="color:var(--muted)">Email:</span> ${esc(state.user?.email||'—')}</div><div><span style="color:var(--muted)">Firebase UID:</span> <code>${esc(state.user?.uid||'—')}</code></div><div><span style="color:var(--muted)">Active Worker URL:</span> <code>${esc(location.origin)}</code></div></div>
        <div class="mt-4"><button id="logout" class="btn" style="color:#fca5a5">Sign out</button></div>
      </div><div class="rounded-xl p-4" style="background:var(--bg2);border:1px solid var(--border)"><div class="font-medium mb-2">About</div><div class="text-sm" style="color:var(--muted)">Multi-provider AI router: Gemini 3 (Flash/Pro) → Groq → OpenRouter → Cloudflare Workers AI fallback. Encrypted vault at <code>/api/vault</code> (AES-256-GCM). Workflows run via Durable Objects + Cloudflare Workflows.</div></div></div>`:''}
    </div>
  </div>`;
}

function renderCanvasView(){
  return `<div class="flex-1 flex flex-col min-h-0"><div class="flex-1 relative"><div id="canvas-wrap" class="absolute inset-0"><div id="canvas-world"></div>
      <div class="absolute left-3 bottom-3 rounded-lg p-1 flex items-center gap-1 text-sm z-10" style="background:var(--bg2);border:1px solid var(--border)"><button id="zoom-out" class="px-2 py-1 hover:bg-zinc-700 rounded">−</button><span id="zoom-label" class="px-2">${Math.round(state.zoom*100)}%</span><button id="zoom-in" class="px-2 py-1 hover:bg-zinc-700 rounded">+</button></div>
      <div class="absolute right-3 top-3 z-10 flex gap-2"><button id="add-node-btn" class="btn text-sm">+ Add Node</button><div id="add-menu" class="hidden absolute right-0 mt-10 w-56 rounded-lg p-1 z-30" style="background:var(--bg2);border:1px solid var(--border)">${[['trigger','manual','⚡ Manual Trigger'],['trigger','webhook','⚡ Webhook'],['trigger','cron','⚡ Cron Schedule'],['ai','workers-ai','🧠 AI Agent'],['code','js','</> Code / JS'],['action','http','⇄ HTTP Request'],['action','twitter','𝕏 X/Twitter'],['action','youtube','▶ YouTube'],['action','telegram','✈ Telegram'],['action','discord','💬 Discord']].map(([t,s,l])=>`<button data-add="${t}:${s}" class="w-full text-left px-3 py-2 hover:bg-zinc-700 rounded text-sm">${l}</button>`).join('')}</div></div>
    </div></div>
    <div id="exec-drawer" class="border-t" style="border-color:var(--border);background:#1e1e22"><button id="exec-toggle" class="w-full px-3 py-2 text-xs flex items-center justify-between" style="color:var(--muted)"><span>Executions</span><span>${state.logs.length} runs ${state.execOpen?'▼':'▲'}</span></button><div id="logs-list" class="${state.execOpen?'max-h-48 pb-2':'max-h-0'} overflow-auto scrollbar px-2 transition-all"></div></div></div>`;
}

function renderAssistantView(){
  return `<div class="flex-1 flex flex-col min-h-0" style="background:var(--bg)">
    <div id="chat-messages" class="flex-1 overflow-auto scrollbar p-4 space-y-3"></div>
    <div id="cred-rows"></div>
    <div class="p-3 border-t space-y-2" style="border-color:var(--border);background:#1e1e22">
      <div class="flex flex-wrap gap-2 items-center"><select id="chat-provider" class="select !w-auto text-xs py-1">${providerOptions(state.chatProvider||'auto')}</select><input id="chat-custom-model" class="input !w-56 text-xs py-1" placeholder="Custom Model ID (optional)" value="${esc(state.chatCustomModel||'')}" /></div>
      <div class="flex gap-2 items-end"><textarea id="chat-input" rows="2" class="input flex-1" placeholder="Ask anything... describe the automation to build"></textarea><button id="chat-send" class="btn btn-primary">Send</button></div>
    </div></div>`;
}

function renderMain(){
  if(state.nav==='settings') return renderSettings();
  const execCount=state.logs.length; const viewTabs=[['assistant','Assistant'],['canvas','Canvas'],['split','Split View']];
  return `<div class="flex-1 flex flex-col min-h-0"><div class="flex items-center gap-2 px-3 py-2 border-b flex-wrap" style="border-color:var(--border);background:#1e1e22">
      <input id="wf-name" class="input !w-48 md:!w-64 !py-1.5" value="${esc(state.workflow.name)}" />
      <div class="flex items-center rounded-lg overflow-hidden" style="border:1px solid var(--border)">${viewTabs.map(([k,l])=>`<button data-view="${k}" class="px-3 py-1.5 text-sm ${state.view===k?'':'opacity-70'}" style="background:${state.view===k?'#2a2a30':'#222226'}">${l}</button>`).join('')}</div>
      <div class="ml-auto flex items-center gap-2"><span class="badge b-idle">${execCount} executions</span><button id="save-wf" class="btn text-sm">Save Workflow</button><button id="exec-wf" class="btn btn-primary text-sm">Execute Workflow</button></div>
    </div>
    <div class="flex-1 min-h-0 flex">${state.view==='assistant'?renderAssistantView():''}${state.view==='canvas'?renderCanvasView():''}${state.view==='split'?`<div class="flex-1 min-h-0 flex flex-col border-r" style="border-color:var(--border)">${renderAssistantView()}</div><div class="flex-1 min-h-0 flex flex-col split-right">${renderCanvasView()}</div>`:''}</div></div>`;
}

function renderApp(){ return `<div class="h-full flex" style="background:var(--bg)"><div id="sidebar" class="sidebar h-full"></div><div id="main" class="flex-1 flex flex-col min-h-0">${renderMain()}</div></div><div id="node-drawer" class="drawer ${state.drawerOpen?'open':''}"></div>`; }

function render(){
  const root=$('#app'); if(!root) return;
  if(!state.user){ root.innerHTML=renderAuth(); bindAuth(); return; }
  if(!root.dataset.shell){ root.innerHTML=renderApp(); root.dataset.shell='1'; renderSidebar(); renderChatPanel(); renderCanvas(); renderLogsOnly(); renderNodeDrawer(); bindGlobal(); }
  renderSidebar();
  const main=$('#main');
  const viewKey = `${state.nav}|${state.view}|${state.settingsTab}`;
  if(main && main.dataset.viewKey !== viewKey){ main.innerHTML = renderMain(); main.dataset.viewKey = viewKey; if(state.nav!=='settings'){ renderChatPanel(); renderCanvas(); renderLogsOnly(); } }
  else {
    const nameInp=$('#wf-name'); if(nameInp && document.activeElement!==nameInp) nameInp.value=state.workflow.name;
    if(state.nav==='settings') { /* keep settings form values unless focused handled by not rerendering structure */ }
  }
  renderNodeDrawer();
}

function bindAuth(){
  $('#auth-form')?.addEventListener('submit', async (e)=>{ e.preventDefault(); state.error=''; try{ await signInWithEmailAndPassword(auth,$('#email').value.trim(),$('#password').value);}catch(err){ state.error=err.message; render(); }});
  $('#signup-btn')?.addEventListener('click', async ()=>{ state.error=''; const em=$('#email').value.trim(),pw=$('#password').value; if(!em||!pw){state.error='Enter email and password.';render();return;} try{ await createUserWithEmailAndPassword(auth,em,pw);}catch(err){ state.error=err.message; render(); }});
  $('#google-btn')?.addEventListener('click', async ()=>{ state.error=''; try{ await signInWithPopup(auth,googleProvider);}catch(err){ state.error=err.message; render(); }});
}

let globalBound=false;
function bindGlobal(){
  if(globalBound) return; globalBound=true;
  document.addEventListener('click', async (e)=>{
    const t=e.target; if(!(t instanceof Element)) return;
    if(t.id==='sb-toggle'){ state.sidebarCollapsed=!state.sidebarCollapsed; renderSidebar(); }
    if(t.id==='new-chat'){ state.activeChatId=null; state.chatMessages=[]; state.requiredCredentials=[]; state.workflow={id:null,name:'Untitled workflow',nodes:[],edges:[],groups:[],triggerType:'manual'}; state.nav='assistant'; const main=$('#main'); if(main) main.dataset.viewKey=''; render(); }
    if(t.id==='logout'||t.closest('#logout')) signOut(auth);
    const stab=t.closest('[data-stab]'); if(stab){ state.settingsTab=stab.getAttribute('data-stab'); const main=$('#main'); if(main) main.dataset.viewKey=''; render(); }
    const nav=t.closest('[data-nav]'); if(nav){ state.nav=nav.getAttribute('data-nav'); const st=nav.getAttribute('data-settings-tab'); if(st) state.settingsTab=st; const main=$('#main'); if(main) main.dataset.viewKey=''; render(); }
    const chat=t.closest('[data-chat]'); if(chat){ await loadChat(chat.getAttribute('data-chat')); }
    const view=t.closest('[data-view]'); if(view){ state.view=view.getAttribute('data-view'); const main=$('#main'); if(main) main.dataset.viewKey=''; render(); }
    if(t.id==='save-wf') saveWorkflow();
    if(t.id==='exec-wf') executeWorkflow();
    if(t.id==='add-node-btn'){ const m=$('#add-menu'); if(m) m.classList.toggle('hidden'); }
    const add=t.closest('[data-add]'); if(add){ const [tp,sp]=add.getAttribute('data-add').split(':'); addNode(tp,sp); $('#add-menu')?.classList.add('hidden'); }
    const pill=t.closest('[data-pill]'); if(pill){ sendChat(pill.getAttribute('data-pill')); }
    if(t.id==='hero-send'){ const hi=$('#hero-input'); if(hi) sendChat(hi.value); }
    if(t.id==='chat-send'){ const ci=$('#chat-input'); if(ci){ state.chatInput=ci.value; sendChat(ci.value); } }
    const copyBtn=t.closest('[data-copy-code]'); if(copyBtn){ const code=decodeURIComponent(copyBtn.getAttribute('data-copy-code')||''); try{ await navigator.clipboard.writeText(code); const prev=copyBtn.textContent; copyBtn.textContent='Copied'; setTimeout(()=>{ copyBtn.textContent=prev; },1200); }catch{ alert('Copy failed'); } }
    const ins=t.closest('[data-insert-code]'); if(ins){ const msgIdx=Number(ins.getAttribute('data-insert-code')); const codeIdx=Number(ins.getAttribute('data-code-idx')||'0'); const msg=state.chatMessages[msgIdx]; if(msg){ const { blocks } = extractAssistantDisplay(msg); const b=blocks[codeIdx]; if(b){ const cn=defaultNode('code','js'); cn.config.code=b.code||''; cn.name=b.title||'Code / JS Transform'; addNodeFrom(cn); } } }
    const credFix=t.closest('[data-cred-fix]'); if(credFix){ openVaultForService(credFix.getAttribute('data-cred-fix'), credFix.getAttribute('data-ai')==='1'); }
    if(t.id==='zoom-in'){ state.zoom=Math.min(2,state.zoom+0.1); renderCanvas(); }
    if(t.id==='zoom-out'){ state.zoom=Math.max(0.3,state.zoom-0.1); renderCanvas(); }
    if(t.id==='exec-toggle'||t.closest('#exec-toggle')){ state.execOpen=!state.execOpen; const l=$('#logs-list'); const btn=$('#exec-toggle span:last-child'); if(btn) btn.textContent=`${state.logs.length} runs ${state.execOpen?'▼':'▲'}`; if(l){ l.className=`${state.execOpen?'max-h-48 pb-2':'max-h-0'} overflow-auto scrollbar px-2 transition-all`; } }
    if(t.id==='save-ai-settings') saveAISettings();
    if(t.id==='v-refresh') { await refreshVault(); const main=$('#main'); if(state.nav==='settings'&&main){ main.dataset.viewKey=''; render(); } }
    const gconn=t.closest('[data-gconn]'); if(gconn){ const service=gconn.getAttribute('data-gconn'); if(!state.token) return alert('Not authenticated'); window.open(`/api/oauth/google/start?service=${encodeURIComponent(service)}&token=${encodeURIComponent(state.token)}`,'google_oauth','width=520,height=700'); }
    const preset=t.closest('[data-preset]'); if(preset){
      const presets=[
        {serviceId:'gemini',label:'Gemini API',fields:[['apiKey','']]},
        {serviceId:'groq',label:'Groq',fields:[['apiKey','']]},
        {serviceId:'openrouter',label:'OpenRouter',fields:[['apiKey','']]},
        {serviceId:'github',label:'GitHub',fields:[['token','']]},
        {serviceId:'twitter',label:'X/Twitter',fields:[['apiKey',''],['apiSecret',''],['accessToken',''],['accessSecret',''],['bearerToken','']]},
        {serviceId:'openai',label:'OpenAI',fields:[['apiKey','']]},
        {serviceId:'searxng',label:'SearXNG Instance',fields:[['instanceUrl','https://searxng-6mmb.onrender.com'],['authHeaderName',''],['authHeaderValue','']]},
        {serviceId:'custom-webhook',label:'Custom Webhook',fields:[['url','https://'],['method','POST'],['authorization','Bearer ']]}
      ];
      const p=presets[Number(preset.getAttribute('data-preset'))];
      if(p){ state._vaultKV=p.fields.map(([k,v])=>({key:k,value:v})); state.searxngTest=null; const main=$('#main'); if(main){main.dataset.viewKey='';} render(); setTimeout(()=>{ const s=$('#v-serviceId'),l=$('#v-label'); if(s) s.value=p.serviceId; if(l) l.value=p.label; },0); }
    }
    const vdel=t.closest('[data-vdel]'); if(vdel){ const id=vdel.getAttribute('data-vdel'); if(confirm(`Delete credential "${id}"?`)){ try{ await api(`/api/vault/${encodeURIComponent(id)}`,{method:'DELETE'}); await refreshVault(); renderCredentialRows(); const main=$('#main'); if(state.nav==='settings'&&main){main.dataset.viewKey='';} render(); }catch(err){ alert(err.message);} } }
    if(t.id==='test-searxng' || t.closest('#test-searxng')){
      state.searxngTest={loading:true, ok:false, msg:''}; const m0=$('#main'); if(m0){m0.dataset.viewKey='';} render();
      try {
        const res = await api('/api/tools/search', { method:'POST', body: JSON.stringify({ query: 'test connection' }) });
        if(res && res.source === 'searxng'){
          state.searxngTest = { loading:false, ok:true, msg: `Connected to SearXNG (${res.instanceUrl||'configured instance'}). Returned ${(res.results||[]).length} result(s).` };
        } else if (res && res.source === 'duckduckgo' && (res.status === 403 || /403/.test(String(res.warning||'')))) {
          state.searxngTest = { loading:false, ok:false, msg: (res.warning || 'SearXNG returned 403.') + " Enable - json under search.formats in SearXNG's settings.yml, then retry." };
        } else {
          state.searxngTest = { loading:false, ok:false, msg: (res && res.warning) ? res.warning : 'SearXNG not reachable; fell back to DuckDuckGo.' };
        }
      } catch (err) {
        state.searxngTest = { loading:false, ok:false, msg: 'Test failed: ' + (err && err.message ? err.message : String(err)) };
      }
      const m1=$('#main'); if(m1){m1.dataset.viewKey='';} render();
      return;
    }
    const vtest=t.closest('[data-vtest]'); if(vtest){ const id=vtest.getAttribute('data-vtest'); if(id==='searxng'){ document.getElementById('test-searxng')?.click(); } else { alert(`Credential "${id}" is stored (encrypted). Runtime connectivity is verified when workflows execute using this credential.`); } }
  });
  document.addEventListener('input',(e)=>{ const t=e.target; if(!(t instanceof Element)) return; if(t.id==='wf-name') state.workflow.name=t.value; if(t.id==='chat-input') state.chatInput=t.value; if(t.id==='chat-provider') state.chatProvider=t.value; if(t.id==='chat-custom-model') state.chatCustomModel=t.value; if(t.id==='set-provider') state.aiSettings.provider=t.value; if(t.id==='set-custom-model') state.aiSettings.customModelId=t.value; if(t.id==='set-gemini-key') state.aiSettings.geminiKey=t.value; if(t.id==='set-groq-key') state.aiSettings.groqKey=t.value; if(t.id==='set-openrouter-key') state.aiSettings.openrouterKey=t.value; if(t.closest('#v-kv')){ const i=Number(t.getAttribute('data-i')); const k=t.getAttribute('data-k'); if(state._vaultKV&&state._vaultKV[i]) state._vaultKV[i][k]=t.value; } });
  document.addEventListener('submit', async (e)=>{ const t=e.target; if(!(t instanceof Element)) return; if(t.id==='vault-form'){ e.preventDefault(); const serviceId=$('#v-serviceId').value.trim(); const label=$('#v-label').value.trim(); const secretData={}; for(const p of (state._vaultKV||[])){ if(p.key&&p.key.trim()) secretData[p.key.trim()]=p.value; } if(!Object.keys(secretData).length) return alert('Add at least one secret field.'); try{ await api('/api/vault',{method:'POST',body:JSON.stringify({serviceId,label,secretData})}); state._vaultKV=[{key:'',value:''}]; await refreshVault(); renderCredentialRows(); if(state.returnTo==='workflow'){ state.nav='assistant'; state.returnTo=null; } const main=$('#main'); if(main){main.dataset.viewKey='';} render(); }catch(err){ alert(err.message);} } });
  document.addEventListener('click',(e)=>{ const t=e.target; if(!(t instanceof Element)) return; if(t.id==='v-add'){ (state._vaultKV=state._vaultKV||[{key:'',value:''}]).push({key:'',value:''}); const main=$('#main'); if(state.nav==='settings'&&main){main.dataset.viewKey='';} render(); } const rm=t.closest('[data-rm]'); if(rm){ state._vaultKV.splice(Number(rm.getAttribute('data-rm')),1); if(!state._vaultKV.length) state._vaultKV.push({key:'',value:''}); const main=$('#main'); if(state.nav==='settings'&&main){main.dataset.viewKey='';} render(); } });
  window.addEventListener('message', async (ev)=>{ const d=ev.data; if(!d||d.type!=='oauth-success') return; if(d.saved){ await refreshVault(); } else if(d.secretData && d.serviceId){ try{ await api('/api/vault',{method:'POST', body: JSON.stringify({serviceId:d.serviceId,label:`Google ${d.service}`,secretData:d.secretData})}); await refreshVault(); }catch(err){ console.warn('OAuth fallback save failed',err);} } renderCredentialRows(); const main=$('#main'); if(state.nav==='settings'&&main){main.dataset.viewKey='';} render(); });
}

function addNodeFrom(n){ const wrap=$('#canvas-wrap'); if(wrap){ const r=wrap.getBoundingClientRect(); n.position={x:(r.width/2-state.pan.x)/state.zoom-90,y:(r.height/2-state.pan.y)/state.zoom-40}; } state.workflow.nodes.push(n); renderCanvas(); }

function openVaultForService(service, ai=false){
  state.returnTo = state.nav==='settings'?null:'workflow';
  state.nav='settings'; state.settingsTab = ai ? 'ai' : 'vault';
  const s=(service||'').toLowerCase().replace(/^google_/,'');
  if(!ai){ const map={youtube:['google_youtube','Google YouTube',[['access_token','(auto via Sign in with Google)']]],gmail:['google_gmail','Google Gmail',[['access_token','(auto)']]],drive:['google_drive','Google Drive',[['access_token','(auto)']]],sheets:['google_sheets','Google Sheets',[['access_token','(auto)']]],twitter:['twitter','X/Twitter',[['apiKey',''],['apiSecret',''],['accessToken',''],['accessSecret',''],['bearerToken','']]],openai:['openai','OpenAI',[['apiKey','']]],webhook:['custom-webhook','Custom Webhook',[['url','https://'],['method','POST'],['authorization','Bearer ']]],github:['github','GitHub',[['token','']]]}; const p=map[s]; if(p){ state._vaultKV=p[2].map(([k,v])=>({key:k,value:v})); state.vaultFocusService=p[0]; setTimeout(()=>{ const si=$('#v-serviceId'),lb=$('#v-label'); if(si) si.value=p[0]; if(lb) lb.value=p[1]; },50);} else { state._vaultKV=[{key:'',value:''}]; } }
  const main=$('#main'); if(main) main.dataset.viewKey=''; render();
}

async function saveAISettings(){
  try{
    const provider=$('#set-provider')?.value||state.aiSettings.provider||'auto';
    const customModelId=$('#set-custom-model')?.value||'';
    const geminiKey=$('#set-gemini-key')?.value?.trim()||'';
    const groqKey=$('#set-groq-key')?.value?.trim()||'';
    const openrouterKey=$('#set-openrouter-key')?.value?.trim()||'';
    await api('/api/agent/settings',{method:'POST',body:JSON.stringify({provider,customModelId})});
    const saves=[];
    if(geminiKey) saves.push(api('/api/vault',{method:'POST',body:JSON.stringify({serviceId:'gemini',label:'Gemini API',secretData:{apiKey:geminiKey}})}));
    if(groqKey) saves.push(api('/api/vault',{method:'POST',body:JSON.stringify({serviceId:'groq',label:'Groq',secretData:{apiKey:groqKey}})}));
    if(openrouterKey) saves.push(api('/api/vault',{method:'POST',body:JSON.stringify({serviceId:'openrouter',label:'OpenRouter',secretData:{apiKey:openrouterKey}})}));
    if(saves.length) await Promise.all(saves);
    state.aiSettings.provider=provider; state.aiSettings.customModelId=customModelId; await refreshVault(); alert('AI settings saved.');
  }catch(e){ alert('Save failed: '+e.message); }
}

function bindCanvasEvents(){
  const wrap=$('#canvas-wrap'), world=$('#canvas-world'); if(!wrap||!world) return;
  $$('#canvas-world .node').forEach(nodeEl=>{ const id=nodeEl.getAttribute('data-node-id'); nodeEl.addEventListener('pointerdown',(e)=>{ if(e.target.closest('[data-port-out]')) return; if(e.target.closest('[data-drag-handle]')){ e.stopPropagation(); const n=getNode(id); if(!n) return; state.dragNode={id,startX:e.clientX,startY:e.clientY,orig:{...n.position}}; nodeEl.setPointerCapture?.(e.pointerId);} }); nodeEl.addEventListener('pointermove',(e)=>{ if(state.dragNode&&state.dragNode.id===id){ const dx=(e.clientX-state.dragNode.startX)/state.zoom, dy=(e.clientY-state.dragNode.startY)/state.zoom; const n=getNode(id); n.position={x:state.dragNode.orig.x+dx,y:state.dragNode.orig.y+dy}; renderCanvas(); }}); nodeEl.addEventListener('pointerup',()=>{ if(state.dragNode&&state.dragNode.id===id) state.dragNode=null; }); nodeEl.addEventListener('click',(e)=>{ if(e.target.closest('[data-port-out]')||state.dragNode) return; state.selectedNodeId=id; state.drawerOpen=true; renderNodeDrawer(); }); });
  $$('#canvas-world [data-port-out]').forEach(p=>p.addEventListener('pointerdown',(e)=>{ e.stopPropagation(); state.connectingFrom=p.getAttribute('data-port-out'); }));
  wrap.addEventListener('pointerup',(e)=>{ if(state.connectingFrom){ const tn=e.target.closest?.('.node'); if(tn){ const tid=tn.getAttribute('data-node-id'); if(tid&&tid!==state.connectingFrom) connectNodes(state.connectingFrom,tid); } state.connectingFrom=null; renderCanvas(); } state.isPointerDown=false; state.panStart=null; });
  wrap.onpointerdown=(e)=>{ if(e.target.closest('.node')||e.target.closest('button')) return; state.isPointerDown=true; state.panStart={x:e.clientX,y:e.clientY,pan:{...state.pan}}; };
  wrap.onpointermove=(e)=>{ if(state.isPointerDown&&state.panStart&&!state.dragNode&&!state.connectingFrom){ state.pan.x=state.panStart.pan.x+(e.clientX-state.panStart.x); state.pan.y=state.panStart.pan.y+(e.clientY-state.panStart.y); const w=$('#canvas-world'); if(w) w.style.transform=`translate(${state.pan.x}px,${state.pan.y}px) scale(${state.zoom})`; }};
  wrap.onwheel=(e)=>{ e.preventDefault(); const delta=-e.deltaY*0.001; const nz=Math.min(2,Math.max(0.3,state.zoom+delta)); const rect=wrap.getBoundingClientRect(); const mx=e.clientX-rect.left,my=e.clientY-rect.top; const wx=(mx-state.pan.x)/state.zoom, wy=(my-state.pan.y)/state.zoom; state.zoom=nz; state.pan.x=mx-wx*state.zoom; state.pan.y=my-wy*state.zoom; renderCanvas(); },{passive:false};
  let pinch=null; wrap.addEventListener('touchstart',(e)=>{ if(e.touches.length===2){ const dx=e.touches[0].clientX-e.touches[1].clientX,dy=e.touches[0].clientY-e.touches[1].clientY; pinch={dist:Math.hypot(dx,dy),zoom:state.zoom}; }},{passive:true}); wrap.addEventListener('touchmove',(e)=>{ if(e.touches.length===2&&pinch){ const dx=e.touches[0].clientX-e.touches[1].clientX,dy=e.touches[0].clientY-e.touches[1].clientY; state.zoom=Math.min(2,Math.max(0.3,pinch.zoom*(Math.hypot(dx,dy)/pinch.dist))); renderCanvas(); }},{passive:true}); wrap.addEventListener('touchend',()=>{pinch=null;},{passive:true});
}

function bindDrawerEvents(){
  $('#nd-close')?.addEventListener('click',()=>{ state.drawerOpen=false; renderNodeDrawer(); });
  $('#nd-close2')?.addEventListener('click',()=>{ state.drawerOpen=false; renderNodeDrawer(); });
  $('[data-nd-tab]').forEach(btn=>btn.addEventListener('click',()=>{ state.inspectorTab = btn.getAttribute('data-nd-tab') || 'config'; renderNodeDrawer(); }));
  $('#nd-delete')?.addEventListener('click',()=>{ if(state.selectedNodeId) deleteNode(state.selectedNodeId); });
  $('#nd-add-cred')?.addEventListener('click',()=>{ state.drawerOpen=false; renderNodeDrawer(); openVaultForService('custom-webhook', false); });
  $('#nd-save')?.addEventListener('click',()=>{
    const n=getNode(state.selectedNodeId); if(!n) return; n.name=$('#nd-name')?.value||n.name; n.credentialId=$('#nd-cred')?.value||''; const st=$('#nd-subtype'); if(st) n.subtype=st.value;
    if(n.type==='trigger'){ if(n.subtype==='cron') n.config.cron=$('#nd-cron')?.value||'0 9 * * *'; state.workflow.triggerType=n.subtype||'manual'; }
    else if(n.type==='ai'){ n.config.provider=$('#nd-provider')?.value||'auto'; n.config.customModelId=$('#nd-custom-model')?.value||''; n.config.system=$('#nd-system')?.value; n.config.prompt=$('#nd-prompt')?.value; }
    else if(n.type==='code'){ n.config.code=$('#nd-code')?.value||''; }
    else { n.config.method=$('#nd-method')?.value||'POST'; n.config.url=$('#nd-url')?.value||''; const b=$('#nd-body')?.value??''; try{ n.config.body=JSON.parse(b);}catch{ n.config.body=b; } }
    state.drawerOpen=false; renderCanvas(); renderNodeDrawer();
  });
}

async function sendChat(text){
  const msg=(text||'').trim(); if(!msg||state.chatSending) return;
  state.chatInput=''; const ci=$('#chat-input'); if(ci) ci.value=''; const hi=$('#hero-input'); if(hi) hi.value='';

  // push user message
  state.chatMessages.push({role:'user',content:msg,ts:new Date().toISOString()});
  state.chatSending=true; renderChatPanel();
  try{
    // build conversation history for conversational follow-ups (exclude the just-added user msg duplication is fine; include all recent)
    const history = state.chatMessages
      .filter(m=>m.role==='user'||m.role==='assistant')
      .slice(-12)
      .map(m=>{
        if(m.role==='user') return { role:'user', content: m.content || '' };
        const { explanation } = extractAssistantDisplay(m);
        return { role:'assistant', content: explanation || m.content || '' };
      });

    const workflowCtx = {
      id: state.workflow.id || undefined,
      name: state.workflow.name || '',
      nodes: state.workflow.nodes || [],
      edges: state.workflow.edges || [],
      groups: state.workflow.groups || [],
      triggerType: state.workflow.triggerType || 'manual',
    };

    const res = await api('/api/agent/chat', {
      method:'POST',
      body: JSON.stringify({
        message: msg,
        chatId: state.activeChatId || undefined,
        history,
        workflow: workflowCtx,
        workflowGraph: workflowCtx,
        provider: state.chatProvider || 'auto',
        model: state.chatCustomModel || undefined
      })
    });

    state.activeChatId = res.chatId || state.activeChatId;
    const explanation = toText(res && (res.explanation ?? res.message ?? res.text)).trim();
    const action = toText(res && res.action).trim() || 'chat';
    const assistantMsg = {
      role:'assistant',
      content: explanation,
      data: { ...(res||{}), action },
      aiMeta: res && res.aiMeta ? res.aiMeta : undefined,
      ts: new Date().toISOString()
    };
    state.chatMessages.push(assistantMsg);

    if(res && Array.isArray(res.requiredCredentials)) state.requiredCredentials = res.requiredCredentials;
    else state.requiredCredentials = [];
    const hasGraph = !!(res && res.workflowGraph && ((Array.isArray(res.workflowGraph.nodes) && res.workflowGraph.nodes.length) || (Array.isArray(res.workflowGraph.edges) && res.workflowGraph.edges.length)));
    if(hasGraph){
      // updates workflow state, renders nodes/edges, centers view; returns false
      // (instead of throwing) when the generated graph had to be rejected.
      if(!applyWorkflowGraph(res.workflowGraph)) renderCanvas();
    } else {
      renderCanvas();
    }

    renderChatPanel();
    await refreshChats();

    if(action === 'execute'){
      const missing = (state.requiredCredentials||[]).filter(r=>!isCredConnected(r));
      if(missing.length){
        state.chatMessages.push({role:'assistant', content:`Cannot execute yet: missing required connections (${missing.join(', ')}). Please connect them above, then run again.`, data:{}, ts:new Date().toISOString()});
        renderChatPanel();
      } else {
        await executeWorkflow();
      }
    }
  }catch(e){
    state.chatMessages.push({role:'assistant',content:'Error: '+(toText(e && e.message)||'failed'),ts:new Date().toISOString()});
    renderChatPanel();
  }
  state.chatSending=false; renderChatPanel();
}

async function saveWorkflow(){ try{ state.workflow.name=$('#wf-name')?.value||state.workflow.name||'Untitled workflow'; const body={id:state.workflow.id||undefined,name:state.workflow.name,data:{nodes:state.workflow.nodes,edges:state.workflow.edges,groups:state.workflow.groups,triggerType:state.workflow.triggerType}}; const res=await api('/api/agent/workflows',{method:'POST',body:JSON.stringify(body)}); if(res&&res.id) state.workflow.id=res.id; await refreshWorkflows(); alert('Workflow saved'); }catch(e){ alert('Save failed: '+e.message); } }
async function pollExecution(logId){
  if(!logId) return null;
  state.activeExecutionId = logId;
  const started = Date.now();
  const timeoutMs = 180000;
  while(Date.now() - started < timeoutMs){
    try {
      await refreshLogs();
      const log = (state.logs||[]).find(l=>l && l.id===logId) || (state.logs||[])[0];
      if(log && log.nodeLogs){
        try {
          const nls = typeof log.nodeLogs === 'string' ? JSON.parse(log.nodeLogs) : log.nodeLogs;
          if(Array.isArray(nls)){
            const map = { ...state.runStatus };
            for(const nl of nls){ if(nl && nl.nodeId) map[nl.nodeId] = nl.status || map[nl.nodeId] || 'idle'; }
            state.runStatus = map;
            renderCanvas(); renderCanvasStatus();
            if(state.drawerOpen) renderNodeDrawer();
          }
        } catch {}
      }
      renderLogsOnly();
      if(log && (log.status==='completed' || log.status==='failed')) return log;
    } catch {}
    await new Promise(r=>setTimeout(r, 1200));
  }
  return null;
}

// Execution output belongs in the chat as text. A node's output is usually an
// object ({ output, provider, badge }), so it is unwrapped before it reaches
// the transcript instead of being interpolated as-is.
function nodeOutputText(output){
  if(output===undefined||output===null) return '';
  const base = (typeof output==='object' && 'output' in output) ? output.output : output;
  let text = toText(base).trim();
  if(!text) return '';
  const limit = (text.startsWith('{')||text.startsWith('[')) ? 700 : 900;
  return text.length > limit ? text.slice(0,limit)+'…' : text;
}

function summarizeRun(log){
  if(!log || typeof log!=='object') return '';
  const status = toText(log.status).trim() || 'completed';
  let nls = [];
  try{ nls = typeof log.nodeLogs==='string' ? JSON.parse(log.nodeLogs) : (Array.isArray(log.nodeLogs)?log.nodeLogs:[]); }catch{ nls=[]; }
  const lines = [];
  for(const nl of (Array.isArray(nls)?nls:[])){
    if(!nl || typeof nl!=='object') continue;
    const name = toText(nl.name || nl.nodeId).trim() || 'Node';
    const st = toText(nl.status).trim().toLowerCase();
    if(st==='success'){ const out = nodeOutputText(nl.output); lines.push(out ? `• ${name}: ${out}` : `• ${name}: done`); }
    else if(st==='error') lines.push(`• ${name}: failed — ${toText(nl.error).trim().slice(0,300) || 'error'}`);
    else if(st==='skipped') lines.push(`• ${name}: skipped`);
    if(lines.length>=6) break;
  }
  const head = status==='completed' ? 'Workflow finished.' : status==='failed' ? 'Workflow failed.' : `Workflow status: ${status}.`;
  const err = toText(log.error).trim();
  return [head, lines.length?lines.join('\n'):'', err?`Error: ${err.slice(0,600)}`:''].filter(Boolean).join('\n\n');
}

function appendRunToChat(log){
  const summary = summarizeRun(log);
  if(!summary) return;
  state.chatMessages.push({ role:'assistant', content: summary, data:{ action:'run-result' }, ts:new Date().toISOString() });
  renderChatPanel();
}

async function executeWorkflow(){
  try{
    state.runStatus={};
    for(const n of (state.workflow.nodes||[])) state.runStatus[n.id]='idle';
    renderCanvas();
    state.workflow.name=$('#wf-name')?.value||state.workflow.name;
    if(!state.workflow.nodes.length){ alert('Add at least one node.'); return; }
    const res = await api('/api/agent/run',{method:'POST', body: JSON.stringify({workflowId:state.workflow.id,workflowName:state.workflow.name,nodes:state.workflow.nodes,edges:state.workflow.edges,groups:state.workflow.groups||[],triggerType:state.workflow.triggerType||'manual'})});
    state.execOpen=true;
    await refreshLogs();
    const log = (res && res.logId) ? await pollExecution(res.logId) : await pollExecution(null);
    if(log) appendRunToChat(log);
  }catch(e){
    const message = toText(e && e.message) || String(e);
    state.chatMessages.push({ role:'assistant', content:'Execution failed: '+message, data:{ action:'run-result' }, ts:new Date().toISOString() });
    renderChatPanel();
    alert('Execution failed: '+message);
  }
}

let pollTimer=null; function startPolling(){ if(pollTimer) clearInterval(pollTimer); pollTimer=setInterval(async ()=>{ if(!state.user) return; if(isEditing()) return; await refreshLogs(); }, 3000); }

async function initApp(){
  try {
    render(); // show auth screen immediately
    const appMod = await import("https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js");
    const authMod = await import("https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js");
    ({ initializeApp, getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, signOut } = authMod);
    fbApp = appMod.initializeApp(firebaseConfig);
    auth = getAuth(fbApp);
    googleProvider = new GoogleAuthProvider();
    onAuthStateChanged(auth, async (user)=>{
      try {
        state.user=user||null; state.error='';
        if(user){
          state.token=await user.getIdToken();
          await Promise.all([refreshVault(),refreshLogs(),refreshWorkflows(),refreshChats(),refreshSettings()]);
          startPolling();
        } else {
          state.token=null; state.vault=[]; state.logs=[]; state.workflows=[]; state.chats=[];
          if(pollTimer) clearInterval(pollTimer);
        }
        const root=$('#app'); if(root){ root.dataset.shell=''; root.innerHTML=''; }
        render();
      } catch (e) { if(window.__showAppError) window.__showAppError((e && (e.stack||e.message)) || String(e)); }
    });
  } catch (e) {
    state.error = 'Failed to initialize app. ' + (e && e.message ? e.message : String(e));
    try { render(); } catch(_) {}
    if(window.__showAppError) window.__showAppError((e && (e.stack||e.message)) || String(e));
  }
}

initApp();
