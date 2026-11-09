'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;


const WINDOW_MS = 20000;        
const SPIKE_FACTOR = 3;         
const MIN_SPIKE_COUNT = 8;      
const COOLDOWN_MS = 15000;      
const RECOVER_AFTER_MS = 20000; 
const MISBEHAVE_MULT = 8;       
const PENALTY = { spike: 15, newPermission: 10, unauthorized: 20, offPurpose: 8 };
const AUTO_SUSPEND_BELOW = 30; 
const PENALTY_LABEL = { spike: 'Unusual access frequency', newPermission: 'New permission request', unauthorized: 'Unauthorized access attempt', offPurpose: 'Request outside the app\'s purpose' };
const SENSITIVE = new Set(['contacts', 'location', 'microphone']);


const APP_DEFS = [
  {
    id: 'photoeditor', expected: ['files', 'camera'], name: 'Lumina Photos', purpose: 'Edits and filters your photos', color: '#c2603a', letter: 'L',
    perms: ['files', 'camera'], used: ['files', 'camera'], rate: 6, // normal accesses per minute
    reasons: { files: ['Open photo to edit', 'Export edited photo', 'Load filter presets'], camera: ['Take a new photo', 'Scan a document'] },
  },
  {
    id: 'notesapp', expected: ['files'], name: 'Notable', purpose: 'Keeps your personal notes', color: '#6b5b95', letter: 'N',
    perms: ['files', 'location'], used: ['files'], rate: 4, // has location but never uses it
    reasons: { files: ['Save note', 'Sync notes', 'Attach file to note'] },
  },
  {
    id: 'fitnesstracker', expected: ['location'], name: 'StrideFit', purpose: 'Tracks your runs and workouts', color: '#2f8f6b', letter: 'S',
    perms: ['location'], used: ['location'], rate: 5,
    reasons: { location: ['Record running route', 'Update pace and distance'] },
  },
  {
    id: 'quickchat', expected: ['contacts', 'camera', 'microphone'], name: 'QuickChat', purpose: 'Messages and calls with friends', color: '#2f5d8a', letter: 'Q',
    perms: ['contacts', 'camera', 'microphone'], used: ['contacts', 'microphone', 'camera'], rate: 7,
    reasons: { contacts: ['Find friends on QuickChat', 'Show contact names'], microphone: ['Voice message', 'Voice call'], camera: ['Video call', 'Send photo'] },
  },
  {
    id: 'weathernow', expected: ['location'], name: 'WeatherNow', purpose: 'Shows your local forecast', color: '#b8860b', letter: 'W',
    perms: ['location'], used: ['location'], rate: 3,
    reasons: { location: ['Refresh local forecast', 'Check rain alerts'] },
  },
];
const pick = (x) => (Array.isArray(x) ? x[Math.floor(Math.random() * x.length)] : x);

let state;

function reset() {
  const keepAuto = state ? state.autoProtect : false;
  state = {
    autoProtect: keepAuto,
    startedAt: Date.now(),
    misbehaving: false,
    tick: 0, total: 0, blocked: 0,
    logs: [],   
    events: [], 
    apps: APP_DEFS.map((d) => ({
      id: d.id, name: d.name, purpose: d.purpose, color: d.color, letter: d.letter, baseline: d.rate, def: d,
      score: 100, status: 'active',
      perms: Object.fromEntries(d.perms.map((r) => [r, { status: 'granted', uses: 0, recent: [] }])),
      window: [],          
      lastPenalty: {},     
      lastPenaltyAt: 0,
      breakdown: [],       
      acc: 0,              
      history: [100],      
    })),
  };
}

const band = (s) => (s >= 80 ? 'safe' : s >= 50 ? 'watch' : 'risky');
const findApp = (id) => state.apps.find((a) => a.id === id);

function addEvent(kind, app, severity, message) {
  state.events.unshift({ ts: Date.now(), kind, app: app.name, severity, message });
  if (state.events.length > 300) state.events.pop();
}


