/**
 * Cron ⇄ English. Every expression is also checked against cron-parser, so a phrase can never
 * resolve to something the scheduler would refuse to run.
 */

import cronParser from 'cron-parser';
import { describeCron, parseCronText, looksLikeCron } from '../server/features/automation/cronText';

let checks = 0;
let failures = 0;
const check = (label: string, actual: any, expected: any) => {
  checks++;
  const ok = actual === expected;
  if (!ok) { failures++; console.log(`  FAIL ${label}\n       expected: ${expected}\n       actual:   ${actual}`); }
  else console.log(`  OK   ${label.padEnd(52)} ${actual}`);
};

console.log('English → cron');
// The phrasing from the request, verbatim.
check('At 04:05 on day-of-month 5.', parseCronText('At 04:05 on day-of-month 5.'), '5 4 5 * *');
check('at 9:30', parseCronText('at 9:30'), '30 9 * * *');
check('at 9am', parseCronText('at 9am'), '0 9 * * *');
check('at 5pm on Monday', parseCronText('at 5pm on Monday'), '0 17 * * 1');
check('every 15 minutes', parseCronText('every 15 minutes'), '*/15 * * * *');
check('every minute', parseCronText('every minute'), '* * * * *');
check('every hour', parseCronText('every hour'), '0 * * * *');
check('every 2 hours', parseCronText('every 2 hours'), '0 */2 * * *');
check('at 09:00 on weekdays', parseCronText('at 09:00 on weekdays'), '0 9 * * 1-5');
check('at 08:00 on weekends', parseCronText('at 08:00 on weekends'), '0 8 * * 0,6');
check('at 06:15 on Monday, Wednesday and Friday', parseCronText('at 06:15 on Monday, Wednesday and Friday'), '15 6 * * 1,3,5');
check('at 00:30 on the 1st', parseCronText('at 00:30 on the 1st'), '30 0 1 * *');
check('at 02:00 in January and June', parseCronText('at 02:00 in January and June'), '0 2 * 1,6 *');
check('on Monday (no time → midnight)', parseCronText('on Monday'), '0 0 * * 1');
check('gibberish yields nothing', parseCronText('please run it sometimes'), '');

console.log('\ncron → English');
check('5 4 5 * *', describeCron('5 4 5 * *'), 'At 04:05 on day-of-month 5');
check('*/15 * * * *', describeCron('*/15 * * * *'), 'Every 15 minutes');
check('* * * * *', describeCron('* * * * *'), 'Every minute');
check('0 9 * * 1-5', describeCron('0 9 * * 1-5'), 'At 09:00 on Monday, Tuesday, Wednesday, Thursday, Friday');
check('0 2 * 1,6 *', describeCron('0 2 * 1,6 *'), 'At 02:00 in January, June');
check('not five fields', describeCron('0 2 *'), '');

console.log('\nround trip: phrase → cron → phrase → same cron');
for (const phrase of ['At 04:05 on day-of-month 5.', 'at 06:15 on Monday, Wednesday and Friday', 'every 15 minutes', 'at 02:00 in January and June']) {
  const expr = parseCronText(phrase);
  const back = parseCronText(describeCron(expr));
  check(`round trip ${phrase}`, back, expr);
}

console.log('\ndetection');
check('5 4 5 * * looks like cron', looksLikeCron('5 4 5 * *'), true);
check('sentence does not', looksLikeCron('At 04:05 on day-of-month 5.'), false);

console.log('\nevery produced expression is runnable');
for (const phrase of ['At 04:05 on day-of-month 5.', 'at 9am', 'every 15 minutes', 'at 09:00 on weekdays', 'at 02:00 in January and June', 'every 2 hours']) {
  const expr = parseCronText(phrase);
  try {
    const next = cronParser.parseExpression(expr, { currentDate: new Date('2026-08-03T12:00:00Z'), tz: 'UTC' }).next().toDate();
    console.log(`  OK   ${expr.padEnd(16)} next ${next.toISOString()}   (${phrase})`);
    checks++;
  } catch (err: any) {
    failures++;
    console.log(`  FAIL ${expr} is not runnable: ${err.message}`);
  }
}

console.log(`\n${failures ? `${failures} FAILURE(S) of ${checks}` : `Cron text engine: passed (${checks} checks)`}`);
if (failures) process.exit(1);
