/* ============================================================
   Sleeper API client - pure fetch/orchestration, no DOM deps.
   Loaded as a global in the browser (<script src="sleeper-client.js">)
   and required as a CommonJS module from Node scripts.
   Depends on logic.js being loaded/required first (computeWeek1Date).
   ============================================================ */

const SLEEPER_API = 'https://api.sleeper.app/v1';

// In Node, require()'d modules have their own scope (unlike browser <script> tags,
// where logic.js's top-level function declarations become globals automatically).
// This shim pulls logic.js's exports into the global object so the rest of this
// file can call them unqualified in both environments.
if (typeof module !== 'undefined' && typeof require === 'function') {
  try {
    const logicModule = require('./logic.js');
    Object.assign(global, logicModule);
  } catch (e) {
    // logic.js not found relative to this file - caller must ensure it's loaded first.
  }
}

async function sleeperApi(pathSuffix) {
  const res = await fetch(`${SLEEPER_API}${pathSuffix}`);
  if (!res.ok) throw new Error(`Sleeper API error ${res.status} on ${pathSuffix}`);
  return res.json();
}

// Fetches the full players dictionary and filters to the positions that can actually
// appear on a roster and matter to these rules: QB/TE for the position-limit rule,
// plus RB/WR since taxi squads can hold any offensive skill-position player, not just
// QB/TE. (K/DEF are excluded - they're never taxied and never subject to either rule.)
const RELEVANT_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

async function fetchPlayersMapRaw() {
  const all = await sleeperApi('/players/nfl');
  const filtered = {};
  for (const [id, p] of Object.entries(all)) {
    if (p && RELEVANT_POSITIONS.has(p.position)) {
      filtered[id] = {
        full_name: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        position: p.position,
        years_exp: p.years_exp,
        team: p.team,
      };
    }
  }
  return filtered;
}

async function fetchDraftPicksForLeague(leagueId) {
  const drafts = await sleeperApi(`/league/${leagueId}/drafts`).catch(() => []);
  const all = [];
  for (const d of drafts) {
    const picks = await sleeperApi(`/draft/${d.draft_id}/picks`).catch(() => []);
    for (const pk of picks) {
      if (pk.player_id) all.push({ round: pk.round, pick_no: pk.pick_no, roster_id: pk.roster_id, player_id: String(pk.player_id) });
    }
  }
  return all;
}

async function fetchTransactionsForLeague(leagueId, weeksToScan) {
  const weeks = Array.from({ length: weeksToScan }, (_, i) => i + 1);
  const results = await Promise.all(
    weeks.map(w => sleeperApi(`/league/${leagueId}/transactions/${w}`).catch(() => []))
  );
  const seen = new Set();
  const all = [];
  for (const weekTxns of results) {
    for (const t of weekTxns) {
      if (seen.has(t.transaction_id)) continue;
      seen.add(t.transaction_id);
      const adds = {};
      const drops = {};
      if (t.adds) for (const [pid, rid] of Object.entries(t.adds)) adds[String(pid)] = rid;
      if (t.drops) for (const [pid, rid] of Object.entries(t.drops)) drops[String(pid)] = rid;
      all.push({ transaction_id: t.transaction_id, type: t.type, status: t.status, created: t.created, adds, drops });
    }
  }
  return all;
}

// Builds the season chain: [currentSeason, ...pastSeasons] going back `seasonsBack` extra seasons.
// Requires computeWeek1Date from logic.js to already be in scope.
async function buildSeasonChain(leagueId, seasonsBack, weeksToScan, week1Overrides, onProgress) {
  const chain = [];
  let curLeagueId = leagueId;
  let hops = 0;
  const maxHops = seasonsBack + 1;

  while (curLeagueId && hops < maxHops) {
    onProgress && onProgress(`Loading season data (${hops + 1}/${maxHops})...`);
    const league = await sleeperApi(`/league/${curLeagueId}`);
    const [transactions, draftPicks, rosters] = await Promise.all([
      fetchTransactionsForLeague(curLeagueId, weeksToScan),
      fetchDraftPicksForLeague(curLeagueId),
      sleeperApi(`/league/${curLeagueId}/rosters`).catch(() => []),
    ]);
    chain.push({
      leagueId: curLeagueId,
      season: league.season,
      transactions,
      draftPicks,
      rosters,
      week1Date: computeWeek1Date(league.season, week1Overrides),
    });
    curLeagueId = league.previous_league_id || null;
    hops += 1;
  }
  return chain;
}

// Runs the full QB/TE + taxi evaluation for every roster in a league, given a
// pre-built season chain and players map. Shared by the browser app and the
// Node-based check-and-notify script so the two never drift out of sync.
// promotedRegistryByRoster / overridesByRoster are optional maps keyed by roster_id.
async function evaluateLeague(leagueId, opts = {}) {
  const {
    seasonsBack = 2,
    weeksToScan = 18,
    week1Overrides = {},
    overridesByRoster = {},
    promotedRegistryByRoster = {},
    autoSummaryByRoster = {},
    onProgress,
  } = opts;

  const [league, rosters, users, playersMap] = await Promise.all([
    sleeperApi(`/league/${leagueId}`),
    sleeperApi(`/league/${leagueId}/rosters`),
    sleeperApi(`/league/${leagueId}/users`),
    fetchPlayersMapRaw(),
  ]);

  const seasonChain = await buildSeasonChain(leagueId, seasonsBack, weeksToScan, week1Overrides, onProgress);

  const userById = {};
  for (const u of users) userById[u.user_id] = u;
  const teamNameFor = (roster) => {
    const u = userById[roster.owner_id];
    if (!u) return `Team ${roster.roster_id}`;
    return (u.metadata && u.metadata.team_name) || u.display_name || `Team ${roster.roster_id}`;
  };

  const teamNameByRosterId = {};
  for (const r of rosters) teamNameByRosterId[r.roster_id] = teamNameFor(r);

  const results = rosters.map(roster => {
    const groups = classifyRosterPositions(roster, playersMap);
    const rosterOverrides = overridesByRoster[roster.roster_id] || {};
    const qb = evaluatePositionGroup('QB', groups.QB, playersMap, roster.roster_id, seasonChain, rosterOverrides, teamNameByRosterId);
    const te = evaluatePositionGroup('TE', groups.TE, playersMap, roster.roster_id, seasonChain, rosterOverrides, teamNameByRosterId);
    const autoSummary = autoSummaryByRoster[roster.roster_id] || { moveCount: 0, promotedPlayerIds: [] };
    const manualPromoted = promotedRegistryByRoster[roster.roster_id] || [];
    const promotedRegistry = Array.from(new Set([...manualPromoted, ...autoSummary.promotedPlayerIds]));
    const taxi = evaluateTaxiRoster(roster, playersMap, seasonChain, rosterOverrides, promotedRegistry, teamNameByRosterId);
    return {
      roster, teamName: teamNameFor(roster), qb, te, taxi,
      autoMoveCount: autoSummary.moveCount || 0,
      manualAdjustment: 0,
    };
  });

  return { league, rosters, users, playersMap, seasonChain, results, teamNameByRosterId };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sleeperApi,
    fetchPlayersMapRaw,
    fetchDraftPicksForLeague,
    fetchTransactionsForLeague,
    buildSeasonChain,
    evaluateLeague,
  };
}
