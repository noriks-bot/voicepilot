require("dotenv").config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// Configure multer for video uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const ext = path.extname(file.originalname);
        cb(null, `video-${timestamp}${ext}`);
    }
});
const upload = multer({ 
    storage,
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/')) cb(null, true);
        else cb(new Error('Only video files allowed'));
    }
});

const app = express();
const PORT = process.env.PORT || 3006;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== DROPBOX CREATIVES API ==========
const DROPBOX_APP_KEY = process.env.DROPBOX_APP_KEY || '';
const DROPBOX_APP_SECRET = process.env.DROPBOX_APP_SECRET || '';
const DROPBOX_REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN || '';
const DROPBOX_ROOT = process.env.DROPBOX_ROOT || '';
const DROPBOX_FOLDERS = [
    '/NORIKS Team Folder/TEJA - KREATIVE/FINAL CREATIVES 🔥',
    '/NORIKS Team Folder/FLORES',
    '/NORIKS Team Folder/TEJA - KREATIVE/Extra',
    '/NORIKS Team Folder/Faraz',
    '/NORIKS Team Folder/Wasif',
    '/NORIKS Team Folder/SERBIA - CONTENT/Final',
    '/NORIKS Team Folder/NORIKS_GP/TRANSLATED CREATIVES',
];

let _dbxToken = null;
let _dbxTokenExp = 0;
async function dropboxToken() {
    if (_dbxToken && Date.now() < _dbxTokenExp) return _dbxToken;
    const body = `grant_type=refresh_token&refresh_token=${DROPBOX_REFRESH_TOKEN}&client_id=${DROPBOX_APP_KEY}&client_secret=${DROPBOX_APP_SECRET}`;
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    const j = await r.json();
    if (!j.access_token) throw new Error('Dropbox token refresh failed: ' + JSON.stringify(j));
    _dbxToken = j.access_token;
    _dbxTokenExp = Date.now() + (j.expires_in * 1000) - 60000;
    return _dbxToken;
}

async function dropboxListFolder(folderPath) {
    const token = await dropboxToken();
    const headers = {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Dropbox-API-Path-Root': JSON.stringify({ '.tag': 'root', 'root': DROPBOX_ROOT }),
    };
    const all = [];
    let body = JSON.stringify({ path: folderPath, recursive: true, limit: 2000 });
    let url = 'https://api.dropboxapi.com/2/files/list_folder';
    while (true) {
        const r = await fetch(url, { method: 'POST', headers, body });
        if (!r.ok) {
            const txt = await r.text();
            throw new Error('Dropbox list_folder ' + folderPath + ' -> ' + r.status + ': ' + txt.slice(0, 200));
        }
        const j = await r.json();
        if (j.entries) all.push(...j.entries);
        if (!j.has_more) break;
        url = 'https://api.dropboxapi.com/2/files/list_folder/continue';
        body = JSON.stringify({ cursor: j.cursor });
    }
    return all;
}

function parseCreativeFilename(name) {
    const COUNTRIES = ['HR','CZ','PL','GR','SK','IT','HU','SI','RO','DE','BG','AT'];
    const idMatch = name.match(/ID(\d+)/i);
    const upper = name.toUpperCase();
    const country = COUNTRIES.find(c =>
        upper.includes('_' + c + '_') || upper.includes('_' + c + '.') ||
        upper.includes('-' + c + '_') || upper.includes('-' + c + '.') ||
        upper.startsWith(c + '_') || upper.startsWith(c + '-')
    );
    let productType = 'other';
    if (/SHIRT|MAJIC/i.test(upper)) productType = 'shirts';
    else if (/BOXER|BOKSER/i.test(upper)) productType = 'boxers';
    else if (/STARTER/i.test(upper)) productType = 'starter';
    else if (/KOMPLET|2P5|BUNDLE/i.test(upper)) productType = 'komplet';
    const dateMatch = name.match(/(\d{2})-(\d{2})-(\d{2})/);
    return {
        creativeId: idMatch ? ('ID' + idMatch[1]) : null,
        country: country || null,
        productType,
        fileDate: dateMatch ? ('20' + dateMatch[1] + '-' + dateMatch[2] + '-' + dateMatch[3]) : null,
    };
}

// ===== SQLite DB for creatives =====
const Database = require('better-sqlite3');
const CREATIVES_DB_PATH = path.join(__dirname, 'creatives.db');
const creativesDb = new Database(CREATIVES_DB_PATH);
creativesDb.pragma('journal_mode = WAL');

creativesDb.exec(`
    CREATE TABLE IF NOT EXISTS creative_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        creative_id TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        country TEXT,
        product_type TEXT,
        file_date TEXT,
        media_type TEXT,
        size INTEGER DEFAULT 0,
        modified TEXT,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_creative_id ON creative_files(creative_id);
    CREATE INDEX IF NOT EXISTS idx_country ON creative_files(country);
    CREATE TABLE IF NOT EXISTS sync_meta (
        key TEXT PRIMARY KEY,
        value TEXT
    );
`);

const _insertFile = creativesDb.prepare(`
    INSERT INTO creative_files (creative_id, name, path, country, product_type, file_date, media_type, size, modified, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(path) DO UPDATE SET
        creative_id = excluded.creative_id,
        name = excluded.name,
        country = excluded.country,
        product_type = excluded.product_type,
        file_date = excluded.file_date,
        media_type = excluded.media_type,
        size = excluded.size,
        modified = excluded.modified,
        synced_at = CURRENT_TIMESTAMP
`);
const _setMeta = creativesDb.prepare(`INSERT INTO sync_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
const _getMeta = creativesDb.prepare(`SELECT value FROM sync_meta WHERE key = ?`);

let _syncInProgress = false;
async function syncCreativesFromDropbox() {
    if (_syncInProgress) return { ok: false, reason: 'already running' };
    _syncInProgress = true;
    const startedAt = Date.now();
    try {
        console.log('[creatives:sync] starting Dropbox scan...');
        const VIDEO_EXT = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
        const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
        const ALL_EXT = [...VIDEO_EXT, ...IMAGE_EXT];

        const results = await Promise.all(
            DROPBOX_FOLDERS.map(fp => dropboxListFolder(fp).catch(e => {
                console.error('[creatives:sync] folder failed:', fp, e.message);
                return [];
            }))
        );

        const files = results.flat()
            .filter(f => f['.tag'] === 'file' && ALL_EXT.some(ext => f.name.toLowerCase().endsWith(ext)))
            .map(f => {
                const p = parseCreativeFilename(f.name);
                const isVideo = VIDEO_EXT.some(ext => f.name.toLowerCase().endsWith(ext));
                return {
                    creativeId: p.creativeId,
                    name: f.name,
                    path: f.path_display || f.path_lower,
                    country: p.country,
                    productType: p.productType,
                    fileDate: p.fileDate,
                    mediaType: isVideo ? 'video' : 'image',
                    size: f.size || 0,
                    modified: f.server_modified || null,
                };
            })
            .filter(f => f.creativeId);

        const insertTx = creativesDb.transaction((items) => {
            creativesDb.exec('DELETE FROM creative_files');
            for (const f of items) {
                _insertFile.run(f.creativeId.toUpperCase(), f.name, f.path, f.country, f.productType, f.fileDate, f.mediaType, f.size, f.modified);
            }
        });
        insertTx(files);

        const finishedAt = new Date().toISOString();
        _setMeta.run('last_sync', finishedAt);
        _setMeta.run('last_sync_count', String(files.length));
        const dur = Date.now() - startedAt;
        console.log(`[creatives:sync] done - ${files.length} files in ${dur}ms`);
        return { ok: true, files: files.length, durationMs: dur, syncedAt: finishedAt };
    } catch (e) {
        console.error('[creatives:sync] error:', e);
        return { ok: false, error: e.message };
    } finally {
        _syncInProgress = false;
    }
}

function readCreativesFromDb() {
    const rows = creativesDb.prepare('SELECT * FROM creative_files').all();
    const groups = {};
    for (const r of rows) {
        const id = (r.creative_id || '').toUpperCase();
        if (!groups[id]) {
            groups[id] = {
                creativeId: id,
                productType: r.product_type || 'other',
                fileDate: r.file_date,
                countries: new Set(),
                fileCount: 0,
                videoCount: 0,
                imageCount: 0,
                latestModified: null,
            };
        }
        const g = groups[id];
        if (r.country) g.countries.add(r.country);
        g.fileCount++;
        if (r.media_type === 'video') g.videoCount++;
        else g.imageCount++;
        if (r.modified && (!g.latestModified || r.modified > g.latestModified)) g.latestModified = r.modified;
        if ((!g.productType || g.productType === 'other') && r.product_type) g.productType = r.product_type;
        if (!g.fileDate && r.file_date) g.fileDate = r.file_date;
    }
    const arr = Object.values(groups).map(g => ({
        creativeId: g.creativeId,
        productType: g.productType,
        fileDate: g.fileDate,
        countries: [...g.countries].sort(),
        countryCount: g.countries.size,
        fileCount: g.fileCount,
        videoCount: g.videoCount,
        imageCount: g.imageCount,
        latestModified: g.latestModified,
    }));
    arr.sort((a, b) => {
        if (a.latestModified && b.latestModified) return b.latestModified.localeCompare(a.latestModified);
        const an = parseInt((a.creativeId || '').replace(/\D/g, '')) || 0;
        const bn = parseInt((b.creativeId || '').replace(/\D/g, '')) || 0;
        return bn - an;
    });
    const lastSync = _getMeta.get('last_sync')?.value || null;
    return {
        creatives: arr,
        total: arr.length,
        totalFiles: rows.length,
        lastSyncAt: lastSync,
    };
}

app.get('/api/creatives', (req, res) => {
    try {
        const data = readCreativesFromDb();
        if (data.total === 0 && !_syncInProgress) {
            console.log('[creatives] empty DB, triggering background sync...');
            syncCreativesFromDropbox().catch(() => {});
        }
        res.json(data);
    } catch (e) {
        console.error('[GET /api/creatives] error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/creatives/sync', async (req, res) => {
    try {
        const result = await syncCreativesFromDropbox();
        if (!result.ok) return res.status(409).json(result);
        const data = readCreativesFromDb();
        res.json({ ...result, ...data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/creatives/:id/files', (req, res) => {
    try {
        const wantId = String(req.params.id).toUpperCase();
        const rows = creativesDb.prepare('SELECT name, path, country, product_type, file_date, media_type, size, modified FROM creative_files WHERE creative_id = ? ORDER BY modified DESC').all(wantId);
        res.json({ creativeId: wantId, files: rows.map(r => ({
            name: r.name, path: r.path, country: r.country, productType: r.product_type,
            fileDate: r.file_date, mediaType: r.media_type, size: r.size, modified: r.modified,
        })) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

function scheduleDailySync() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(3, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next.getTime() - now.getTime();
    console.log('[creatives:sync] next daily sync at', next.toISOString());
    setTimeout(() => {
        syncCreativesFromDropbox().catch(e => console.error('[creatives:sync] daily failed:', e));
        scheduleDailySync();
    }, delay);
}
scheduleDailySync();

setTimeout(() => {
    const count = creativesDb.prepare('SELECT COUNT(*) AS c FROM creative_files').get().c;
    if (count === 0) {
        console.log('[creatives:sync] DB empty, running initial sync...');
        syncCreativesFromDropbox().catch(e => console.error('[creatives:sync] initial failed:', e));
    } else {
        console.log('[creatives:sync] DB has', count, 'files (skipping initial sync)');
    }
}, 3000);

// ========== END DROPBOX CREATIVES API ==========


// Image proxy for CORS - fetch external images and serve with proper headers
app.get('/api/image-proxy', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) {
        return res.status(400).send('Missing url parameter');
    }
    
    try {
        const response = await fetch(imageUrl);
        const buffer = await response.arrayBuffer();
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(Buffer.from(buffer));
    } catch (err) {
        console.error('Image proxy error:', err);
        res.status(500).send('Failed to fetch image');
    }
});

// Load data
function loadData() {
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        return {
            countries: ["HR", "CZ", "PL", "GR", "IT", "HU", "SK", "BG", "RO"],
            defaultTasks: [],
            assignees: ["Ajda", "Dejan", "Grega", "Petra", "Teja"],
            countryData: {}
        };
    }
}

// Save data
function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Initialize country data if missing
function initCountryData(data, country) {
    if (!data.countryData[country]) {
        data.countryData[country] = { tasks: [], customTasks: [] };
    }
    // Ensure all default tasks exist
    data.defaultTasks.forEach((taskName, index) => {
        const existing = data.countryData[country].tasks.find(t => t.name === taskName);
        if (!existing) {
            data.countryData[country].tasks.push({
                id: `default-${index}`,
                name: taskName,
                done: false,
                assignee: "",
                notes: ""
            });
        }
    });
    return data;
}

// GET all data
app.get('/api/data', (req, res) => {
    let data = loadData();
    // Initialize all countries
    data.countries.forEach(country => {
        data = initCountryData(data, country);
    });
    saveData(data);
    res.json(data);
});

// GET country data
app.get('/api/country/:code', (req, res) => {
    let data = loadData();
    const country = req.params.code.toUpperCase();
    data = initCountryData(data, country);
    saveData(data);
    res.json({
        country: country,
        tasks: data.countryData[country].tasks,
        customTasks: data.countryData[country].customTasks || []
    });
});

// UPDATE task
app.put('/api/country/:code/task/:taskId', (req, res) => {
    const data = loadData();
    const country = req.params.code.toUpperCase();
    const taskId = req.params.taskId;
    const { done, assignee, notes, shortNote, deadline, assignMessage } = req.body;

    if (!data.countryData[country]) {
        return res.status(404).json({ error: 'Country not found' });
    }

    // Check in regular tasks
    let task = data.countryData[country].tasks.find(t => t.id === taskId);
    if (!task) {
        // Check in custom tasks
        task = (data.countryData[country].customTasks || []).find(t => t.id === taskId);
    }

    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }

    if (done !== undefined) task.done = done;
    if (assignee !== undefined) task.assignee = assignee;
    if (notes !== undefined) task.notes = notes;
    if (shortNote !== undefined) task.shortNote = shortNote;
    if (deadline !== undefined) task.deadline = deadline;
    if (assignMessage !== undefined) task.assignMessage = assignMessage;
    if (req.body.category !== undefined) task.category = req.body.category;
    if (req.body.name !== undefined) task.name = req.body.name;
    if (req.body.link !== undefined) task.link = req.body.link;
    if (req.body.linkLabel !== undefined) task.linkLabel = req.body.linkLabel;
    if (req.body.toolType !== undefined) task.toolType = req.body.toolType;

    saveData(data);
    res.json({ success: true, task });
});

// REORDER tasks
app.put('/api/country/:code/reorder', (req, res) => {
    const data = loadData();
    const country = req.params.code.toUpperCase();
    const { taskIds } = req.body;

    if (!data.countryData[country]) {
        return res.status(404).json({ error: 'Country not found' });
    }

    const allTasks = [...data.countryData[country].tasks, ...(data.countryData[country].customTasks || [])];
    
    // Reorder based on taskIds array
    const reorderedTasks = [];
    const reorderedCustom = [];
    
    taskIds.forEach(id => {
        const task = allTasks.find(t => t.id === id);
        if (task) {
            if (task.isCustom) {
                reorderedCustom.push(task);
            } else {
                reorderedTasks.push(task);
            }
        }
    });
    
    // Keep any tasks that weren't in the reorder list (shouldn't happen but safety)
    allTasks.forEach(task => {
        if (!taskIds.includes(task.id)) {
            if (task.isCustom) {
                reorderedCustom.push(task);
            } else {
                reorderedTasks.push(task);
            }
        }
    });
    
    data.countryData[country].tasks = reorderedTasks;
    data.countryData[country].customTasks = reorderedCustom;

    saveData(data);
    res.json({ success: true });
});

// ADD custom task - adds to ALL countries
app.post('/api/country/:code/task', (req, res) => {
    const data = loadData();
    const { name, category, link } = req.body;
    const taskId = `custom-${Date.now()}`;

    // Add task to ALL countries
    data.countries.forEach(country => {
        if (!data.countryData[country]) {
            data.countryData[country] = { tasks: [], customTasks: [] };
        }
        if (!data.countryData[country].customTasks) {
            data.countryData[country].customTasks = [];
        }

        data.countryData[country].customTasks.push({
            id: taskId,
            name: name,
            category: category || 'other',
            done: false,
            assignee: "",
            notes: "",
            shortNote: "",
            link: link || "",
            isCustom: true
        });
    });

    saveData(data);
    res.json({ success: true, taskId });
});

// GET daily log for a task
app.get('/api/country/:code/task/:taskId/daily-log', (req, res) => {
    const data = loadData();
    const country = req.params.code.toUpperCase();
    const taskId = req.params.taskId;

    if (!data.countryData[country]) {
        return res.status(404).json({ error: 'Country not found' });
    }

    // Find task
    let task = data.countryData[country].tasks?.find(t => t.id === taskId);
    if (!task) task = data.countryData[country].customTasks?.find(t => t.id === taskId);
    
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }

    res.json(task.dailyLog || {});
});

// POST mark today as done in daily log
app.post('/api/country/:code/task/:taskId/daily-log', (req, res) => {
    const data = loadData();
    const country = req.params.code.toUpperCase();
    const taskId = req.params.taskId;
    const { by } = req.body;

    if (!data.countryData[country]) {
        return res.status(404).json({ error: 'Country not found' });
    }

    // Find task
    let task = data.countryData[country].tasks?.find(t => t.id === taskId);
    if (!task) task = data.countryData[country].customTasks?.find(t => t.id === taskId);
    
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }

    // Initialize daily log if needed
    if (!task.dailyLog) task.dailyLog = {};
    
    // Add today's entry
    const today = new Date().toISOString().split('T')[0];
    const now = new Date();
    task.dailyLog[today] = {
        done: true,
        by: by || 'Unknown',
        time: now.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })
    };

    saveData(data);
    res.json({ success: true, date: today });
});

// PUT update specific date in daily log
app.put('/api/country/:code/task/:taskId/daily-log/:dateKey', (req, res) => {
    const data = loadData();
    const country = req.params.code.toUpperCase();
    const taskId = req.params.taskId;
    const dateKey = req.params.dateKey;
    const { done, by } = req.body;

    if (!data.countryData[country]) {
        return res.status(404).json({ error: 'Country not found' });
    }

    // Find task
    let task = data.countryData[country].tasks?.find(t => t.id === taskId);
    if (!task) task = data.countryData[country].customTasks?.find(t => t.id === taskId);
    
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }

    // Initialize daily log if needed
    if (!task.dailyLog) task.dailyLog = {};
    
    if (done) {
        const now = new Date();
        task.dailyLog[dateKey] = {
            done: true,
            by: by || 'Unknown',
            time: now.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })
        };
    } else {
        delete task.dailyLog[dateKey];
    }

    saveData(data);
    res.json({ success: true, date: dateKey, done });
});

// DELETE any task
app.delete('/api/country/:code/task/:taskId', (req, res) => {
    const data = loadData();
    const country = req.params.code.toUpperCase();
    const taskId = req.params.taskId;

    if (!data.countryData[country]) {
        return res.status(404).json({ error: 'Country not found' });
    }

    // Try to delete from regular tasks
    const tasks = data.countryData[country].tasks || [];
    const taskIndex = tasks.findIndex(t => t.id === taskId);
    if (taskIndex !== -1) {
        tasks.splice(taskIndex, 1);
        saveData(data);
        return res.json({ success: true });
    }

    // Try to delete from custom tasks
    const customTasks = data.countryData[country].customTasks || [];
    const customIndex = customTasks.findIndex(t => t.id === taskId);
    if (customIndex !== -1) {
        customTasks.splice(customIndex, 1);
        saveData(data);
        return res.json({ success: true });
    }

    res.status(404).json({ error: 'Task not found' });
});

// ADD new country
app.post('/api/country', (req, res) => {
    const data = loadData();
    const { code } = req.body;
    const countryCode = code.toUpperCase();

    if (data.countries.includes(countryCode)) {
        return res.status(400).json({ error: 'Country already exists' });
    }

    data.countries.push(countryCode);
    data.countryData[countryCode] = { tasks: [], customTasks: [] };
    
    // Initialize with default tasks
    data.defaultTasks.forEach((taskName, index) => {
        data.countryData[countryCode].tasks.push({
            id: `default-${index}`,
            name: taskName,
            done: false,
            assignee: "",
            notes: ""
        });
    });

    saveData(data);
    res.json({ success: true, country: countryCode });
});

// Store and get pending Slack notifications
const NOTIFICATIONS_FILE = path.join(__dirname, 'notifications.json');

function loadNotifications() {
    try {
        return JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf8'));
    } catch (e) {
        return { pending: [], sent: [] };
    }
}

function saveNotifications(data) {
    fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(data, null, 2));
}

// Slack user IDs
const slackUsers = {
    'Dejan': 'U0A6L2WURD3',
    'Ajda': null,
    'Grega': null,
    'Petra': null,
    'Teja': null
};

const SLACK_TOKEN = process.env.SLACK_TOKEN || '';

// Send Slack message
async function sendSlackMessage(userId, text) {
    if (!userId) return { ok: false, error: 'No user ID' };
    
    const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${SLACK_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ channel: userId, text })
    });
    return response.json();
}

// POST notification (from frontend) - sends immediately
app.post('/api/notify', async (req, res) => {
    const { assignee, taskName, country, deadline, message, taskId } = req.body;
    const notifications = loadNotifications();
    
    const notification = {
        id: Date.now(),
        assignee,
        taskName,
        country,
        deadline,
        message,
        taskId,
        createdAt: new Date().toISOString()
    };
    
    // Try to send Slack message immediately
    const slackUserId = slackUsers[assignee];
    if (slackUserId) {
        const deadlineStr = deadline ? new Date(deadline).toLocaleDateString('sl-SI', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Ni določen';
        const slackText = `🚀 *Nova naloga: ${taskName}*\n\n📍 Država: ${country}\n📅 Rok: ${deadlineStr}\n\n📝 *Opis:*\n${message || 'Ni opisa'}\n\n✅ Ko končaš, označi tukaj: https://miki.noriks.com/launches/`;
        
        const result = await sendSlackMessage(slackUserId, slackText);
        notification.slackSent = result.ok;
        notification.slackError = result.error;
        
        if (result.ok) {
            notification.sentAt = new Date().toISOString();
            notifications.sent.push(notification);
        } else {
            notifications.pending.push(notification);
        }
    } else {
        notification.slackSent = false;
        notification.slackError = 'No Slack ID for user';
        notifications.pending.push(notification);
    }
    
    saveNotifications(notifications);
    res.json({ success: true, slackSent: notification.slackSent, error: notification.slackError });
});

