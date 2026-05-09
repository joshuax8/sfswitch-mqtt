/**
 * MeshCore NOC Dashboard - Frontend Application
 * Uses vanilla JS (no framework) per AGENTS.md rules
 */

// ============================================
// State Management
// ============================================

const state = {
    // Connection status
    mqttConnected: false,
    wsConnected: false,
    
    // Data
    packets: [],
    observers: [],
    stats: {
        totalPackets: 0,
        packetsPerObserver: {},
        packetTypes: {},
        routeTypes: {},
        windowPackets: 0,
        bufferSize: 0,
        bufferCapacity: 0,
        observerCount: 0,
    },
    
    // UI state
    currentView: 'overview',
    packetLimit: 100,
    lastUpdate: null,
};

// ============================================
// DOM Elements
// ============================================

const elements = {
    mqttStatus: document.getElementById('mqtt-status'),
    wsStatus: document.getElementById('ws-status'),
    navLinks: document.querySelectorAll('.nav-link'),
    views: document.querySelectorAll('.view'),
    statsTabs: document.querySelectorAll('.stats-tab'),
    statsContents: document.querySelectorAll('.stats-tab-content'),
    
    // Overview
    totalPackets: document.getElementById('total-packets'),
    activeObservers: document.getElementById('active-observers'),
    packetsPerSec: document.getElementById('packets-per-sec'),
    bufferUsage: document.getElementById('buffer-usage'),
    lastUpdate: document.getElementById('last-update'),
    
    // Observers
    observersTableBody: document.getElementById('observers-table-body'),
    observerFilter: document.getElementById('observer-filter'),
    observerSort: document.getElementById('observer-sort'),
    
    // Packets
    packetsTableBody: document.getElementById('packets-table-body'),
    refreshPackets: document.getElementById('refresh-packets'),
    packetLimit: document.getElementById('packet-limit'),
    
    // Stats
    perObserverStats: document.getElementById('per-observer-stats'),
};

// ============================================
// Utility Functions
// ============================================

function formatNumber(num) {
    if (num === null || num === undefined) return '0';
    if (typeof num === 'string') num = parseFloat(num);
    if (num > 9999) return (num / 1000).toFixed(1) + 'K';
    if (num > 999) return (num / 1000).toFixed(1) + 'K';
    return num.toLocaleString();
}

function formatSNR(snr) {
    if (snr === null || snr === undefined) return 'N/A';
    const val = parseFloat(snr);
    if (isNaN(val)) return 'N/A';
    return val.toFixed(1) + ' dB';
}

function formatRSSI(rssi) {
    if (rssi === null || rssi === undefined) return 'N/A';
    const val = parseInt(rssi);
    if (isNaN(val)) return 'N/A';
    return val + ' dBm';
}

function formatTimestamp(ts) {
    if (!ts) return 'N/A';
    try {
        const date = new Date(ts);
        return date.toLocaleString();
    } catch {
        return ts;
    }
}

function timeAgo(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);
    
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
}

function truncate(str, len = 20) {
    if (!str) return 'N/A';
    if (str.length <= len) return str;
    return str.substring(0, len - 3) + '...';
}

function getStatusBadge(status) {
    return `<span class="status-badge ${status}">${status}</span>`;
}

// ============================================
// Packet Type Names (from MeshCore docs)
// ============================================

const PACKET_TYPES = {
    '0': 'REQ',
    '1': 'RESPONSE',
    '2': 'TXT_MSG',
    '3': 'ACK',
    '4': 'ADVERT',
    '5': 'GRP_TXT',
    '6': 'GRP_DATA',
    '7': 'ANON_REQ',
    '8': 'PATH',
    '9': 'TRACE',
    '10': 'MULTIPART',
    '11': 'CONTROL',
    '15': 'RAW_CUSTOM',
};

const ROUTE_TYPES = {
    'F': 'FLOOD',
    'D': 'DIRECT',
    'T': 'TRANSPORT',
};

// ============================================
// WebSocket Connection
// ============================================

let ws;
let wsReconnectInterval;

