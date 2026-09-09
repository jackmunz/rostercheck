/* ============================================================
   Roster Compliance Checker
   Custom QB/TE roster-limit rule engine for Sleeper leagues.
   Everything runs client-side against Sleeper's public API.

   This build is locked to a single league, with a lightweight
   admin/viewer split: anyone with the base URL sees a read-only
   view; the commissioner unlocks override controls once per device
   via a private "?admin=TOKEN" link (see checkAdminAccess below).
   This is a soft gate suitable for a trusted league, not real auth -
   see README for the full explanation.
   ============================================================ */

const HARDCODED_LEAGUE_ID = '1314033821036851200';
const ADMIN_LS_KEY = 'rc:isAdmin';

const LS_KEYS = {
  seasonsBack: 'rc:seasonsBack',
  week1Overrides: 'rc:week1Overrides',
  overrides: 'rc:overrides:', // + leagueId
  playersCache: 'rc:playersCache:v2', // v2: widened from QB/TE-only to QB/RB/WR/TE so taxi players resolve correctly
  weeksToScan: 'rc:weeksToScan',
  taxiMoves: 'rc:taxiMoves:', // + leagueId, value: { [season]: { [rosterId]: count } }
  taxiPromoted: 'rc:taxiPromoted:', // + leagueId, value: { [rosterId]: [player_id, ...] }
};

// Checks the URL for "?admin=TOKEN" and compares it against config.json's
// adminToken. On a match, remembers admin status on this device (localStorage)
// and strips the token out of the visible URL/history so it isn't left sitting
// in the address bar for someone looking over your shoulder. A device that has
// never matched the token, or is visiting the plain URL, stays a read-only viewer.
async function checkAdminAccess() {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('admin');
  if (urlToken) {
    try {
      const res = await fetch('config.json', { cache: 'no-store' });
      const config = res.ok ? await res.json() : {};
      if (config.adminToken && urlToken === config.adminToken) {
        localStorage.setItem(ADMIN_LS_KEY, 'true');
      }
    } catch (e) { /* config.json not reachable - leave admin status as whatever it already was */ }
    params.delete('admin');
    const rest = params.toString();
    const newUrl = window.location.pathname + (rest ? '?' + rest : '') + window.location.hash;
    window.history.replaceState({}, '', newUrl);
  }
  return localStorage.getItem(ADMIN_LS_KEY) === 'true';
}


// ---------------- Daily snapshot events (from GitHub Actions background job) ----------------

// Returns { available, events }. `available` distinguishes "the daily snapshot
// job has never run / isn't deployed" from "it's running fine, there's just
// nothing to report yet" - both used to look identical to the UI.
async function fetchSnapshotEvents() {
  try {
    const res = await fetch('data/events.json', { cache: 'no-store' });
    if (!res.ok) return { available: false, events: [] };
    const events = await res.json();
    return { available: true, events };
  } catch (e) {
    return { available: false, events: [] }; // no snapshot data yet, or not hosted alongside a data/ folder - fall back to manual tracking only
  }
}

// ---------------- Sleeper API (players cache wraps the shared fetchPlayersMapRaw) ----------------

async function fetchPlayersMap(force = false) {
  const cached = localStorage.getItem(LS_KEYS.playersCache);
  if (cached && !force) {
    try {
      const parsed = JSON.parse(cached);
      const age = Date.now() - parsed.fetchedAt;
      if (age < 1000 * 60 * 60 * 24) return parsed.data; // 24h cache
    } catch (e) { /* fall through to refetch */ }
  }
  const filtered = await fetchPlayersMapRaw();
  try {
    localStorage.setItem(LS_KEYS.playersCache, JSON.stringify({ fetchedAt: Date.now(), data: filtered }));
  } catch (e) { /* storage full - proceed without caching */ }
  return filtered;
}

// ---------------- App state & orchestration ----------------

const state = {
  leagueId: HARDCODED_LEAGUE_ID,
  isAdmin: false,
  seasonsBack: Number(localStorage.getItem(LS_KEYS.seasonsBack) || 2),
  weeksToScan: Number(localStorage.getItem(LS_KEYS.weeksToScan) || 18),
  week1Overrides: JSON.parse(localStorage.getItem(LS_KEYS.week1Overrides) || '{}'),
  league: null,
  rosters: [],
  users: [],
  playersMap: {},
  seasonChain: [],
  results: [], // per roster evaluation
  snapshotSummary: {},
  snapshotAvailable: false,
  teamNameByRosterId: {},
  lastSynced: null,
  loading: false,
  error: null,
};