// GET pending notifications (for agent to send)
app.get('/api/notifications/pending', (req, res) => {
    const notifications = loadNotifications();
    res.json(notifications.pending);
});

// Mark notification as sent
app.post('/api/notifications/:id/sent', (req, res) => {
    const notifications = loadNotifications();
    const id = parseInt(req.params.id);
    const index = notifications.pending.findIndex(n => n.id === id);
    
    if (index !== -1) {
        const [notification] = notifications.pending.splice(index, 1);
        notification.sentAt = new Date().toISOString();
        notifications.sent.push(notification);
        saveNotifications(notifications);
    }
    
    res.json({ success: true });
});

// Social Proof Generator
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const localNames = {
    hr: ['Marko Horvat', 'Ivan Kovačević', 'Ana Babić', 'Petra Jurić', 'Luka Novak', 'Maja Tomić', 'Filip Marić'],
    cz: ['Jakub Novák', 'Tomáš Svoboda', 'Martin Dvořák', 'Jana Černá', 'Lucie Procházková', 'Petr Kučera'],
    pl: ['Piotr Kowalski', 'Anna Nowak', 'Krzysztof Wiśniewski', 'Agnieszka Wójcik', 'Michał Kamiński', 'Magdalena Lewandowska'],
    gr: ['Νίκος Παπαδόπουλος', 'Μαρία Κωνσταντίνου', 'Γιώργος Αντωνίου', 'Ελένη Νικολάου', 'Δημήτρης Γεωργίου'],
    it: ['Marco Rossi', 'Giuseppe Russo', 'Francesca Bianchi', 'Alessandra Ferrari', 'Luca Esposito', 'Giulia Romano'],
    hu: ['Kovács Péter', 'Nagy Ágnes', 'Szabó Tamás', 'Tóth Katalin', 'Horváth Gábor', 'Varga Eszter'],
    sk: ['Ján Horváth', 'Peter Kováč', 'Mária Nagyová', 'Anna Szabová', 'Tomáš Baláž', 'Zuzana Tóthová'],
    bg: ['Георги Иванов', 'Димитър Петров', 'Мария Георгиева', 'Ивана Димитрова', 'Николай Тодоров', 'Елена Стоянова'],
    ro: ['Andrei Popescu', 'Ion Ionescu', 'Maria Popa', 'Elena Dumitrescu', 'Alexandru Stan', 'Ana Gheorghe']
};

const languages = {
    hr: 'Croatian', cz: 'Czech', pl: 'Polish', gr: 'Greek', it: 'Italian', hu: 'Hungarian', sk: 'Slovak', bg: 'Bulgarian', ro: 'Romanian'
};

const productNames = {
    hr: { boxers: 'boksericama', tshirt: 'majicom', set: 'kompletom' },
    cz: { boxers: 'boxerkami', tshirt: 'tričkem', set: 'setem' },
    pl: { boxers: 'bokserkami', tshirt: 'koszulką', set: 'zestawem' },
    gr: { boxers: 'μποξεράκια', tshirt: 'μπλούζα', set: 'σετ' },
    it: { boxers: 'boxer', tshirt: 'maglietta', set: 'set' },
    hu: { boxers: 'boxerrel', tshirt: 'pólóval', set: 'szettel' },
    sk: { boxers: 'boxerkami', tshirt: 'tričkom', set: 'setom' },
    bg: { boxers: 'боксерки', tshirt: 'тениска', set: 'комплект' },
    ro: { boxers: 'boxeri', tshirt: 'tricou', set: 'set' }
};

app.post('/api/social-proof/generate', async (req, res) => {
    const { country, style, product, praiseType } = req.body;
    
    const lang = languages[country] || 'English';
    const names = localNames[country] || localNames.hr;
    const name = names[Math.floor(Math.random() * names.length)];
    
    const actualProduct = product === 'any' 
        ? ['boxers', 'tshirt', 'set'][Math.floor(Math.random() * 3)]
        : product;
    
    const actualPraise = praiseType === 'any'
        ? ['quality', 'delivery', 'support', 'price'][Math.floor(Math.random() * 4)]
        : praiseType;
    
    const praiseDescriptions = {
        quality: 'amazing product quality, comfortable material, perfect fit',
        delivery: 'super fast delivery, great packaging',
        support: 'excellent customer support, quick responses',
        price: 'great value for money, affordable premium quality'
    };
    
    const prompt = `Write a short, authentic customer review in ${lang} language for NORIKS underwear/clothing brand.
The review should praise: ${praiseDescriptions[actualPraise]}
Product: ${actualProduct === 'boxers' ? 'boxer shorts' : actualProduct === 'tshirt' ? 't-shirt' : 'underwear set'}
Style: casual, genuine, like a real customer wrote it. NOT too formal, NOT marketing speak.
Length: 3-4 sentences.
DO NOT include greetings, sign-offs, or title.
Write ONLY the review body text in ${lang}, nothing else.`;

    const titlePrompt = `Write a short, enthusiastic review title (4-6 words max) in ${lang} language about NORIKS ${actualProduct === 'boxers' ? 'boxer shorts' : actualProduct === 'tshirt' ? 't-shirt' : 'underwear set'}.
Style: casual but excited, like "NORIKS boxers are the best!" or "Super comfortable!"
Write ONLY the title in ${lang}, nothing else.`;

    try {
        // Generate both text and title in parallel
        const [textResponse, titleResponse] = await Promise.all([
            fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 250,
                    temperature: 0.9
                })
            }),
            fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [{ role: 'user', content: titlePrompt }],
                    max_tokens: 50,
                    temperature: 0.9
                })
            })
        ]);
        
        const textData = await textResponse.json();
        const titleData = await titleResponse.json();
        
        if (textData.error) {
            return res.status(500).json({ error: textData.error.message });
        }
        
        const text = textData.choices[0].message.content.trim();
        const title = titleData.choices?.[0]?.message?.content?.trim() || 'Odlično!';
        
        // Generate random date in last 30 days
        const daysAgo = Math.floor(Math.random() * 30) + 1;
        const date = new Date();
        date.setDate(date.getDate() - daysAgo);
        const dateStr = date.toLocaleDateString(country === 'gr' ? 'el-GR' : country === 'bg' ? 'bg-BG' : country === 'ro' ? 'ro-RO' : `${country}-${country.toUpperCase()}`, { 
            day: 'numeric', month: 'short', year: 'numeric' 
        });
        
        res.json({
            text,
            title,
            name,
            date: dateStr,
            stars: Math.random() > 0.3 ? 5 : 4,
            country,
            product: actualProduct,
            praiseType: actualPraise
        });
        
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Generate review for Social Proof Generator (frontend calls this)
app.post('/api/generate-review', async (req, res) => {
    const { country, product, praise, stars, style, isGift } = req.body;
    
    const lang = languages[country.toLowerCase()] || 'English';
    
    const productMap = {
        boxers: { en: 'boxer shorts', hr: 'boksarice', cz: 'boxerky', pl: 'bokserki', gr: 'μποξεράκια', it: 'boxer', hu: 'boxer', sk: 'boxerky', bg: 'боксерки', ro: 'boxeri' },
        tshirt: { en: 't-shirt', hr: 'majica', cz: 'tričko', pl: 'koszulka', gr: 'μπλούζα', it: 'maglietta', hu: 'póló', sk: 'tričko', bg: 'тениска', ro: 'tricou' },
        set: { en: 'underwear set', hr: 'komplet', cz: 'set', pl: 'zestaw', gr: 'σετ', it: 'set', hu: 'szett', sk: 'set', bg: 'комплект', ro: 'set' }
    };
    
    const praiseMap = {
        quality: 'amazing product quality, soft comfortable material, perfect fit that stays in place',
        delivery: 'super fast delivery, excellent packaging, arrived quickly',
        support: 'excellent customer support, quick helpful responses, great communication',
        value: 'great value for money, affordable yet premium quality, worth every penny',
        comfort: 'incredibly comfortable, feels like wearing nothing, perfect all-day comfort',
        durability: 'very durable, keeps shape and color after many washes, long-lasting quality',
        gift: 'bought as gift for partner/husband, they absolutely love it, great gift idea'
    };
    
    const productName = productMap[product]?.en || 'underwear';
    const praiseFocus = praiseMap[praise] || praiseMap.quality;
    
    const isFacebook = style === 'facebook';
    
    // Gender context for the review
    const genderContext = isGift 
        ? 'The reviewer is a WOMAN who bought this as a gift for her boyfriend/husband. She talks about how HE loves it.'
        : 'The reviewer is a MAN who bought this for himself. He talks about his own experience wearing it.';
    
    const prompt = isFacebook 
        ? `Write an authentic Facebook comment in ${lang} language praising NORIKS brand ${productName}.

${genderContext}

The comment should emphasize: ${praiseFocus}

Requirements:
- Write like a REAL Facebook comment, casual and conversational
- 2-3 sentences maximum (short comment style)
- Can compare to other brands (without naming them) like "other boxers always..."
- NO hashtags, NO emojis, NO formal language
- Mention NORIKS brand name naturally
- Sound like native ${lang} speaker
- Use correct grammatical gender for the reviewer

Return ONLY the comment text in ${lang}, no quotes.`
        : `Write an authentic short customer review in ${lang} language for NORIKS brand ${productName}.

${genderContext}

The review should emphasize: ${praiseFocus}

Requirements:
- Write like a REAL customer, casual and genuine
- 3-4 sentences maximum
- NO marketing speak, NO formal language
- Mention NORIKS brand naturally
- Sound like native ${lang} speaker
- Use correct grammatical gender for the reviewer
- ${stars === 4 ? 'Slightly less enthusiastic but still positive' : 'Very satisfied customer'}

Return ONLY the review text, no quotes, no translation, just the ${lang} text.`;

    const titlePrompt = `Write a short catchy review title (3-6 words) in ${lang} language for a ${productName} review.

Examples style: "Best purchase ever!", "Finally found the one", "Super comfortable!"

Write ONLY the title in ${lang}, no quotes.`;

    try {
        // For Facebook style, skip title generation
        const requests = [
            fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 300,
                    temperature: 0.85
                })
            })
        ];
        
        // Only add title request for Trustpilot style
        if (!isFacebook) {
            requests.push(
                fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${OPENAI_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: 'gpt-4o-mini',
                        messages: [{ role: 'user', content: titlePrompt }],
                        max_tokens: 50,
                        temperature: 0.85
                    })
                })
            );
        }
        
        const results = await Promise.all(requests);
        const textData = await results[0].json();
        const titleData = results[1] ? await results[1].json() : null;
        
        if (textData.error) {
            console.error('OpenAI error:', textData.error);
            return res.status(500).json({ error: textData.error.message });
        }
        
        const body = textData.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
        const title = titleData?.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, '') || null;
        
        res.json({ title, body });
        
    } catch (err) {
        console.error('Generate review error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Video upload endpoint
app.post('/api/upload-video', upload.single('video'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No video file uploaded' });
    }
    
    console.log('Video uploaded:', req.file.filename, 'Size:', (req.file.size / 1024 / 1024).toFixed(2), 'MB');
    
    res.json({
        success: true,
        filename: req.file.filename,
        path: req.file.path,
        size: req.file.size
    });
});

// List uploaded videos
app.get('/api/videos', (req, res) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
        return res.json([]);
    }
    const files = fs.readdirSync(uploadDir).filter(f => f.startsWith('video-'));
    res.json(files.map(f => {
        const stat = fs.statSync(path.join(uploadDir, f));
        return {
            filename: f,
            size: stat.size,
            uploaded: stat.mtime
        };
    }).sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded)));
});

// Serve uploaded videos
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Gemini/OpenAI video analysis
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

app.post('/api/analyze-video', async (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'Missing filename' });
    
    const videoPath = path.join(__dirname, 'uploads', filename);
    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video not found' });
    
    try {
        // Extract frames from video (1 per second for first 30 seconds)
        const framesDir = path.join(__dirname, 'uploads', 'frames-' + Date.now());
        fs.mkdirSync(framesDir, { recursive: true });
        
        await execPromise(`ffmpeg -i "${videoPath}" -vf "fps=1" -t 30 -q:v 2 "${framesDir}/frame-%03d.jpg" 2>/dev/null`);
        
        const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
        console.log(`Extracted ${frames.length} frames from ${filename}`);
        
        if (frames.length === 0) {
            fs.rmSync(framesDir, { recursive: true });
            return res.json({ texts: [], message: 'No frames extracted' });
        }
        
        // Analyze ALL frames - no sampling to ensure we catch every text
        const sampled = frames.slice(0, 30); // Analyze up to 30 frames (first 30 seconds)
        const extractedTexts = [];
        
        for (let i = 0; i < sampled.length; i++) {
            const framePath = path.join(framesDir, sampled[i]);
            const base64 = fs.readFileSync(framePath).toString('base64');
            const timestamp = `${Math.floor(i * 3)}s`;
            
            try {
                const response = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${OPENAI_API_KEY}`
                    },
                    body: JSON.stringify({
                        model: 'gpt-4o-mini',
                        messages: [{
                            role: 'user',
                            content: [
                                {
                                    type: 'text',
                                    text: 'Extract ALL visible text overlays from this video frame. Focus on marketing text, titles, subtitles, captions, call-to-actions. Return ONLY a JSON array of objects with "text" and "context" fields. Context should briefly describe where/what the text is (e.g., "headline", "subtitle", "CTA button"). If no text visible, return empty array [].'
                                },
                                {
                                    type: 'image_url',
                                    image_url: { url: `data:image/jpeg;base64,${base64}` }
                                }
                            ]
                        }],
                        max_tokens: 500
                    })
                });
                
                const data = await response.json();
                const content = data.choices?.[0]?.message?.content || '[]';
                
                // Parse JSON from response
                const jsonMatch = content.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    const texts = JSON.parse(jsonMatch[0]);
                    texts.forEach(t => {
                        // Avoid duplicates
                        if (!extractedTexts.find(e => e.text === t.text)) {
                            extractedTexts.push({ ...t, timestamp });
                        }
                    });
                }
            } catch (e) {
                console.error('Frame analysis error:', e.message);
            }
        }
        
        // Cleanup frames
        fs.rmSync(framesDir, { recursive: true });
        
        console.log(`Extracted ${extractedTexts.length} unique texts from ${filename}`);
        res.json({ texts: extractedTexts });
        
    } catch (e) {
        console.error('Video analysis error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Translate texts to multiple languages
app.post('/api/translate-texts', async (req, res) => {
    const { texts, languages } = req.body;
    if (!texts || !languages) return res.status(400).json({ error: 'Missing texts or languages' });
    
    const LANG_NAMES = {
        'SI': 'Slovenian',
        'HR': 'Croatian',
        'CZ': 'Czech', 
        'PL': 'Polish',
        'GR': 'Greek',
        'IT': 'Italian',
        'HU': 'Hungarian',
        'SK': 'Slovak',
        'BG': 'Bulgarian',
        'RO': 'Romanian',
        'DE': 'German'
    };
    
    try {
        const translations = [];
        
        // Batch all texts for translation
        const textsToTranslate = texts.map(t => t.text);
        
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [{
                    role: 'system',
                    content: `You are a professional marketing translator. Translate the given texts into the requested languages. Keep the tone punchy and marketing-appropriate. CRITICAL: NORIKS sells T-SHIRTS (casual, round neck) and BOXER SHORTS. NEVER translate t-shirt as dress shirt/formal shirt. Use: HR=majica, CZ=tričko, PL=koszulka, GR=μπλούζα, IT=maglietta, HU=póló, SK=tričko, BG=тениска, RO=tricou. NEVER use: HR=košulja, CZ=košile, PL=koszula, IT=camicia, HU=ing, SK=košeľa, BG=риза, RO=cămașă. Maintain any emojis. Return ONLY valid JSON.
CRITICAL LANGUAGE WARNING: SK = SLOVAK language (slovenčina/slovenský jazyk, spoken in SLOVAKIA). This is NOT Slovenian (slovenščina, spoken in Slovenia). These are completely DIFFERENT languages. The source texts are in Slovenian — you must translate them INTO Slovak for the SK field. Do NOT copy the Slovenian source text as the Slovak translation.`
                }, {
                    role: 'user',
                    content: `Translate these marketing texts into ${languages.map(l => LANG_NAMES[l]).join(', ')}:

${textsToTranslate.map((t, i) => `${i + 1}. "${t}"`).join('\n')}

Return as JSON array where each element has the language codes as keys:
[{"HR": "...", "CZ": "...", "PL": "...", "GR": "...", "IT": "...", "HU": "...", "SK": "..."}, ...]`
                }],
                max_tokens: 8000
            })
        });
        
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '[]';
        
        // Parse JSON from response
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            res.json({ translations: parsed });
        } else {
            res.json({ translations: [], error: 'Could not parse translations' });
        }
        
    } catch (e) {
        console.error('Translation error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============================================
// VIDEO LOCALIZER API
// ============================================

const localizationJobs = new Map();
const archiver = require('archiver');

// Start localization job
app.post('/api/localize', async (req, res) => {
    const { videoWithText, videoClean, name } = req.body;
    if (!videoWithText || !videoClean) {
        return res.status(400).json({ error: 'Missing videos' });
    }
    
    const jobId = `job-${Date.now()}`;
    const job = {
        id: jobId,
        name: name || jobId,
        videoWithText,
        videoClean,
        status: 'analyzing',
        progress: 0,
        completed: 0,
        created: new Date().toISOString(),
        outputs: {}
    };
    
    localizationJobs.set(jobId, job);
    
    // Start async processing
    processLocalizationJob(job).catch(e => {
        job.status = 'error';
        job.error = e.message;
        console.error('Localization error:', e);
    });
    
    res.json(job);
});

// List all jobs (must be before :id route)
app.get('/api/localize/list', (req, res) => {
    const jobs = Array.from(localizationJobs.values())
        .sort((a, b) => new Date(b.created) - new Date(a.created))
        .slice(0, 50);
    res.json(jobs);
});

// Get job status
app.get('/api/localize/:id', (req, res) => {
    const job = localizationJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

// Download individual video
app.get('/api/localize/:id/video/:lang', (req, res) => {
    const job = localizationJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    const videoPath = job.outputs[req.params.lang];
    if (!videoPath || !fs.existsSync(videoPath)) {
        return res.status(404).json({ error: 'Video not found' });
    }
    
    res.download(videoPath);
});

// Download all as ZIP
app.get('/api/localize/:id/download', (req, res) => {
    const job = localizationJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'done') return res.status(400).json({ error: 'Job not complete' });
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${job.name}-localized.zip"`);
    
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);
    
    for (const [lang, videoPath] of Object.entries(job.outputs)) {
        if (fs.existsSync(videoPath)) {
            archive.file(videoPath, { name: `${job.name}-${lang}.mp4` });
        }
    }
    
    archive.finalize();
});