function connectWebSocket() {
    // Try to determine backend host
    let host = window.location.hostname;
    let protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let port = window.location.port || (protocol === 'wss:' ? '443' : '80');
    
    // If running locally without nginx proxy
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        host = 'localhost';
        port = '3000';
        protocol = 'ws:';
    }
    
    const wsUrl = `${protocol}//${host}:${port}/ws`;
    
    console.log('Connecting to WebSocket:', wsUrl);
    
    try {
        ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
            state.wsConnected = true;
            updateStatusUI();
            console.log('WebSocket connected');
            
            // Fetch initial data
            fetchHealth();
            fetchStats();
            fetchObservers();
            fetchPackets();
        };
        
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            handleWebSocketMessage(data);
        };
        
        ws.onclose = () => {
            state.wsConnected = false;
            updateStatusUI();
            console.log('WebSocket disconnected, reconnecting...');
            startReconnect();
        };
        
        ws.onerror = (err) => {
            console.error('WebSocket error:', err);
            state.wsConnected = false;
            updateStatusUI();
        };
    } catch (err) {
        console.error('WebSocket connection failed:', err);
        state.wsConnected = false;
        updateStatusUI();
        startReconnect();
    }
}

function startReconnect() {
    clearInterval(wsReconnectInterval);
    wsReconnectInterval = setInterval(() => {
        if (!state.wsConnected) {
            connectWebSocket();
        }
    }, 5000);
}

function handleWebSocketMessage(data) {
    switch (data.type) {
        case 'init':
            state.stats = data.stats;
            state.observers = data.observers;
            break;
        case 'stats':
            state.stats = data.data;
            break;
        case 'packets':
            state.packets = data.data;
            break;
        case 'observers':
            state.observers = data.data;
            break;
    }
    state.lastUpdate = new Date();
    updateUI();
}

// ============================================
// REST API Calls
// ============================================

function getBackendUrl() {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        return `http://localhost:3000`;
    }
    return ''; // Relative path when behind nginx proxy
}

async function fetchHealth() {
    try {
        const response = await fetch('/health');
        const data = await response.json();
        state.mqttConnected = data.mqtt?.connected || false;
        state.wsConnected = state.wsConnected || false; // Keep WS status from socket
        state.stats.bufferSize = data.backend?.packetsStored || 0;
        state.stats.bufferCapacity = data.backend?.bufferCapacity || 0;
        updateStatusUI();
        updateUI();
    } catch (err) {
        console.error('Failed to fetch health:', err);
    }
}

async function fetchStats() {
    try {
        const response = await fetch('/api/stats');
        const data = await response.json();
        state.stats = data;
        state.lastUpdate = new Date();
        updateUI();
    } catch (err) {
        console.error('Failed to fetch stats:', err);
    }
}

async function fetchObservers() {
    try {
        const response = await fetch('/api/observers');
        const data = await response.json();
        state.observers = data;
        state.lastUpdate = new Date();
        updateUI();
    } catch (err) {
        console.error('Failed to fetch observers:', err);
    }
}

async function fetchPackets(limit = 100) {
    try {
        const response = await fetch(`/api/packets?limit=${limit}`);
        const data = await response.json();
        state.packets = data;
        state.lastUpdate = new Date();
        updateUI();
    } catch (err) {
        console.error('Failed to fetch packets:', err);
    }
}

// ============================================
// UI Updates
// ============================================

function updateStatusUI() {
    // MQTT status
    if (elements.mqttStatus) {
        const dot = elements.mqttStatus.querySelector('.status-dot');
        const text = elements.mqttStatus.querySelector('span:last-child');
        if (dot) {
            dot.className = `status-dot ${state.mqttConnected ? 'online' : 'offline'}`;
        }
        if (text) {
            text.textContent = `MQTT: ${state.mqttConnected ? 'Connected' : 'Disconnected'}`;
        }
    }
    
    // WebSocket status
    if (elements.wsStatus) {
        const dot = elements.wsStatus.querySelector('.status-dot');
        const text = elements.wsStatus.querySelector('span:last-child');
        if (dot) {
            dot.className = `status-dot ${state.wsConnected ? 'online' : 'offline'}`;
        }
        if (text) {
            text.textContent = `WebSocket: ${state.wsConnected ? 'Connected' : 'Disconnected'}`;
        }
    }
}