function overridesKey() { return LS_KEYS.overrides + state.leagueId; }
function loadOverrides() {
  try { return JSON.parse(localStorage.getItem(overridesKey()) || '{}'); } catch (e) { return {}; }
}
function saveOverrides(ov) {
  localStorage.setItem(overridesKey(), JSON.stringify(ov));
}

function taxiMovesKey() { return LS_KEYS.taxiMoves + state.leagueId; }
function loadTaxiMoves() {
  try { return JSON.parse(localStorage.getItem(taxiMovesKey()) || '{}'); } catch (e) { return {}; }
}
function saveTaxiMoves(obj) { localStorage.setItem(taxiMovesKey(), JSON.stringify(obj)); }
function getTaxiMoveCount(rosterId) {
  const all = loadTaxiMoves();
  const season = state.league ? state.league.season : 'unknown';
  return (all[season] && all[season][rosterId]) || 0;
}
function setTaxiMoveCount(rosterId, count) {
  const all = loadTaxiMoves();
  const season = state.league ? state.league.season : 'unknown';
  if (!all[season]) all[season] = {};
  all[season][rosterId] = Math.max(0, count);
  saveTaxiMoves(all);
}

function taxiPromotedKey() { return LS_KEYS.taxiPromoted + state.leagueId; }
function loadTaxiPromoted() {
  try { return JSON.parse(localStorage.getItem(taxiPromotedKey()) || '{}'); } catch (e) { return {}; }
}
function saveTaxiPromoted(obj) { localStorage.setItem(taxiPromotedKey(), JSON.stringify(obj)); }
function getPromotedList(rosterId) {
  const all = loadTaxiPromoted();
  return all[rosterId] || [];
}
function togglePromoted(rosterId, playerId) {
  const all = loadTaxiPromoted();
  if (!all[rosterId]) all[rosterId] = [];
  const idx = all[rosterId].indexOf(playerId);
  if (idx === -1) all[rosterId].push(playerId); else all[rosterId].splice(idx, 1);
  saveTaxiPromoted(all);
}

function userForRoster(roster) {
  return state.users.find(u => u.user_id === roster.owner_id);
}
function teamName(roster) {
  const u = userForRoster(roster);
  if (!u) return `Team ${roster.roster_id}`;
  return (u.metadata && u.metadata.team_name) || u.display_name || `Team ${roster.roster_id}`;
}

async function loadLeague(leagueId, { forcePlayers = false } = {}) {
  state.loading = true;
  state.error = null;
  render();
  try {
    const [league, rosters, users, playersMap] = await Promise.all([
      sleeperApi(`/league/${leagueId}`),
      sleeperApi(`/league/${leagueId}/rosters`),
      sleeperApi(`/league/${leagueId}/users`),
      fetchPlayersMap(forcePlayers),
    ]);
    state.league = league;
    state.rosters = rosters;
    state.users = users;
    state.playersMap = playersMap;
    state.leagueId = leagueId; // set early so per-league storage keys resolve correctly below

    const overrides = loadOverrides();
    const snapshotResult = await fetchSnapshotEvents();
    state.snapshotAvailable = snapshotResult.available;
    state.snapshotSummary = summarizeEvents(snapshotResult.events, league.season);

    // Used to label trade partners in the acquisition-history summary. Reflects
    // CURRENT ownership of each roster slot (see the same assumption already
    // documented for cross-season roster_id stability).
    state.teamNameByRosterId = {};
    for (const r of rosters) state.teamNameByRosterId[r.roster_id] = teamName(r);

    state.seasonChain = await buildSeasonChain(
      leagueId, state.seasonsBack, state.weeksToScan, state.week1Overrides,
      (msg) => { state.loadingMessage = msg; render(); }
    );

    state.results = rosters.map(roster => {
      const groups = classifyRosterPositions(roster, playersMap);
      const rosterOverrides = overrides[roster.roster_id] || {};
      const qb = evaluatePositionGroup('QB', groups.QB, playersMap, roster.roster_id, state.seasonChain, rosterOverrides, state.teamNameByRosterId);
      const te = evaluatePositionGroup('TE', groups.TE, playersMap, roster.roster_id, state.seasonChain, rosterOverrides, state.teamNameByRosterId);
      const rosterSummary = state.snapshotSummary[roster.roster_id] || { moveCount: 0, promotedPlayerIds: [], log: [] };
      const manualPromoted = getPromotedList(roster.roster_id);
      const promotedRegistry = Array.from(new Set([...manualPromoted, ...rosterSummary.promotedPlayerIds]));
      const taxi = evaluateTaxiRoster(roster, playersMap, state.seasonChain, rosterOverrides, promotedRegistry, state.teamNameByRosterId);
      const manualAdjustment = getTaxiMoveCount(roster.roster_id);
      const autoMoveCount = rosterSummary.moveCount;
      return { roster, teamName: teamName(roster), qb, te, taxi, autoMoveCount, manualAdjustment, taxiLog: rosterSummary.log, taxiPromotedAuto: rosterSummary.promotedPlayerIds };
    });

    if (!collapseDefaultsApplied) {
      // Auto-expand violations (need attention), auto-collapse everything else,
      // so the view stays scannable in larger leagues. Only applied once - after
      // that, user toggles are left alone across resyncs.
      for (const result of state.results) {
        if (rosterStatus(result) !== 'violation') collapsedRosterIds.add(String(result.roster.roster_id));
      }
      collapseDefaultsApplied = true;
    }

    // League is locked to HARDCODED_LEAGUE_ID for this deployment - nothing to persist.
    state.lastSynced = new Date();
    state.error = null;
  } catch (err) {
    console.error(err);
    state.error = err.message || 'Something went wrong loading this league.';
  } finally {
    state.loading = false;
    state.loadingMessage = null;
    render();
  }
}