// Process localization job
async function processLocalizationJob(job) {
    const LANGUAGES = ['SI', 'HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK', 'BG', 'RO', 'DE'];
    const outputDir = path.join(__dirname, 'uploads', 'localized', job.id);
    fs.mkdirSync(outputDir, { recursive: true });
    
    const videoWithTextPath = path.join(__dirname, 'uploads', job.videoWithText);
    const videoCleanPath = path.join(__dirname, 'uploads', job.videoClean);
    
    // Step 1: Analyze video with text
    job.status = 'analyzing';
    console.log(`[${job.id}] Analyzing video...`);
    
    const framesDir = path.join(outputDir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });
    
    // Extract frames
    await execPromise(`ffmpeg -y -i "${videoWithTextPath}" -vf "fps=2" -t 30 -q:v 2 "${framesDir}/frame-%03d.jpg" 2>/dev/null`);
    
    const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
    const segments = [];
    let lastTexts = [];
    
    // Analyze frames with OpenAI Vision
    for (let i = 0; i < frames.length; i += 3) {
        const framePath = path.join(framesDir, frames[i]);
        const base64 = fs.readFileSync(framePath).toString('base64');
        const timestamp = (parseInt(frames[i].match(/\d+/)[0]) - 1) * 0.5;
        
        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [{ role: 'user', content: [
                        { type: 'text', text: 'Extract ALL visible text overlays from this video frame. Return JSON array: [{"text": "...", "position": "top/center/bottom"}]. If no text, return [].' },
                        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
                    ]}],
                    max_tokens: 300
                })
            });
            
            const data = await response.json();
            const content = data.choices?.[0]?.message?.content || '[]';
            const match = content.match(/\[[\s\S]*\]/);
            
            if (match) {
                try {
                    // Clean up common JSON issues from AI responses
                    let jsonStr = match[0]
                        .replace(/[\u201C\u201D]/g, '"')  // Smart quotes
                        .replace(/[\u2018\u2019]/g, "'")  // Smart apostrophes
                        .replace(/,\s*]/g, ']')          // Trailing commas
                        .replace(/,\s*}/g, '}');         // Trailing commas in objects
                    
                    const texts = JSON.parse(jsonStr);
                    texts.forEach(t => {
                        if (!t.text) return; // Skip empty texts
                        const existing = segments.find(s => s.text === t.text);
                        if (existing) {
                            existing.end = timestamp + 1;
                        } else if (!lastTexts.includes(t.text)) {
                            segments.push({ text: t.text, start: timestamp, end: timestamp + 1.5, position: t.position || 'center' });
                        }
                    });
                    lastTexts = texts.map(t => t.text).filter(Boolean);
                } catch (parseErr) {
                    console.error('JSON parse error:', parseErr.message, 'Content:', match[0].substring(0, 200));
                }
            }
        } catch (e) {
            console.error('Frame analysis error:', e.message);
        }
    }
    
    // Cleanup frames
    fs.rmSync(framesDir, { recursive: true });
    
    if (segments.length === 0) {
        throw new Error('No text found in video');
    }
    
    console.log(`[${job.id}] Found ${segments.length} text segments`);
    
    // Step 2: Translate
    job.status = 'translating';
    console.log(`[${job.id}] Translating...`);
    
    const textsToTranslate = segments.map(s => s.text);
    const transResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{
                role: 'system',
                content: 'You are a marketing translator for NORIKS men\'s underwear. Keep texts punchy and short. T-shirt translations: HR=majica, CZ=tričko, PL=koszulka, IT=maglietta, HU=póló, SK=tričko, BG=тениска, RO=tricou. NEVER use dress shirt words (košulja/košile/koszula/camicia/ing/košeľa/риза/cămașă). CRITICAL: SK = SLOVAK (slovenčina/slovenský jazyk, spoken in SLOVAKIA), NOT Slovenian (slovenščina, spoken in Slovenia). These are DIFFERENT languages. Do NOT output Slovenian text for SK.'
            }, {
                role: 'user',
                content: `Translate to Croatian, Czech, Polish, Greek, Italian, Hungarian, Slovak:\n\n${textsToTranslate.map((t, i) => `${i+1}. "${t}"`).join('\n')}\n\nReturn JSON: [{"HR":"...","CZ":"...","PL":"...","GR":"...","IT":"...","HU":"...","SK":"..."}, ...]`
            }],
            max_tokens: 8000
        })
    });
    
    const transData = await transResponse.json();
    let transContent = transData.choices?.[0]?.message?.content || '[]';
    // Strip markdown code fences if present
    transContent = transContent.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
    const transMatch = transContent.match(/\[[\s\S]*\]/);
    const translations = transMatch ? JSON.parse(transMatch[0]) : [];
    
    // Step 3: Generate videos
    job.status = 'generating';
    console.log(`[${job.id}] Generating videos...`);
    
    for (let langIdx = 0; langIdx < LANGUAGES.length; langIdx++) {
        const lang = LANGUAGES[langIdx];
        
        // Create ASS file
        let ass = `[Script Info]\nTitle: ${job.name} ${lang}\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n`;
        ass += `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n`;
        ass += `Style: Default,Arial,64,&H00000000,&H000000FF,&H00000000,&H00FFFFFF,1,0,0,0,100,100,0,0,3,0,0,5,50,50,50,1\n\n`;
        ass += `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
        
        segments.forEach((seg, i) => {
            const text = translations[i]?.[lang] || seg.text;
            const start = formatAssTime(seg.start);
            const end = formatAssTime(seg.end);
            
            // For center stacking (hkrati), use \pos for precise control
            if (seg.position === 'center-top') {
                ass += `Dialogue: 0,${start},${end},Default,,0,0,0,,{\\an5\\pos(540,880)\\fad(200,200)}${text}\n`;
            } else if (seg.position === 'center-bottom') {
                ass += `Dialogue: 0,${start},${end},Default,,0,0,0,,{\\an5\\pos(540,1000)\\fad(200,200)}${text}\n`;
            } else {
                // Default center position
                ass += `Dialogue: 0,${start},${end},Default,,0,0,0,,{\\an5\\fad(200,200)}${text}\n`;
            }
        });
        
        const assPath = path.join(outputDir, `subs-${lang}.ass`);
        fs.writeFileSync(assPath, ass);
        
        // Generate video
        const outVideo = path.join(outputDir, `${job.name}-${lang}.mp4`);
        await execPromise(`ffmpeg -y -i "${videoCleanPath}" -vf "ass='${assPath}':fontsdir=/usr/share/fonts" -c:a copy "${outVideo}" 2>/dev/null`);
        
        job.outputs[lang] = outVideo;
        job.completed = langIdx + 1;
        job.progress = Math.round(((langIdx + 1) / LANGUAGES.length) * 100);
        
        console.log(`[${job.id}] Generated ${lang} (${job.completed}/${LANGUAGES.length})`);
    }
    
    job.status = 'done';
    console.log(`[${job.id}] Complete!`);
}

function formatAssTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.floor((seconds % 1) * 100);
    return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}.${cs.toString().padStart(2,'0')}`;
}

// ============================================
// VIDEO LOCALIZER V2 API
// ============================================

// Persistent job storage
const JOBS_FILE = path.join(__dirname, 'data', 'localizer-jobs.json');

function loadJobs() {
    try {
        if (fs.existsSync(JOBS_FILE)) {
            return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading jobs:', e);
    }
    return [];
}

function saveJobs(jobs) {
    try {
        fs.mkdirSync(path.dirname(JOBS_FILE), { recursive: true });
        fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
    } catch (e) {
        console.error('Error saving jobs:', e);
    }
}

// Load jobs from file into Map
const localizerJobs = new Map();
const savedJobs = loadJobs();
savedJobs.forEach(job => localizerJobs.set(job.id, job));
console.log(`Loaded ${savedJobs.length} localizer jobs from disk`);

// Helper to persist current jobs
function persistJobs() {
    const jobs = Array.from(localizerJobs.values());
    saveJobs(jobs);
}

const FFMPEG = '/usr/local/bin/ffmpeg';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// Smart video analysis - detect scene cuts using ffmpeg
app.post('/api/localizer/smart-analyze', async (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'Missing filename' });
    
    const videoPath = path.join(__dirname, 'uploads', filename);
    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video not found' });
    
    try {
        const jobId = `smart-${Date.now()}`;
        console.log(`[${jobId}] Starting scene detection for ${filename}`);
        
        // Get video duration
        const durationResult = await execPromise(`${FFMPEG} -i "${videoPath}" 2>&1 | grep Duration | cut -d ' ' -f 4 | sed s/,//`);
        const durationParts = durationResult.stdout.trim().split(':');
        const totalSeconds = parseInt(durationParts[0] || 0) * 3600 + parseInt(durationParts[1] || 0) * 60 + parseFloat(durationParts[2] || 0);
        
        console.log(`[${jobId}] Video duration: ${totalSeconds}s`);
        
        // Two-pass scene detection:
        // Pass 1: Low threshold (0.15) to catch all cuts including color changes
        // Pass 2: Merge segments that are too short (< 1s) with their neighbor
        const sceneCmd = `${FFMPEG} -i "${videoPath}" -vf "select='gt(scene,0.15)',showinfo" -f null - 2>&1 | grep showinfo | grep pts_time`;
        
        let sceneResult;
        try {
            sceneResult = await execPromise(sceneCmd);
        } catch (e) {
            sceneResult = { stdout: e.stdout || '', stderr: e.stderr || '' };
        }
        
        const output = sceneResult.stderr || sceneResult.stdout || '';
        
        // Parse ALL scene timestamps
        const rawSceneTimes = [0];
        const regex = /pts_time:([0-9.]+)/g;
        let match;
        while ((match = regex.exec(output)) !== null) {
            const time = parseFloat(match[1]);
            if (time - rawSceneTimes[rawSceneTimes.length - 1] >= 0.3) {
                rawSceneTimes.push(time);
            }
        }
        
        console.log(`[${jobId}] Raw scene cuts (${rawSceneTimes.length}):`, rawSceneTimes.map(t => t.toFixed(1)));
        
        // Create raw segments
        let segments = [];
        for (let i = 0; i < rawSceneTimes.length; i++) {
            const start = rawSceneTimes[i];
            const end = rawSceneTimes[i + 1] || totalSeconds;
            segments.push({ start, end, texts: [] });
        }
        
        // Merge segments shorter than 1.5s with their NEXT neighbor
        // (short segments are usually part of a transition, merge forward)
        const MIN_DURATION = 1.0;
        let merged = true;
        while (merged) {
            merged = false;
            for (let i = 0; i < segments.length; i++) {
                const dur = segments[i].end - segments[i].start;
                if (dur < MIN_DURATION && segments.length > 1) {
                    if (i < segments.length - 1) {
                        // Merge with next segment
                        segments[i + 1].start = segments[i].start;
                        segments.splice(i, 1);
                    } else {
                        // Last segment: merge with previous
                        segments[i - 1].end = segments[i].end;
                        segments.splice(i, 1);
                    }
                    merged = true;
                    break;
                }
            }
        }
        
        // Round timestamps
        segments = segments.map(s => ({
            start: Math.round(s.start * 10) / 10,
            end: Math.round(s.end * 10) / 10,
            texts: []
        }));
        
        console.log(`[${jobId}] Final segments (${segments.length}):`, segments.map(s => `${s.start}-${s.end}s`).join(', '));
        res.json({ segments, duration: totalSeconds });
        
    } catch (e) {
        console.error('Scene detection error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Translate texts to English for editing
app.post('/api/localizer/to-english', async (req, res) => {
    const { texts } = req.body;
    if (!texts?.length) return res.status(400).json({ error: 'Missing texts' });
    
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [{
                    role: 'system',
                    content: 'Translate marketing texts to English. Keep brand names unchanged. Keep translations short and punchy.'
                }, {
                    role: 'user',
                    content: `Translate these texts to English (or keep as-is if already English):

${texts.map((t, i) => `${i+1}. "${t}"`).join('\n')}

Return JSON array of translations in same order:
["translation1", "translation2", ...]`
                }],
                max_tokens: 1000
            })
        });
        
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '[]';
        const match = content.match(/\[[\s\S]*\]/);
        const translations = match ? JSON.parse(match[0]) : texts;
        
        res.json({ translations });
    } catch (e) {
        console.error('To-English error:', e);
        res.json({ translations: texts }); // Return original if translation fails
    }
});

// Translate to Slovenian (pivot language for localization)
app.post('/api/localizer/to-slovenian', async (req, res) => {
    const { texts } = req.body;
    if (!texts?.length) return res.status(400).json({ error: 'Missing texts' });
    
    console.log('To-Slovenian request:', texts.length, 'texts');
    console.log('Texts to translate:', texts);
    
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [{
                    role: 'system',
                    content: `Si profesionalni slovenski copywriter za NORIKS - premium moška spodnja oblačila (boksarice, majice).

PRAVILA:
1. NE prevajaj dobesedno - ustvari NARAVEN slovenski tekst ki ima SMISEL
2. Piši kot da govoriš s prijateljem - sproščeno, a prepričljivo
3. Kratko in udarno - max 5-7 besed če je mogoče
4. Če original ne pomeni nič dobesedno, razmisli kaj SPOROČILO želi povedati
5. Brand "NORIKS" ostane nespremenjen
6. Fokus: udobje, kvaliteta, mehkoba, premium občutek`
                }, {
                    role: 'user',
                    content: `Prevedi te marketinške tekste v naravno slovenščino. Jezik vira je lahko grščina, angleščina, madžarščina, poljščina, itd.

${texts.map((t, i) => `${i+1}. "${t}"`).join('\n')}

Vrni SAMO JSON array s slovenskimi prevodi:
["prevod1", "prevod2", ...]

POMEMBNO: Če tekst dobesedno preveden ne bi imel smisla, razmisli kaj želi povedati in napiši SMISELN slovenski tekst!`
                }],
                max_tokens: 1500
            })
        });
        
        const data = await response.json();
        console.log('OpenAI response:', JSON.stringify(data).substring(0, 500));
        
        const content = data.choices?.[0]?.message?.content || '[]';
        console.log('Translation content:', content);
        
        const match = content.match(/\[[\s\S]*\]/);
        const translations = match ? JSON.parse(match[0]) : texts;
        
        console.log('Parsed translations:', translations);
        
        res.json({ translations });
    } catch (e) {
        console.error('To-Slovenian error:', e);
        res.json({ translations: texts }); // Return original if translation fails
    }
});

