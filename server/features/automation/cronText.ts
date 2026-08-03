/**
 * Two-way translation between cron expressions and plain English.
 *
 * The Schedules UI lets a tester type either form — "At 04:05 on day-of-month 5." or "5 4 5 * *" —
 * and always resolves to the exact expression the scheduler will run. Both directions live here, and
 * on the server, so the preview cannot drift from cronParser, which is what actually fires the job.
 */

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_SHORT = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const pad = (n: number) => String(n).padStart(2, '0');
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Expand "1,3", "1-5", "*\/2" into concrete numbers, or null when it is not a plain list. */
function expand(field: string, min: number, max: number): number[] | null {
  if (field === '*') return null;
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const step = part.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
    if (step) {
      const [from, to] = step[1] === '*' ? [min, max] : step[1].includes('-')
        ? step[1].split('-').map(Number) as [number, number]
        : [Number(step[1]), max];
      for (let i = from; i <= to; i += Number(step[2])) out.add(i);
      continue;
    }
    if (part.includes('-')) {
      const [from, to] = part.split('-').map(Number);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
      for (let i = from; i <= to; i++) out.add(i);
      continue;
    }
    const n = Number(part);
    if (!Number.isFinite(n)) return null;
    out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

function listNames(values: number[], names: string[]): string {
  return values.map((v) => titleCase(names[v % names.length] || String(v))).join(', ');
}

/** Cron expression → the sentence a tester can check at a glance. */
export function describeCron(expression: string): string {
  const parts = String(expression || '').trim().split(/\s+/);
  if (parts.length !== 5) return '';
  const [minute, hour, dom, month, dow] = parts;

  // Time phrase.
  let time: string;
  const everyMin = minute.match(/^\*\/(\d+)$/);
  if (minute === '*' && hour === '*') time = 'Every minute';
  else if (everyMin && hour === '*') time = `Every ${everyMin[1]} minutes`;
  else if (hour === '*') time = `At ${minute} minutes past every hour`;
  else {
    const everyHour = hour.match(/^\*\/(\d+)$/);
    const minutes = expand(minute, 0, 59);
    const hours = expand(hour, 0, 23);
    if (everyHour) time = `At minute ${minute} of every ${everyHour[1]} hours`;
    else if (minutes && hours && minutes.length === 1 && hours.length === 1) time = `At ${pad(hours[0])}:${pad(minutes[0])}`;
    else if (minutes && hours) time = `At ${hours.map((h) => minutes.map((m) => `${pad(h)}:${pad(m)}`).join(', ')).join(', ')}`;
    else time = `At ${hour}:${minute}`;
  }

  const clauses: string[] = [];
  const domValues = expand(dom, 1, 31);
  if (domValues) clauses.push(`on day-of-month ${domValues.join(', ')}`);
  const dowValues = expand(dow, 0, 6);
  if (dowValues) clauses.push(`on ${listNames(dowValues, DAY_NAMES)}`);
  const monthValues = expand(month, 1, 12);
  if (monthValues) clauses.push(`in ${listNames(monthValues.map((m) => m - 1), MONTH_NAMES)}`);

  return [time, ...clauses].join(' ');
}

function nameIndex(token: string): { day?: number; month?: number } {
  const t = token.toLowerCase();
  const day = DAY_NAMES.indexOf(t) >= 0 ? DAY_NAMES.indexOf(t) : DAY_SHORT.indexOf(t);
  if (day >= 0) return { day };
  const month = MONTH_NAMES.indexOf(t) >= 0 ? MONTH_NAMES.indexOf(t) : MONTH_SHORT.indexOf(t);
  if (month >= 0) return { month: month + 1 };
  return {};
}

/** Plain English → cron expression. Returns '' when nothing recognisable was found. */
export function parseCronText(input: string): string {
  const text = String(input || '').trim().toLowerCase().replace(/\.$/, '').replace(/\s+/g, ' ');
  if (!text) return '';

  let minute = '0';
  let hour = '*';
  let dom = '*';
  let month = '*';
  let dow = '*';
  let matched = false;

  // Interval phrases own the minute/hour fields outright.
  const everyMinutes = text.match(/every (\d+) minutes?/);
  const everyHours = text.match(/every (\d+) hours?/);
  if (/every minute\b/.test(text)) { minute = '*'; hour = '*'; matched = true; }
  else if (everyMinutes) { minute = `*/${everyMinutes[1]}`; hour = '*'; matched = true; }
  else if (everyHours) { minute = '0'; hour = `*/${everyHours[1]}`; matched = true; }
  else if (/every hour\b/.test(text)) { minute = '0'; hour = '*'; matched = true; }

  // "at 04:05", "at 4:05 pm", "at 9am"
  const clock = text.match(/at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (clock && !everyMinutes && !everyHours) {
    let h = Number(clock[1]);
    const m = clock[2] ? Number(clock[2]) : 0;
    if (clock[3] === 'pm' && h < 12) h += 12;
    if (clock[3] === 'am' && h === 12) h = 0;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) { hour = String(h); minute = String(m); matched = true; }
  }
  // "at minute 5" / "at 5 minutes past every hour"
  const pastHour = text.match(/at (?:minute )?(\d{1,2}) minutes? past/);
  if (pastHour) { minute = String(Number(pastHour[1])); hour = '*'; matched = true; }

  // "on day-of-month 5", "on day 5 of the month", "on the 5th"
  const domMatch = text.match(/day-of-month ([\d,\- ]+)/) || text.match(/on day ([\d,\- ]+?) of/) || text.match(/on the (\d{1,2})(?:st|nd|rd|th)/);
  if (domMatch) { dom = domMatch[1].replace(/\s/g, ''); matched = true; }

  // Day names anywhere in the sentence, plus the two common groupings.
  const days = new Set<number>();
  for (const token of text.split(/[^a-z]+/)) {
    const { day } = nameIndex(token);
    if (day !== undefined) days.add(day);
  }
  if (/weekdays?\b/.test(text) && !days.size) { dow = '1-5'; matched = true; }
  else if (/weekends?\b/.test(text) && !days.size) { dow = '0,6'; matched = true; }
  else if (days.size) { dow = [...days].sort((a, b) => a - b).join(','); matched = true; }

  // Month names ("in January and June").
  const months = new Set<number>();
  for (const token of text.split(/[^a-z]+/)) {
    const found = nameIndex(token).month;
    if (found !== undefined) months.add(found);
  }
  if (months.size) { month = [...months].sort((a, b) => a - b).join(','); matched = true; }

  if (!matched) return '';
  // A bare day/month phrase with no stated time means midnight, not "every minute of that day".
  if (hour === '*' && minute === '0' && (dom !== '*' || dow !== '*' || month !== '*')) hour = '0';
  return `${minute} ${hour} ${dom} ${month} ${dow}`;
}

/** True when the input already looks like a 5-field cron expression rather than a sentence. */
export function looksLikeCron(input: string): boolean {
  const parts = String(input || '').trim().split(/\s+/);
  return parts.length === 5 && parts.every((p) => /^[\d*/,\-]+$/.test(p));
}
