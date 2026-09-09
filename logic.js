// ---- Pure rule-engine logic for the QB/TE roster exception rule ----
// No network calls in here - everything is passed in as data so it can be unit tested.

const MAX_BASE = { QB: 2, TE: 2 };
const EXCEPTION_YEARS_EXP_MAX = 1; // years_exp 0 (rookie) or 1 (2nd year) qualifies
const MAX_HOPS = 15; // safety limit when walking trade chains

// Computes an approximate NFL Week 1 kickoff date for a season:
// Thursday following Labor Day (first Monday of September).
function computeWeek1Date(season, overrides = {}) {
  if (overrides[season]) return new Date(overrides[season] + 'T00:00:00Z');
  const year = Number(season);
  const sept1 = new Date(Date.UTC(year, 8, 1)); // month 8 = September
  const dayOfWeek = sept1.getUTCDay(); // 0=Sun..6=Sat
  const daysUntilMonday = (8 - dayOfWeek) % 7; // days from Sept1 to first Monday
  const laborDay = new Date(Date.UTC(year, 8, 1 + daysUntilMonday));
  const week1 = new Date(laborDay);
  week1.setUTCDate(week1.getUTCDate() + 3); // Thursday after Labor Day
  return week1;
}

// Given a roster and the players map, returns arrays of player_ids at QB and TE.
// Only counts players against the QB/TE limit if they're on the active/bench
// roster - taxi squad and IR are separate roster real estate in dynasty formats
// and have their own rules (taxi) or are exempted by convention (IR), so a
// player sitting in either shouldn't also count against the 2+1 QB/TE limit.
function classifyRosterPositions(roster, playersMap) {
  const out = { QB: [], TE: [] };
  const ids = roster.players || [];
  const excludedIds = new Set([...(roster.taxi || []), ...(roster.reserve || [])]);
  for (const pid of ids) {
    if (excludedIds.has(pid)) continue;
    const p = playersMap[pid];
    if (!p) continue;
    if (p.position === 'QB') out.QB.push(pid);
    if (p.position === 'TE') out.TE.push(pid);
  }
  return out;
}

// seasonChain: array ordered [currentSeason, ...pastSeasons], each:
//   { season: '2026', transactions: [...], draftPicks: [{round,pick_no,roster_id,player_id}], week1Date }
// Finds the transaction (in a given season) that most recently placed `playerId` onto `rosterId`,
// i.e. the last completed add for that player/roster pair, ignoring transactions after "asOf".
function findLatestAdd(seasonEntry, playerId, rosterId, asOf) {
  const txns = (seasonEntry.transactions || [])
    .filter(t => t.status === 'complete')
    .filter(t => t.adds && t.adds[playerId] === rosterId)
    .filter(t => !asOf || t.created <= asOf)
    .sort((a, b) => b.created - a.created);
  return txns[0] || null;
}

// Finds a rookie-draft pick record for this player/roster in a given season, if any.
function findDraftPick(seasonEntry, playerId, rosterId) {
  const picks = seasonEntry.draftPicks || [];
  return picks.find(p => p.player_id === playerId && p.roster_id === rosterId) || null;
}

// Walks the acquisition chain backward from the current roster to determine whether
// the player's presence on that roster traces back, via trades only, to either:
//   (a) a rookie-draft pick, or
//   (b) a waiver/free_agent add completed before that rookie season's Week 1.
// Returns { eligible: true|false|null, reason, trail }
// Resolves a roster_id to a display name, falling back to "Roster N" when no
// name map is provided (e.g. in contexts without Sleeper user data on hand).
function nameForRoster(rosterId, teamNameByRosterId) {
  return (teamNameByRosterId && teamNameByRosterId[rosterId]) || `Roster ${rosterId}`;
}