// ---------------- Rendering ----------------

const root = document.getElementById('app');
let expandedPlayer = null; // {rosterId, pos, playerId}
let settingsOpen = false;
let aboutOpen = false;
let collapsedRosterIds = new Set(); // roster_id (as string) -> collapsed
let collapseDefaultsApplied = false; // only auto-set defaults once, so user toggles survive resyncs

function statusWord(playerEligibleDetail, isExemptSlot, positionViolation) {
  if (!playerEligibleDetail) return isExemptSlot ? 'exception' : 'ok';
  if (playerEligibleDetail.eligible === true) return isExemptSlot ? 'exception' : 'ok';
  if (playerEligibleDetail.eligible === false) return 'violation';
  return 'review';
}

function renderSlotBar(group, pos) {
  const base = MAX_BASE[pos];
  let chips = '';
  for (let i = 0; i < base; i++) {
    chips += `<div class="slot-chip ${group.violation ? 'filled-violation' : 'filled-ok'}"></div>`;
  }
  if (group.count > base) {
    const cls = group.violation ? 'filled-violation' : (group.needsReview ? 'filled-exception' : 'filled-exception');
    chips += `<div class="slot-chip ${cls}"></div>`;
  } else {
    chips += `<div class="slot-chip empty"></div>`;
  }
  return `<div class="slot-bar">${chips}</div>`;
}

function playerTag(p) {
  if (p.years_exp === 0) return 'Rookie';
  if (p.years_exp === 1) return '2nd year';
  if (p.years_exp === undefined || p.years_exp === null) return '';
  return `Yr ${p.years_exp + 1}`;
}

function renderPositionGroup(roster, pos, group) {
  const taxiSet = new Set(roster.taxi || []);
  const reserveSet = new Set(roster.reserve || []);
  const playerIds = (roster.players || []).filter(pid => {
    const p = state.playersMap[pid];
    return p && p.position === pos;
  });

  const rows = playerIds.map(pid => {
    const p = state.playersMap[pid] || { full_name: pid };
    const isTaxi = taxiSet.has(pid);
    const isIR = reserveSet.has(pid);

    if (isTaxi || isIR) {
      // Doesn't count against the QB/TE limit at all - shown for visibility,
      // not evaluated, so it should never look like a counted "ok" roster spot.
      const label = isTaxi ? 'Taxi' : 'IR';
      return `
        <div class="player-row">
          <div class="player-name">
            <span>${escapeHtml(p.full_name || pid)}</span>
            <span class="player-tag">${playerTag(p)} \u00b7 doesn't count toward the limit</span>
          </div>
          <span class="player-status taxi">${label}</span>
        </div>
      `;
    }

    const isExempt = group.exemptPlayerId === pid;
    const detail = group.details[pid];
    const isFlaggedGroup = group.count > group.max;
    const status = isFlaggedGroup ? statusWord(detail, isExempt, group.violation) : 'ok';
    const clickable = isFlaggedGroup;
    const key = `${roster.roster_id}:${pos}:${pid}`;
    const isOpen = expandedPlayer === key;

    let acquisitionSummary = null;
    if (isExempt && detail) {
      acquisitionSummary = formatAcquisitionSummary(detail.chain, state.teamNameByRosterId) || detail.reason;
    }

    let detailHtml = '';
    if (isOpen && detail) {
      const trailHtml = (detail.trail || []).map(step => `<li>${escapeHtml(step)}</li>`).join('');
      detailHtml = `
        <div class="detail-panel">
          <div>${escapeHtml(detail.reason || '')}</div>
          ${trailHtml ? `<ol>${trailHtml}</ol>` : ''}
          ${state.isAdmin ? `
          <div class="override-row">
            <button class="approve" data-action="override" data-key="${key}" data-value="approved">Mark approved</button>
            <button class="reject" data-action="override" data-key="${key}" data-value="violation">Mark violation</button>
          </div>
          <div class="override-row">
            <button data-action="override" data-key="${key}" data-value="clear">Clear override</button>
          </div>` : ''}
        </div>`;
    }

    return `
      <div class="player-row ${clickable ? 'flagged' : ''}" ${clickable ? `data-action="toggle" data-key="${key}"` : ''}>
        <div class="player-name">
          <span>${escapeHtml(p.full_name || pid)}</span>
          <span class="player-tag">${playerTag(p)}${isExempt ? ` \u00b7 exception slot \u00b7 ${escapeHtml(acquisitionSummary || '')}` : ''}</span>
        </div>
        <span class="player-status ${status}">${status}</span>
      </div>
      ${detailHtml}
    `;
  }).join('');

  return `
    <div class="pos-group">
      <div class="pos-head">
        <span>${pos} \u00b7 ${group.count}/${group.max}${group.count > group.max ? '+1' : ''}</span>
        ${renderSlotBar(group, pos)}
      </div>
      <div class="player-list">${rows}</div>
    </div>
  `;
}