// Analyze video - extract frames and scene descriptions
app.post('/api/localizer/analyze', async (req, res) => {
    const { filename, mode } = req.body;
    if (!filename) return res.status(400).json({ error: 'Missing filename' });
    
    const videoPath = path.join(__dirname, 'uploads', filename);
    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video not found' });
    
    try {
        const jobId = `analyze-${Date.now()}`;
        const framesDir = path.join(__dirname, 'uploads', 'analysis', jobId);
        fs.mkdirSync(framesDir, { recursive: true });
        
        // Extract frames at 2 fps for better timing accuracy and catching brief text
        console.log(`[${jobId}] Extracting frames from ${filename}...`);
        // Extract at 2fps to catch text that appears briefly
        await execPromise(`${FFMPEG} -y -i "${videoPath}" -vf "fps=2" -t 30 -q:v 1 "${framesDir}/frame-%03d.jpg" 2>/dev/null`);
        
        const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
        console.log(`[${jobId}] Extracted ${frames.length} frames`);
        
        if (frames.length === 0) {
            fs.rmSync(framesDir, { recursive: true });
            return res.json({ segments: [], texts: [] });
        }
        
        // Analyze frames with GPT-4o Vision - MORE SEGMENTS for dynamic text
        const segments = [];
        const texts = [];
        let lastDescription = '';
        
        // Analyze EVERY frame for more granular segments
        // At 2 fps: frame 1 = 0s, frame 2 = 0.5s, frame 3 = 1s, etc.
        // Analyze every frame (at 1fps this is reasonable - ~30 frames max)
        for (let i = 0; i < frames.length; i += 1) {
            const framePath = path.join(framesDir, frames[i]);
            const base64 = fs.readFileSync(framePath).toString('base64');
            const frameNum = parseInt(frames[i].match(/\d+/)[0]);
            const timestamp = (frameNum - 1) * 0.5; // 2 fps = 0.5s per frame
            
            try {
                const response = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
                    body: JSON.stringify({
                        model: 'gpt-4o',
                        messages: [{ role: 'user', content: [
                            { type: 'text', text: `Find ALL text overlays/captions in this video frame. This includes:
- Text with colored background boxes (white, orange, etc.)
- Text overlays WITHOUT background (floating text, subtitles)
- Large bold text added in post-production
- Call-to-action text, slogans, marketing phrases

Return JSON:
{
  "texts": [
    {"text": "exact text", "x": 50, "y": 30}
  ]
}

RULES:
- x,y = position as % of image (0-100)
- Include text in ANY language (Greek, Croatian, Czech, Polish, Hungarian, Italian, etc.)
- Multi-line text that belongs together = combine into one: "Line1 Line2"
- IGNORE: brand logos printed ON physical products/clothing, size labels on garments, watermarks
- INCLUDE: any text that was ADDED to the video in post-production (editing)

If no added text overlay visible, return: {"texts": []}` },
                            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
                        ]}],
                        max_tokens: 500
                    })
                });
                
                const data = await response.json();
                const content = data.choices?.[0]?.message?.content || '{}';
                
                // DEBUG: Log raw response for first 3 frames and any frames with text
                if (i < 3 || content.includes('"text"')) {
                    console.log(`[${jobId}] Frame ${i} (${timestamp}s) RAW:`, content.substring(0, 300));
                }
                
                // DEBUG: Log every frame's texts for troubleshooting
                console.log(`[${jobId}] Frame ${i} (${timestamp}s):`, content.match(/"text":\s*"[^"]+"/g)?.join(', ') || 'no texts');
                
                const match = content.match(/\{[\s\S]*\}/);
                
                if (match) {
                    // Clean up common JSON issues
                    let jsonStr = match[0]
                        .replace(/[\u201C\u201D]/g, '"')
                        .replace(/[\u2018\u2019]/g, "'")
                        .replace(/,\s*}/g, '}')
                        .replace(/,\s*]/g, ']');
                    
                    let parsed;
                    try {
                        parsed = JSON.parse(jsonStr);
                    } catch (parseErr) {
                        console.error('Analyze JSON parse error:', parseErr.message, 'Content:', jsonStr.substring(0, 200));
                        continue; // Skip this frame
                    }
                    
                    // Extract texts with timing (0.5s precision at 2fps)
                    const frameInterval = 0.5; // seconds per frame at 2fps
                    
                    if (parsed.texts?.length) {
                        parsed.texts.forEach(t => {
                            if (!t) return;
                            
                            // Handle both new format {text, x, y} and old format (string)
                            const isObject = typeof t === 'object';
                            const textContent = isObject ? t.text : t;
                            // Strip emojis and clean up text
                            const normalizedText = (textContent || '')
                                .replace(/[\u{1F300}-\u{1F9FF}]/gu, '') // Remove emojis
                                .replace(/[\u{2600}-\u{26FF}]/gu, '') // Remove misc symbols
                                .replace(/[\u{2700}-\u{27BF}]/gu, '') // Remove dingbats
                                .replace(/[\u{FE00}-\u{FE0F}]/gu, '') // Remove variation selectors
                                .replace(/[\u{1F000}-\u{1F02F}]/gu, '') // Remove mahjong
                                .replace(/[\u{1F0A0}-\u{1F0FF}]/gu, '') // Remove playing cards
                                .trim();
                            if (!normalizedText) return;
                            
                            // Get position data
                            const xPos = isObject ? (t.x || 50) : 50;
                            const yPos = isObject ? (t.y || 50) : 50;
                            const posLabel = isObject ? (t.position || 'center') : (parsed.textPosition || 'center');
                            
                            // Helper to strip emojis and normalize for comparison
                            const stripForCompare = (str) => str
                                .replace(/[\u{1F300}-\u{1F9FF}]/gu, '') // Remove emojis
                                .replace(/[^\p{L}\p{N}\s]/gu, '') // Keep only letters, numbers, spaces
                                .replace(/\s+/g, ' ')
                                .trim()
                                .toLowerCase();
                            
                            const normalizedForCompare = stripForCompare(normalizedText);
                            
                            // Check if this text (or very similar) already exists and is still open
                            const existingText = texts.find(x => !x.closed && (
                                x.text === normalizedText || 
                                x.text.toLowerCase() === normalizedText.toLowerCase() ||
                                stripForCompare(x.text) === normalizedForCompare
                            ));
                            
                            if (existingText) {
                                // Only extend if text was detected in consecutive frames (no gap)
                                const gap = timestamp - existingText.end;
                                if (gap <= frameInterval) {
                                    // Extend the end time of existing text
                                    existingText.end = timestamp + frameInterval;
                                    // Update position if we have better data
                                    if (isObject && t.x !== undefined) {
                                        existingText.x = xPos;
                                        existingText.y = yPos;
                                    }
                                } else {
                                    // Gap too large - this is a new appearance, add as new text
                                    console.log(`[gap] "${normalizedText}" reappeared after ${gap}s gap, adding as new`);
                                    texts.push({ 
                                        text: normalizedText, 
                                        start: timestamp,
                                        end: timestamp + frameInterval,
                                        position: posLabel,
                                        x: xPos,
                                        y: yPos
                                    });
                                }
                            } else {
                                // New text - add with start time and position
                                texts.push({ 
                                    text: normalizedText, 
                                    start: timestamp,
                                    end: timestamp + frameInterval,
                                    position: posLabel,
                                    x: xPos,
                                    y: yPos
                                });
                            }
                        });
                    }
                    
                    // Mark texts that are no longer visible in this frame
                    // Use normalized comparison (strip emojis/symbols)
                    const stripForCompare2 = (str) => (str || '')
                        .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
                        .replace(/[^\p{L}\p{N}\s]/gu, '')
                        .replace(/\s+/g, ' ')
                        .trim()
                        .toLowerCase();
                    
                    const currentTextsNormalized = (parsed.texts || []).map(t => {
                        const txt = typeof t === 'object' ? t.text : t;
                        return stripForCompare2(txt);
                    });
                    texts.forEach(t => {
                        if (!t.closed) {
                            const textNorm = stripForCompare2(t.text);
                            // STRICT comparison - only exact match counts as "still visible"
                            // This prevents "Navadne boksarice" staying open when "NORIKS boksarice" appears
                            const stillVisible = currentTextsNormalized.some(ct => ct === textNorm);
                            if (!stillVisible && timestamp > t.start) {
                                // Text disappeared - close it at this timestamp
                                t.end = timestamp;
                                t.duration = t.end - t.start;
                                t.closed = true;
                                console.log(`[closing] "${t.text}" ended at ${timestamp}s (was ${t.start}s-${t.end}s)`);
                            }
                        }
                    });
                    
                    // Create segment if new scene OR if current segment is too long (max 2 seconds for dynamic feel)
                    const currentSegmentTooLong = segments.length > 0 && (timestamp - segments[segments.length - 1].start) >= 2;
                    
                    if (parsed.isNewScene || segments.length === 0 || currentSegmentTooLong) {
                        // Close previous segment
                        if (segments.length > 0) {
                            segments[segments.length - 1].end = timestamp;
                        }
                        
                        segments.push({
                            id: segments.length,
                            start: timestamp,
                            end: timestamp + frameInterval,
                            description: parsed.description || `Scene ${segments.length + 1}`,
                            emotion: parsed.emotion || 'neutral',
                            thumbnail: `/uploads/analysis/${jobId}/${frames[i]}`
                        });
                        
                        lastDescription = parsed.description || '';
                    } else {
                        // Extend current segment
                        if (segments.length > 0) {
                            segments[segments.length - 1].end = timestamp + frameInterval;
                        }
                    }
                }
            } catch (e) {
                console.error('Frame analysis error:', e.message);
            }
        }
        
        // Ensure last segment has proper end time (at 2fps, frame N = (N-1)*0.5 seconds)
        if (segments.length > 0 && frames.length > 0) {
            const lastFrame = parseInt(frames[frames.length - 1].match(/\d+/)[0]);
            const lastTimestamp = (lastFrame - 1) * 0.5 + 0.5; // End of last frame at 2fps
            segments[segments.length - 1].end = lastTimestamp;
        }
        
        // Close any still-open texts at the end
        texts.forEach(t => {
            if (!t.closed && frames.length > 0) {
                const lastFrame = parseInt(frames[frames.length - 1].match(/\d+/)[0]);
                t.end = (lastFrame - 1) * 0.5 + 0.5;
                t.duration = t.end - t.start;
            }
        });
        
        // Filter out brand names, size labels, and product text (not overlays)
        const BRAND_FILTER = ['noriks', 'nike', 'adidas', 'puma', 'under armour', 'calvin klein', 'tommy hilfiger', 'hugo boss', 'lacoste', 'ralph lauren', 'armani', 'diesel', 'levis', 'gap', 'zara', 'h&m', 'nano'];
        const SIZE_FILTER = ['xs', 's', 'm', 'l', 'xl', '2xl', '3xl', '4xl', '5xl', 'xxl', 'xxxl'];
        
        const filteredTexts = texts.filter(t => {
            const textLower = (t.text || '').toLowerCase().trim();
            // Remove if it's just a brand name
            if (BRAND_FILTER.some(brand => textLower === brand || textLower === brand.replace(' ', ''))) {
                return false;
            }
            // Remove size labels
            if (SIZE_FILTER.includes(textLower)) {
                return false;
            }
            // Remove brand + size combinations (e.g., "NORIKS 3XL", "NORIKS 2XL")
            if (/^noriks\s*\d*x*l$/i.test(textLower) || /^\d*x*l\s*noriks$/i.test(textLower)) {
                return false;
            }
            // Remove texts that are just brand names with sizes
            if (/^[a-z]+\s+(simple\s+)?(shirts|done|better)/i.test(textLower)) {
                return false; // "NORIKS Simple Shirts. Done Better"
            }
            // Remove very short texts (likely OCR errors or logos)
            if (textLower.length < 3) return false;
            // Remove if text spans almost entire video (likely logo on product)
            const duration = (t.end || 0) - (t.start || 0);
            const videoLength = frames.length * 0.5; // 2fps = 0.5s per frame
            if (duration > videoLength * 0.7) return false; // More than 70% of video = probably product logo
            return true;
        });
        
        console.log(`[${jobId}] Found ${segments.length} segments, ${texts.length} texts (${filteredTexts.length} after filtering)`);
        
        // POST-PROCESS: Merge overlapping/consecutive texts with same/similar content
        const mergedTexts = [];
        const normalizeForMerge = (str) => (str || '')
            .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
            .replace(/[^\p{L}\p{N}\s]/gu, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
        
        // Sort by start time
        filteredTexts.sort((a, b) => a.start - b.start);
        
        filteredTexts.forEach(t => {
            const tNorm = normalizeForMerge(t.text);
            // Find if there's an existing text with EXACTLY same content that overlaps or is consecutive
            const existing = mergedTexts.find(m => {
                const mNorm = normalizeForMerge(m.text);
                // STRICT: Only merge if texts are EXACTLY the same (normalized)
                if (mNorm !== tNorm) return false;
                
                // Check if overlapping OR consecutive (within 0.5s gap for 2fps)
                const overlaps = t.start <= m.end && t.end >= m.start;
                const gap = t.start - m.end;
                const isConsecutive = gap > 0 && gap <= 0.5;
                
                return overlaps || isConsecutive;
            });
            
            if (existing) {
                // Merge: extend time range to cover both
                existing.start = Math.min(existing.start, t.start);
                existing.end = Math.max(existing.end, t.end);
            } else {
                // Add new text
                mergedTexts.push({ ...t });
            }
        });
        
        console.log(`[${jobId}] After merging duplicates: ${mergedTexts.length} texts`);
        
        // DEBUG: Log each text with timing
        mergedTexts.forEach((t, i) => {
            console.log(`[${jobId}] Final text ${i}: "${t.text}" ${t.start}s-${t.end}s`);
        });
        
        // Use merged texts - return ORIGINAL language (no auto-translation)
        // User will click "Prevedi v SLO" button to translate separately
        const finalTexts = mergedTexts;
        
        console.log(`[${jobId}] ✅ Returning ${finalTexts.length} texts in original language`);
        
        res.json({ segments, texts: finalTexts, framesDir: jobId });
        
    } catch (e) {
        console.error('Analysis error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Generate 3 text variants per segment - MARKETING FOCUSED
app.post('/api/localizer/variants', async (req, res) => {
    const { segments, existingTexts, product, targetAudience } = req.body;
    if (!segments?.length) return res.status(400).json({ error: 'No segments provided' });
    
    // Detect product from video content
    const detectedProduct = product || 'tshirt'; // Default to tshirt
    
    // Product benefits database
    const productBenefits = {
        tshirt: [
            'Ne dviguje se nikoli',
            'Daljši kroj za popolno prileganje',
            'Velikosti do 4XL',
            'Na voljo v več barvah',
            'Premium udoben material',
            'Ostane na mestu tudi pri gibanju'
        ],
        boxers: [
            'Ne vrezujejo se',
            'Ne smrdijo cel dan',
            'Udobne od jutra do večera',
            'Premium material',
            'Popolnoma prileganje',
            'Brez neprijetnega dvigovanja'
        ]
    };
    
    // Hook templates by type
    const hookTemplates = {
        problem: [
            'Poznaš ta problem?',
            'Se ti tudi to dogaja?',
            'Zakaj vedno isto?',
            'A ti je tudi tega dovolj?',
            'Ta občutek poznaš...'
        ],
        solution: [
            'Končno rešitev!',
            'NORIKS to reši',
            'Obstaja boljši način',
            'Poglej razliko',
            'To je tisto kar rabiš'
        ],
        benefit: [
            'Udobje celo dan',
            'Samozavest v vsaki situaciji',
            'Brez skrbi',
            'Končno mir',
            'Občutek svobode'
        ],
        cta: [
            'Naroči zdaj',
            'Poglej več',
            'Link v opisu',
            'Klikni spodaj',
            'Ne zamudi'
        ]
    };
    
    try {
        const segmentDescriptions = segments.map((s, i) => 
            `${i+1}. [${s.start}s-${s.end}s] ${s.description} (emotion: ${s.emotion})`
        ).join('\n');
        
        const existingTextsList = existingTexts?.length 
            ? `\n\nOriginal texts from competitor video (ADAPT, don't copy!):\n${existingTexts.map(t => `- "${t.text}" at ${t.timestamp}s`).join('\n')}`
            : '';
        
        const benefits = productBenefits[detectedProduct] || productBenefits.tshirt;
        
        const numSegments = segments.length;
        
        // Determine story position for each segment
        const storyPositions = segments.map((seg, i) => {
            const position = i / (numSegments - 1 || 1);
            if (i === 0) return 'HOOK';
            if (i === numSegments - 1) return 'CTA';
            if (position < 0.3) return 'PROBLEM';
            if (position < 0.6) return 'REŠITEV';
            return 'BENEFIT';
        });
        
        const segmentDetails = segments.map((s, i) => 
            `Kader ${i+1} [${s.start}s-${s.end}s] - VLOGA: ${storyPositions[i]}
   Vizualno: ${s.description}
   Emocija: ${s.emotion}`
        ).join('\n\n');
        
        const prompt = `Si copywriter za NORIKS ${detectedProduct === 'tshirt' ? 'majice' : 'bokserice'}.

VIDEO ANALIZA - za vsak kader veš KAJ se dogaja in KAKŠNO VLOGO ima v zgodbi:

${segmentDetails}

PREDNOSTI PRODUKTA:
${benefits.map(b => `• ${b}`).join('\n')}

TVOJA NALOGA:
Za vsak kader napiši 3 ODLIČNE variante besedila.
Vsaka varianta mora:
1. UJEMATI vizualno vsebino (kar se vidi na kadru)
2. USTREZATI vlogi v zgodbi (HOOK/PROBLEM/REŠITEV/BENEFIT/CTA)
3. BITI kratka (max 5 besed) in prodajna

3 VARIANTE za vsak kader:
- A: Direkten pristop
- B: Vprašanje/dialog
- C: Čustveni pristop

PRIMERI po vlogah:
- HOOK: "Poznaš ta problem?" / "Ti je tega dovolj?" / "Poglej to..."
- PROBLEM: "Majica se dvigne..." / "Vedno ista zgodba" / "Trebuh na vidiku"
- REŠITEV: "NORIKS ostane na mestu" / "Končno rešitev" / "S NORIKS je drugače"
- BENEFIT: "Udobje cel dan" / "Velikosti do 4XL" / "Brez skrbi"
- CTA: "Naroči zdaj" / "Link v opisu" / "Klikni spodaj"

Vrni JSON array:
[{"segmentId": 0, "variants": {"A": "...", "B": "...", "C": "..."}}, ...]`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: 'Si expert copywriter za performance marketing. Pišeš kratke, udarne tekste ki prodajajo. Vedno odgovoriš SAMO z JSON formatom.' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 8000,
                temperature: 0.8
            })
        });
        
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '[]';
        const match = content.match(/\[[\s\S]*\]/);
        
        if (match) {
            const variants = JSON.parse(match[0]);
            
            // Merge variants into segments
            const result = segments.map((seg, i) => ({
                ...seg,
                variants: variants.find(v => v.segmentId === i)?.variants || {
                    A: hookTemplates.problem[i % hookTemplates.problem.length],
                    B: hookTemplates.solution[i % hookTemplates.solution.length],
                    C: hookTemplates.benefit[i % hookTemplates.benefit.length]
                }
            }));
            
            // Log generated variants
            console.log('=== GENERATED VARIANTS ===');
            result.forEach((seg, i) => {
                console.log(`Kader ${i+1} [${seg.start}s-${seg.end}s]: ${seg.description}`);
                console.log(`  A: ${seg.variants.A}`);
                console.log(`  B: ${seg.variants.B}`);
                console.log(`  C: ${seg.variants.C}`);
            });
            console.log('=== END VARIANTS ===');
            
            res.json({ segments: result });
        } else {
            res.status(500).json({ error: 'Failed to parse variants' });
        }
        
    } catch (e) {
        console.error('Variants error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ASS style definitions - Format: Name,Font,Size,Primary,Secondary,Outline,Back,Bold,Italic,Under,Strike,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Align,MarginL,R,V,Encoding
// BorderStyle: 1=outline+shadow, 3=opaque box
// Colors: &HAABBGGRR (hex, BGR order!)
// ============ PNG TEXT OVERLAY HELPERS ============
// Style configs for PNG generation: bgColor, textColor, cornerRadius multiplier
const pngStyleConfigs = {
    white:     { bg: 'white',              text: 'black', radius: 0.15 },
    black:     { bg: 'black',              text: 'white', radius: 0.15 },
    rounded:   { bg: 'white',              text: 'black', radius: 0.45 },
    shadow:    { bg: 'rgba(0,0,0,0.7)',    text: 'white', radius: 0.15 },
    gradient:  { bg: '#10b981',            text: 'white', radius: 0.15 },
    outline:   { bg: 'rgba(0,0,0,0.3)',    text: 'white', radius: 0.15, border: 'white' },
    red:       { bg: '#ef4444',            text: 'white', radius: 0.15 },
    orange:    { bg: '#f97316',            text: 'white', radius: 0.15 },
    yellow:    { bg: '#eab308',            text: 'black', radius: 0.15 },
    fire:      { bg: '#ff6600',            text: 'white', radius: 0.15 },
    neon:      { bg: 'black',              text: '#00ffff', radius: 0.15 },
    explosive: { bg: '#7c3aed',            text: 'white', radius: 0.15 },
    green:     { bg: '#22c55e',            text: 'white', radius: 0.15 },
    pulse:     { bg: '#10b981',            text: 'white', radius: 0.15 },
    urgent:    { bg: '#dc2626',            text: 'white', radius: 0.15 },
    gold:      { bg: '#fbbf24',            text: 'black', radius: 0.15 },
};

// Generates PNG images with box backgrounds using ImageMagick for ALL styles
async function generateTextOverlayPngs(texts, fontSize, outputDir, videoWidth = 1080, videoHeight = 1920) {
    const pngs = [];
    // Scale fontSize to match ASS rendering (ASS fontSize on PlayResY=1920 ≈ 65% of ImageMagick pointsize)
    const scaledFontSize = Math.round(fontSize * 0.65);
    const paddingX = Math.round(scaledFontSize * 0.6);
    const paddingY = Math.round(scaledFontSize * 0.35);
    
    for (let i = 0; i < texts.length; i++) {
        const t = texts[i];
        const styleName = t._resolvedStyle || t.style || 'white';
        const cfg = pngStyleConfigs[styleName] || pngStyleConfigs.white;
        const cornerRadius = Math.round(scaledFontSize * cfg.radius);
        
        // Escape text for shell
        const text = t.text.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/"/g, '\\\\"').replace(/`/g, '\\`');
        const pngPath = path.join(outputDir, `text-${i}.png`);
        
        // Max width: video width minus margins
        const maxTextWidth = videoWidth - paddingX * 2 - 40; // 40px safety margin
        
        // Step 1: Measure text with word wrap using caption: (auto-wraps to fit width)
        // First measure single line to check if wrapping needed
        const measureCmd = `convert -font "/usr/share/fonts/google-noto-vf/NotoSans[wght].ttf" -weight 700 -pointsize ${scaledFontSize} -gravity center label:"${text}" -format "%wx%h" info:`;
        let singleW = 9999, singleH = scaledFontSize;
        try {
            const { stdout } = await execPromise(measureCmd);
            const parts = stdout.trim().split('x');
            singleW = parseInt(parts[0]);
            singleH = parseInt(parts[1]);
        } catch (e) {}
        
        let imgW, imgH;
        let useCaption = singleW > maxTextWidth;
        
        if (useCaption) {
            // Text too wide - use caption: with fixed width for word wrapping
            const captionW = maxTextWidth;
            const measureWrapCmd = `convert -font "/usr/share/fonts/google-noto-vf/NotoSans[wght].ttf" -weight 700 -pointsize ${scaledFontSize} -size ${captionW}x -gravity center caption:"${text}" -format "%wx%h" info:`;
            try {
                const { stdout } = await execPromise(measureWrapCmd);
                const parts = stdout.trim().split('x');
                imgW = Math.round(parseInt(parts[0]) + paddingX * 2);
                imgH = Math.round(parseInt(parts[1]) + paddingY * 2);
            } catch (e) {
                imgW = captionW + paddingX * 2;
                imgH = Math.round(scaledFontSize * 2.6 + paddingY * 2);
            }
        } else {
            imgW = Math.round(singleW + paddingX * 2);
            imgH = Math.round(singleH + paddingY * 2);
        }
        
        // Step 2: Generate PNG with background rect + text
        let drawBg = `-fill "${cfg.bg}" -draw "roundrectangle 0,0 ${imgW-1},${imgH-1} ${cornerRadius},${cornerRadius}"`;
        if (cfg.border) {
            drawBg += ` -stroke "${cfg.border}" -strokewidth 3 -fill none -draw "roundrectangle 0,0 ${imgW-1},${imgH-1} ${cornerRadius},${cornerRadius}"`;
        }
        
        // Use caption: for wrapped text, label: for single line
        const textOp = useCaption 
            ? `-size ${imgW - paddingX * 2}x -gravity center caption:"${text}"`
            : `-gravity center -annotate +0+0 "${text}"`;
        
        const cmd = useCaption
            ? `convert \\( -size ${imgW}x${imgH} xc:"rgba(0,0,0,0)" ${drawBg} \\) \\( -font "/usr/share/fonts/google-noto-vf/NotoSans[wght].ttf" -weight 700 -pointsize ${scaledFontSize} -fill "${cfg.text}" -background none -size ${imgW - paddingX * 2}x -gravity center caption:"${text}" \\) -gravity center -composite PNG32:"${pngPath}"`
            : `convert -size ${imgW}x${imgH} xc:"rgba(0,0,0,0)" ${drawBg} -stroke none -fill "${cfg.text}" -font "/usr/share/fonts/google-noto-vf/NotoSans[wght].ttf" -weight 700 -pointsize ${scaledFontSize} -gravity center -annotate +0+0 "${text}" PNG32:"${pngPath}"`;
        await execPromise(cmd);
        
        // Calculate position (centered horizontally)
        const x = Math.round((videoWidth - imgW) / 2);
        const y = t._posY || Math.round(videoHeight / 2 - imgH / 2);
        
        pngs.push({ index: i, path: pngPath, x, y, w: imgW, h: imgH, start: t.start, end: t.end });
    }
    
    return pngs;
}

// ASS styles - Using BorderStyle=1 with large outline for continuous multi-line boxes
// Format: Name,Font,Size,Primary,Secondary,Outline,Back,Bold,Italic,Under,Strike,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Align,MarginL,R,V,Encoding
// ASS Styles with BorderStyle=3 (opaque box) for clean rectangular background
// Format: Name,Fontname,Fontsize,Primary,Secondary,Outline,Back,Bold,Italic,Underline,Strike,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Align,MarginL,MarginR,MarginV,Encoding
// BorderStyle=3 = opaque box, OutlineColour = box color, BackColour = box shadow
const assStyles = {
    // White box, black text (classic) - BorderStyle=3 for opaque box
    white: 'Style: Default,Noto Sans,72,&H00000000,&H000000FF,&H00FFFFFF,&H00FFFFFF,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Black box, white text  
    black: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // No box, just shadow
    shadow: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,0,5,5,50,50,200,1',
    // Smaller padding (looks rounder)
    rounded: 'Style: Default,Noto Sans,72,&H00000000,&H000000FF,&H00FFFFFF,&H00FFFFFF,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Green box (NORIKS brand)
    gradient: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H0081B910,&H0081B910,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // White outline, no fill
    outline: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,5,0,5,50,50,200,1',
    // === EXPLOSIVE STYLES FOR HOOK/CTA ===
    // Red box (#ef4444 = BGR: 4444EF)
    red: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H004444EF,&H004444EF,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Orange box (#f97316 = BGR: 1673F9)
    orange: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H001673F9,&H001673F9,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Yellow box (#eab308 = BGR: 08B3EA)
    yellow: 'Style: Default,Noto Sans,72,&H00000000,&H000000FF,&H0008B3EA,&H0008B3EA,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Fire - red/orange gradient effect (using red as base)
    fire: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H000066FF,&H000066FF,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Neon cyan on black (#0ff = BGR: FFFF00)
    neon: 'Style: Default,Noto Sans,72,&H00FFFF00,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Explosive - purple/red (#dc2626 = BGR: 2626DC, #7c3aed)
    explosive: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H00ED3A7C,&H00ED3A7C,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Green box (#22c55e = BGR: 5EC522)
    green: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H005EC522,&H005EC522,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Pulse - green gradient
    pulse: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H0081B910,&H0081B910,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Urgent - red with gold border (#dc2626 red, #fbbf24 gold)
    urgent: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H002626DC,&H002626DC,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Gold (#fbbf24 = BGR: 24BFFB)
    gold: 'Style: Default,Noto Sans,72,&H00000000,&H000000FF,&H0024BFFB,&H0024BFFB,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1'
};

// Generate Slovenian preview video
app.post('/api/localizer/preview', async (req, res) => {
    console.log('Preview request received:', req.body);
    const { videoClean, name, texts, language, style, fontSize = 72, hookStyle, ctaStyle } = req.body;
    if (!videoClean || !texts?.length) {
        console.log('Preview missing data:', { videoClean, textsLength: texts?.length });
        return res.status(400).json({ error: 'Missing data' });
    }
    
    const videoPath = path.join(__dirname, 'uploads', videoClean);
    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video not found' });
    
    try {
        const jobId = `preview-${Date.now()}`;
        const outputDir = path.join(__dirname, 'uploads', 'previews', jobId);
        fs.mkdirSync(outputDir, { recursive: true });
        
        console.log('Preview using style:', style, 'fontSize:', fontSize, 'hookStyle:', hookStyle, 'ctaStyle:', ctaStyle);
        console.log('[Preview] Per-text styles:', texts.map((t, i) => `[${i}] "${t.text?.substring(0,20)}" style=${t.style}`).join(', '));
        
        const baseStyle = assStyles[style] || assStyles.white;
        const defaultStyle = baseStyle.replace(/,Noto Sans,\d+,/, `,Noto Sans,${fontSize},`);
        
        // Create per-text styles
        const perTextStyleLines = [];
        const usedStyles = new Set();
        texts.forEach((t, i) => {
            const s = t.style || style;
            if (s !== style && !usedStyles.has(s)) {
                usedStyles.add(s);
                const base = assStyles[s] || assStyles.white;
                perTextStyleLines.push(base.replace('Style: Default,', `Style: S_${s},`).replace(/,Noto Sans,\d+,/, `,Noto Sans,${fontSize},`));
            }
        });
        
        // Hook/CTA styles
        if (hookStyle && !usedStyles.has(hookStyle)) {
            const base = assStyles[hookStyle] || assStyles.white;
            perTextStyleLines.push(base.replace('Style: Default,', 'Style: Hook,').replace(/,Noto Sans,\d+,/, `,Noto Sans,${fontSize},`));
        }
        if (ctaStyle && !usedStyles.has(ctaStyle)) {
            const base = assStyles[ctaStyle] || assStyles.white;
            perTextStyleLines.push(base.replace('Style: Default,', 'Style: CTA,').replace(/,Noto Sans,\d+,/, `,Noto Sans,${fontSize},`));
        }
        
        let ass = `[Script Info]
Title: ${name} Preview
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${defaultStyle}
${perTextStyleLines.join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
        
        // Separate rounded texts (PNG overlay) from others (ASS)
        const roundedTextIndices = [];
        texts.forEach((t, i) => {
            const resolvedStyle = t.style || style;
            if (resolvedStyle === 'rounded') {
                roundedTextIndices.push(i);
                return; // skip ASS for rounded
            }
            const start = formatAssTime(t.start);
            const end = formatAssTime(t.end);
            let styleName = (resolvedStyle !== style) ? `S_${resolvedStyle}` : 'Default';
            
            let pos = '\\an5\\pos(540,960)';
            if (t.position === 'center-top') pos = '\\an5\\pos(540,880)';
            else if (t.position === 'center-bottom') pos = '\\an5\\pos(540,1000)';
            else if (t.position === 'top') pos = '\\an8';
            else if (t.position === 'bottom') pos = '\\an2';
            
            ass += `Dialogue: 0,${start},${end},${styleName},,0,0,0,,{${pos}\\fad(200,200)}${t.text}\n`;
        });
        
        const assPath = path.join(outputDir, 'preview.ass');
        fs.writeFileSync(assPath, ass);
        
        // Generate PNG overlays for rounded texts
        const roundedOverlayTexts = roundedTextIndices.map(i => ({
            ...texts[i],
            _resolvedStyle: 'rounded',
            _posY: texts[i].position === 'center-top' ? 820 : texts[i].position === 'center-bottom' ? 1000 : 900
        }));
        const pngOverlays = await generateTextOverlayPngs(roundedOverlayTexts, fontSize, outputDir);
        
        const outputVideo = path.join(outputDir, `${name}-preview.mp4`);
        
        if (pngOverlays.length > 0) {
            // Combine ASS + PNG overlays
            const pngInputs = pngOverlays.map(p => `-i "${p.path}"`).join(' ');
            let fc = `[0:v]ass='${assPath}':fontsdir=/usr/share/fonts[assout]`;
            let lastLabel = '[assout]';
            pngOverlays.forEach((p, idx) => {
                const isLast = idx === pngOverlays.length - 1;
                const outLabel = isLast ? '[vout]' : `[ov${idx}]`;
                fc += `;${lastLabel}[${idx + 1}:v]overlay=${p.x}:${p.y}:enable='between(t\\,${p.start}\\,${p.end})'${outLabel}`;
                lastLabel = outLabel;
            });
            await execPromise(`${FFMPEG} -y -i "${videoPath}" ${pngInputs} -filter_complex "${fc}" -map "[vout]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a copy "${outputVideo}" 2>&1`);
        } else {
            await execPromise(`${FFMPEG} -y -i "${videoPath}" -vf "ass='${assPath}':fontsdir=/usr/share/fonts" -c:v libx264 -preset fast -crf 23 -c:a copy "${outputVideo}" 2>/dev/null`);
        }
        
        res.json({ 
            success: true, 
            videoUrl: `/uploads/previews/${jobId}/${name}-preview.mp4` 
        });
        
    } catch (e) {
        console.error('Preview error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Generate all 7 country videos
app.post('/api/localizer/generate', async (req, res) => {
    console.log('Generate request:', JSON.stringify(req.body, null, 2));
    const { videoClean, name, texts, style, fontSize = 72, namingParts, hookStyle, ctaStyle, perTextStyles, countries, source, uppercase, mode, voiceoverScript, videoDuration } = req.body;
    if (!videoClean || (!texts?.length && !voiceoverScript?.length)) {
        console.log('Generate 400: videoClean=', videoClean, 'texts=', texts);
        return res.status(400).json({ error: 'Missing data: videoClean=' + !!videoClean + ' texts=' + (texts?.length || 0) });
        return res.status(400).json({ error: 'Missing data: videoClean=' + !!videoClean + ' texts=' + (texts?.length || 0) });
    }
    if (perTextStyles) {
        console.log('[Generate] Per-text styles:', texts.map(t => `"${t.text?.substring(0,20)}" → style:${t.style}`).join(', '));
    }
    
    const videoPath = path.join(__dirname, 'uploads', videoClean);
    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video not found' });
    
    // Validate and default countries
    const ALL_COUNTRIES = ['SI', 'HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK', 'BG', 'RO', 'DE'];
    const selectedCountries = (countries && Array.isArray(countries) && countries.length > 0) 
        ? countries.filter(c => ALL_COUNTRIES.includes(c))
        : ALL_COUNTRIES;
    
    // Get video duration for voiceover mode
    let actualVideoDuration = videoDuration;
    if (mode === 'voiceover' && !actualVideoDuration) {
        try {
            const durResult = await execPromise(`${FFMPEG} -i "${videoPath}" 2>&1 | grep Duration | awk '{print $2}' | tr -d ','`);
            const parts = durResult.stdout.trim().split(':');
            actualVideoDuration = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
        } catch(e) { actualVideoDuration = 30; }
    }
    const jobId = `gen-${Date.now()}`;
    const job = {
        id: jobId,
        name,
        namingParts, // { id, date, product, type, author }
        videoClean,
        texts,
        style: style || 'white',
        fontSize: fontSize || 72,
        hookStyle: hookStyle || null, // Style for hook_problem texts
        ctaStyle: ctaStyle || null,   // Style for cta texts
        perTextStyles: perTextStyles || false, // Enable per-text style overrides
        uppercase: uppercase || false, // All caps mode
        countries: selectedCountries, // Selected countries to generate
        source: source || 'library',
        mode: mode || 'subtitles',
        voiceoverScript: voiceoverScript || null,
        videoDuration: actualVideoDuration || videoDuration || null,
        status: 'translating',
        completed: 0,
        currentLang: '',
        outputs: {},
        created: new Date().toISOString()
    };
    
    localizerJobs.set(jobId, job);
    persistJobs();
    
    // Start async generation
    const generator = (mode === 'voiceover') ? generateVoiceoverCountries : generateAllCountries;
    generator(job, videoPath).catch(e => {
        job.status = 'error';
        job.error = e.message;
        persistJobs();
        console.error(`[${jobId}] Error:`, e);
    });
    
    res.json({ jobId, status: 'started' });
});

// Quality Check Function - verifies texts and translation quality
async function qualityCheckVideo(videoPath, originalTexts, translations, langCode, langName, jobId) {
    const issues = [];
    const checks = [];
    
    try {
        // Extract frames at text timestamps for visual check
        const qcDir = path.join(path.dirname(videoPath), `qc-${langCode}`);
        fs.mkdirSync(qcDir, { recursive: true });
        
        // Get texts for this language
        const textsToCheck = originalTexts.map((t, i) => ({
            original: t.text,
            translated: translations[i]?.[langCode] || t.text,
            timestamp: t.start
        }));
        
        // Extract one frame per text (first 3 only for speed)
        for (let i = 0; i < textsToCheck.length; i++) {
            const t = textsToCheck[i];
            const framePath = path.join(qcDir, `frame-${i}.jpg`);
            await execPromise(`${FFMPEG} -y -ss ${t.timestamp + 0.5} -i "${videoPath}" -frames:v 1 -q:v 2 "${framePath}" 2>/dev/null`);
        }
        
        // Use GPT-4o to verify translation quality (batch check)
        const translatedTexts = textsToCheck.map(t => t.translated);
        
        const qcResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [{
                    role: 'system',
                    content: `You are a NATIVE ${langName} speaker reviewing marketing translations.
Your job is to check if texts sound NATURAL to a native speaker.

Rate each text:
- ✅ GOOD = sounds natural, a native would say it this way
- ⚠️ AWKWARD = understandable but sounds foreign/robotic
- ❌ BAD = confusing, wrong grammar, or doesn't make sense

Be STRICT - if a native speaker would find it odd, mark it as AWKWARD or BAD.`
                }, {
                    role: 'user',
                    content: `Review these ${langName} marketing texts for NORIKS men's clothing:

${translatedTexts.map((t, i) => `${i + 1}. "${t}"`).join('\n')}

Return JSON array with verdicts:
[
  {"text": "...", "verdict": "GOOD|AWKWARD|BAD", "suggestion": "better version if not GOOD", "reason": "brief explanation"}
]`
                }],
                max_tokens: 1000
            })
        });
        
        const qcData = await qcResponse.json();
        const qcContent = qcData.choices?.[0]?.message?.content || '[]';
        
        const qcMatch = qcContent.match(/\[[\s\S]*\]/);
        if (qcMatch) {
            try {
                const verdicts = JSON.parse(qcMatch[0]);
                verdicts.forEach((v, i) => {
                    checks.push({
                        text: translatedTexts[i],
                        verdict: v.verdict,
                        suggestion: v.suggestion,
                        reason: v.reason
                    });
                    
                    if (v.verdict !== 'GOOD') {
                        issues.push({
                            type: 'translation',
                            text: translatedTexts[i],
                            verdict: v.verdict,
                            suggestion: v.suggestion,
                            reason: v.reason
                        });
                    }
                });
            } catch (e) {
                console.error(`[${jobId}] QC JSON parse error:`, e.message);
            }
        }
        
        // Cleanup QC frames
        fs.rmSync(qcDir, { recursive: true, force: true });
        
    } catch (e) {
        console.error(`[${jobId}] QC error:`, e.message);
        issues.push({ type: 'error', message: e.message });
    }
    
    return { 
        lang: langCode, 
        langName,
        issues, 
        checks,
        passed: issues.length === 0 
    };
}

async function generateAllCountries(job, videoPath) {
    // Use job.countries if specified, otherwise default to all
    const LANGUAGES = job.countries || ['SI', 'HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK', 'BG', 'RO', 'DE'];
    const LANG_NAMES = {
        SI: 'Slovenian', HR: 'Croatian', CZ: 'Czech', PL: 'Polish', BG: 'Bulgarian', RO: 'Romanian', 
        GR: 'Greek', IT: 'Italian', HU: 'Hungarian', SK: 'Slovak', DE: 'German'
    };
    
    const outputDir = path.join(__dirname, 'uploads', 'generated', job.id);
    fs.mkdirSync(outputDir, { recursive: true });
    
    // Step 1: Translate all texts
    console.log(`[${job.id}] Translating texts to ${LANGUAGES.length} languages: ${LANGUAGES.join(', ')}...`);
    
    // Build language list for translation prompt
    const langList = LANGUAGES.map(l => LANG_NAMES[l]).join(', ');
    const jsonFormat = LANGUAGES.map(l => `"${l}":"..."`).join(',');
    
    const textsToTranslate = job.texts.map(t => t.text);
    const transResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{
                role: 'system',
                content: `You are a professional marketing translator with NATIVE-SPEAKER fluency in ${langList}.

CRITICAL RULES:
1. Translate for NATURAL speech, NOT literal word-for-word
2. Use colloquial, everyday language that locals actually speak
3. Match the casual, punchy marketing tone
4. Keep texts SHORT and IMPACTFUL (max 5 words ideally)
5. Brand name "NORIKS" stays unchanged
6. Adapt idioms/expressions to what natives would say
8. EACH translation must sound like a NATIVE SPEAKER wrote it - NOT like a translation
9. If unsure, use the SIMPLEST everyday expression
10. Test: would a local person on the street say it exactly like this? If not, rephrase.
7. Target: men buying for themselves OR women buying gifts for partners

Product: NORIKS premium men's clothing (t-shirts, boxers) - emphasize comfort, quality, fit.
CRITICAL: T-shirt = casual round-neck shirt. CORRECT translations: HR=majica, CZ=tričko, PL=koszulka, IT=maglietta, HU=póló, SK=tričko, BG=тениска, RO=tricou. NEVER use dress shirt words (košulja/košile/koszula/camicia/ing/košeľa/риза/cămașă).
CRITICAL LANGUAGE WARNING: SK = SLOVAK (slovenčina/slovenský jazyk, spoken in SLOVAKIA). The source texts below are in SLOVENIAN (slovenščina, spoken in Slovenia). These are DIFFERENT languages! You must translate INTO Slovak for SK. Do NOT copy the Slovenian source as the Slovak translation.`
            }, {
                role: 'user',
                content: `Translate these Slovenian marketing texts. Make them sound like a NATIVE SPEAKER wrote them:

${textsToTranslate.map((t, i) => `${i+1}. "${t}"`).join('\n')}

Return ONLY valid JSON array:
[{${jsonFormat}}, ...]`
            }],
            max_tokens: 8000
        })
    });
    
    const transData = await transResponse.json();
    let transContent = transData.choices?.[0]?.message?.content || '[]';
    // Strip markdown code fences if present
    transContent = transContent.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
    console.log(`[${job.id}] Raw translation response:`, transContent.substring(0, 500));
    
    const transMatch = transContent.match(/\[[\s\S]*\]/);
    let translations = [];
    try {
        translations = transMatch ? JSON.parse(transMatch[0]) : [];
    } catch (e) {
        console.error(`[${job.id}] Failed to parse translations:`, e.message);
    }
    
    console.log(`[${job.id}] Parsed ${translations.length} translation objects`);
    if (translations.length > 0) {
        console.log(`[${job.id}] First translation object:`, JSON.stringify(translations[0]));
    }
    
    // Check if cancelled during translation
    if (job.cancelled) {
        console.log(`[${job.id}] Job cancelled during translation`);
        job.status = 'cancelled';
        persistJobs();
        return;
    }
    
    console.log(`[${job.id}] Translations ready. Generating videos...`);
    
    // DEBUG: Log all texts with their timing
    console.log(`[${job.id}] Input texts (${job.texts.length}):`);
    job.texts.forEach((t, i) => {
        console.log(`[${job.id}]   ${i}: "${t.text}" @ ${t.start}s-${t.end}s pos(${t.x},${t.y})`);
    });
    
    job.status = 'generating';
    
    // Step 2: Generate video for each language
    for (let langIdx = 0; langIdx < LANGUAGES.length; langIdx++) {
        // Check if job was cancelled
        if (job.cancelled) {
            console.log(`[${job.id}] Job cancelled, stopping generation`);
            job.status = 'cancelled';
            job.currentLang = '';
            persistJobs();
            return;
        }
        
        const lang = LANGUAGES[langIdx];
        job.currentLang = lang;
        
        console.log(`[${job.id}] Generating ${lang}...`);
        
        // Get styles with custom font size
        const baseStyle = assStyles[job.style] || assStyles.white;
        const defaultStyle = baseStyle.replace(/,Noto Sans,\d+,/, `,Noto Sans,${job.fontSize || 72},`);
        
        // Create Hook and CTA styles if specified
        let hookStyleLine = '';
        let ctaStyleLine = '';
        
        if (job.hookStyle) {
            const hookBase = assStyles[job.hookStyle] || assStyles.white;
            hookStyleLine = hookBase
                .replace('Style: Default,', 'Style: Hook,')
                .replace(/,Noto Sans,\d+,/, `,Noto Sans,${job.fontSize || 72},`);
        }
        
        if (job.ctaStyle) {
            const ctaBase = assStyles[job.ctaStyle] || assStyles.white;
            ctaStyleLine = ctaBase
                .replace('Style: Default,', 'Style: CTA,')
                .replace(/,Noto Sans,\d+,/, `,Noto Sans,${job.fontSize || 72},`);
        }
        
        // Build styles - if perTextStyles, create style for each unique style used
        let additionalStyles = '';
        const usedStyles = new Set();
        
        if (job.perTextStyles) {
            job.texts.forEach(t => {
                if (t.style && t.style !== (job.style || 'white')) {
                    usedStyles.add(t.style);
                }
            });
            
            usedStyles.forEach(styleName => {
                const styleBase = assStyles[styleName] || assStyles.white;
                const styleFormatted = styleBase
                    .replace('Style: Default,', `Style: ${styleName},`)
                    .replace(/,Noto Sans,\d+,/, `,Noto Sans,${job.fontSize || 72},`);
                additionalStyles += styleFormatted + '\n';
            });
        }
        
        // Create ASS file
        let ass = `[Script Info]
Title: ${job.name} ${lang}
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${defaultStyle}
${hookStyleLine}
${ctaStyleLine}
${additionalStyles}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
        
        // NATIVE SPEAKER PROOFREAD - fix awkward translations before rendering
        try {
            const textsForLang = job.texts.map((t, idx) => translations[idx]?.[lang] || t.text);
            const proofResponse = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": "Bearer " + OPENAI_API_KEY },
                body: JSON.stringify({ model: "gpt-4o-mini", messages: [{
                    role: "system", content: "You are a NATIVE " + LANG_NAMES[lang] + " speaker. Review these marketing texts. Fix any that sound unnatural, have wrong grammar, or would confuse a native speaker. T-shirt = casual round-neck (majica/tričko/koszulka/maglietta/póló/тениска/tricou), NEVER dress shirt. IMPORTANT: If language is Slovak (slovenčina/slovenský jazyk, SLOVAKIA), make sure texts are in SLOVAK, not Slovenian (slovenščina, Slovenia) - these are different languages! Return ONLY a JSON array of corrected texts in the same order. If a text is fine, keep it unchanged."
                }, { role: "user", content: JSON.stringify(textsForLang) }], max_tokens: 1500 })
            });
            const proofData = await proofResponse.json();
            const proofContent = proofData.choices?.[0]?.message?.content || "[]";
            const proofMatch = proofContent.match(/\[([\s\S]*?)\]/);
            if (proofMatch) {
                const fixed = JSON.parse("[" + proofMatch[1] + "]");
                fixed.forEach((f, idx) => { if (f && translations[idx]) translations[idx][lang] = f; });
                console.log("[" + job.id + "] Proofread " + lang + ": " + fixed.length + " texts checked");
            }
        } catch(pe) { console.error("[" + job.id + "] Proofread error " + lang + ":", pe.message); }
        const roundedTextIndicesGen = [];
        job.texts.forEach((t, i) => {
            const translatedText = translations[i]?.[lang];
            let text = translatedText || t.text;
            if (job.uppercase) text = text.toUpperCase();
            
            if (i === 0) {
                console.log(`[${job.id}] Text 0 for ${lang}: translated="${translatedText}" original="${t.text}" using="${text}"`);
            }
            const start = formatAssTime(t.start);
            const end = formatAssTime(t.end);
            
            // Resolve style
            const resolvedStyle = (job.perTextStyles && t.style) ? t.style : (job.style || 'white');
            
            // Skip rounded - will be PNG overlay
            if (resolvedStyle === 'rounded') {
                roundedTextIndicesGen.push({ idx: i, text, start: t.start, end: t.end, y: t.y, position: t.position });
                return;
            }
            
            let styleName = 'Default';
            if (job.perTextStyles && t.style && t.style !== (job.style || 'white')) {
                styleName = t.style;
            } else if (t.role === 'hook_problem' && job.hookStyle) {
                styleName = 'Hook';
            } else if (t.role === 'cta' && job.ctaStyle) {
                styleName = 'CTA';
            }
            
            const pixelX = 540;
            const pixelY = (t.y !== undefined) ? Math.round((t.y / 100) * 1920) : 900;
            const posOverride = `\\an5\\pos(${pixelX},${pixelY})`;
            
            ass += `Dialogue: 0,${start},${end},${styleName},,0,0,0,,{${posOverride}\\fad(200,200)}${text}\n`;
        });
        
        const assPath = path.join(outputDir, `subs-${lang}.ass`);
        fs.writeFileSync(assPath, ass);
        
        // Generate PNG overlays for rounded texts
        const roundedGenTexts = roundedTextIndicesGen.map(rt => ({
            ...rt,
            _resolvedStyle: 'rounded',
            _posY: rt.position === 'center-top' ? 820 : rt.position === 'center-bottom' ? 1000 : (rt.y !== undefined ? Math.round((rt.y / 100) * 1920) - 60 : 900)
        }));
        const genPngOverlays = await generateTextOverlayPngs(roundedGenTexts, job.fontSize || 72, outputDir);
        
        // Generate video with naming convention
        let videoName;
        if (job.namingParts) {
            const { id, date, product, type, author } = job.namingParts;
            videoName = `${id}_${date}_${lang}_${product}_${type}_${author}`;
        } else {
            videoName = `${job.name}-${lang}`;
        }
        const outVideo = path.join(outputDir, `${videoName}.mp4`);
        
        if (genPngOverlays.length > 0) {
            const pngInputs = genPngOverlays.map(p => `-i "${p.path}"`).join(' ');
            let fc = `[0:v]ass='${assPath}':fontsdir=/usr/share/fonts[assout]`;
            let lastLabel = '[assout]';
            genPngOverlays.forEach((p, idx) => {
                const isLast = idx === genPngOverlays.length - 1;
                const outLabel = isLast ? '[vout]' : `[ov${idx}]`;
                fc += `;${lastLabel}[${idx + 1}:v]overlay=${p.x}:${p.y}:enable='between(t\\,${p.start}\\,${p.end})'${outLabel}`;
                lastLabel = outLabel;
            });
            await execPromise(`${FFMPEG} -y -i "${videoPath}" ${pngInputs} -filter_complex "${fc}" -map "[vout]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a copy "${outVideo}" 2>&1`);
        } else {
            await execPromise(`${FFMPEG} -y -i "${videoPath}" -vf "ass='${assPath}':fontsdir=/usr/share/fonts" -c:v libx264 -preset fast -crf 23 -c:a copy "${outVideo}" 2>/dev/null`);
        }
        
        job.outputs[lang] = outVideo;
        job.completed = langIdx + 1;
        
        // QUALITY CHECK: Verify texts and translations
        try {
            const qcResults = await qualityCheckVideo(outVideo, job.texts, translations, lang, LANG_NAMES[lang], job.id);
            if (!job.qualityChecks) job.qualityChecks = {};
            job.qualityChecks[lang] = qcResults;
            
            if (qcResults.issues.length > 0) {
                console.log(`[${job.id}] ⚠️ QC issues for ${lang}:`, qcResults.issues);
            } else {
                console.log(`[${job.id}] ✅ QC passed for ${lang}`);
            }
        } catch (qcErr) {
            console.error(`[${job.id}] QC error for ${lang}:`, qcErr.message);
        }
        
        persistJobs(); // Save progress
        
        console.log(`[${job.id}] ${lang} done (${job.completed}/${LANGUAGES.length})`);
    }
    
    job.status = 'done';
    job.currentLang = '';
    job.completedAt = new Date().toISOString();
    persistJobs(); // Save final state
    console.log(`[${job.id}] All done!`);
    
    // TODO: Send Telegram notification
}


