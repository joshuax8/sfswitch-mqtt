/**
 * MeshCore NOC Dashboard - Frontend Application
 * Uses vanilla JS (no framework) per AGENTS.md rules
 */

const state = {
    mqttConnected: false,
    wsConnected: false,
    packets: [],
    observers: [],
    stats: {
        totalPackets: 0, packetsPerObserver: {}, packetTypes: {}, routeTypes: {},
        windowPackets: 0, bufferSize: 0, bufferCapacity: 0, observerCount: 0,
    },
    topology: { enabled: false, nodes: [], edges: [], observers: [] },
    alerts: [],
    currentView: 'overview',
    packetLimit: 100,
    lastUpdate: null,
};

const elements = {
    mqttStatus: document.getElementById('mqtt-status'),
    wsStatus: document.getElementById('ws-status'),
    navLinks: document.querySelectorAll('.nav-link'),
    views: document.querySelectorAll('.view'),
    statsTabs: document.querySelectorAll('.stats-tab'),
    statsContents: document.querySelectorAll('.stats-tab-content'),
    totalPackets: document.getElementById('total-packets'),
    activeObservers: document.getElementById('active-observers'),
    packetsPerSec: document.getElementById('packets-per-sec'),
    bufferUsage: document.getElementById('buffer-usage'),
    lastUpdate: document.getElementById('last-update'),
    observersTableBody: document.getElementById('observers-table-body'),
    observerFilter: document.getElementById('observer-filter'),
    observerSort: document.getElementById('observer-sort'),
    packetsTableBody: document.getElementById('packets-table-body'),
    refreshPackets: document.getElementById('refresh-packets'),
    packetLimit: document.getElementById('packet-limit'),
    perObserverStats: document.getElementById('per-observer-stats'),
    topologyNodeCount: document.getElementById('topology-node-count'),
    topologyEdgeCount: document.getElementById('topology-edge-count'),
    topologyStatus: document.getElementById('topology-status'),
    topologyCanvas: document.getElementById('topology-canvas'),
    topologyNodesTable: document.getElementById('topology-nodes-table'),
    topologyEdgesTable: document.getElementById('topology-edges-table'),
    alertsActiveCount: document.getElementById('alerts-active-count'),
    alertsList: document.getElementById('alerts-list'),
    alertsTableBody: document.getElementById('alerts-table-body'),
    acknowledgeAllAlerts: document.getElementById('acknowledge-all-alerts'),
    refreshAlerts: document.getElementById('refresh-alerts'),
};

const PACKET_TYPES = {'0':'REQ','1':'RESPONSE','2':'TXT_MSG','3':'ACK','4':'ADVERT','5':'GRP_TXT','6':'GRP_DATA','7':'ANON_REQ','8':'PATH','9':'TRACE','10':'MULTIPART','11':'CONTROL','15':'RAW_CUSTOM'};
const ROUTE_TYPES = {'F':'FLOOD','D':'DIRECT','T':'TRANSPORT'};

function formatNumber(num) { if (num == null) return '0'; num = parseFloat(num); if (num > 999) return (num/1000).toFixed(1)+'K'; return num.toLocaleString(); }
function formatSNR(snr) { if (snr == null) return 'N/A'; const v = parseFloat(snr); return isNaN(v) ? 'N/A' : v.toFixed(1)+' dB'; }
function formatRSSI(rssi) { if (rssi == null) return 'N/A'; const v = parseInt(rssi); return isNaN(v) ? 'N/A' : v+' dBm'; }
function formatTimestamp(ts) { if (!ts) return 'N/A'; try { return new Date(ts).toLocaleString(); } catch { return ts; } }
function timeAgo(ts) { const d = Math.floor((Date.now()-new Date(ts))/1000); if (d<60) return d+'s ago'; if (d<3600) return Math.floor(d/60)+'m ago'; if (d<86400) return Math.floor(d/3600)+'h ago'; return Math.floor(d/86400)+'d ago'; }
function truncate(str, len=20) { if (!str) return 'N/A'; return str.length<=len ? str : str.substring(0,len-3)+'...'; }
function getStatusBadge(s) { return `<span class="status-badge ${s}">${s}</span>`; }
function getSeverityBadge(s) { const c = getSeverityClass(s); return `<span class="severity-badge ${c}">${s||'info'}</span>`; }
function getSeverityClass(s) { switch((s||'').toLowerCase()) { case 'critical': return 'critical'; case 'warning': return 'warning'; default: return 'info'; } }