function traceEligibility(playerId, currentRosterId, seasonChain, teamNameByRosterId = {}) {
  const trail = [];
  const chain = []; // structured acquisition steps, discovered most-recent-first, for formatAcquisitionSummary
  let rosterId = currentRosterId;
  let seasonIdx = 0;
  let asOf = undefined; // cursor moving backward in time

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (seasonIdx >= seasonChain.length) {
      trail.push(`No further season history available - inconclusive.`);
      return { eligible: null, reason: 'Ran out of season history to trace.', trail, chain };
    }
    const seasonEntry = seasonChain[seasonIdx];

    // Case 1: drafted onto this roster this season -> qualifying base case.
    const pick = findDraftPick(seasonEntry, playerId, rosterId);
    if (pick) {
      trail.push(`Drafted by ${nameForRoster(rosterId, teamNameByRosterId)} in the ${seasonEntry.season} draft (round ${pick.round}). Qualifies.`);
      chain.push({ type: 'draft', season: seasonEntry.season, round: pick.round });
      return { eligible: true, reason: 'Drafted in rookie draft.', trail, chain };
    }

    // Case 2: find the transaction that put the player on this roster (most recent before asOf).
    const txn = findLatestAdd(seasonEntry, playerId, rosterId, asOf);
    if (!txn) {
      // No transaction found this season (before the current cursor) for this roster -
      // the roster likely just held the player through this season with no move.
      // Step back to the previous season and keep looking for the original acquisition.
      trail.push(`No add transaction found for ${nameForRoster(rosterId, teamNameByRosterId)} in ${seasonEntry.season} (held with no move) - checking earlier season.`);
      seasonIdx += 1;
      asOf = undefined;
      continue;
    }

    if (txn.type === 'trade') {
      // Find which roster this player was dropped from in the same trade.
      const fromRosterId = txn.drops ? txn.drops[playerId] : undefined;
      trail.push(`Traded to ${nameForRoster(rosterId, teamNameByRosterId)} on ${new Date(txn.created).toISOString().slice(0, 10)} (from ${nameForRoster(fromRosterId, teamNameByRosterId)}). Exception carries forward - continuing trace.`);
      if (fromRosterId === undefined || fromRosterId === null) {
        trail.push('Trade record missing origin roster - inconclusive.');
        return { eligible: null, reason: 'Incomplete trade record.', trail, chain };
      }
      chain.push({ type: 'trade', fromRosterId, created: txn.created, season: seasonEntry.season, week1Date: seasonEntry.week1Date });
      rosterId = fromRosterId;
      asOf = txn.created; // keep looking earlier than this trade
      continue;
    }

    if (txn.type === 'waiver' || txn.type === 'free_agent') {
      const week1 = seasonEntry.week1Date;
      const acquiredDate = new Date(txn.created);
      chain.push({ type: txn.type, created: txn.created, season: seasonEntry.season, week1Date: seasonEntry.week1Date });
      if (week1 && acquiredDate <= week1) {
        trail.push(`Added via ${txn.type} on ${acquiredDate.toISOString().slice(0, 10)}, before Week 1 (${week1.toISOString().slice(0, 10)}) of ${seasonEntry.season}. Qualifies.`);
        return { eligible: true, reason: 'Acquired before Week 1 of rookie/2nd-year season.', trail, chain };
      } else {
        trail.push(`Added via ${txn.type} on ${acquiredDate.toISOString().slice(0, 10)}, after Week 1 kickoff. Breaks the exception chain.`);
        return { eligible: false, reason: 'Picked up on waivers/free agency after Week 1.', trail, chain };
      }
    }

    trail.push(`Unrecognized transaction type "${txn.type}" - inconclusive.`);
    return { eligible: null, reason: 'Unrecognized transaction type.', trail, chain };
  }

  trail.push('Exceeded max trace hops - inconclusive.');
  return { eligible: null, reason: 'Trade chain too long to trace.', trail, chain };
}

// Full evaluation for one position group (QB or TE) on one roster.
// playerIds: array of player_ids at that position on the roster
// playersMap: id -> {years_exp, full_name, ...}
// Returns { count, max, violation, exemptPlayerId, needsReview, details: {playerId: {eligible, reason, trail}} }
// Classifies when an acquisition event happened relative to that season's Week 1:
// "Offseason {season}" for anything at/before Week 1 kickoff (covers the whole gap
// between the prior season ending and this season's Week 1), otherwise
// "Week {N} of {season} season" based on how many 7-day windows past Week 1.
function classifyAcquisitionTiming(timestamp, week1Date, season) {
  const d = new Date(timestamp);
  if (!week1Date || d <= week1Date) return `Offseason ${season}`;
  const weeksSince = Math.floor((d - week1Date) / (7 * 24 * 60 * 60 * 1000)) + 1;
  return `Week ${weeksSince} of ${season} season`;
}