function penalize(app, type, severity, message) {
  const now = Date.now();
  if (now - (app.lastPenalty[type] || 0) < COOLDOWN_MS) return;
  app.lastPenalty[type] = now;
  app.lastPenaltyAt = now;
  app.score = Math.max(0, app.score - PENALTY[type]);
  app.breakdown.unshift({ ts: now, type, points: PENALTY[type], label: PENALTY_LABEL[type], detail: message });
  if (app.breakdown.length > 12) app.breakdown.pop();
  addEvent('alert', app, severity, `${message} (trust score -${PENALTY[type]})`);
}


function handleAccess(appId, resource, reason) {
  const app = findApp(appId);
  if (!app) return { error: 'Unknown app' };
  const now = Date.now();

  
  app.window.push(now);
  while (app.window.length && now - app.window[0] > WINDOW_MS) app.window.shift();

  let allowed = false;
  let note = '';

  if (app.status === 'suspended') {
    note = 'App is suspended';
    state.total++; state.blocked++;
  } else {
    if (!app.def.expected.includes(resource)) {
      penalize(app, 'offPurpose', 'medium', `${app.name} requested ${resource}, which does not match its purpose`);
    }
    const p = app.perms[resource];
    if (!p) {
      
      app.perms[resource] = { status: 'pending', uses: 0, recent: [] };
      note = 'Requested a new permission';
      penalize(app, 'newPermission', 'medium', `${app.name} requested new permission: ${resource}`);
    } else if (p.status === 'granted') {
      allowed = true;
    } else if (p.status === 'restricted') {
      
      p.recent = p.recent.filter((t) => now - t < 60000);
      if (p.recent.length < 3) { p.recent.push(now); allowed = true; }
      else note = 'Restricted: rate limit reached';
    } else {
      
      note = p.status === 'pending' ? 'Permission not approved yet' : 'Permission revoked';
      penalize(app, 'unauthorized', 'high', `${app.name} tried to access ${resource} without permission`);
    }
    if (allowed) { app.perms[resource].uses++; app.perms[resource].lastUsed = now; }
    state.total++; if (!allowed) state.blocked++;

    
    const ratePerMin = app.window.length * (60000 / WINDOW_MS);
    if (app.window.length >= MIN_SPIKE_COUNT && ratePerMin > app.baseline * SPIKE_FACTOR) {
      penalize(app, 'spike', 'medium',
        `${app.name} is accessing data ${Math.round(ratePerMin / app.baseline)}x more often than normal`);
    }
  }

  state.logs.unshift({ ts: now, app: app.name, resource, reason: reason || 'No reason given', allowed, note });
  if (state.logs.length > 1000) state.logs.pop();
  return { allowed, note };
}


function simTick() {
  state.tick++;
  const now = Date.now();
  for (const app of state.apps) {
    const bad = state.misbehaving && app.id === 'fitnesstracker';

    
    app.acc += ((app.baseline * (bad ? MISBEHAVE_MULT : 1)) / 60) * (0.6 + Math.random() * 0.8); // jitter for realism
    while (app.acc >= 1) {
      app.acc -= 1;
      const u = app.def.used;
      const res = u[Math.floor(Math.random() * u.length)];
      handleAccess(app.id, res, pick(app.def.reasons[res]));
    }

    
    if (bad && state.tick % 3 === 0) {
      const targets = ['contacts', 'files', 'microphone'];
      handleAccess(app.id, targets[Math.floor(state.tick / 3) % 3], 'Unspecified');
    }

    
    if (app.status === 'active' && app.score < 100 &&
        now - app.lastPenaltyAt > RECOVER_AFTER_MS && state.tick % 5 === 0) app.score++;

    app.history.push(app.score);
    if (app.history.length > 90) app.history.shift();
  }
  autoProtect();
}

function autoProtect() {
  if (!state.autoProtect) return;
  for (const app of state.apps) {
    if (app.status === 'active' && app.score < AUTO_SUSPEND_BELOW) {
      setStatus(app.id, 'suspended');
      addEvent('alert', app, 'high', `Auto-protect suspended ${app.name} (trust score ${app.score})`);
    }
  }
}