let ws, wsReconnectInterval;

function connectWebSocket() {
    let host = window.location.hostname, protocol = window.location.protocol==='https:'?'wss:':'ws:', port = window.location.port||(protocol==='wss:'?'443':'80');
    if (window.location.hostname==='localhost'||window.location.hostname==='127.0.0.1') { host='localhost'; port='3000'; protocol='ws:'; }
    const wsUrl = `${protocol}//${host}:${port}/ws`;
    try {
        ws = new WebSocket(wsUrl);
        ws.onopen = () => { state.wsConnected=true; updateStatusUI(); fetchHealth(); fetchStats(); fetchObservers(); fetchPackets(); fetchTopology(); fetchAlerts(); };
        ws.onmessage = (e) => { const d=JSON.parse(e.data); handleWS(d); };
        ws.onclose = () => { state.wsConnected=false; updateStatusUI(); startReconnect(); };
        ws.onerror = (err) => { console.error('WS error:',err); state.wsConnected=false; updateStatusUI(); };
    } catch(err) { console.error('WS failed:',err); state.wsConnected=false; updateStatusUI(); startReconnect(); }
}
function startReconnect() { clearInterval(wsReconnectInterval); wsReconnectInterval=setInterval(()=>{if(!state.wsConnected) connectWebSocket();},5000); }
function handleWS(data) {
    switch(data.type) {
        case 'init': state.stats=data.stats; state.observers=data.observers; break;
        case 'stats': state.stats=data.data; break;
        case 'packets': state.packets=data.data; break;
        case 'observers': state.observers=data.data; break;
        case 'topology': state.topology={enabled:true,...data.data}; break;
        case 'alerts': state.alerts=data.data||[]; break;
    }
    state.lastUpdate=new Date(); updateUI();
}

async function fetchHealth() { try { const r=await fetch('/health'), d=await r.json(); state.mqttConnected=d.mqtt?.connected||false; state.stats.bufferSize=d.backend?.packetsStored||0; state.stats.bufferCapacity=d.backend?.bufferCapacity||0; updateStatusUI(); updateUI(); } catch(e){console.error('Fetch health:',e);} }
async function fetchStats() { try { const r=await fetch('/api/stats'), d=await r.json(); state.stats=d; state.lastUpdate=new Date(); updateUI(); } catch(e){console.error('Fetch stats:',e);} }
async function fetchObservers() { try { const r=await fetch('/api/observers'), d=await r.json(); state.observers=d; state.lastUpdate=new Date(); updateUI(); } catch(e){console.error('Fetch observers:',e);} }
async function fetchPackets(limit=100) { try { const r=await fetch(`/api/packets?limit=${limit}`), d=await r.json(); state.packets=d; state.lastUpdate=new Date(); updateUI(); } catch(e){console.error('Fetch packets:',e);} }
async function fetchTopology() { try { const r=await fetch('/api/topology'), d=await r.json(); state.topology={enabled:!d.error,...d}; state.lastUpdate=new Date(); updateUI(); } catch(e){console.error('Fetch topology:',e); state.topology.enabled=false;} }
async function fetchAlerts() { try { const r=await fetch('/api/alerts'), d=await r.json(); state.alerts=d||[]; state.lastUpdate=new Date(); updateUI(); } catch(e){console.error('Fetch alerts:',e); state.alerts=[];} }
async function acknowledgeAlert(id,by='web') { try { const r=await fetch(`/api/alerts/acknowledge?id=${encodeURIComponent(id)}&by=${encodeURIComponent(by)}`), d=await r.json(); if(d.success){ const a=state.alerts.find(x=>x.id===id||x.alertId===id); if(a){a.acknowledged=true;a.acknowledgedAt=new Date().toISOString();a.acknowledgedBy=by;} updateUI();} return d.success; } catch(e){console.error('Ack alert:',e); return false;} }
async function acknowledgeAllAlerts(by='web') { try { const r=await fetch(`/api/alerts/acknowledge-all?by=${encodeURIComponent(by)}`), d=await r.json(); if(d.success){ state.alerts.forEach(a=>{a.acknowledged=true;a.acknowledgedAt=new Date().toISOString();a.acknowledgedBy=by;}); updateUI();} return d.success; } catch(e){console.error('Ack all:',e); return false;} }

