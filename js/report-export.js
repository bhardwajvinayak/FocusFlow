// js/report-export.js
// Productivity CSV and a small hand-written PDF writer. PURE: no DOM, no chrome.*, no storage, no
// network, no dependencies. Both formats contain AGGREGATE numbers only: no habit names, task titles or
// notes. Input is the object returned by buildProductivityInsights (js/insights.js). Never throws.
//
// PDF: one A4 page, built-in Helvetica (Latin-1 only; any other character is written as "?"), vector bar chart.

import { csvField } from './report.js';

export const PRODUCTIVITY_CSV_HEADER = Object.freeze([
  'date', 'weekday', 'status', 'focus_minutes', 'sessions', 'tasks_completed', 'habits_done', 'habits_tracked',
]);

const valid = (insights) => Boolean(insights && insights.report && Array.isArray(insights.days) && insights.days.length === 7);

function period(insights) {
  return `${insights.report.weekStartKey}_to_${insights.report.weekEndKey}`;
}

/** One header row and seven daily rows (CRLF). Days with no data have blank cells, never 0. */
export function productivityCsv(insights) {
  if (!valid(insights)) return '';
  const lines = [PRODUCTIVITY_CSV_HEADER.join(',')];
  for (const d of insights.days) {
    lines.push([d.date, d.weekday, d.status, d.minutes, d.sessions, d.tasksCompleted, d.habitsDone, d.habitsTracked].map(csvField).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function productivityCsvFilename(insights) {
  return valid(insights) ? `focusflow-productivity-${period(insights)}.csv` : 'focusflow-productivity.csv';
}

export function productivityPdfFilename(insights) {
  return valid(insights) ? `focusflow-productivity-${period(insights)}.pdf` : 'focusflow-productivity.pdf';
}

/* ---------------- PDF ---------------- */

function toLatin1(text) {
  let out = '';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    out += (code >= 32 && code < 127) || (code >= 160 && code < 256) ? ch : '?';
  }
  return out;
}

const esc = (text) => text.replace(/[\\()]/g, '\\$&');

function wrap(text, max) {
  const lines = [];
  let current = '';
  for (const word of String(text).split(/\s+/)) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > max && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

const cellText = (value) => (value === null || value === undefined ? '-' : String(value));

function assemble(content) {
  const objects = [
    null,
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [5 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i <= 6; i += 1) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += 'xref\n0 7\n0000000000 65535 f \n';
  for (let i = 1; i <= 6; i += 1) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

/** Returns a Uint8Array containing the PDF, or null if the input is not a valid insights object. */
export function buildProductivityPdf(insights, { generatedAt = new Date() } = {}) {
  if (!valid(insights)) return null;
  const r = insights.report;
  const ops = [];
  const text = (x, y, size, bold, str) => ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${esc(toLatin1(str))}) Tj ET`);

  text(50, 800, 18, true, 'FocusFlow weekly productivity report');
  text(50, 780, 11, false, `Period: ${r.weekStartKey} to ${r.weekEndKey}${r.isCurrentWeek ? ` (week to date, through ${r.throughKey})` : ''}. Weeks run Monday to Sunday, local time.`);
  const generated = generatedAt instanceof Date && !Number.isNaN(generatedAt.getTime()) ? generatedAt : new Date();
  text(50, 766, 9, false, `Generated on ${generated.getFullYear()}-${String(generated.getMonth() + 1).padStart(2, '0')}-${String(generated.getDate()).padStart(2, '0')} on this device.`);

  text(50, 740, 12, true, 'Summary');
  let y = 724;
  for (const line of insights.lines.slice(0, 8)) {
    for (const part of wrap(line.text, 95)) {
      text(60, y, 10, false, part);
      y -= 13;
    }
  }

  // Bar chart of focus minutes per day (a day with no data has no bar and reads "n/a").
  const chartTop = Math.min(y - 14, 600);
  text(50, chartTop, 12, true, 'Focus minutes per day');
  const base = chartTop - 110;
  const values = insights.days.map((d) => d.minutes);
  const max = Math.max(1, ...values.filter((v) => typeof v === 'number'));
  ops.push(`0.5 w 50 ${base} m 545 ${base} l S`);
  insights.days.forEach((d, i) => {
    const x = 60 + i * 70;
    if (typeof d.minutes === 'number' && d.minutes > 0) {
      ops.push(`0.31 0.27 0.9 rg ${x} ${base} 40 ${Math.max(1, Math.round((d.minutes / max) * 80))} re f 0 g`);
    }
    text(x + 4, base - 12, 9, false, d.weekday.slice(0, 3));
    text(x + 4, base + 4 + (typeof d.minutes === 'number' ? Math.round((d.minutes / max) * 80) : 0), 9, false, typeof d.minutes === 'number' ? String(d.minutes) : 'n/a');
  });

  // Daily table
  let ty = base - 40;
  text(50, ty, 12, true, 'Daily breakdown');
  ty -= 16;
  const cols = [50, 130, 210, 270, 350, 450];
  ['Date', 'Focus min', 'Sessions', 'Tasks done', 'Habits done/tracked', 'Status'].forEach((h, i) => text(cols[i], ty, 9, true, h));
  for (const d of insights.days) {
    ty -= 13;
    const habits = d.habitsTracked === null ? '-' : `${d.habitsDone}/${d.habitsTracked}`;
    [d.date, cellText(d.minutes), cellText(d.sessions), cellText(d.tasksCompleted), habits, d.status].forEach((v, i) => text(cols[i], ty, 9, false, v));
  }

  ty -= 22;
  const notes = [
    '"-" means no data (before your recorded history, upcoming, or nothing to track), which is different from 0.',
    'Task counts include only tasks still in your list. Habit numbers cover active habits from the day each was added.',
    'Totals are rounded to minutes. This report uses only data stored on this device.',
  ];
  for (const note of notes) {
    for (const part of wrap(note, 105)) {
      text(50, ty, 8, false, part);
      ty -= 11;
    }
  }

  const content = ops.join('\n');
  const pdf = assemble(content);
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i += 1) bytes[i] = pdf.charCodeAt(i) & 255;
  return bytes;
}