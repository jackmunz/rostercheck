// Runs once a day via GitHub Actions. Fetches current roster state from Sleeper,
// diffs it against yesterday's stored snapshot, and appends any taxi-squad
// events (promotions, adds, drops, trades) to data/events.json.
//
// This file intentionally has no dependencies beyond Node's built-in fetch
// (Node 20+) and fs, since it runs in a minimal CI container.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_DIR = path.join(ROOT, 'data');
const LATEST_PATH = path.join(DATA_DIR, 'latest.json');
const EVENTS_PATH = path.join(DATA_DIR, 'events.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');

const { diffSnapshots } = require('../logic.js');

const API = 'https://api.sleeper.app/v1';

async function api(pathSuffix) {
  const res = await fetch(`${API}${pathSuffix}`);
  if (!res.ok) throw new Error(`Sleeper API error ${res.status} on ${pathSuffix}`);
  return res.json();
}

function todayISO() {
  if (process.env.SNAPSHOT_DATE_OVERRIDE) return process.env.SNAPSHOT_DATE_OVERRIDE;
  return new Date().toISOString().slice(0, 10);
}

function loadJSON(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

async function main() {
  const config = loadJSON(CONFIG_PATH, null);
  if (!config || !config.leagueId) {
    console.error('config.json is missing a "leagueId" value. Set it before running snapshots.');
    process.exit(1);
  }

  const league = await api(`/league/${config.leagueId}`);
  const rostersRaw = await api(`/league/${config.leagueId}/rosters`);
  const rosters = rostersRaw.map(r => ({
    roster_id: r.roster_id,
    players: r.players || [],
    starters: r.starters || [],
    reserve: r.reserve || [],
    taxi: r.taxi || [],
  }));

  const date = todayISO();
  const currentSnapshot = { date, season: league.season, leagueId: config.leagueId, rosters };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });

  const previousSnapshot = loadJSON(LATEST_PATH, null);

  if (previousSnapshot && previousSnapshot.date === date) {
    console.log(`Already have a snapshot for ${date}. Skipping (no duplicate run today).`);
    return;
  }

  let events = loadJSON(EVENTS_PATH, []);

  if (previousSnapshot) {
    const diff = diffSnapshots(previousSnapshot, currentSnapshot);
    const hasEvents = Object.keys(diff.rosterEvents).length > 0;
    if (hasEvents) {
      events.push(diff);
      console.log(`Detected taxi changes on ${date}:`, JSON.stringify(diff.rosterEvents));
    } else {
      console.log(`No taxi changes detected on ${date}.`);
    }
  } else {
    console.log(`No previous snapshot found - this is the first run. Nothing to diff yet.`);
  }

  fs.writeFileSync(LATEST_PATH, JSON.stringify(currentSnapshot, null, 2));
  fs.writeFileSync(EVENTS_PATH, JSON.stringify(events, null, 2));
  fs.writeFileSync(path.join(HISTORY_DIR, `${date}.json`), JSON.stringify(currentSnapshot, null, 2));

  console.log(`Snapshot for ${date} saved.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