// === VOICEOVER: ElevenLabs TTS + Subtitle generation ===
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';

// Voice IDs for each language - natural male voices
const VOICE_MAP = {
    HR: { voice_id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel' },  // Male
    CZ: { voice_id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel' },
    PL: { voice_id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel' },
    GR: { voice_id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel' },
    IT: { voice_id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel' },
    HU: { voice_id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel' },
    SK: { voice_id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel' },
    BG: { voice_id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel' },
    RO: { voice_id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel' }
};

// Language codes for ElevenLabs
const ELEVEN_LANG_CODES = {
    HR: 'hr', CZ: 'cs', PL: 'pl', GR: 'el', IT: 'it', HU: 'hu', SK: 'sk', BG: 'bg', RO: 'ro'
};

// Generate TTS audio with ElevenLabs
async function generateTTS(text, langCode, outputPath) {
    const voiceConfig = VOICE_MAP[langCode] || VOICE_MAP.HR;
    const elevenLang = ELEVEN_LANG_CODES[langCode] || 'en';
    
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceConfig.voice_id}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'xi-api-key': ELEVENLABS_API_KEY
        },
        body: JSON.stringify({
            text: text,
            model_id: 'eleven_multilingual_v2',
            language_code: elevenLang,
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75,
                style: 0.3,
                use_speaker_boost: true
            }
        })
    });
    
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`ElevenLabs TTS error: ${response.status} - ${err}`);
    }
    
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);
    
    // Get duration of generated audio
    try {
        const durResult = await execPromise(`${FFMPEG} -i "${outputPath}" 2>&1 | grep Duration | awk '{print $2}' | tr -d ','`);
        const parts = durResult.stdout.trim().split(':');
        const duration = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
        return { path: outputPath, duration };
    } catch (e) {
        return { path: outputPath, duration: 3 }; // fallback 3s
    }
}

// API: Convert library texts to voiceover script
app.post('/api/localizer/voiceover-script', async (req, res) => {
    const { texts, videoDuration } = req.body;
    if (!texts?.length || !videoDuration) {
        return res.status(400).json({ error: 'Missing texts or videoDuration' });
    }
    
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [{
                    role: 'system',
                    content: `Pišeš podnapise v PRAVILNI SLOVENŠČINI za NORIKS reklamo. NORIKS prodaja premium moške majice in boksarice.

VSAK stavek mora biti POPOLN — z jasnim subjektom in pomenom. Bralec mora razumeti stavek BREZ konteksta.
Stavki morajo biti med seboj POVEZANI — vsak naslednji stavek logično sledi prejšnjemu. Skupaj tvorijo eno tekoče besedilo.

STRUKTURA zgodbe:
1. PROBLEM — opiši težavo ki jo kupec pozna (1-2 stavka)
2. REŠITEV — predstavi NORIKS kot rešitev (2-3 stavki)
3. KORISTI — konkretne prednosti produkta (2-3 stavki)  
4. CTA — poziv k akciji (1 stavek)

Vsak prehod med stavki mora biti naraven — kot da govoriš eno zgodbo, ne berieš seznama.

Primer DOBRE zgodbe:
"Poznate občutek ko vas boksarice režejo? NORIKS boksarice so narejene iz premium bombaža. Material se prilagodi telesu in ne stiska. Po pranju ohranjajo obliko kot nove. Na voljo v velikostih do 4XL. Danes jih dobiš s 20% popustom."

Video traja TOČNO ${videoDuration} sekund. Zadnji stavek PRED ${videoDuration}s.`
                }, {
                    role: 'user',
                    content: `Iz teh točk napiši POVEZANO ZGODBO za podnapise:

${texts.map((t, i) => `${i+1}. "${t.text}"`).join('\n')}

Video: ${videoDuration}s. NE preseči!

JSON: [{"text": "stavek", "start": 0, "end": 2.5}, ...]

- Max 6 besed na stavek (NIKOLI 3 vrstice!)
- Stavki se LOGIČNO povezujejo
- VSAK stavek ima subjekt in pomen
- Ne uporabi vseh točk če ne gre v čas
- 0.3-0.5s premor med stavki
- SAMO JSON`
                }],
                max_tokens: 8000
            })
        });
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '[]';
        const match = content.match(/\[[\s\S]*\]/);
        const script = match ? JSON.parse(match[0]) : [];
        
        res.json({ script, videoDuration });
    } catch (e) {
        console.error('Voiceover script error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Generate voiceover video for all countries
async function generateVoiceoverCountries(job, videoPath) {
    const LANGUAGES = job.countries || ['SI', 'HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK', 'BG', 'RO', 'DE'];
    const LANG_NAMES = {
        SI: 'Slovenian', HR: 'Croatian', CZ: 'Czech', PL: 'Polish', BG: 'Bulgarian', RO: 'Romanian',
        GR: 'Greek', IT: 'Italian', HU: 'Hungarian', SK: 'Slovak', DE: 'German'
    };
    
    const outputDir = path.join(__dirname, 'uploads', 'generated', job.id);
    fs.mkdirSync(outputDir, { recursive: true });
    
    // Step 1: Translate voiceover script
    console.log(`[${job.id}] [VO] Translating voiceover script to ${LANGUAGES.length} languages...`);
    
    const langList = LANGUAGES.map(l => LANG_NAMES[l]).join(', ');
    const jsonFormat = LANGUAGES.map(l => `"${l}":"..."`).join(',');
    const textsToTranslate = job.voiceoverScript.map(s => s.text);
    
    const transResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{
                role: 'system',
                content: `You are a professional marketing translator with NATIVE-SPEAKER fluency in ${langList}.

CRITICAL RULES:
1. These are VOICE-OVER scripts - they must sound NATURAL when spoken aloud
2. Use conversational, everyday language
3. Keep the same casual, friendly tone as the original
4. Sentences should be SHORT and easy to speak (2-4 seconds each)
5. Brand name "NORIKS" stays unchanged
6. Think: how would a local friend recommend this product?
7. CRITICAL: T-shirt = casual round-neck. Use: HR=majica, CZ=tričko, PL=koszulka, IT=maglietta, HU=póló, SK=tričko, BG=тениска, RO=tricou. NEVER use dress shirt words (košulja/košile/koszula/camicia/ing/košeľa/риза/cămașă).
8. CRITICAL LANGUAGE WARNING: SK = SLOVAK (slovenčina/slovenský jazyk, spoken in SLOVAKIA). The source is SLOVENIAN (slovenščina, Slovenia). These are DIFFERENT languages! Translate INTO Slovak for SK. Do NOT copy Slovenian as Slovak.`
            }, {
                role: 'user',
                content: `Translate these Slovenian voice-over sentences. They will be READ ALOUD, so make them sound natural:

${textsToTranslate.map((t, i) => `${i+1}. "${t}"`).join('\n')}

Return ONLY valid JSON array:
[{${jsonFormat}}, ...]`
            }],
            max_tokens: 8000
        })
    });
    
    const transData = await transResponse.json();
    let transContent = transData.choices?.[0]?.message?.content || '[]';
    // Strip markdown code fences if present
    transContent = transContent.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
    const transMatch = transContent.match(/\[[\s\S]*\]/);
    let translations = [];
    try {
        translations = transMatch ? JSON.parse(transMatch[0]) : [];
    } catch (e) {
        console.error(`[${job.id}] [VO] Failed to parse translations:`, e.message);
    }
    
    console.log(`[${job.id}] [VO] Parsed ${translations.length} translations`);
    
    if (job.cancelled) {
        job.status = 'cancelled';
        persistJobs();
        return;
    }
    
    job.status = 'generating';
    
    // Step 2: For each language - generate TTS + subtitles + combine
    for (let langIdx = 0; langIdx < LANGUAGES.length; langIdx++) {
        if (job.cancelled) {
            job.status = 'cancelled';
            persistJobs();
            return;
        }
        
        const lang = LANGUAGES[langIdx];
        job.currentLang = lang;
        console.log(`[${job.id}] [VO] Generating ${lang}...`);
        
        // NATIVE SPEAKER PROOFREAD for voiceover
        try {
            const voTextsForLang = job.voiceoverScript.map((s, idx) => translations[idx]?.[lang] || s.text);
            const vpResponse = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": "Bearer " + OPENAI_API_KEY },
                body: JSON.stringify({ model: "gpt-4o-mini", messages: [{
                    role: "system", content: "You are a NATIVE " + LANG_NAMES[lang] + " speaker. These are voice-over sentences that will be READ ALOUD. Fix any that sound unnatural or have grammar issues. They must sound perfect when spoken. T-shirt = casual (majica/tričko/koszulka/maglietta/póló/тениска/tricou). IMPORTANT: If Slovak (slovenčina, SLOVAKIA), ensure texts are SLOVAK not Slovenian (slovenščina, Slovenia) - different languages! Return ONLY a JSON array of corrected texts."
                }, { role: "user", content: JSON.stringify(voTextsForLang) }], max_tokens: 1500 })
            });
            const vpData = await vpResponse.json();
            const vpContent = vpData.choices?.[0]?.message?.content || "[]";
            const vpMatch = vpContent.match(/\[([\s\S]*?)\]/);
            if (vpMatch) {
                const vFixed = JSON.parse("[" + vpMatch[1] + "]");
                vFixed.forEach((f, idx) => { if (f && translations[idx]) translations[idx][lang] = f; });
                console.log("[" + job.id + "] [VO] Proofread " + lang + ": " + vFixed.length + " texts checked");
            }
        } catch(vpe) { console.error("[" + job.id + "] [VO] Proofread error " + lang + ":", vpe.message); }
        // Get translated texts for this language
        const langTexts = job.voiceoverScript.map((s, i) => {
            const translated = translations[i]?.[lang] || s.text;
            return { ...s, translatedText: translated };
        });
        
        // Generate TTS for each sentence
        const ttsDir = path.join(outputDir, `tts-${lang}`);
        fs.mkdirSync(ttsDir, { recursive: true });
        
        const ttsSegments = [];
        for (let i = 0; i < langTexts.length; i++) {
            const segment = langTexts[i];
            const ttsPath = path.join(ttsDir, `segment-${i}.mp3`);
            
            try {
                console.log(`[${job.id}] [VO] TTS ${lang} segment ${i}: "${segment.translatedText.substring(0, 40)}..."`);
                const ttsResult = await generateTTS(segment.translatedText, lang, ttsPath);
                ttsSegments.push({
                    text: segment.translatedText,
                    audioPath: ttsResult.path,
                    audioDuration: ttsResult.duration,
                    start: segment.start,
                    end: segment.end
                });
            } catch (e) {
                console.error(`[${job.id}] [VO] TTS error for ${lang} segment ${i}:`, e.message);
                // Skip this segment if TTS fails
                ttsSegments.push({
                    text: segment.translatedText,
                    audioPath: null,
                    audioDuration: segment.end - segment.start,
                    start: segment.start,
                    end: segment.end
                });
            }
        }
        
        // Create concat file for TTS audio with silence gaps
        const concatPath = path.join(ttsDir, 'concat.txt');
        const silencePath = path.join(ttsDir, 'silence.mp3');
        
        // Generate a short silence file
        await execPromise(`${FFMPEG} -y -f lavfi -i anullsrc=r=44100:cl=mono -t 0.3 -q:a 9 "${silencePath}" 2>/dev/null`);
        
        // Build full audio: place each TTS segment at its start time
        // Use amerge approach: create a full-length silent track, then overlay each segment
        const videoDuration = job.videoDuration || 30;
        const fullSilencePath = path.join(ttsDir, 'full-silence.mp3');
        await execPromise(`${FFMPEG} -y -f lavfi -i anullsrc=r=44100:cl=mono -t ${videoDuration} -q:a 9 "${fullSilencePath}" 2>/dev/null`);
        
        // Build filter complex to overlay each TTS segment at its timestamp
        let filterParts = [];
        let inputs = [`-i "${fullSilencePath}"`];
        const validSegments = ttsSegments.filter(s => s.audioPath && fs.existsSync(s.audioPath));
        
        validSegments.forEach((seg, idx) => {
            inputs.push(`-i "${seg.audioPath}"`);
        });
        
        const combinedAudioPath = path.join(ttsDir, 'combined.mp3');
        
        if (validSegments.length > 0) {
            let fc = '';
            validSegments.forEach((seg, idx) => {
                fc += `[${idx + 1}:a]adelay=${Math.round(seg.start * 1000)}|${Math.round(seg.start * 1000)}[d${idx}];`;
            });
            fc += `[0:a]`;
            validSegments.forEach((_, idx) => {
                fc += `[d${idx}]`;
            });
            fc += `amix=inputs=${validSegments.length + 1}:duration=first:dropout_transition=0[aout]`;
            
            await execPromise(`${FFMPEG} -y ${inputs.join(' ')} -filter_complex "${fc}" -map "[aout]" -t ${videoDuration} "${combinedAudioPath}" 2>/dev/null`);
        } else {
            // No valid TTS - use silence
            fs.copyFileSync(fullSilencePath, combinedAudioPath);
        }
        
        // Create ASS subtitles (bottom-center, subtitle style)
        const subsStyle = `Style: Default,Noto Sans,${job.fontSize || 90},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,1,5,30,30,200,1`;
        
        let ass = `[Script Info]
Title: ${job.name} ${lang} VO
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${subsStyle}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
        
        ttsSegments.forEach(seg => {
            const start = formatAssTime(seg.start);
            const end = formatAssTime(Math.min(seg.start + seg.audioDuration, seg.end + 0.5));
            ass += `Dialogue: 0,${start},${end},Default,,0,0,0,,{\\fad(200,200)}${seg.text}\n`;
        });
        
        const assPath = path.join(outputDir, `vo-subs-${lang}.ass`);
        fs.writeFileSync(assPath, ass);
        
        // Final: combine video + TTS audio + subtitles
        let videoName;
        if (job.namingParts) {
            const { id, date, product, type, author } = job.namingParts;
            videoName = `${id}_${date}_${lang}_${product}_${type}_${author}`;
        } else {
            videoName = `${job.name}-${lang}`;
        }
        const outVideo = path.join(outputDir, `${videoName}.mp4`);
        
        // Mix original audio (if exists) with voiceover, or just use voiceover
        // Lower original audio volume, add voiceover on top
        try {
            // Check if video has audio
            const probeResult = await execPromise(`${FFMPEG} -i "${videoPath}" 2>&1 | grep "Audio:"`);
            const hasAudio = probeResult.stdout.trim().length > 0;
            
            if (hasAudio) {
                // Mix: original at 30% volume + voiceover at 100%
                await execPromise(`${FFMPEG} -y -i "${videoPath}" -i "${combinedAudioPath}" -filter_complex "[0:a]volume=0.3[orig];[1:a]volume=1.0[vo];[orig][vo]amix=inputs=2:duration=first[aout];[0:v]ass='${assPath}':fontsdir=/usr/share/fonts[vout]" -map "[vout]" -map "[aout]" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -t ${videoDuration} "${outVideo}" 2>&1`);
            } else {
                // No original audio - just voiceover
                await execPromise(`${FFMPEG} -y -i "${videoPath}" -i "${combinedAudioPath}" -vf "ass='${assPath}':fontsdir=/usr/share/fonts" -map 0:v -map 1:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -shortest "${outVideo}" 2>&1`);
            }
        } catch (e) {
            // Fallback: no audio mix, just subtitles
            console.error(`[${job.id}] [VO] Audio mix error for ${lang}:`, e.message);
            await execPromise(`${FFMPEG} -y -i "${videoPath}" -i "${combinedAudioPath}" -vf "ass='${assPath}':fontsdir=/usr/share/fonts" -map 0:v -map 1:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -shortest "${outVideo}" 2>&1`);
        }
        
        job.outputs[lang] = outVideo;
        job.completed = langIdx + 1;
        persistJobs();
        
        console.log(`[${job.id}] [VO] ${lang} done (${job.completed}/${LANGUAGES.length})`);
    }
    
    job.status = 'done';
    job.currentLang = '';
    job.completedAt = new Date().toISOString();
    persistJobs();
    console.log(`[${job.id}] [VO] All done!`);
}
// === END VOICEOVER ===
// List all jobs

// Get video duration


// Voice-over SLO preview - generate video with Slovenian subtitles + TTS
app.post('/api/localizer/vo-preview', async (req, res) => {
    const { videoClean, script, videoDuration } = req.body;
    if (!videoClean || !script?.length) {
        return res.status(400).json({ error: 'Missing videoClean or script' });
    }
    
    const videoPath = path.join(__dirname, 'uploads', videoClean);
    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video not found' });
    
    const previewDir = path.join(__dirname, 'uploads', 'vo-previews');
    fs.mkdirSync(previewDir, { recursive: true });
    
    const previewId = 'vo-preview-' + Date.now();
    const ttsDir = path.join(previewDir, previewId + '-tts');
    fs.mkdirSync(ttsDir, { recursive: true });
    
    // Create ASS subtitle file
    const subsStyle = "Style: Default,Noto Sans,90,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,1,5,30,30,200,1";
    
    let ass = `[Script Info]