function updateStatusUI() {
    if(elements.mqttStatus){ const dot=elements.mqttStatus.querySelector('.status-dot'), txt=elements.mqttStatus.querySelector('span:last-child'); if(dot) dot.className=`status-dot ${state.mqttConnected?'online':'offline'}`; if(txt) txt.textContent=`MQTT: ${state.mqttConnected?'Connected':'Disconnected'}`; }
    if(elements.wsStatus){ const dot=elements.wsStatus.querySelector('.status-dot'), txt=elements.wsStatus.querySelector('span:last-child'); if(dot) dot.className=`status-dot ${state.wsConnected?'online':'offline'}`; if(txt) txt.textContent=`WebSocket: ${state.wsConnected?'Connected':'Disconnected'}`; }
}
function updateUI() {
    updateStatusUI();
    if(elements.lastUpdate&&state.lastUpdate) elements.lastUpdate.textContent=`Last update: ${state.lastUpdate.toLocaleString()} (${timeAgo(state.lastUpdate)})`;
    switch(state.currentView) {
        case 'overview': renderOverview(); break;
        case 'observers': renderObservers(); break;
        case 'packets': renderPackets(); break;
        case 'stats': renderStats(); break;
        case 'topology': renderTopology(); break;
        case 'alerts': renderAlerts(); break;
    }
}
function renderOverview() {
    if(elements.totalPackets) elements.totalPackets.textContent=formatNumber(state.stats.totalPackets);
    if(elements.activeObservers) elements.activeObservers.textContent=formatNumber(state.stats.observerCount);
    if(elements.packetsPerSec) elements.packetsPerSec.textContent=formatNumber(state.stats.windowPackets);
    if(elements.bufferUsage) elements.bufferUsage.textContent=`${formatNumber(state.stats.bufferSize)} / ${formatNumber(state.stats.bufferCapacity)}`;
}
function renderObservers() {
    if(!elements.observersTableBody) return;
    let obs=[...state.observers];
    const filter=elements.observerFilter?.value.toLowerCase()||'';
    if(filter) obs=obs.filter(o=>o.name.toLowerCase().includes(filter)||o.originId.toLowerCase().includes(filter));
    const sort=elements.observerSort?.value||'name';
    obs.sort((a,b)=>{ switch(sort){case'packets':return b.packetCount-a.packetCount;case'snr':return(b.avgSNR||0)-(a.avgSNR||0);case'rssi':return(b.avgRSSI||0)-(a.avgRSSI||0);case'status':return a.status.localeCompare(b.status);default:return a.name.localeCompare(b.name);} });
    if(obs.length===0){ elements.observersTableBody.innerHTML='<tr class="empty-state"><td colspan="7">No observers found</td></tr>'; return; }
    elements.observersTableBody.innerHTML=obs.map(o=>`<tr><td>${getStatusBadge(o.status)}</td><td>${truncate(o.name,30)}</td><td class="font-mono">${truncate(o.originId,16)}</td><td class="font-mono">${formatNumber(o.packetCount)}</td><td class="${(o.avgSNR||0)<-10?'text-danger':(o.avgSNR||0)>0?'text-success':''}">${formatSNR(o.avgSNR)}</td><td class="${(o.avgRSSI||0)<-90?'text-danger':(o.avgRSSI||0)>-70?'text-success':''}">${formatRSSI(o.avgRSSI)}</td><td>${timeAgo(o.lastSeen)}</td></tr>`).join('');
}
function renderPackets() {
    if(!elements.packetsTableBody) return;
    const limit=parseInt(elements.packetLimit?.value)||100;
    if(state.packets.length===0){ elements.packetsTableBody.innerHTML='<tr class="empty-state"><td colspan="6">No packets found</td></tr>'; return; }
    elements.packetsTableBody.innerHTML=state.packets.slice(0,limit).map(p=>`<tr><td class="font-mono">${formatTimestamp(p.timestamp)}</td><td>${truncate(p.origin,25)}</td><td class="font-mono">${PACKET_TYPES[p.packet_type]||p.packet_type}</td><td class="font-mono">${ROUTE_TYPES[p.route]||p.route}</td><td class="${parseFloat(p.SNR)<-10?'text-danger':parseFloat(p.SNR)>0?'text-success':''}">${formatSNR(p.SNR)}</td><td class="${parseInt(p.RSSI)<-90?'text-danger':parseInt(p.RSSI)>-70?'text-success':''}">${formatRSSI(p.RSSI)}</td></tr>`).join('');
}
function renderStats() {
    if(!elements.perObserverStats) return;
    const obsPkts=state.stats.packetsPerObserver||{}, total=state.stats.totalPackets||1;
    const html=Object.entries(obsPkts).map(([id,count])=>{ const o=state.observers.find(x=>x.originId===id); const n=o?truncate(o.name,20):truncate(id,20); const pct=((count/total)*100).toFixed(1); return `<tr><td>${n}</td><td class="font-mono">${formatNumber(count)}</td><td class="font-mono">${pct}%</td></tr>`; }).join('');
    elements.perObserverStats.innerHTML=html||'<tr class="empty-state"><td colspan="3">No data available</td></tr>';
}
function renderTopology() {
    if(elements.topologyNodeCount) elements.topologyNodeCount.textContent=formatNumber(state.topology.nodes?.length||0);
    if(elements.topologyEdgeCount) elements.topologyEdgeCount.textContent=formatNumber(state.topology.edges?.length||0);
    if(elements.topologyStatus) { elements.topologyStatus.className=state.topology.enabled?'enabled':'disabled'; elements.topologyStatus.textContent=state.topology.enabled?'Topology: Enabled':'Topology: Disabled (set PARSE_RAW_PACKETS=true)'; }
    renderTopologyTables(); renderTopologyCanvas();
}
function renderTopologyTables() {
    if(elements.topologyNodesTable) {
        if(!state.topology.nodes||state.topology.nodes.length===0) elements.topologyNodesTable.innerHTML='<tr class="empty-state"><td colspan="4">No nodes found</td></tr>';
        else elements.topologyNodesTable.innerHTML=state.topology.nodes.map(n=>{ const o=state.topology.observers?.find(x=>x.hash===n.hash); const t=o?'Observer':'Node'; return `<tr><td class="font-mono">${truncate(n.hash,20)}</td><td>${t}</td><td class="font-mono">${formatNumber(n.packetCount)}</td><td>${timeAgo(n.lastSeen)}</td></tr>`; }).join('');
    }
    if(elements.topologyEdgesTable) {
        if(!state.topology.edges||state.topology.edges.length===0) elements.topologyEdgesTable.innerHTML='<tr class="empty-state"><td colspan="4">No edges found</td></tr>';
        else elements.topologyEdgesTable.innerHTML=state.topology.edges.map(e=>`<tr><td class="font-mono">${truncate(e.from,20)}</td><td class="font-mono">${truncate(e.to,20)}</td><td class="font-mono">${formatNumber(e.count)}</td><td>${timeAgo(e.lastSeen)}</td></tr>`).join('');
    }
}
function renderTopologyCanvas() {
    if(!elements.topologyCanvas) return;
    const canvas=elements.topologyCanvas, ctx=canvas.getContext('2d');
    const container=canvas.parentElement;
    if(container) { canvas.width=container.clientWidth; canvas.height=container.clientHeight; }
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if(!state.topology.nodes||state.topology.nodes.length===0) { ctx.fillStyle='#64748b'; ctx.font='14px sans-serif'; ctx.textAlign='center'; ctx.fillText('No topology data available. Enable PARSE_RAW_PACKETS.',canvas.width/2,canvas.height/2); return; }
    const nodes=state.topology.nodes, edges=state.topology.edges, obsHashes=new Set(state.topology.observers?.map(o=>o.hash)||[]);
    const positions={}, radius=20, centerX=canvas.width/2, centerY=canvas.height/2;
    const angleStep=(2*Math.PI)/nodes.length;
    nodes.forEach((n,i)=>{ const a=i*angleStep; positions[n.hash]={x:centerX+Math.cos(a)*Math.min(canvas.width,canvas.height)*0.4,y:centerY+Math.sin(a)*Math.min(canvas.width,canvas.height)*0.4}; });
    for(let iter=0;iter<20;iter++) {
        for(let i=0;i<nodes.length;i++) for(let j=i+1;j<nodes.length;j++) { const a=nodes[i],b=nodes[j],pa=positions[a.hash],pb=positions[b.hash],dx=pb.x-pa.x,dy=pb.y-pa.y,dist=Math.sqrt(dx*dx+dy*dy); if(dist<1) dist=1; const f=100/(dist*dist),fx=(dx/dist)*f,fy=(dy/dist)*f; pa.vx=(pa.vx||0)-fx; pa.vy=(pa.vy||0)-fy; pb.vx=(pb.vx||0)+fx; pb.vy=(pb.vy||0)+fy; }
        edges.forEach(e=>{ const pa=positions[e.from],pb=positions[e.to]; if(!pa||!pb) return; const dx=pb.x-pa.x,dy=pb.y-pa.y,dist=Math.sqrt(dx*dx+dy*dy); if(dist<1) dist=1; const f=0.1*dist,fx=(dx/dist)*f,fy=(dy/dist)*f; pa.vx=(pa.vx||0)+fx; pa.vy=(pa.vy||0)+fy; pb.vx=(pb.vx||0)-fx; pb.vy=(pb.vy||0)-fy; });
        nodes.forEach(n=>{ const p=positions[n.hash]; if(p.vx||p.vy) { p.x+=(p.vx||0)*0.8; p.y+=(p.vy||0)*0.8; p.vx=(p.vx||0)*0.8; p.vy=(p.vy||0)*0.8; } });
    }
    ctx.strokeStyle='#475569'; ctx.lineWidth=1; edges.forEach(e=>{ const pa=positions[e.from],pb=positions[e.to]; if(!pa||!pb) return; ctx.beginPath(); ctx.moveTo(pa.x,pa.y); ctx.lineTo(pb.x,pb.y); ctx.stroke(); });
    nodes.forEach(n=>{ const p=positions[n.hash]; if(!p) return; const isObs=obsHashes.has(n.hash); ctx.beginPath(); ctx.arc(p.x,p.y,radius,0,2*Math.PI); ctx.fillStyle=isObs?'#22c55e':'#2563eb'; ctx.fill(); ctx.fillStyle='#ffffff'; ctx.font='10px monospace'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(truncate(n.hash,8),p.x,p.y); });
    ctx.fillStyle='#94a3b8'; ctx.font='12px sans-serif'; ctx.textAlign='left'; ctx.fillText(`${nodes.length} nodes, ${edges.length} edges`,10,20);
}
function renderAlerts() {
    if(elements.alertsActiveCount) { const ac=state.alerts.filter(a=>!a.acknowledged).length; elements.alertsActiveCount.textContent=ac; }
    renderAlertsList(); renderAlertsTable();
}
function renderAlertsList() {
    if(!elements.alertsList) return;
    const active=state.alerts.filter(a=>!a.acknowledged);
    if(active.length===0) { elements.alertsList.innerHTML='<div class="empty-state">No active alerts</div>'; return; }
    elements.alertsList.innerHTML=active.map(a=>{ const sev=getSeverityClass(a.severity), o=state.observers.find(x=>x.originId===a.originId), on=o?truncate(o.name,20):truncate(a.originId,20); return `<div class="alert-card ${sev} ${a.acknowledged?'acknowledged':''}" data-alert-id="${a.id||a.alertId}"><div class="alert-icon ${sev}">${sev==='critical'?'!':sev==='warning'?'!':'i'}</div><div class="alert-content"><div class="alert-message">${a.message}</div><div class="alert-meta">${getSeverityBadge(a.severity)} | Observer: ${on} | ${timeAgo(a.createdAt)}</div></div><div class="alert-actions"><button class="alert-ack-btn ${a.acknowledged?'acknowledged':''}" onclick="acknowledgeAlert('${a.id||a.alertId}','web')">${a.acknowledged?'Acknowledged':'Ack'}</button></div></div>`; }).join('');
}
function renderAlertsTable() {
    if(!elements.alertsTableBody) return;
    if(state.alerts.length===0) { elements.alertsTableBody.innerHTML='<tr class="empty-state"><td colspan="6">No alerts found</td></tr>'; return; }
    elements.alertsTableBody.innerHTML=state.alerts.map(a=>{ const o=state.observers.find(x=>x.originId===a.originId), on=o?truncate(o.name,20):truncate(a.originId,20); return `<tr class="${a.acknowledged?'acknowledged':''}"><td>${getSeverityBadge(a.severity)}</td><td class="font-mono">${a.type||'N/A'}</td><td>${truncate(a.message,50)}</td><td>${on}</td><td>${a.acknowledged?`Acked by ${a.acknowledgedBy}`:'Active'}</td><td><button class="alert-ack-btn ${a.acknowledged?'acknowledged':''}" onclick="acknowledgeAlert('${a.id||a.alertId}','web')">${a.acknowledged?'Acknowledged':'Ack'}</button></td></tr>`; }).join('');
}