function rosterStatus(result) {
  const taxiViolation = Object.values(result.taxi || {}).some(t => t.violation);
  const taxiReview = Object.values(result.taxi || {}).some(t => t.needsReview);
  const totalMoves = (result.autoMoveCount || 0) + (result.manualAdjustment || 0);
  const movesOver = totalMoves > TAXI_MAX_MOVES;
  if (result.qb.violation || result.te.violation || taxiViolation || movesOver) return 'violation';
  if (result.qb.needsReview || result.te.needsReview || taxiReview) return 'review';
  return 'ok';
}

function renderTaxiSection(result) {
  const { roster, taxi, autoMoveCount, manualAdjustment, taxiLog } = result;
  const taxiIds = roster.taxi || [];
  const promotedList = getPromotedList(roster.roster_id);
  const totalMoves = (autoMoveCount || 0) + (manualAdjustment || 0);

  const rows = taxiIds.map(pid => {
    const p = state.playersMap[pid] || { full_name: pid };
    const t = taxi[pid] || {};
    let status = 'ok';
    if (t.violation) status = 'violation';
    else if (t.needsReview) status = 'review';
    const key = `${roster.roster_id}:TAXI:${pid}`;
    const isOpen = expandedPlayer === key;
    const isPromoted = promotedList.includes(pid);
    const autoPromoted = (result.taxiPromotedAuto || []).includes(pid);

    let detailHtml = '';
    if (isOpen) {
      const trail = (t.eligibility && t.eligibility.trail) || [];
      const trailHtml = trail.map(step => `<li>${escapeHtml(step)}</li>`).join('');
      detailHtml = `
        <div class="detail-panel">
          <div>${escapeHtml((t.eligibility && t.eligibility.reason) || '')}</div>
          ${trailHtml ? `<ol>${trailHtml}</ol>` : ''}
          <div>${escapeHtml((t.duration && t.duration.reason) || '')}</div>
          ${t.promotionViolation ? `<div style="color:var(--danger); margin-top:6px;">Flagged: this player was previously promoted off taxi${autoPromoted ? ' (auto-detected from daily snapshots)' : ' (manually marked)'} and is back on it. Confirm it went through waivers, or mark a violation.</div>` : ''}
          ${state.isAdmin ? `
          <div class="override-row">
            <button class="approve" data-action="override" data-key="${key}" data-value="approved">Mark approved</button>
            <button class="reject" data-action="override" data-key="${key}" data-value="violation">Mark violation</button>
          </div>
          <div class="override-row">
            <button data-action="override" data-key="${key}" data-value="clear">Clear override</button>
            <button data-action="toggle-promoted" data-roster="${roster.roster_id}" data-player="${pid}">${isPromoted ? 'Unmark "previously promoted"' : 'Mark "previously promoted"'}</button>
          </div>` : ''}
        </div>`;
    }

    return `
      <div class="player-row flagged" data-action="toggle" data-key="${key}">
        <div class="player-name">
          <span>${escapeHtml(p.full_name || pid)}</span>
          <span class="player-tag">${playerTag(p)}${isPromoted ? ' \u00b7 previously promoted' : ''}</span>
        </div>
        <span class="player-status ${status}">${status}</span>
      </div>
      ${detailHtml}
    `;
  }).join('');

  const movesClass = totalMoves > TAXI_MAX_MOVES ? 'violation' : (totalMoves === TAXI_MAX_MOVES ? 'review' : 'ok');
  const snapshotLabel = state.snapshotAvailable
    ? ' (auto-detected + manual)'
    : ' (manual only \u2014 daily snapshot job not detected; see README)';

  return `
    <div class="pos-group">
      <div class="pos-head">
        <span>Taxi \u00b7 ${taxiIds.length} rostered</span>
      </div>
      <div class="player-list">${rows || '<div class="player-tag" style="padding:4px 2px;">No players on taxi.</div>'}</div>
      <div class="detail-panel" style="margin-top:8px;">
        <div style="display:flex; align-items:center; justify-content:space-between;">
          <span>Taxi moves this season${snapshotLabel}</span>
          <span class="player-status ${movesClass}">${totalMoves}/${TAXI_MAX_MOVES}</span>
        </div>
        <div class="player-tag" style="margin-top:4px;">Auto-detected: ${autoMoveCount} \u00b7 Manual adjustment: ${manualAdjustment}</div>
        ${state.isAdmin ? `
        <div class="override-row">
          <button data-action="taxi-move" data-roster="${roster.roster_id}" data-delta="-1">\u2212 Manual adjust</button>
          <button data-action="taxi-move" data-roster="${roster.roster_id}" data-delta="1">+ Manual adjust</button>
        </div>` : ''}
      </div>
    </div>
  `;
}