function recommendations() {
  const now = Date.now();
  const recs = [];
  for (const app of state.apps) {
    if (app.status === 'suspended') continue;
    for (const [res, p] of Object.entries(app.perms)) {
      if (p.status === 'pending') {
        recs.push({
          id: `deny-${app.id}-${res}`, severity: SENSITIVE.has(res) ? 'high' : 'medium',
          text: `${app.name} asked for ${res} access, which doesn't fit its purpose (${app.purpose.toLowerCase()}).`,
          actionLabel: `Deny ${res}`, action: { type: 'permission', appId: app.id, resource: res, value: 'revoke' },
        });
      }
      const off = !app.def.expected.includes(res);
      if (p.status === 'granted' && (off || (p.uses === 0 && now - state.startedAt > 30000))) {
        recs.push({
          id: `unused-${app.id}-${res}`, severity: off && SENSITIVE.has(res) ? 'high' : SENSITIVE.has(res) ? 'medium' : 'low',
          text: off ? `${app.name} has ${res} access, which does not match its purpose (${app.purpose.toLowerCase()}). Revoking reduces your exposure.`
                 : `${app.name} has ${res} access but has never used it. Revoking reduces your exposure.`,
          actionLabel: `Revoke ${res}`, action: { type: 'permission', appId: app.id, resource: res, value: 'revoke' },
        });
      }
    }
    if (app.score < 50) {
      recs.push({
        id: `suspend-${app.id}`, severity: 'high',
        text: `${app.name} has a trust score of ${app.score}. Suspend it until you have reviewed its activity.`,
        actionLabel: 'Suspend app', action: { type: 'status', appId: app.id, value: 'suspended' },
      });
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  return recs.sort((a, b) => order[a.severity] - order[b.severity]);
}


const PERM_VALUES = { approve: 'granted', restrict: 'restricted', revoke: 'revoked' };

function setPermission(appId, resource, value) {
  const app = findApp(appId);
  if (!app || !PERM_VALUES[value] || !['files', 'camera', 'contacts', 'location', 'microphone'].includes(resource)) return { error: 'Invalid request' };
  if (!app.perms[resource]) app.perms[resource] = { status: 'revoked', uses: 0, recent: [] }; // lets the user grant a new permission
  app.perms[resource].status = PERM_VALUES[value];
  app.perms[resource].recent = [];
  addEvent('change', app, 'info', `${resource} permission for ${app.name} set to ${PERM_VALUES[value]}`);
  return { ok: true };
}

function setStatus(appId, status) {
  const app = findApp(appId);
  if (!app || !['active', 'suspended'].includes(status)) return { error: 'Invalid request' };
  app.status = status;
  addEvent('change', app, 'info', `${app.name} was ${status === 'suspended' ? 'suspended' : 'reactivated'}`);
  return { ok: true };
}


function privacy() {
  const avg = state.apps.reduce((n, a) => n + a.score, 0) / state.apps.length;
  let off = 0, pend = 0;
  for (const a of state.apps) for (const [r, p] of Object.entries(a.perms)) {
    if (p.status === 'granted' && !a.def.expected.includes(r)) off++;
    if (p.status === 'pending') pend++;
  }
  const score = Math.max(0, Math.round(avg - off * 4 - pend * 3));
  const risky = state.apps.filter((a) => a.score < 50).length;
  const bits = [];
  if (risky) bits.push(`${risky} risky app${risky > 1 ? 's' : ''}`);
  if (pend) bits.push(`${pend} permission request${pend > 1 ? 's' : ''} waiting for you`);
  if (off) bits.push(`${off} permission${off > 1 ? 's' : ''} that ${off > 1 ? 'do' : 'does'} not match an app's purpose`);
  return { score, band: band(score), headline: bits.length ? 'Needs attention: ' + bits.join(', ') + '.' : 'All apps are behaving as expected.' };
}

function riskSummary(a) {
  if (a.status === 'suspended') return 'Suspended. All of its access requests are being blocked.';
  const now = Date.now();
  const recent = (t) => now - (a.lastPenalty[t] || 0) < 60000;
  const asked = Object.entries(a.perms).filter(([, p]) => p.status === 'pending' || p.status === 'revoked').map(([r]) => r);
  const parts = [];
  if (recent('spike')) parts.push('is accessing data far more often than normal');
  if (asked.length) parts.push(`asked for ${asked.join(', ')}, which does not match its purpose (${a.purpose.toLowerCase()})`);
  else if (recent('unauthorized')) parts.push('tried to use data it was not given');
  if (!parts.length) return a.score >= 80 ? 'Behaving normally. Its access matches its purpose and usual pattern.' : 'Recently flagged. Recovering while its behavior stays normal.';
  return `${a.name} ${parts.join(' and ')}.`;
}


function exportReport(format) {
  const rows = [
    ...state.logs.map((l) => ({ time: l.ts, type: 'access', app: l.app, detail: `${l.resource}: ${l.reason}`, result: l.allowed ? 'allowed' : 'denied' + (l.note ? ' (' + l.note + ')' : '') })),
    ...state.events.map((e) => ({ time: e.ts, type: e.kind, app: e.app, detail: e.message, result: e.severity })),
  ].sort((a, b) => a.time - b.time).map((r) => ({ ...r, time: new Date(r.time).toISOString() }));
  if (format === 'json') return { type: 'application/json', body: JSON.stringify({ generatedAt: new Date().toISOString(), apps: state.apps.map((a) => ({ name: a.name, trustScore: a.score, status: a.status })), records: rows }, null, 2), ext: 'json' };
  const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  return { type: 'text/csv', body: 'time,type,app,detail,result\n' + rows.map((r) => [r.time, r.type, r.app, r.detail, r.result].map(q).join(',')).join('\n'), ext: 'csv' };
}


function snapshot() {
  return {
    misbehaving: state.misbehaving,
    autoProtect: state.autoProtect,
    privacy: privacy(),
    target: findApp('fitnesstracker').name,
    summary: {
      monitored: state.apps.length,
      risky: state.apps.filter((a) => a.score < 50).length,
      total: state.total, blocked: state.blocked,
      alerts: state.events.filter((e) => e.kind === 'alert').length,
    },
    apps: state.apps.map((a) => ({
      id: a.id, name: a.name, purpose: a.purpose, color: a.color, letter: a.letter, score: a.score, band: band(a.score),
      status: a.status, history: a.history, summaryText: riskSummary(a), breakdown: a.breakdown.slice(0, 4),
      perms: Object.entries(a.perms).map(([resource, p]) => ({
        resource, status: p.status, uses: p.uses, lastUsed: p.lastUsed || 0, offPurpose: !a.def.expected.includes(resource), sensitive: SENSITIVE.has(resource),
      })),
    })),
    logs: state.logs.slice(0, 40),
    events: state.events.slice(0, 40),
    recommendations: recommendations(),
  };
}

// ---------- Tiny HTTP server ----------
function send(res, code, data, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/api/state') return send(res, 200, snapshot());
  if (req.method === 'GET' && url === '/api/export') {
    const r = exportReport(req.url.includes('format=json') ? 'json' : 'csv');
    res.writeHead(200, { 'Content-Type': r.type, 'Content-Disposition': `attachment; filename="edith-audit-report.${r.ext}"` });
    return res.end(r.body);
  }

  if (req.method === 'POST' && url.startsWith('/api/')) {
    const b = await readBody(req);
    if (url === '/api/access') return send(res, 200, handleAccess(b.appId, b.resource, b.reason));
    if (url === '/api/permission') return send(res, 200, setPermission(b.appId, b.resource, b.value));
    if (url === '/api/status') return send(res, 200, setStatus(b.appId, b.status || b.value));
    if (url === '/api/simulator') { state.misbehaving = !!b.misbehaving; return send(res, 200, { ok: true }); }
    if (url === '/api/autoprotect') { state.autoProtect = !!b.enabled; return send(res, 200, { ok: true }); }
    if (url === '/api/reset') { reset(); return send(res, 200, { ok: true }); }
    return send(res, 404, { error: 'Not found' });
  }

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    return fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) =>
      err ? send(res, 500, 'Could not load dashboard', 'text/plain') : send(res, 200, data, 'text/html; charset=utf-8'));
  }
  send(res, 404, 'Not found', 'text/plain');
});

reset();
setInterval(simTick, 1000);
server.listen(PORT, () => console.log(`E.D.I.T.H. running at http://localhost:${PORT}`));