// Formats a human-readable acquisition summary from the structured `chain` array
// produced by traceEligibility (most-recent-first). teamNameByRosterId maps
// roster_id -> current display name, used to label any trade partners in the chain.
// Returns null if the chain is empty (e.g. a manual override with no traced history).
function formatAcquisitionSummary(chain, teamNameByRosterId) {
  if (!chain || chain.length === 0) return null;
  const base = chain[chain.length - 1];
  if (base.type !== 'draft' && base.type !== 'waiver' && base.type !== 'free_agent') {
    return null; // incomplete chain (e.g. ran out of history mid-trade) - caller should fall back
  }
  let desc = base.type === 'draft'
    ? `Rookie Draft ${base.season}`
    : classifyAcquisitionTiming(base.created, base.week1Date, base.season);

  for (let i = chain.length - 2; i >= 0; i--) {
    const step = chain[i]; // a trade step
    const timing = classifyAcquisitionTiming(step.created, step.week1Date, step.season);
    const teamName = (teamNameByRosterId && teamNameByRosterId[step.fromRosterId]) || `Roster ${step.fromRosterId}`;
    desc = `Trade (${timing}) from ${teamName} who acquired via ${desc}`;
  }
  return desc;
}

function evaluatePositionGroup(pos, playerIds, playersMap, currentRosterId, seasonChain, manualOverrides = {}, teamNameByRosterId = {}) {
  const base = MAX_BASE[pos];
  const details = {};
  const count = playerIds.length;

  if (count <= base) {
    return { count, max: base, violation: false, needsReview: false, exemptPlayerId: null, details };
  }

  // Find candidates that could qualify for the single exception slot.
  // Only players who could plausibly USE the exception (rookies/2nd-year, or an
  // explicit manual override) are evaluated at all - a veteran was never attempting
  // to claim the exception slot, so they get no per-player status here and simply
  // render as a normal, compliant roster player filling one of the base slots.
  const candidates = [];
  for (const pid of playerIds) {
    const p = playersMap[pid] || {};
    const override = manualOverrides[pid];
    if (override === 'approved') {
      details[pid] = { eligible: true, reason: 'Manually approved by commissioner.', trail: [] };
      candidates.push(pid);
      continue;
    }
    if (override === 'violation') {
      details[pid] = { eligible: false, reason: 'Manually marked as violation by commissioner.', trail: [] };
      continue;
    }
    const yearsExp = p.years_exp;
    if (yearsExp === undefined || yearsExp === null || yearsExp > EXCEPTION_YEARS_EXP_MAX) {
      continue; // not a rookie/2nd-year - never a candidate, not flagged, just a normal roster player
    }
    const result = traceEligibility(pid, currentRosterId, seasonChain, teamNameByRosterId);
    details[pid] = result;
    if (result.eligible) candidates.push(pid);
  }

  const allowedExtra = 1; // only one exception slot per position
  const allowedTotal = base + allowedExtra;

  if (count <= allowedTotal && candidates.length >= (count - base)) {
    // Exactly enough (or more) qualifying candidates to cover the overage - compliant.
    // Only the player actually filling the exception slot (or an explicit manual
    // override) should carry a visible status; other rookies/2nd-years who were
    // evaluated as potential candidates but aren't needed (because someone else
    // already covers the one exception slot) should look like normal roster
    // players, not get blamed for their own individually-failed trace.
    const exemptPlayerId = candidates[0];
    const trimmedDetails = {};
    for (const [pid, detail] of Object.entries(details)) {
      if (pid === exemptPlayerId || manualOverrides[pid]) trimmedDetails[pid] = detail;
    }
    return {
      count, max: base, violation: false, needsReview: false,
      exemptPlayerId, details: trimmedDetails
    };
  }

  const anyInconclusive = Object.values(details).some(d => d.eligible === null);
  if (count <= allowedTotal && candidates.length === 0 && anyInconclusive) {
    return { count, max: base, violation: false, needsReview: true, exemptPlayerId: null, details };
  }

  // Either too many players even with the exception, or no one qualifies for it.
  return {
    count, max: base, violation: true,
    needsReview: anyInconclusive,
    exemptPlayerId: candidates[0] || null,
    details
  };
}

// ---------------- Taxi squad rules ----------------

const TAXI_YEARS_EXP_MAX = 1; // 1st or 2nd year player
const TAXI_MAX_SEASONS = 2;
const TAXI_MAX_MOVES = 3;