function renderRosterCard(result) {
  const { roster, qb, te } = result;
  const status = rosterStatus(result);
  const cardClass = status === 'violation' ? 'has-violation' : (status === 'review' ? 'has-review' : '');
  const statusLabel = status === 'violation' ? 'Violation' : (status === 'review' ? 'Needs review' : 'Compliant');
  const rosterKey = String(roster.roster_id);
  const isCollapsed = collapsedRosterIds.has(rosterKey);

  return `
    <div class="roster-card ${cardClass}">
      <div class="team-row" data-action="toggle-team" data-roster-id="${rosterKey}">
        <span class="team-name">${escapeHtml(teamName(roster))}</span>
        <div class="team-row-right">
          <span class="status-pill ${status}">${statusLabel}</span>
          <span class="collapse-arrow ${isCollapsed ? 'collapsed' : ''}">\u25BE</span>
        </div>
      </div>
      ${isCollapsed ? '' : `
      ${renderPositionGroup(roster, 'QB', qb)}
      ${renderPositionGroup(roster, 'TE', te)}
      ${renderTaxiSection(result)}
      `}
    </div>
  `;
}

function renderSummary() {
  const okCount = state.results.filter(r => rosterStatus(r) === 'ok').length;
  const reviewCount = state.results.filter(r => rosterStatus(r) === 'review').length;
  const violationCount = state.results.filter(r => rosterStatus(r) === 'violation').length;
  return `
    <div class="summary-strip">
      <div class="summary-chip ok"><span class="num">${okCount}</span><span class="lbl">Compliant</span></div>
      <div class="summary-chip review"><span class="num">${reviewCount}</span><span class="lbl">Review</span></div>
      <div class="summary-chip violation"><span class="num">${violationCount}</span><span class="lbl">Violation</span></div>
    </div>
    <button class="secondary" data-action="download-pdf" style="margin-bottom:16px;">Download PDF report</button>
  `;
}