function updateUI() {
    updateStatusUI();
    
    // Update last update timestamp
    if (elements.lastUpdate && state.lastUpdate) {
        elements.lastUpdate.textContent = `Last update: ${state.lastUpdate.toLocaleString()} (${timeAgo(state.lastUpdate)})`;
    }
    
    // Update current view
    switch (state.currentView) {
        case 'overview':
            renderOverview();
            break;
        case 'observers':
            renderObservers();
            break;
        case 'packets':
            renderPackets();
            break;
        case 'stats':
            renderStats();
            break;
    }
}

function renderOverview() {
    if (elements.totalPackets) {
        elements.totalPackets.textContent = formatNumber(state.stats.totalPackets);
    }
    if (elements.activeObservers) {
        elements.activeObservers.textContent = formatNumber(state.stats.observerCount);
    }
    if (elements.packetsPerSec) {
        elements.packetsPerSec.textContent = formatNumber(state.stats.windowPackets);
    }
    if (elements.bufferUsage) {
        elements.bufferUsage.textContent = `${formatNumber(state.stats.bufferSize)} / ${formatNumber(state.stats.bufferCapacity)}`;
    }
}

function renderObservers() {
    if (!elements.observersTableBody) return;
    
    let observers = [...state.observers];
    
    // Filter
    const filter = elements.observerFilter?.value.toLowerCase() || '';
    if (filter) {
        observers = observers.filter(o => 
            o.name.toLowerCase().includes(filter) ||
            o.originId.toLowerCase().includes(filter)
        );
    }
    
    // Sort
    const sort = elements.observerSort?.value || 'name';
    observers.sort((a, b) => {
        switch (sort) {
            case 'packets':
                return b.packetCount - a.packetCount;
            case 'snr':
                return (b.avgSNR || 0) - (a.avgSNR || 0);
            case 'rssi':
                return (b.avgRSSI || 0) - (a.avgRSSI || 0);
            case 'status':
                return a.status.localeCompare(b.status);
            default:
                return a.name.localeCompare(b.name);
        }
    });
    
    // Render
    if (observers.length === 0) {
        elements.observersTableBody.innerHTML = '<tr class="empty-state"><td colspan="7">No observers found</td></tr>';
        return;
    }
    
    const html = observers.map(obs => `
        <tr>
            <td>${getStatusBadge(obs.status)}</td>
            <td>${truncate(obs.name, 30)}</td>
            <td class="font-mono">${truncate(obs.originId, 16)}</td>
            <td class="font-mono">${formatNumber(obs.packetCount)}</td>
            <td class="${(obs.avgSNR || 0) < -10 ? 'text-danger' : (obs.avgSNR || 0) > 0 ? 'text-success' : ''}">${formatSNR(obs.avgSNR)}</td>
            <td class="${(obs.avgRSSI || 0) < -90 ? 'text-danger' : (obs.avgRSSI || 0) > -70 ? 'text-success' : ''}">${formatRSSI(obs.avgRSSI)}</td>
            <td>${timeAgo(obs.lastSeen)}</td>
        </tr>
    `).join('');
    
    elements.observersTableBody.innerHTML = html;
}

function renderPackets() {
    if (!elements.packetsTableBody) return;
    
    const limit = parseInt(elements.packetLimit?.value) || 100;
    
    if (state.packets.length === 0) {
        elements.packetsTableBody.innerHTML = '<tr class="empty-state"><td colspan="6">No packets found</td></tr>';
        return;
    }
    
    const packets = state.packets.slice(0, limit);
    
    const html = packets.map(p => `
        <tr>
            <td class="font-mono">${formatTimestamp(p.timestamp)}</td>
            <td>${truncate(p.origin, 25)}</td>
            <td class="font-mono">${PACKET_TYPES[p.packet_type] || p.packet_type}</td>
            <td class="font-mono">${ROUTE_TYPES[p.route] || p.route}</td>
            <td class="${parseFloat(p.SNR) < -10 ? 'text-danger' : parseFloat(p.SNR) > 0 ? 'text-success' : ''}">${formatSNR(p.SNR)}</td>
            <td class="${parseInt(p.RSSI) < -90 ? 'text-danger' : parseInt(p.RSSI) > -70 ? 'text-success' : ''}">${formatRSSI(p.RSSI)}</td>
        </tr>
    `).join('');
    
    elements.packetsTableBody.innerHTML = html;
}