// Evaluates whether a player currently on taxi is validly there:
// years_exp gate + acquisition trace (drafted / added before Week 1, trades carry forward).
function evaluateTaxiEligibility(playerId, rosterId, playersMap, seasonChain, manualOverride, teamNameByRosterId = {}) {
  if (manualOverride === 'approved') {
    return { eligible: true, reason: 'Manually approved by commissioner.', trail: [] };
  }
  if (manualOverride === 'violation') {
    return { eligible: false, reason: 'Manually marked as violation by commissioner.', trail: [] };
  }
  const p = playersMap[playerId] || {};
  const yearsExp = p.years_exp;
  if (yearsExp === undefined || yearsExp === null || yearsExp > TAXI_YEARS_EXP_MAX) {
    return { eligible: false, reason: `Not a 1st or 2nd-year player (years_exp=${yearsExp}).`, trail: [] };
  }
  return traceEligibility(playerId, rosterId, seasonChain, teamNameByRosterId);
}

// Counts how many PRIOR seasons (not the current one) a player appears in any
// roster's taxi array, using each season's historical roster snapshot.
// seasonChain entries here are expected to also carry a `rosters` array:
//   { season, rosters: [{ roster_id, taxi: [...] }, ...] }
function priorSeasonsOnTaxi(playerId, seasonChain) {
  let count = 0;
  const details = [];
  for (let i = 1; i < seasonChain.length; i++) { // skip index 0 = current season
    const entry = seasonChain[i];
    const onTaxi = (entry.rosters || []).some(r => (r.taxi || []).includes(playerId));
    if (onTaxi) {
      count += 1;
      details.push(entry.season);
    }
  }
  return { count, seasons: details };
}

function evaluateTaxiDuration(playerId, seasonChain) {
  const { count, seasons } = priorSeasonsOnTaxi(playerId, seasonChain);
  if (count >= TAXI_MAX_SEASONS) {
    return {
      violation: true,
      reason: `Already spent ${count} prior season(s) on taxi (${seasons.join(', ')}) - exceeds the ${TAXI_MAX_SEASONS}-season limit.`
    };
  }
  return { violation: false, reason: count > 0 ? `On taxi in ${count} prior season(s) (${seasons.join(', ')}).` : 'First season on taxi.' };
}

// Full taxi evaluation for one roster's current taxi squad.
// promotedRegistry: array of player_ids previously promoted off taxi for this roster
//   (manually maintained) - if one of them is back on taxi, that's a promotion-rule violation
//   unless the commissioner has confirmed it went through waivers (handled via manualOverride).
function evaluateTaxiRoster(roster, playersMap, seasonChain, manualOverrides = {}, promotedRegistry = [], teamNameByRosterId = {}) {
  const taxiIds = roster.taxi || [];
  const results = {};
  for (const pid of taxiIds) {
    const override = manualOverrides[pid];
    const elig = evaluateTaxiEligibility(pid, roster.roster_id, playersMap, seasonChain, override, teamNameByRosterId);
    const duration = evaluateTaxiDuration(pid, seasonChain);
    const wasPromoted = promotedRegistry.includes(pid);
    const promotionViolation = wasPromoted && override !== 'approved';
    const violation = elig.eligible === false || duration.violation || promotionViolation;
    const needsReview = !violation && elig.eligible === null;
    results[pid] = { eligibility: elig, duration, wasPromoted, promotionViolation, violation, needsReview };
  }
  return results;
}

// ---------------- Report building (shared by client-side PDF and the daily email job) ----------------

