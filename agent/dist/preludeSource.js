export const pausePreludeSource = `
import { test as __testflowTest } from 'playwright/test';
const tf = {
  async pause(request) {
    return __testflowTest.step('pause: ' + request.prompt, async () => {
      const url = process.env.TESTFLOW_CONTROL_URL;
      const key = process.env.TESTFLOW_CONTROL_KEY;
      if (!url || !key) {
        console.warn('[TestFlow] pause skipped because no control channel is configured.');
        return '';
      }
      const headers = { 'content-type': 'application/json', 'x-testflow-control-key': key };
      const opened = await fetch(url + '/pause/open', { method: 'POST', headers, body: JSON.stringify(request) });
      if (!opened.ok) throw new Error('Unable to open pause (' + opened.status + '): ' + await opened.text());
      const { token } = await opened.json();
      for (;;) {
        const response = await fetch(url + '/pause/wait?token=' + encodeURIComponent(token), { headers });
        if (response.status === 204) continue;
        if (!response.ok) throw new Error('Unable to wait for pause (' + response.status + '): ' + await response.text());
        const answer = await response.json();
        if (answer.outcome === 'resolved') return answer.value || '';
        if (answer.outcome === 'skipped' || (answer.outcome === 'expired' && request.onTimeout === 'skip')) return '';
        throw new Error(answer.outcome === 'expired' ? 'Pause expired: ' + request.prompt : 'Pause aborted: ' + request.prompt);
      }
    });
  },
};
`;
//# sourceMappingURL=preludeSource.js.map