function renderStats() {
    // Per observer stats
    if (elements.perObserverStats) {
        const observerPackets = state.stats.packetsPerObserver || {};
        const total = state.stats.totalPackets || 1;
        
        const html = Object.entries(observerPackets).map(([id, count]) => {
            const observer = state.observers.find(o => o.originId === id);
            const name = observer ? truncate(observer.name, 20) : truncate(id, 20);
            const pct = ((count / total) * 100).toFixed(1);
            return `
                <tr>
                    <td>${name}</td>
                    <td class="font-mono">${formatNumber(count)}</td>
                    <td class="font-mono">${pct}%</td>
                </tr>
            `;
        }).join('');
        
        if (html) {
            elements.perObserverStats.innerHTML = html;
        } else {
            elements.perObserverStats.innerHTML = '<tr class="empty-state"><td colspan="3">No data available</td></tr>';
        }
    }
}

// ============================================
// Event Handlers
// ============================================

function initEventHandlers() {
    // Navigation
    elements.navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const view = link.dataset.view;
            state.currentView = view;
            
            // Update nav links
            elements.navLinks.forEach(l => l.classList.remove('active'));
            link.classList.add('active');
            
            // Update views
            elements.views.forEach(v => v.classList.remove('active'));
            document.getElementById(view)?.classList.add('active');
            
            updateUI();
            
            // Scroll to top of main content
            document.querySelector('.main').scrollTop = 0;
        });
    });
    
    // Stats tabs
    elements.statsTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabId = tab.dataset.tab;
            
            elements.statsTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            elements.statsContents.forEach(c => c.classList.remove('active'));
            document.getElementById(`stats-${tabId}`)?.classList.add('active');
        });
    });
    
    // Observer filter
    if (elements.observerFilter) {
        elements.observerFilter.addEventListener('input', () => {
            if (state.currentView === 'observers') {
                renderObservers();
            }
        });
    }
    
    // Observer sort
    if (elements.observerSort) {
        elements.observerSort.addEventListener('change', () => {
            if (state.currentView === 'observers') {
                renderObservers();
            }
        });
    }
    
    // Refresh packets
    if (elements.refreshPackets) {
        elements.refreshPackets.addEventListener('click', () => {
            const limit = parseInt(elements.packetLimit?.value) || 100;
            fetchPackets(limit);
        });
    }
    
    // Packet limit change
    if (elements.packetLimit) {
        elements.packetLimit.addEventListener('change', () => {
            if (state.currentView === 'packets') {
                renderPackets();
            }
        });
    }
    
    // Periodic refresh
    setInterval(() => {
        if (state.wsConnected) {
            // WebSocket provides real-time updates
            return;
        }
        // Fallback to polling
        fetchHealth();
        fetchStats();
        fetchObservers();
    }, 5000);
}

// ============================================
// Initialization
// ============================================

function init() {
    console.log('Initializing MeshCore NOC Dashboard...');
    
    // Set initial view
    const hash = window.location.hash.substring(1) || 'overview';
    state.currentView = hash;
    
    // Set active nav link
    const activeLink = document.querySelector(`.nav-link[data-view="${state.currentView}"]`);
    if (activeLink) {
        activeLink.classList.add('active');
    }
    
    // Set active view
    const activeView = document.getElementById(state.currentView);
    if (activeView) {
        activeView.classList.add('active');
    }
    
    // Initialize WebSocket
    connectWebSocket();
    
    // Initialize event handlers
    initEventHandlers();
    
    // Initial render
    updateUI();
    
    console.log('Dashboard initialized');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