// results: array of { roster, teamName, qb, te, taxi, autoMoveCount, manualAdjustment }
// where qb/te are evaluatePositionGroup() outputs and taxi is evaluateTaxiRoster() output,
// and taxi entries carry the player_id keys used to look up names via playersMap.
function buildReportData(leagueMeta, results, playersMap, teamNameByRosterId = {}) {
  const teams = results.map(r => {
    const issues = [];

    for (const pos of ['qb', 'te']) {
      const group = r[pos];
      const label = pos.toUpperCase();
      if (!group || (!group.violation && !group.needsReview)) continue;
      let reportedAny = false;
      for (const [pid, detail] of Object.entries(group.details || {})) {
        if (detail.eligible === true) continue; // exception slot granted - not an issue
        const name = (playersMap[pid] && playersMap[pid].full_name) || pid;
        const status = detail.eligible === false ? 'VIOLATION' : 'NEEDS REVIEW';
        // Prefer the friendly "Trade from X who acquired via..." summary over the
        // raw internal trace-walk message; fall back to the short reason when the
        // chain is incomplete (e.g. an inconclusive review case).
        const reason = formatAcquisitionSummary(detail.chain, teamNameByRosterId) || detail.reason;
        issues.push({ category: label, player: name, status, reason });
        reportedAny = true;
      }
      if (group.violation && !reportedAny) {
        // No individual player could be pinpointed (e.g. all veterans, none ever
        // attempting the exception) - the violation is a pure roster-count issue.
        issues.push({
          category: label, player: '-', status: 'VIOLATION',
          reason: `Roster carries ${group.count} ${label}s (limit ${group.max}, plus 1 rookie/2nd-year exception) with no eligible player to fill the exception slot.`
        });
      }
    }

    for (const [pid, t] of Object.entries(r.taxi || {})) {
      if (!t.violation && !t.needsReview) continue;
      const name = (playersMap[pid] && playersMap[pid].full_name) || pid;
      const status = t.violation ? 'VIOLATION' : 'NEEDS REVIEW';
      const reasonParts = [];
      if (t.eligibility && t.eligibility.eligible !== true) {
        reasonParts.push(formatAcquisitionSummary(t.eligibility.chain, teamNameByRosterId) || t.eligibility.reason);
      }
      if (t.duration && t.duration.violation) reasonParts.push(t.duration.reason);
      if (t.promotionViolation) reasonParts.push('Previously promoted off taxi - cannot return without going through waivers.');
      issues.push({ category: 'Taxi', player: name, status, reason: reasonParts.join(' ') });
    }

    const totalMoves = (r.autoMoveCount || 0) + (r.manualAdjustment || 0);
    if (totalMoves > TAXI_MAX_MOVES) {
      issues.push({ category: 'Taxi Moves', player: '-', status: 'VIOLATION', reason: `${totalMoves}/${TAXI_MAX_MOVES} taxi moves used this season.` });
    }

    const status = issues.some(i => i.status === 'VIOLATION') ? 'violation'
      : issues.some(i => i.status === 'NEEDS REVIEW') ? 'review'
      : 'ok';

    return { teamName: r.teamName, status, issues };
  });

  const summary = {
    ok: teams.filter(t => t.status === 'ok').length,
    review: teams.filter(t => t.status === 'review').length,
    violation: teams.filter(t => t.status === 'violation').length,
  };

  return {
    leagueName: leagueMeta.name || 'Untitled League',
    season: leagueMeta.season || '',
    generatedAt: new Date().toISOString(),
    summary,
    teams,
  };
}

// Reshapes buildReportData's output into the violations-focused report format:
// a top activity summary (taxi moves, taxi promotions, QB/TE-impacting moves)
// followed by ONLY the teams currently in violation (not "needs review").
// results: same shape passed to buildReportData (must include autoMoveCount,
// manualAdjustment, taxiLog for the activity summary sections).
function buildViolationReport(leagueMeta, results, playersMap, teamNameByRosterId = {}) {
  const full = buildReportData(leagueMeta, results, playersMap, teamNameByRosterId);

  const taxiMoves = results
    .map(r => ({
      teamName: r.teamName,
      moveCount: (r.autoMoveCount || 0) + (r.manualAdjustment || 0),
      cap: TAXI_MAX_MOVES,
    }))
    .filter(m => m.moveCount > 0)
    .sort((a, b) => b.moveCount - a.moveCount);

  const taxiPromotions = [];
  for (const r of results) {
    for (const day of (r.taxiLog || [])) {
      for (const ev of (day.events || [])) {
        if (ev.type === 'promoted_active') {
          const name = (playersMap[ev.player_id] && playersMap[ev.player_id].full_name) || ev.player_id;
          taxiPromotions.push({ teamName: r.teamName, player: name, date: day.date });
        }
      }
    }
  }
  taxiPromotions.sort((a, b) => (a.date < b.date ? 1 : -1));

  const qbteMoves = [];
  for (const r of results) {
    for (const pos of ['qb', 'te']) {
      const group = r[pos];
      if (!group || !group.violation) continue;
      for (const [pid, detail] of Object.entries(group.details || {})) {
        if (detail.eligible !== false) continue; // only confirmed violations, not review/exception
        const name = (playersMap[pid] && playersMap[pid].full_name) || pid;
        const note = formatAcquisitionSummary(detail.chain, teamNameByRosterId) || detail.reason;
        qbteMoves.push({ teamName: r.teamName, category: pos.toUpperCase(), player: name, note });
      }
    }
  }

  const violationTeams = full.teams
    .filter(t => t.status === 'violation')
    .map(t => ({ teamName: t.teamName, issues: t.issues.filter(i => i.status === 'VIOLATION') }));

  return {
    leagueName: full.leagueName,
    season: full.season,
    generatedAt: full.generatedAt,
    summary: full.summary,
    activity: { taxiMoves, taxiPromotions, qbteMoves },
    violationTeams,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    computeWeek1Date,
    classifyRosterPositions,
    findLatestAdd,
    findDraftPick,
    traceEligibility,
    nameForRoster,
    classifyAcquisitionTiming,
    formatAcquisitionSummary,
    evaluatePositionGroup,
    evaluateTaxiEligibility,
    evaluateTaxiDuration,
    evaluateTaxiRoster,
    priorSeasonsOnTaxi,
    diffSnapshots,
    summarizeEvents,
    buildReportData,
    buildViolationReport,
    MAX_BASE,
    EXCEPTION_YEARS_EXP_MAX,
    TAXI_YEARS_EXP_MAX,
    TAXI_MAX_SEASONS,
    TAXI_MAX_MOVES
  };
}

