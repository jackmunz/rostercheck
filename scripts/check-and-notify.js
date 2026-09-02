// Runs once a day via GitHub Actions (after the taxi snapshot job, so it sees
// today's freshly-diffed taxi events). Evaluates the full rule set - QB/TE limits
// and taxi rules - and, if a violation is found, emails a PDF report.
//
// IMPORTANT LIMITATION: this automated check does NOT see any manual overrides
// or "previously promoted" markings you've set inside the app - those live in
// your browser's local storage, not in this repo. It's a pure, automated read
// of Sleeper's data plus the daily snapshot log. The in-app "Download PDF
// report" button, by contrast, reflects whatever you're currently looking at,
// overrides included. If the automated email flags something you've already
// resolved in the app, that's expected - resolve it there, and the daily email
// will simply keep reporting it as a reminder until the underlying data changes.

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const ROOT = path.join(__dirname, '..');
const logic = require(path.join(ROOT, 'logic.js'));
const sleeperClient = require(path.join(ROOT, 'sleeper-client.js'));
const { renderReportToBuffer } = require('./pdf-report.js');

function loadJSON(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

async function main() {
  const config = loadJSON(path.join(ROOT, 'config.json'), null);
  if (!config || !config.leagueId) {
    console.error('config.json is missing a "leagueId" value.');
    process.exit(1);
  }

  const week1Overrides = loadJSON(path.join(ROOT, 'data', 'week1-overrides.json'), {});
  const events = loadJSON(path.join(ROOT, 'data', 'events.json'), []);

  // We need the current season to filter events - fetch it first.
  const leagueMeta = await sleeperClient.sleeperApi(`/league/${config.leagueId}`);
  const autoSummaryByRoster = logic.summarizeEvents(events, leagueMeta.season);

  console.log('Evaluating league...');
  const { league, results, playersMap, teamNameByRosterId } = await sleeperClient.evaluateLeague(config.leagueId, {
    seasonsBack: config.seasonsBack || 2,
    weeksToScan: config.weeksToScan || 18,
    week1Overrides,
    autoSummaryByRoster,
    onProgress: (msg) => console.log(msg),
  });

  const report = logic.buildReportData(league, results, playersMap, teamNameByRosterId);
  console.log(`Summary: ${report.summary.ok} compliant, ${report.summary.review} needs review, ${report.summary.violation} violation(s).`);

  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', 'last-report.json'), JSON.stringify(report, null, 2));

  const notifyOn = config.notifyOn || 'violation';
  const shouldNotify = notifyOn === 'violation_and_review'
    ? (report.summary.violation > 0 || report.summary.review > 0)
    : report.summary.violation > 0;

  if (!shouldNotify) {
    console.log('No violations to report today - no email sent.');
    return;
  }

  const { EMAIL_USER, EMAIL_PASS, EMAIL_TO } = process.env;
  if (!EMAIL_USER || !EMAIL_PASS || !EMAIL_TO) {
    console.error('Violations found, but EMAIL_USER / EMAIL_PASS / EMAIL_TO secrets are not set - skipping email. See README for setup.');
    return;
  }

  console.log('Rendering PDF...');
  const violationReport = logic.buildViolationReport(league, results, playersMap, teamNameByRosterId);
  const pdfBuffer = await renderReportToBuffer(violationReport);

  console.log('Sending email...');
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });

  const dateStr = new Date().toISOString().slice(0, 10);
  await transporter.sendMail({
    from: EMAIL_USER,
    to: EMAIL_TO,
    subject: `RosterCheck: ${report.summary.violation} violation(s) found - ${report.leagueName}`,
    text: `RosterCheck found ${report.summary.violation} violation(s) and ${report.summary.review} item(s) needing review in ${report.leagueName} (${report.season}). Full report attached.`,
    attachments: [{ filename: `rostercheck-violations-${dateStr}.pdf`, content: pdfBuffer }],
  });

  console.log('Email sent.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