Title: VO Preview SLO
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${subsStyle}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
    
    script.forEach(seg => {
        const start = formatAssTime(seg.start);
        const end = formatAssTime(seg.end);
        ass += `Dialogue: 0,${start},${end},Default,,0,0,0,,{\\fad(200,200)}${seg.text}\n`;
    });
    
    const assPath = path.join(previewDir, `${previewId}.ass`);
    fs.writeFileSync(assPath, ass);
    
    const outPath = path.join(previewDir, `${previewId}.mp4`);
    
    try {
        // Generate TTS for each segment in Slovenian
        console.log(`[vo-preview] Generating SLO TTS for ${script.length} segments...`);
        const validSegments = [];
        
        for (let i = 0; i < script.length; i++) {
            const seg = script[i];
            const ttsPath = path.join(ttsDir, `seg-${i}.mp3`);
            try {
                await generateTTS(seg.text, 'HR', ttsPath); // HR uses same voice, SLO text
                if (fs.existsSync(ttsPath)) {
                    validSegments.push({ path: ttsPath, start: seg.start });
                }
            } catch (e) {
                console.error(`[vo-preview] TTS error segment ${i}:`, e.message);
            }
        }
        
        const vDuration = videoDuration || 30;
        
        if (validSegments.length > 0) {
            // Create silent base audio
            const silencePath = path.join(ttsDir, 'silence.mp3');
            await execPromise(`${FFMPEG} -y -f lavfi -i anullsrc=r=44100:cl=mono -t ${vDuration} -q:a 9 "${silencePath}" 2>/dev/null`);
            
            // Build filter to overlay TTS at timestamps
            let inputs = [`-i "${silencePath}"`];
            validSegments.forEach(seg => { inputs.push(`-i "${seg.path}"`); });
            
            let fc = '';
            validSegments.forEach((seg, idx) => {
                fc += `[${idx + 1}:a]adelay=${Math.round(seg.start * 1000)}|${Math.round(seg.start * 1000)}[d${idx}];`;
            });
            fc += '[0:a]';
            validSegments.forEach((_, idx) => { fc += `[d${idx}]`; });
            fc += `amix=inputs=${validSegments.length + 1}:duration=first:dropout_transition=0[voaudio]`;
            
            const combinedAudio = path.join(ttsDir, 'combined.mp3');
            await execPromise(`${FFMPEG} -y ${inputs.join(' ')} -filter_complex "${fc}" -map "[voaudio]" -t ${vDuration} "${combinedAudio}" 2>/dev/null`);
            
            // Combine: video + subtitles + lowered original audio + voiceover
            try {
                const probeResult = await execPromise(`${FFMPEG} -i "${videoPath}" 2>&1 | grep "Audio:"`);
                const hasAudio = probeResult.stdout.trim().length > 0;
                
                if (hasAudio) {
                    await execPromise(`${FFMPEG} -y -i "${videoPath}" -i "${combinedAudio}" -filter_complex "[0:a]volume=0.15[orig];[1:a]volume=1.0[vo];[orig][vo]amix=inputs=2:duration=first[aout];[0:v]ass='${assPath}':fontsdir=/usr/share/fonts[vout]" -map "[vout]" -map "[aout]" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -t ${vDuration} "${outPath}" 2>&1`);
                } else {
                    await execPromise(`${FFMPEG} -y -i "${videoPath}" -i "${combinedAudio}" -vf "ass='${assPath}':fontsdir=/usr/share/fonts" -map 0:v -map 1:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -shortest "${outPath}" 2>&1`);
                }
            } catch (e) {
                // Fallback: just subtitles + voiceover, no original audio mix
                await execPromise(`${FFMPEG} -y -i "${videoPath}" -i "${combinedAudio}" -vf "ass='${assPath}':fontsdir=/usr/share/fonts" -map 0:v -map 1:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -shortest "${outPath}" 2>&1`);
            }
        } else {
            // No TTS succeeded - just subtitles
            await execPromise(`${FFMPEG} -y -i "${videoPath}" -vf "ass='${assPath}':fontsdir=/usr/share/fonts" -c:v libx264 -preset fast -crf 23 -c:a copy "${outPath}" 2>/dev/null`);
        }
        
        console.log(`[vo-preview] Done: ${outPath}`);
        res.json({ previewUrl: '/uploads/vo-previews/' + previewId + '.mp4' });
    } catch (e) {
        console.error('VO Preview error:', e.message);
        res.status(500).json({ error: e.message });
    }
});