function initEventHandlers() {
    elements.navLinks.forEach(link=>{ link.addEventListener('click',(e)=>{ e.preventDefault(); const v=link.dataset.view; state.currentView=v; elements.navLinks.forEach(l=>l.classList.remove('active')); link.classList.add('active'); elements.views.forEach(vv=>vv.classList.remove('active')); document.getElementById(v)?.classList.add('active'); updateUI(); document.querySelector('.main').scrollTop=0; }); });
    elements.statsTabs.forEach(tab=>{ tab.addEventListener('click',()=>{ const tid=tab.dataset.tab; elements.statsTabs.forEach(t=>t.classList.remove('active')); tab.classList.add('active'); elements.statsContents.forEach(c=>c.classList.remove('active')); document.getElementById(`stats-${tid}`)?.classList.add('active'); }); });
    if(elements.observerFilter) elements.observerFilter.addEventListener('input',()=>{ if(state.currentView==='observers') renderObservers(); });
    if(elements.observerSort) elements.observerSort.addEventListener('change',()=>{ if(state.currentView==='observers') renderObservers(); });
    if(elements.refreshPackets) elements.refreshPackets.addEventListener('click',()=>{ const l=parseInt(elements.packetLimit?.value)||100; fetchPackets(l); });
    if(elements.packetLimit) elements.packetLimit.addEventListener('change',()=>{ if(state.currentView==='packets') renderPackets(); });
    if(elements.acknowledgeAllAlerts) elements.acknowledgeAllAlerts.addEventListener('click',async()=>{ await acknowledgeAllAlerts('web'); });
    if(elements.refreshAlerts) elements.refreshAlerts.addEventListener('click',()=>{ fetchAlerts(); });
    window.addEventListener('resize',()=>{ if(state.currentView==='topology') renderTopologyCanvas(); });
    setInterval(()=>{ if(!state.wsConnected) { fetchHealth(); fetchStats(); fetchObservers(); fetchTopology(); fetchAlerts(); } },5000);
}

function init() {
    const hash=window.location.hash.substring(1)||'overview'; state.currentView=hash;
    const al=document.querySelector(`.nav-link[data-view="${state.currentView}"]`); if(al) al.classList.add('active');
    const av=document.getElementById(state.currentView); if(av) av.classList.add('active');
    connectWebSocket(); initEventHandlers(); updateUI();
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
