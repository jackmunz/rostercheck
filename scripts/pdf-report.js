// Renders the same violations-focused report as the browser's jsPDF version,
// using pdfkit (a well-established Node PDF library) since jsPDF is a
// browser-oriented UMD build not meant for server-side use. Returns a Buffer.
// Expects a report built by logic.js's buildViolationReport().

const PDFDocument = require('pdfkit');

// Colors lifted from style.css so the emailed PDF matches the app's look.
const COLOR = {
  bg: '#10151b',
  text: '#eceff3',
  textDim: '#8c97a6',
  line: '#2e3844',
  accent: '#3e8e5f',
  warn: '#e8a33d',
  danger: '#e0524a',
};

function renderReportToBuffer(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    function paintBackground() {
      doc.save();
      doc.rect(0, 0, doc.page.width, doc.page.height).fill(COLOR.bg);
      doc.restore();
    }
    // Fill the background on every page, including ones pdfkit auto-adds
    // when content overflows.
    doc.on('pageAdded', paintBackground);
    paintBackground();

    function heading(text, color = COLOR.text, size = 13) {
      doc.font('Helvetica-Bold').fontSize(size).fillColor(color).text(text.toUpperCase());
      doc.moveDown(0.4);
    }
    function body(text, opts = {}) {
      const { indent = 0, color = COLOR.text, bold = false, size = 10 } = opts;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color)
        .text(text, { indent });
    }
    function divider() {
      doc.moveDown(0.5);
      const y = doc.y;
      doc.strokeColor(COLOR.line).moveTo(doc.page.margins.left, y)
        .lineTo(doc.page.width - doc.page.margins.right, y).stroke();
      doc.moveDown(0.8);
    }

    doc.font('Helvetica-Bold').fontSize(20).fillColor(COLOR.accent).text('RosterCheck');
    doc.font('Helvetica-Bold').fontSize(13).fillColor(COLOR.text).text('Violation Report');
    doc.moveDown(0.6);

    body(`${report.leagueName}${report.season ? ' \u00b7 ' + report.season : ''}`, { color: COLOR.textDim });
    body(`Generated ${new Date(report.generatedAt).toLocaleString()}`, { color: COLOR.textDim });
    doc.moveDown(0.3);
    body(
      `${report.summary.violation} violation(s)  \u00b7  ${report.summary.review} needing review  \u00b7  ${report.summary.ok} compliant`,
      { bold: true }
    );
    divider();

    // ---- Activity summary ----
    heading('Activity Summary', COLOR.warn);

    body('Taxi Moves This Season', { bold: true, size: 11 });
    if (report.activity.taxiMoves.length === 0) {
      body('No taxi moves logged yet.', { indent: 12, color: COLOR.textDim });
    } else {
      for (const m of report.activity.taxiMoves) {
        const over = m.moveCount > m.cap;
        body(`${m.teamName}: ${m.moveCount}/${m.cap}${over ? '  (OVER LIMIT)' : ''}`, { indent: 12, color: over ? COLOR.danger : COLOR.text });
      }
    }
    doc.moveDown(0.4);

    body('Taxi Promotions', { bold: true, size: 11 });
    if (report.activity.taxiPromotions.length === 0) {
      body('No promotions detected yet.', { indent: 12, color: COLOR.textDim });
    } else {
      for (const p of report.activity.taxiPromotions) {
        body(`${p.teamName}: ${p.player} promoted from taxi on ${p.date}`, { indent: 12 });
      }
    }
    doc.moveDown(0.4);

    body('QB/TE Moves of Note', { bold: true, size: 11 });
    if (report.activity.qbteMoves.length === 0) {
      body('No flagged QB/TE roster moves.', { indent: 12, color: COLOR.textDim });
    } else {
      for (const m of report.activity.qbteMoves) {
        body(`${m.teamName} [${m.category}] ${m.player}: ${m.note}`, { indent: 12 });
      }
    }
    divider();

    // ---- Violations ----
    heading('Violations', COLOR.danger);

    if (report.violationTeams.length === 0) {
      body('No violations found.', { color: COLOR.accent, bold: true });
    } else {
      for (const team of report.violationTeams) {
        // colored left bar to mimic the app's card accent
        const barY = doc.y;
        doc.rect(doc.page.margins.left, barY + 2, 3, 14).fill(COLOR.danger);
        body(team.teamName, { indent: 12, bold: true, size: 12, color: COLOR.danger });
        for (const issue of team.issues) {
          body(`[${issue.category}] ${issue.player}: ${issue.reason}`, { indent: 24 });
        }
        doc.moveDown(0.6);
      }
    }

    doc.end();
  });
}

module.exports = { renderReportToBuffer };