// Upload SRT and burn onto video
app.post('/api/localizer/burn-srt', upload.single('srt'), async (req, res) => {
    const { videoClean } = req.body;
    const srtFile = req.file;
    if (!videoClean || !srtFile) return res.status(400).json({ error: 'Missing video or SRT' });
    
    const videoPath = path.join(__dirname, 'uploads', videoClean);
    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video not found' });
    
    const outDir = path.join(__dirname, 'uploads', 'vo-previews');
    fs.mkdirSync(outDir, { recursive: true });
    const outId = 'srt-burn-' + Date.now();
    const outPath = path.join(outDir, outId + '.mp4');
    
    try {
        await execPromise(`${FFMPEG} -y -i "${videoPath}" -vf "subtitles='${srtFile.path}'" -c:v libx264 -preset fast -crf 23 -c:a copy "${outPath}" 2>&1`);
        res.json({ previewUrl: '/uploads/vo-previews/' + outId + '.mp4' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/localizer/video-duration', async (req, res) => {
    const file = req.query.file;
    if (!file) return res.status(400).json({ error: 'Missing file' });
    const videoPath = path.join(__dirname, 'uploads', file);
    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'File not found' });
    try {
        const durResult = await execPromise(`${FFMPEG} -i "${videoPath}" 2>&1 | grep Duration | awk '{print $2}' | tr -d ','`);
        const parts = durResult.stdout.trim().split(':');
        const duration = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
        res.json({ duration: Math.round(duration * 10) / 10 });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/localizer/jobs', (req, res) => {
    const jobs = Array.from(localizerJobs.values());
    res.json({ jobs });
});

// Get job status
app.get('/api/localizer/job/:id', (req, res) => {
    const job = localizerJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

// Download individual video
app.get('/api/localizer/job/:id/video/:lang', (req, res) => {
    const job = localizerJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    const videoPath = job.outputs[req.params.lang];
    if (!videoPath || !fs.existsSync(videoPath)) {
        return res.status(404).json({ error: 'Video not found' });
    }
    
    res.download(videoPath);
});

// Download all as ZIP
app.get('/api/localizer/job/:id/zip', (req, res) => {
    const job = localizerJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'done') return res.status(400).json({ error: 'Job not complete' });
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${job.name}-all-countries.zip"`);
    
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);
    
    for (const [lang, videoPath] of Object.entries(job.outputs)) {
        if (fs.existsSync(videoPath)) {
            archive.file(videoPath, { name: `${job.name}-${lang}.mp4` });
        }
    }
    
    archive.finalize();
});

// Delete a job (only if author matches)
app.delete('/api/localizer/job/:id', (req, res) => {
    const { author } = req.body; // Username of the person trying to delete
    const job = localizerJobs.get(req.params.id);
    
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    // Check if author matches (case insensitive)
    const jobAuthor = job.namingParts?.author?.toUpperCase() || '';
    const requestAuthor = (author || '').toUpperCase();
    
    if (jobAuthor && requestAuthor && jobAuthor !== requestAuthor) {
        return res.status(403).json({ error: 'Lahko brišeš samo svoje kreative' });
    }
    
    // Delete video files
    const outputDir = path.join(__dirname, 'uploads', 'generated', job.id);
    if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
        console.log(`Deleted video folder: ${outputDir}`);
    }
    
    // Remove from map and persist
    localizerJobs.delete(req.params.id);
    persistJobs();
    
    console.log(`Job ${req.params.id} deleted by ${author}`);
    res.json({ success: true });
});

// Cancel a generating job
app.post('/api/localizer/job/:id/cancel', (req, res) => {
    const job = localizerJobs.get(req.params.id);
    
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    if (job.status !== 'translating' && job.status !== 'generating') {
        return res.status(400).json({ error: 'Job is not in progress' });
    }
    
    job.cancelled = true;
    persistJobs();
    
    console.log(`Job ${req.params.id} cancelled`);
    res.json({ success: true, message: 'Job will be cancelled' });
});

// List all generated videos
app.get('/api/localizer/generated-videos', (req, res) => {
    try {
        const generatedDir = path.join(__dirname, 'uploads', 'generated');
        
        if (!fs.existsSync(generatedDir)) {
            return res.json({ jobs: [] });
        }
        
        const folders = fs.readdirSync(generatedDir)
            .filter(f => fs.statSync(path.join(generatedDir, f)).isDirectory())
            .sort((a, b) => {
                // Extract timestamp from folder name
                const tsA = a.match(/\d+/)?.[0] || '0';
                const tsB = b.match(/\d+/)?.[0] || '0';
                return parseInt(tsB) - parseInt(tsA); // Newest first
            });
        
        const jobs = folders.map(folder => {
            const folderPath = path.join(generatedDir, folder);
            const files = fs.readdirSync(folderPath);
            
            const videos = files.map(file => {
                const filePath = path.join(folderPath, file);
                const stats = fs.statSync(filePath);
                return {
                    name: file,
                    size: stats.size,
                    created: stats.mtime
                };
            });
            
            // Extract timestamp from folder name
            const tsMatch = folder.match(/(\d+)/);
            const timestamp = tsMatch ? tsMatch[1] : Date.now();
            
            return {
                id: folder,
                timestamp,
                videos
            };
        });
        
        res.json({ jobs });
        
    } catch (err) {
        console.error('Error listing generated videos:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============ NIGHT QUEUE ENDPOINTS ============

// ============ END QUEUE ENDPOINTS ============

// ============ FINANCE API ============

const METAKOCKA_COMPANY_ID = 6371;
const METAKOCKA_SECRET = process.env.METAKOCKA_SECRET || '';

// Meta Ads API
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_AD_ACCOUNT = 'act_1922887421998222';

// VAT rates by country code
const VAT_RATES = {
    'SI': 0.22, 'HR': 0.25, 'CZ': 0.21, 'PL': 0.23,
    'GR': 0.24, 'IT': 0.22, 'HU': 0.27, 'SK': 0.20
};

// Map WooCommerce country to our codes
const COUNTRY_MAP = {
    'Slovenia': 'SI', 'Slovenija': 'SI', 'SI': 'SI',
    'Croatia': 'HR', 'Hrvaška': 'HR', 'HR': 'HR',
    'Czech Republic': 'CZ', 'Czechia': 'CZ', 'Česka': 'CZ', 'CZ': 'CZ',
    'Poland': 'PL', 'Poljska': 'PL', 'PL': 'PL',
    'Greece': 'GR', 'Grčija': 'GR', 'GR': 'GR',
    'Italy': 'IT', 'Italija': 'IT', 'IT': 'IT',
    'Hungary': 'HU', 'Madžarska': 'HU', 'HU': 'HU',
    'Slovakia': 'SK', 'Slovaška': 'SK', 'SK': 'SK'
};

// Get finance summary from Metakocka
app.get('/api/finance/summary', async (req, res) => {
    const period = req.query.period || '2026-02'; // YYYY-MM format
    const [year, month] = period.split('-');
    
    try {
        // Calculate date range
        const startDate = `${year}-${month}-01`;
        const endDate = new Date(year, parseInt(month), 0).toISOString().split('T')[0];
        
        // Try Metakocka API
        let orders = [];
        try {
            const metakockaResponse = await fetch('https://main.metakocka.si/rest/eshop/v1/json/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    secret_key: METAKOCKA_SECRET,
                    company_id: METAKOCKA_COMPANY_ID,
                    doc_type: 'sales_order',
                    query_advance: [
                        { type: 'date', field: 'doc_date', from: startDate, to: endDate }
                    ],
                    limit: 1000,
                    offset: 0
                })
            });
            
            const responseText = await metakockaResponse.text();
            
            // Check if response is JSON
            if (responseText.trim().startsWith('{') || responseText.trim().startsWith('[')) {
                const data = JSON.parse(responseText);
                if (!data.error && data.result) {
                    orders = data.result || [];
                } else if (data.error) {
                    console.log('Metakocka returned error:', data.error);
                }
            } else {
                console.log('Metakocka returned non-JSON response');
            }
        } catch (mkErr) {
            console.log('Metakocka API failed, using manual data:', mkErr.message);
        }
        
        // If no orders from API, return sample structure for manual entry
        if (orders.length === 0) {
            // Return empty structure - data will be entered manually
            return res.json({ 
                pending: { total: 0, count: 0, byCountry: {} },
                received: { total: 0, count: 0, byCountry: {} },
                period: { start: startDate, end: endDate },
                source: 'manual'
            });
        }
        
        // Process orders
        const pending = { total: 0, count: 0, byCountry: {} };
        const received = { total: 0, count: 0, byCountry: {} };
        
        for (const order of orders) {
            const amount = parseFloat(order.doc_total || order.total || 0);
            const country = COUNTRY_MAP[order.partner_country || order.country || 'SI'] || 'SI';
            const isPaid = order.status === 'paid' || order.payment_status === 'paid' || order.doc_status === 'closed';
            
            const target = isPaid ? received : pending;
            target.total += amount;
            target.count++;
            
            if (!target.byCountry[country]) {
                target.byCountry[country] = { amount: 0, count: 0, vat: 0 };
            }
            target.byCountry[country].amount += amount;
            target.byCountry[country].count++;
            
            // Calculate VAT
            const vatRate = VAT_RATES[country] || 0.22;
            target.byCountry[country].vat += amount * vatRate / (1 + vatRate);
        }
        
        res.json({ pending, received, period: { start: startDate, end: endDate }, source: 'metakocka' });
        
    } catch (err) {
        console.error('Finance API error:', err);
        res.json({ 
            pending: { total: 0, count: 0, byCountry: {} },
            received: { total: 0, count: 0, byCountry: {} },
            error: err.message,
            source: 'error'
        });
    }
});

// Get Facebook Ads spend
app.get('/api/finance/fb-spend', async (req, res) => {
    const period = req.query.period || '2026-02';
    const [year, month] = period.split('-');
    
    try {
        const startDate = `${year}-${month}-01`;
        const lastDay = new Date(year, parseInt(month), 0).getDate();
        const endDate = `${year}-${month}-${lastDay.toString().padStart(2, '0')}`;
        
        const url = `https://graph.facebook.com/v21.0/${META_AD_ACCOUNT}/insights?` + 
            `access_token=${META_ACCESS_TOKEN}&` +
            `fields=spend&` +
            `time_range={"since":"${startDate}","until":"${endDate}"}&` +
            `level=account`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.error) {
            console.error('Meta API error:', data.error);
            return res.json({ error: data.error.message, spend: 0 });
        }
        
        const spend = data.data && data.data[0] ? parseFloat(data.data[0].spend) : 0;
        
        res.json({ spend, period: { start: startDate, end: endDate } });
        
    } catch (err) {
        console.error('FB Spend API error:', err);
        res.json({ error: err.message, spend: 0 });
    }
});

// Get daily orders from Metakocka
app.get('/api/finance/daily-orders', async (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    
    try {
        const response = await fetch('https://main.metakocka.si/rest/eshop/v1/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                secret_key: METAKOCKA_SECRET,
                company_id: METAKOCKA_COMPANY_ID,
                doc_type: 'sales_order',
                result_type: 'doc',
                limit: 100,
                return_delivery_service_events: true,
                query_advance: [
                    { type: 'doc_date_from', value: date + '+02:00' },
                    { type: 'doc_date_to', value: date + '+02:00' }
                ]
            })
        });
        
        const data = await response.json();
        
        if (data.opr_code !== '0') {
            return res.json({ error: data.opr_desc || 'Metakocka error' });
        }
        
        const orders = data.result || [];
        const summary = {
            date,
            total_orders: orders.length,
            cod_orders: 0,
            online_orders: 0,
            total_revenue: 0,
            cod_revenue: 0,
            online_revenue: 0,
            by_country: {},
            by_status: {},
            pending_cod: { count: 0, amount: 0 },
            delivered_cod: { count: 0, amount: 0 },
            rejected: { count: 0, amount: 0 }
        };
        
        for (const order of orders) {
            const amount = parseFloat(order.sum_all) || 0;
            const country = order.partner?.country_iso_2 || 'SI';
            const status = order.status_code || 'Unknown';
            const isCOD = order.method_of_payment === 'Po povzetju';
            const isPaid = !!order.sum_paid;
            
            // Track by country
            if (!summary.by_country[country]) {
                summary.by_country[country] = { orders: 0, revenue: 0, cod: 0, online: 0 };
            }
            summary.by_country[country].orders++;
            summary.by_country[country].revenue += amount;
            
            // Track by status
            summary.by_status[status] = (summary.by_status[status] || 0) + 1;
            
            // Track COD vs Online
            if (isCOD) {
                summary.cod_orders++;
                summary.cod_revenue += amount;
                summary.by_country[country].cod++;
                
                // Check delivery events for COD status
                const events = order.delivery_service_events || [];
                const eventTexts = events.map(e => e.event_status?.toLowerCase() || '');
                
                const isDelivered = eventTexts.some(e => 
                    e.includes('isporucena primatelju') || 
                    e.includes('delivered') ||
                    e.includes('predana u paketomat')
                );
                const isRejected = eventTexts.some(e => 
                    e.includes('neuruciva') || 
                    e.includes('povrat') ||
                    e.includes('rejected') ||
                    e.includes('return')
                );
                
                if (isRejected) {
                    summary.rejected.count++;
                    summary.rejected.amount += amount;
                } else if (isPaid || isDelivered) {
                    summary.delivered_cod.count++;
                    summary.delivered_cod.amount += amount;
                } else {
                    summary.pending_cod.count++;
                    summary.pending_cod.amount += amount;
                }
            } else {
                summary.online_orders++;
                summary.online_revenue += amount;
                summary.by_country[country].online++;
            }
            
            summary.total_revenue += amount;
        }
        
        res.json(summary);
        
    } catch (err) {
        console.error('Daily orders API error:', err);
        res.json({ error: err.message });
    }
});

// Get all pending COD (shipped but not yet received)
app.get('/api/finance/pending-cod', async (req, res) => {
    try {
        // Get recent shipped orders
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        
        const response = await fetch('https://main.metakocka.si/rest/eshop/v1/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                secret_key: METAKOCKA_SECRET,
                company_id: METAKOCKA_COMPANY_ID,
                doc_type: 'sales_order',
                result_type: 'doc',
                limit: 100,
                return_delivery_service_events: true,
                query_advance: [
                    { type: 'doc_date_from', value: thirtyDaysAgo + '+02:00' }
                ]
            })
        });
        
        const data = await response.json();
        
        if (data.opr_code !== '0') {
            return res.json({ error: data.opr_desc, total: 0, count: 0, byCountry: {} });
        }
        
        const orders = data.result || [];
        let total = 0;
        let count = 0;
        const byCountry = {};
        const byDate = {};
        
        for (const order of orders) {
            const isCOD = order.method_of_payment === 'Po povzetju';
            const isPaid = !!order.sum_paid;
            const status = order.status_code;
            
            // Only count shipped COD orders that are not paid/rejected
            if (!isCOD || isPaid || status === 'Brisan') continue;
            
            const events = order.delivery_service_events || [];
            const eventTexts = events.map(e => e.event_status?.toLowerCase() || '');
            
            const isDelivered = eventTexts.some(e => 
                e.includes('isporucena primatelju') || 
                e.includes('delivered') ||
                e.includes('predana u paketomat')
            );
            const isRejected = eventTexts.some(e => 
                e.includes('neuruciva') || 
                e.includes('povrat') ||
                e.includes('return')
            );
            
            // Skip delivered or rejected
            if (isDelivered || isRejected) continue;
            
            const amount = parseFloat(order.sum_all) || 0;
            const country = order.partner?.country_iso_2 || 'SI';
            const orderDate = order.doc_date?.split('+')[0] || 'unknown';
            
            total += amount;
            count++;
            
            if (!byCountry[country]) {
                byCountry[country] = { amount: 0, count: 0 };
            }
            byCountry[country].amount += amount;
            byCountry[country].count++;
            
            if (!byDate[orderDate]) {
                byDate[orderDate] = { amount: 0, count: 0 };
            }
            byDate[orderDate].amount += amount;
            byDate[orderDate].count++;
        }
        
        res.json({ total: Math.round(total * 100) / 100, count, byCountry, byDate });
        
    } catch (err) {
        console.error('Pending COD API error:', err);
        res.json({ total: 0, count: 0, error: err.message });
    }
});

// Save/load fixed costs
const FIXED_COSTS_FILE = path.join(__dirname, 'data', 'fixed-costs.json');

app.get('/api/finance/fixed-costs', (req, res) => {
    try {
        if (fs.existsSync(FIXED_COSTS_FILE)) {
            const data = JSON.parse(fs.readFileSync(FIXED_COSTS_FILE, 'utf8'));
            res.json(data);
        } else {
            res.json([]);
        }
    } catch (err) {
        res.json({ error: err.message });
    }
});