// Builds a report PDF client-side with jsPDF from the currently loaded results,
// and triggers a browser download. Same underlying data as buildReportData()
// used by the daily email job, so the two report styles stay in sync.
// Builds a violations-focused report PDF client-side with jsPDF, styled to match
// the app's dark card-based look, and triggers a browser download.
function generatePdfReport() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const report = buildViolationReport(state.league || {}, state.results, state.playersMap, state.teamNameByRosterId);

  // Colors lifted from style.css so the PDF matches the app's look.
  const COLOR = {
    bg: [16, 21, 27],
    text: [236, 239, 243],
    textDim: [140, 151, 166],
    line: [46, 56, 68],
    accent: [62, 142, 95],
    warn: [232, 163, 61],
    danger: [224, 82, 74],
  };

  const marginX = 48;
  const contentWidth = 500;
  let y = 0;
  const lineHeight = 15;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  function paintBackground() {
    doc.setFillColor(...COLOR.bg);
    doc.rect(0, 0, pageWidth, pageHeight, 'F');
  }

  function newPage() {
    doc.addPage();
    paintBackground();
    y = 56;
  }

  function ensureRoom(extra = lineHeight) {
    if (y + extra > pageHeight - 48) newPage();
  }

  function heading(text, size = 13, color = COLOR.text) {
    ensureRoom(size + 6);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    doc.text(text.toUpperCase(), marginX, y);
    y += size + 8;
  }

  function bodyLine(text, opts = {}) {
    const { indent = 0, color = COLOR.text, bold = false, size = 10 } = opts;
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const wrapped = doc.splitTextToSize(text, contentWidth - indent);
    for (const line of wrapped) {
      ensureRoom();
      doc.text(line, marginX + indent, y);
      y += lineHeight;
    }
  }

  function divider() {
    ensureRoom(16);
    doc.setDrawColor(...COLOR.line);
    doc.line(marginX, y, marginX + contentWidth, y);
    y += 16;
  }

  paintBackground();
  y = 56;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(...COLOR.accent);
  doc.text('RosterCheck', marginX, y);
  y += 20;
  doc.setFontSize(13);
  doc.setTextColor(...COLOR.text);
  doc.text('Violation Report', marginX, y);
  y += 22;

  bodyLine(`${report.leagueName}${report.season ? ' \u00b7 ' + report.season : ''}`, { color: COLOR.textDim });
  bodyLine(`Generated ${new Date(report.generatedAt).toLocaleString()}`, { color: COLOR.textDim });
  y += 6;
  bodyLine(
    `${report.summary.violation} violation(s)  \u00b7  ${report.summary.review} needing review  \u00b7  ${report.summary.ok} compliant`,
    { bold: true }
  );
  y += 10;
  divider();

  // ---- Activity summary ----
  heading('Activity Summary', 13, COLOR.warn);

  bodyLine('Taxi Moves This Season', { bold: true, size: 11 });
  if (report.activity.taxiMoves.length === 0) {
    bodyLine('No taxi moves logged yet.', { indent: 12, color: COLOR.textDim });
  } else {
    for (const m of report.activity.taxiMoves) {
      const over = m.moveCount > m.cap;
      bodyLine(`${m.teamName}: ${m.moveCount}/${m.cap}${over ? '  (OVER LIMIT)' : ''}`, { indent: 12, color: over ? COLOR.danger : COLOR.text });
    }
  }
  y += 6;

  bodyLine('Taxi Promotions', { bold: true, size: 11 });
  if (report.activity.taxiPromotions.length === 0) {
    bodyLine('No promotions detected yet.', { indent: 12, color: COLOR.textDim });
  } else {
    for (const p of report.activity.taxiPromotions) {
      bodyLine(`${p.teamName}: ${p.player} promoted from taxi on ${p.date}`, { indent: 12 });
    }
  }
  y += 6;

  bodyLine('QB/TE Moves of Note', { bold: true, size: 11 });
  if (report.activity.qbteMoves.length === 0) {
    bodyLine('No flagged QB/TE roster moves.', { indent: 12, color: COLOR.textDim });
  } else {
    for (const m of report.activity.qbteMoves) {
      bodyLine(`${m.teamName} [${m.category}] ${m.player}: ${m.note}`, { indent: 12 });
    }
  }
  y += 10;
  divider();

  // ---- Violations ----
  heading('Violations', 13, COLOR.danger);

  if (report.violationTeams.length === 0) {
    bodyLine('No violations found.', { color: COLOR.accent, bold: true });
  } else {
    for (const team of report.violationTeams) {
      ensureRoom(24);
      // colored left bar to mimic the app's card accent
      doc.setFillColor(...COLOR.danger);
      doc.rect(marginX, y - 11, 3, 16, 'F');
      bodyLine(team.teamName, { indent: 12, bold: true, size: 12, color: COLOR.danger });
      for (const issue of team.issues) {
        bodyLine(`[${issue.category}] ${issue.player}: ${issue.reason}`, { indent: 24, color: COLOR.text });
      }
      y += 8;
    }
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  doc.save(`rostercheck-violations-${dateStr}.pdf`);
}

function renderSettings() {
  if (!settingsOpen || !state.isAdmin) return '';
  const w1rows = state.seasonChain.map(s => `
    <tr>
      <td>${s.season}</td>
      <td><input type="date" data-w1-season="${s.season}" value="${state.week1Overrides[s.season] || ''}" /></td>
    </tr>
  `).join('');

  return `
    <div class="settings-panel">
      <h3>Settings (admin only)</h3>
      <div class="settings-row">
        <label class="field-label">Seasons to look back (for the 2-year exception window)</label>
        <input type="number" id="seasons-back-input" min="1" max="4" value="${state.seasonsBack}" />
      </div>
      <div class="settings-row">
        <label class="field-label">Weeks scanned per season (transaction history)</label>
        <input type="number" id="weeks-scan-input" min="1" max="25" value="${state.weeksToScan}" />
      </div>
      <div class="settings-row">
        <label class="field-label">Week 1 date overrides (auto-estimated otherwise)</label>
        <table class="week1-table"><tbody>${w1rows}</tbody></table>
      </div>
      <button class="primary" data-action="apply-settings">Apply &amp; resync</button>
      <button class="secondary" data-action="refresh-players">Refresh player database</button>
      <button class="secondary" data-action="reset-overrides">Clear all manual overrides</button>
      <button class="secondary" data-action="exit-admin">Exit admin mode on this device</button>
    </div>
  `;
}