// ---------------- Daily snapshot diffing (for background taxi-move detection) ----------------

// Compares two daily snapshots ({ date, season, rosters: [{roster_id, players, starters, reserve, taxi}] })
// and returns per-roster events for that day, classifying each taxi change.
function diffSnapshots(prev, curr) {
  const rosterIds = new Set([
    ...(prev.rosters || []).map(r => r.roster_id),
    ...(curr.rosters || []).map(r => r.roster_id),
  ]);
  const byId = (snap, id) => (snap.rosters || []).find(r => r.roster_id === id) || {};
  const findOwner = (snap, pid, excludeId) => {
    const hit = (snap.rosters || []).find(r => r.roster_id !== excludeId && (r.players || []).includes(pid));
    return hit ? hit.roster_id : null;
  };

  const rosterEvents = {};

  for (const id of rosterIds) {
    const prevR = byId(prev, id);
    const currR = byId(curr, id);
    const prevTaxi = prevR.taxi || [];
    const currTaxi = currR.taxi || [];
    const removed = prevTaxi.filter(pid => !currTaxi.includes(pid));
    const added = currTaxi.filter(pid => !prevTaxi.includes(pid));
    const events = [];

    for (const pid of removed) {
      if ((currR.players || []).includes(pid)) {
        if ((currR.reserve || []).includes(pid)) {
          events.push({ type: 'moved_to_ir', player_id: pid });
        } else {
          events.push({ type: 'promoted_active', player_id: pid });
        }
      } else {
        const otherRoster = findOwner(curr, pid, id);
        if (otherRoster !== null) {
          events.push({ type: 'traded_off_taxi', player_id: pid, roster_to: otherRoster });
        } else {
          events.push({ type: 'dropped_from_taxi', player_id: pid });
        }
      }
    }

    for (const pid of added) {
      const wasOnThisRosterBefore = (prevR.players || []).includes(pid);
      if (wasOnThisRosterBefore) {
        events.push({ type: 'moved_to_taxi_from_active', player_id: pid });
      } else {
        const otherRoster = findOwner(prev, pid, id);
        if (otherRoster !== null) {
          events.push({ type: 'traded_onto_taxi', player_id: pid, roster_from: otherRoster });
        } else {
          events.push({ type: 'added_to_taxi_new', player_id: pid });
        }
      }
    }

    if (events.length > 0) {
      rosterEvents[id] = { date: curr.date, moveCount: 1, events };
    }
  }

  return { date: curr.date, season: curr.season, rosterEvents };
}

// Aggregates a list of per-day diff results (as produced by diffSnapshots, one per day)
// into per-roster totals for a given season: total moves, and player_ids ever promoted to active.
function summarizeEvents(dailyDiffs, season) {
  const perRoster = {};
  for (const day of dailyDiffs) {
    if (season && day.season !== season) continue;
    for (const [rosterId, info] of Object.entries(day.rosterEvents || {})) {
      if (!perRoster[rosterId]) perRoster[rosterId] = { moveCount: 0, promotedPlayerIds: new Set(), log: [] };
      perRoster[rosterId].moveCount += info.moveCount;
      perRoster[rosterId].log.push({ date: info.date, events: info.events });
      for (const ev of info.events) {
        if (ev.type === 'promoted_active') perRoster[rosterId].promotedPlayerIds.add(ev.player_id);
      }
    }
  }
  const out = {};
  for (const [rosterId, v] of Object.entries(perRoster)) {
    out[rosterId] = { moveCount: v.moveCount, promotedPlayerIds: Array.from(v.promotedPlayerIds), log: v.log };
  }
  return out;
}