app.post('/api/finance/fixed-costs', (req, res) => {
    try {
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        
        fs.writeFileSync(FIXED_COSTS_FILE, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch (err) {
        res.json({ error: err.message });
    }
});

// ============ END FINANCE API ============

// ============ PACKING API ============
// Uses existing METAKOCKA_COMPANY_ID and METAKOCKA_SECRET from line ~2774

// Get packing orders from Metakocka
app.get('/api/packing/orders', async (req, res) => {
    const { status = 'Odpremljen', date, limit = 100 } = req.query;
    
    try {
        console.log(`[Packing] Fetching orders with status: ${status}, date: ${date || 'all'}`);
        
        const queryAdvance = [];
        
        // Filter by date if provided
        if (date) {
            queryAdvance.push({ type: 'doc_date_from', value: `${date}+02:00` });
            queryAdvance.push({ type: 'doc_date_to', value: `${date}+02:00` });
        }
        
        const requestBody = {
            secret_key: METAKOCKA_SECRET,
            company_id: METAKOCKA_COMPANY_ID,
            doc_type: 'sales_order',
            result_type: 'doc',
            limit: 100, // Metakocka max is 100
            order_direction: 'desc'
        };
        
        if (queryAdvance.length > 0) {
            requestBody.query_advance = queryAdvance;
        }
        
        const response = await fetch('https://main.metakocka.si/rest/eshop/v1/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });
        
        const data = await response.json();
        
        if (data.opr_code !== '0') {
            console.error('[Packing] Metakocka error:', data);
            return res.status(500).json({ error: 'Metakocka API error', details: data });
        }
        
        let results = data.result || [];
        console.log(`[Packing] Fetched ${results.length} orders from Metakocka`);
        
        // Filter by status locally
        if (status) {
            results = results.filter(o => o.status_code === status);
            console.log(`[Packing] After status filter (${status}): ${results.length} orders`);
        }
        
        // Limit to requested amount
        results = results.slice(0, parseInt(limit));
        
        // Transform orders for packing display
        const orders = results.map(order => {
            const partner = order.partner || {};
            const receiver = order.receiver || partner;
            
            // Get customer name - prefer receiver if different
            const customerName = receiver.customer || partner.customer || 'Neznano';
            
            // Get country from partner
            const country = partner.country || '';
            
            // Parse products
            const items = (order.product_list || [])
                .filter(p => {
                    // Filter out shipping/delivery products
                    const code = (p.code || '').toLowerCase();
                    const name = (p.name || '').toLowerCase();
                    const unit = (p.unit || '').toLowerCase();
                    
                    // Skip services (unit = 'stor')
                    if (unit === 'stor') return false;
                    
                    // Skip shipping keywords
                    const shippingKeywords = [
                        'doručenie', 'dorucenie', 'dostava', 'pošta', 'posta', 
                        'gls', 'dpd', 'shipping', 'dobierka', 'dobírka', 'dobirka',
                        'poplatek', 'poplatok', 'standard', 'štandard', 'standart',
                        'express', 'balík', 'balik', 'paket24', 'dní', 'dni', 'dana',
                        'kurýr', 'kuryr', 'kurier'
                    ];
                    
                    for (const kw of shippingKeywords) {
                        if (code.includes(kw) || name.includes(kw)) return false;
                    }
                    
                    return true;
                })
                .map(product => {
                    const docDesc = product.doc_desc || '';
                    const code = product.code || '';
                    const name = product.name || '';
                    const amount = parseInt(product.amount) || 1;
                    
                    // Parse doc_desc to get individual items
                    const parsedItems = parseDocDesc(docDesc, code, name);
                    
                    // Build product label with item count
                    const totalItems = parsedItems.length * amount;
                    const productLabel = (amount > 1 ? amount + 'x ' : '') + name + 
                        (parsedItems.length > 0 ? ` (${amount > 1 ? amount + '×' + parsedItems.length + ' = ' : ''}${totalItems} kos)` : '');
                    
                    if (parsedItems.length > 0) {
                        // Multiply by amount
                        let allItems;
                        if (amount > 1) {
                            allItems = [];
                            for (let a = 0; a < amount; a++) {
                                allItems.push(...parsedItems.map(item => ({...item})));
                            }
                        } else {
                            allItems = parsedItems;
                        }
                        return { label: productLabel, items: allItems };
                    }
                    
                    // Fallback
                    const fallbackItems = [];
                    for (let a = 0; a < amount; a++) {
                        fallbackItems.push({ type: name, color: '', size: '', colorHex: '#ccc' });
                    }
                    return { label: productLabel, items: fallbackItems };
                });
            
            // Parse date and time
            let dateStr = '';
            let timeStr = '';
            // Prefer shipped_date for "Odpremljen" orders, fallback to doc_date
            const dateSource = order.shipped_date || order.doc_date;
            if (dateSource) {
                dateStr = dateSource.split('+')[0].split('T')[0];
            }
            // Get time from order_create_ts (e.g., "2026-02-26T13:04:57+02:00")
            if (order.order_create_ts) {
                const match = order.order_create_ts.match(/T(\d{2}:\d{2})/);
                if (match) timeStr = match[1];
            }
            
            // Order created date/time
            let orderDate = '', orderTime = '';
            if (order.order_create_ts) {
                const parts = order.order_create_ts.split('+')[0].split('T');
                orderDate = parts[0] || '';
                orderTime = parts[1] ? parts[1].substring(0, 5) : '';
            }
            // Shipped date
            let shippedDate = '';
            if (order.shipped_date) {
                shippedDate = order.shipped_date.split('+')[0].split('T')[0];
            }
            
            return {
                id: order.count_code,
                customer: customerName,
                date: dateStr,
                time: timeStr,
                orderDate: orderDate,
                orderTime: orderTime,
                shippedDate: shippedDate,
                country: country,
                status: order.status_code,
                currency: order.currency_code || 'EUR',
                total: order.sum_all || '0',
                products: items, // [{label, items: [...]}]
                items: items.map(p => p.items || p) // flat for backward compat
            };
        });
        
        res.json({ orders, count: orders.length });
        
    } catch (e) {
        console.error('[Packing] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Bundle definitions - what's inside each known bundle type
const bundleContents = {
    // Black boxer packs
    'NORIKS-BOX-BLACK-3-PACK': (size) => [
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Črna', size },
    ],
    'NORIKS-BOX-BLACK-5-PACK': (size) => [
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Črna', size },
    ],
    // All black shirts
    'NORIKS-ALL-BLACK-3-PACK': (size) => [
        { type: 'Majica', color: 'Črna', size },
        { type: 'Majica', color: 'Črna', size },
        { type: 'Majica', color: 'Črna', size },
    ],
    // All white shirts
    'NORIKS-ALL-WHITE-3-PACK': (size) => [
        { type: 'Majica', color: 'Bela', size },
        { type: 'Majica', color: 'Bela', size },
        { type: 'Majica', color: 'Bela', size },
    ],
    // Coastal 3-pack (blue, green, white boxers)
    'NORIKS-COASTAL-3-PACK': (size) => [
        { type: 'Boksarice', color: 'Modra', size },
        { type: 'Boksarice', color: 'Zelena', size },
        { type: 'Boksarice', color: 'Bela', size },
    ],
    // Monochrome 3-pack (black, white, grey boxers)
    'NORIKS-MONOCHROME-3-PACK': (size) => [
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Bela', size },
        { type: 'Boksarice', color: 'Siva', size },
    ],
    // City combo 6-pack (3 boxers + 3 shirts, mixed)
    'NORIKS-CITY-COMBO-6-PACK': (size) => [
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Modra', size },
        { type: 'Boksarice', color: 'Siva', size },
        { type: 'Majica', color: 'Črna', size },
        { type: 'Majica', color: 'Bela', size },
        { type: 'Majica', color: 'Modra', size },
    ],
    // Ponoćni mix 7-pack (2x crna, 2x siva, 3x modra boksarice)
    'NORIKS-BOX-BUNDLE-7-SECOND': (size) => [
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Siva', size },
        { type: 'Boksarice', color: 'Siva', size },
        { type: 'Boksarice', color: 'Modra', size },
        { type: 'Boksarice', color: 'Modra', size },
        { type: 'Boksarice', color: 'Modra', size },
    ],
    // Neutral mix 9-pack
    'NORIKS-NEUTRAL-MIX-9-PACK': (size) => [
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Bela', size },
        { type: 'Boksarice', color: 'Siva', size },
        { type: 'Boksarice', color: 'Modra', size },
        { type: 'Boksarice', color: 'Zelena', size },
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Bela', size },
        { type: 'Boksarice', color: 'Siva', size },
        { type: 'Boksarice', color: 'Modra', size },
    ],
};

// Type translations for doc_desc parsing (multi-language)
const typeTranslations = {
    'Tricka': 'Majica', 'Boxerky': 'Boksarice', 'Tričko': 'Majica',
    'Boxerky 1': 'Boksarice', 'Boxerky 2': 'Boksarice', 'Boxerky 3': 'Boksarice',
    'Tricka 1': 'Majica', 'Tricka 2': 'Majica', 'Tricka 3': 'Majica',
    'Koszulka': 'Majica', 'Koszulka 1': 'Majica', 'Koszulka 2': 'Majica',
    'Bokserki 1': 'Boksarice', 'Bokserki 2': 'Boksarice',
    'Póló': 'Majica', 'Póló 1': 'Majica', 'Póló 2': 'Majica',
    'Maglietta': 'Majica', 'Boxer': 'Boksarice',
    'Majica': 'Majica', 'Majica 1': 'Majica', 'Majica 2': 'Majica',
    'Bokserica': 'Boksarice', 'Bokserica 1': 'Boksarice', 'Bokserica 2': 'Boksarice',
    'Boksarice': 'Boksarice',
    'Μπλούζα': 'Majica', 'Μπλούζα 1': 'Majica', 'Μπλούζα 2': 'Majica',
    'Μπόξερ': 'Boksarice', 'Μπόξερ 1': 'Boksarice', 'Μπόξερ 2': 'Boksarice',
    'Tshirt': 'Majica', 'Shirt': 'Majica', 'T-shirt': 'Majica',
    'majica': 'Majica', 'bokserica': 'Boksarice',
    'Koszulki': 'Majica', 'Bokserki': 'Boksarice',
};

// Color translations for doc_desc (multi-language → Slovenian)
const colorTranslationsServer = {
    // Czech/Slovak
    'modrá': 'Modra', 'modra': 'Modra', 'zelená': 'Zelena', 'zelena': 'Zelena',
    'červená': 'Rdeča', 'cervena': 'Rdeča', 'čierna': 'Črna', 'cierna': 'Črna',
    'černá': 'Črna', 'cerna': 'Črna', 'biela': 'Bela', 'bílá': 'Bela', 'bila': 'Bela',
    'šedá': 'Siva', 'seda': 'Siva',
    // Polish
    'czarny': 'Črna', 'czarna': 'Črna', 'niebieski': 'Modra', 'niebieska': 'Modra',
    'biały': 'Bela', 'bialy': 'Bela', 'biała': 'Bela', 'biala': 'Bela',
    'szary': 'Siva', 'szara': 'Siva', 'zielony': 'Zelena', 'zielona': 'Zelena',
    'czerwony': 'Rdeča', 'czerwona': 'Rdeča',
    // Croatian
    'crna': 'Črna', 'crno': 'Črna', 'plava': 'Modra', 'bijela': 'Bela',
    'siva': 'Siva', 'crvena': 'Rdeča',
    // Hungarian
    'fekete': 'Črna', 'kék': 'Modra', 'kek': 'Modra', 'fehér': 'Bela', 'feher': 'Bela',
    'szürke': 'Siva', 'szurke': 'Siva', 'piros': 'Rdeča', 'zöld': 'Zelena', 'zold': 'Zelena',
    // Greek
    'Μαύρο': 'Črna', 'Μπλε': 'Modra', 'Λευκό': 'Bela', 'Γκρι': 'Siva',
    'Σκούρο μπλε': 'Temno modra', 'Πράσινο': 'Zelena', 'Κόκκινο': 'Rdeča',
    // Italian
    'nero': 'Črna', 'nera': 'Črna', 'blu': 'Modra', 'bianco': 'Bela', 'bianca': 'Bela',
    'grigio': 'Siva', 'grigia': 'Siva', 'rosso': 'Rdeča', 'verde': 'Zelena',
    // Slovenian (pass through)
    'Črna': 'Črna', 'Modra': 'Modra', 'Bela': 'Bela', 'Siva': 'Siva',
    'Zelena': 'Zelena', 'Rdeča': 'Rdeča',
};

function translateColorServer(color) {
    return colorTranslationsServer[color] || colorTranslationsServer[color.toLowerCase()] || color;
}

// Helper: Parse doc_desc field to extract items
function parseDocDesc(docDesc, productCode, productName) {
    const code = (productCode || '').toUpperCase();
    const productType = getProductTypeFromCode(productCode, productName);
    
    // Extract size from doc_desc or product code
    let bundleSize = '';
    if (docDesc) {
        const sizeMatch = docDesc.match(/(?:velicina|rozmiar|size|méret|velikost|megethos|velicina-majice|velicina-bokseric|megethos-mployzakia|megethos-mpoxer|meret|rozmer)\s*:\s*(\S+)/i);
        if (sizeMatch) bundleSize = sizeMatch[1].toUpperCase();
    }
    if (!bundleSize) {
        // Try from code: NORIKS-BOX-BLACK-3-PACK-XL → XL
        const codeSize = code.match(/-((?:\d*X*)?[SMLX]{1,3}L?)$/);
        if (codeSize) bundleSize = codeSize[1].toUpperCase();
    }
    
    // Check if this is a known bundle - match base code without size suffix
    const baseCode = code.replace(/-((?:\d*X*)?[SMLX]{1,3}L?)$/, '');
    const bundleFn = bundleContents[baseCode] || bundleContents[code];
    if (bundleFn && bundleSize) {
        return bundleFn(bundleSize);
    }
    
    // Handle socks with pair counts (e.g., NORIKS-SOCKS-BW-10PC-43-46)
    if (code.includes('SOCKS')) {
        let pairCount = 1;
        const pcMatch = code.match(/(\d+)PC/i);
        if (pcMatch) pairCount = parseInt(pcMatch[1]);
        // Also try from product name: "10 pari" or "(10 pari)"
        const nameMatch = productName.match(/(\d+)\s*par/i);
        if (nameMatch) pairCount = parseInt(nameMatch[1]);
        
        const sizeFromDesc = docDesc.match(/(?:velikost|velicina|rozmiar|size|méret)\s*:\s*(\S+)/i);
        const sockSize = sizeFromDesc ? sizeFromDesc[1] : bundleSize || '';
        
        const items = [];
        // BW = Black & White, half each
        const isBW = code.includes('BW');
        for (let i = 0; i < pairCount; i++) {
            const color = isBW ? (i < pairCount/2 ? 'Črna' : 'Bela') : '';
            items.push({ type: 'Nogavice', color, size: sockSize });
        }
        return items;
    }
    
    // Handle BUNDLE products with dual sizes (shirts + boxers)
    if (code.includes('BUNDLE-SHIRTS-BOX') || code.includes('BUNDLE-SH-BOX')) {
        const items = [];
        if (docDesc) {
            // Match various language patterns for shirt/boxer sizes
            const shirtSize = docDesc.match(/(?:velicina-majice|megethos-mployzakia|rozmiar-koszulki|meret-polo)\s*:\s*(\S+)/i);
            const boxerSize = docDesc.match(/(?:velicina-bokseric|megethos-mpoxer|rozmiar-bokserki|meret-boxer)\s*:\s*(\S+)/i);
            const sSize = shirtSize ? shirtSize[1].toUpperCase() : bundleSize;
            const bSize = boxerSize ? boxerSize[1].toUpperCase() : bundleSize;
            
            // Parse shirt and boxer counts - prefer product name over code
            let numShirts = 2, numBoxers = 5;
            const nameCountMatch = productName.match(/(\d+)\s*(?:majic|μπλουζ|koszul|tričk|póló|shirt)/i);
            const nameBoxerMatch = productName.match(/(\d+)\s*(?:bokser|μπόξερ|boxer)/i);
            if (nameCountMatch) numShirts = parseInt(nameCountMatch[1]);
            if (nameBoxerMatch) numBoxers = parseInt(nameBoxerMatch[1]);
            
            // Bundle color definitions by variant code
            // P-2: črna+modra majica, P-3: siva+bela, P-4: črna+siva
            // Boxers always: črna, siva, modra, zelena, rdeča
            const bundleVariants = {
                'P-2': { shirts: ['Črna', 'Modra'], boxers: ['Črna', 'Siva', 'Modra', 'Zelena', 'Rdeča'] },
                'P-3': { shirts: ['Siva', 'Bela'], boxers: ['Črna', 'Siva', 'Modra', 'Zelena', 'Rdeča'] },
                'P-4': { shirts: ['Črna', 'Siva'], boxers: ['Črna', 'Siva', 'Modra', 'Zelena', 'Rdeča'] },
            };
            // Detect variant from code (e.g., SHIRTS-BOX-P-3-XL)
            const variantMatch = code.match(/P-(\d)/);
            const variant = variantMatch ? `P-${variantMatch[1]}` : null;
            const colors = bundleVariants[variant] || { shirts: ['Črna', 'Bela'], boxers: ['Črna', 'Siva', 'Modra', 'Zelena', 'Rdeča'] };
            
            // For 4+10 bundles, double each color
            const isLargeBundle = code.includes('SH-BOX-4-10') || code.includes('SHIRTS-BOX-4-10');
            if (isLargeBundle) {
                numShirts = 4; numBoxers = 10;
            }
            
            // Fallback to code pattern if name didn't provide counts
            if (!nameCountMatch && !nameBoxerMatch && !isLargeBundle) {
                const countMatch = code.match(/(?:SH-BOX|SHIRTS-BOX)-(\d+)-(\d+)/i);
                if (countMatch) {
                    numShirts = parseInt(countMatch[1]);
                    numBoxers = parseInt(countMatch[2]);
                }
            }
            
            const shirtColors = isLargeBundle ? ['Črna', 'Črna', 'Siva', 'Siva'] : colors.shirts;
            const boxerColors = isLargeBundle 
                ? ['Črna', 'Črna', 'Siva', 'Siva', 'Modra', 'Modra', 'Zelena', 'Zelena', 'Rdeča', 'Rdeča']
                : colors.boxers;
            
            for (let n = 0; n < numShirts; n++) {
                items.push({ type: 'Majica', color: shirtColors[n % shirtColors.length], size: sSize });
            }
            for (let n = 0; n < numBoxers; n++) {
                items.push({ type: 'Boksarice', color: boxerColors[n % boxerColors.length], size: bSize });
            }
        }
        if (items.length > 0) return items;
    }
    
    // Parse doc_desc for Starter packs and other items with detailed descriptions
    if (docDesc) {
        const items = [];
        // Clean up metadata
        let cleanDesc = docDesc.replace(/_bundle_pairs\s*:.*$/i, '').replace(/_offer_id\s*:.*$/i, '').trim();
        
        // Pattern: "1 : Type: Color - Size" or "1 : Color - Size"
        // Also handles Greek: "1 : Μπλούζα 1: Μαύρο - XL"
        const regex = /(\d+)\s*:\s*(?:([^:\-]+?):\s*)?([^-\d]+?)\s*-\s*(\d*X*[SMLX]{1,3}L?)/gi;
        let match;
        
        while ((match = regex.exec(cleanDesc)) !== null) {
            let itemType = productType;
            if (match[2]) {
                const typeKey = match[2].trim();
                itemType = typeTranslations[typeKey] || typeKey;
            }
            
            const rawColor = match[3].trim();
            const color = translateColorServer(rawColor);
            const size = match[4].trim().toUpperCase();
            
            items.push({ type: itemType, color, size });
        }
        
        if (items.length > 0) return items;
        
        // Simpler format: just size
        if (bundleSize) {
            return [{ type: productType || productName, color: '', size: bundleSize }];
        }
    }
    
    return [];
}

// Helper: Get product type from code
function getProductTypeFromCode(code, name) {
    const codeUpper = (code || '').toUpperCase();
    const nameLower = (name || '').toLowerCase();
    
    if (codeUpper.includes('BOXERS') || nameLower.includes('bokser') || nameLower.includes('boxerk')) {
        return 'Boksarice';
    }
    if (codeUpper.includes('SHIRTS') || codeUpper.includes('MAJIC') || nameLower.includes('majic') || nameLower.includes('tričk') || nameLower.includes('tričko')) {
        return 'Majica';
    }
    if (codeUpper.includes('STARTER')) {
        return 'Starter paket';
    }
    if (codeUpper.includes('SOCKS') || nameLower.includes('nogavic') || nameLower.includes('ponožk')) {
        return 'Nogavice';
    }
    return '';
}
// ============ END PACKING API ============

// Serve index.html for root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Launches server running on port ${PORT}`);
});