function renderAbout() {
  return `
    <div class="about-toggle" data-action="toggle-about">${aboutOpen ? 'Hide' : 'How this works & limitations'}</div>
    ${aboutOpen ? `
      <div class="about-box">
        <h4>The rule</h4>
        <p>Rosters may carry at most 2 QBs and 2 TEs, unless a 3rd is a rookie or 2nd-year player who was drafted in the rookie draft, or added before Week 1 (including rookie waivers). The exception lasts up to 2 years and carries forward through trades - but not through a drop-and-re-add on waivers.</p>
        <p>This limit only applies to your active/bench roster - anyone on taxi squad or IR doesn't count against it, since those are separate roster spots governed by their own rules.</p>
        <h4>How eligibility is traced</h4>
        <ul>
          <li>Checks each QB/TE's experience (years_exp \u2264 1).</li>
          <li>Walks the transaction history backward from the current roster, following trades, until it finds either a rookie-draft pick or a pre-Week-1 waiver/free-agent add.</li>
          <li>A waiver/free-agent add after Week 1 breaks the chain for whoever picked the player up.</li>
          <li>The exception slot's tag shows exactly how and when that acquisition happened - e.g. "Rookie Draft 2026," "Offseason 2026," or "Trade (Week 7 of 2026 season) from Team X who acquired via Rookie Draft 2025" for a player who's since been traded. Trade partner names reflect who currently owns that roster slot, not necessarily who owned it at the time of the trade.</li>
        </ul>
        <h4>Taxi squad rule</h4>
        <p>Taxi-eligible players must be 1st/2nd-year, drafted or added via waiver/free agency at any time (unlike the QB/TE exception, taxi additions aren't restricted to before Week 1 - that would make the 3-moves-per-season allowance meaningless). A player can stay on taxi up to 2 seasons, checked against each season's historical roster snapshot.</p>
        <h4>Taxi moves &amp; promotion tracking</h4>
        <p>If this app is deployed with its GitHub Actions snapshot job running daily, taxi promotions/adds/drops/trades are auto-detected by diffing each day's roster state, and rolled into the move count and "previously promoted" list automatically. Without that job running, these fall back to a manual counter and checklist you maintain yourself.</p>
        <h4>Known limitations</h4>
        <ul>
          <li>Week 1 dates are estimated (Thursday after Labor Day) unless you set exact dates in Settings.</li>
          <li>Assumes roster IDs stay consistent across seasons in this league's history, which is standard for continued Sleeper dynasty leagues.</li>
          <li>If history can't be traced far enough back, a player is marked "review" rather than guessed at - use the manual override to resolve it.</li>
          <li>Taxi moves-per-season and promotion history are auto-detected daily if you've set up the GitHub Actions snapshot job (see README); otherwise they fall back to manual logging.</li>
          <li>Daily snapshots can't see moves that happen and reverse between two checks (e.g. promoted and demoted the same day) - they only capture net daily change.</li>
        </ul>
      </div>
    ` : ''}
  `;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render() {
  if (state.loading) {
    root.innerHTML = `
      ${renderHeader()}
      <div class="container">
        <div class="loading-row">${escapeHtml(state.loadingMessage || 'Loading league...')}</div>
      </div>
    `;
    return;
  }

  if (state.error) {
    root.innerHTML = `
      ${renderHeader()}
      <div class="container">
        <div class="error-box">${escapeHtml(state.error)}</div>
        <button class="secondary" data-action="retry">Retry</button>
      </div>
    `;
    bindGlobalActions();
    return;
  }

  root.innerHTML = `
    ${renderHeader()}
    <div class="container">
      ${renderSettings()}
      ${renderSummary()}
      ${state.results.map(renderRosterCard).join('')}
      ${renderAbout()}
    </div>
  `;
  bindGlobalActions();
}

function renderHeader() {
  const leagueName = state.league ? state.league.name : '';
  const season = state.league ? state.league.season : '';
  const syncedStr = state.lastSynced ? `Synced ${state.lastSynced.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
  return `
    <header class="app-header">
      <div class="container">
        <div class="header-row">
          <h1 class="app-title">Roster<span class="accent-dot">Check</span>${state.isAdmin ? '<span class="admin-badge">Admin</span>' : ''}</h1>
          ${state.isAdmin ? '<button class="icon-btn" data-action="toggle-settings">\u2699</button>' : ''}
        </div>
        <div class="league-sub">
          <span>${escapeHtml(leagueName)}${season ? ` \u00b7 ${season}` : ''}</span>
          ${syncedStr ? `<span>${syncedStr}</span>` : ''}
          <button class="sync-btn" data-action="sync">Sync now</button>
        </div>
      </div>
    </header>
  `;
}

function bindGlobalActions() {
  root.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', onAction);
  });
  const seasonsBackInput = document.getElementById('seasons-back-input');
  if (seasonsBackInput) seasonsBackInput.addEventListener('input', (e) => { state.seasonsBack = Number(e.target.value) || 2; });
  const weeksScanInput = document.getElementById('weeks-scan-input');
  if (weeksScanInput) weeksScanInput.addEventListener('input', (e) => { state.weeksToScan = Number(e.target.value) || 18; });
  root.querySelectorAll('[data-w1-season]').forEach(el => {
    el.addEventListener('input', (e) => {
      const season = e.target.getAttribute('data-w1-season');
      state.week1Overrides[season] = e.target.value || undefined;
    });
  });
}

function onAction(e) {
  const el = e.currentTarget;
  const action = el.getAttribute('data-action');
  const ADMIN_ONLY_ACTIONS = new Set([
    'toggle-settings', 'override', 'taxi-move', 'toggle-promoted',
    'apply-settings', 'refresh-players', 'reset-overrides', 'exit-admin',
  ]);
  if (ADMIN_ONLY_ACTIONS.has(action) && !state.isAdmin) return; // defense in depth - these buttons aren't rendered for viewers anyway

  if (action === 'toggle-settings') {
    settingsOpen = !settingsOpen;
    render();
  } else if (action === 'download-pdf') {
    try {
      generatePdfReport();
    } catch (err) {
      console.error(err);
      alert('Could not generate the PDF report: ' + err.message);
    }
  } else if (action === 'toggle-about') {
    aboutOpen = !aboutOpen;
    render();
  } else if (action === 'sync' || action === 'retry') {
    loadLeague(state.leagueId);
  } else if (action === 'exit-admin') {
    localStorage.removeItem(ADMIN_LS_KEY);
    state.isAdmin = false;
    settingsOpen = false;
    render();
  } else if (action === 'toggle-team') {
    const rosterId = el.getAttribute('data-roster-id');
    if (collapsedRosterIds.has(rosterId)) collapsedRosterIds.delete(rosterId); else collapsedRosterIds.add(rosterId);
    render();
  } else if (action === 'toggle') {
    const key = el.getAttribute('data-key');
    expandedPlayer = expandedPlayer === key ? null : key;
    render();
  } else if (action === 'override') {
    const key = el.getAttribute('data-key');
    const value = el.getAttribute('data-value');
    const [rosterId, pos, playerId] = key.split(':');
    const overrides = loadOverrides();
    if (!overrides[rosterId]) overrides[rosterId] = {};
    if (value === 'clear') {
      delete overrides[rosterId][playerId];
    } else {
      overrides[rosterId][playerId] = value;
    }
    saveOverrides(overrides);
    loadLeague(state.leagueId);
  } else if (action === 'toggle-promoted') {
    const rosterId = el.getAttribute('data-roster');
    const playerId = el.getAttribute('data-player');
    togglePromoted(rosterId, playerId);
    loadLeague(state.leagueId);
  } else if (action === 'taxi-move') {
    const rosterId = el.getAttribute('data-roster');
    const delta = Number(el.getAttribute('data-delta'));
    setTaxiMoveCount(rosterId, getTaxiMoveCount(rosterId) + delta);
    const result = state.results.find(r => String(r.roster.roster_id) === String(rosterId));
    if (result) result.manualAdjustment = getTaxiMoveCount(rosterId);
    render();
  } else if (action === 'apply-settings') {
    localStorage.setItem(LS_KEYS.seasonsBack, String(state.seasonsBack));
    localStorage.setItem(LS_KEYS.weeksToScan, String(state.weeksToScan));
    localStorage.setItem(LS_KEYS.week1Overrides, JSON.stringify(state.week1Overrides));
    settingsOpen = false;
    loadLeague(state.leagueId);
  } else if (action === 'refresh-players') {
    loadLeague(state.leagueId, { forcePlayers: true });
  } else if (action === 'reset-overrides') {
    if (confirm('Clear all manual overrides for this league?')) {
      localStorage.removeItem(overridesKey());
      loadLeague(state.leagueId);
    }
  }
}

// ---------------- Boot ----------------

(async function boot() {
  state.isAdmin = await checkAdminAccess();
  await loadLeague(state.leagueId);
})();
