const stateEls = {
  runStatus: document.querySelector("#run-status"),
  runSurface: document.querySelector("#run-surface"),
  startedAt: document.querySelector("#started-at"),
  exitCode: document.querySelector("#exit-code"),
  logs: document.querySelector("#logs"),
  casesBody: document.querySelector("#cases-body"),
  bugsBody: document.querySelector("#bugs-body"),
  stopRuns: document.querySelectorAll("[data-stop-run]"),
  updatedAt: document.querySelector("#updated-at"),
  filter: document.querySelector("#case-filter"),
  counts: {
    PENDING: document.querySelector("#count-pending"),
    RUNNING: document.querySelector("#count-running"),
    PASS: document.querySelector("#count-pass"),
    FAIL: document.querySelector("#count-fail"),
    SKIP: document.querySelector("#count-skip")
  }
};

let latestRows = [];

const formatDate = (value) => {
  if (!value) return "-";
  return new Date(value).toLocaleString();
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const statusClass = (status) => {
  if (status === "PASS") return "pass";
  if (status === "FAIL") return "fail";
  if (status === "RUNNING") return "running";
  if (status === "SKIP") return "skip";
  return "pending";
};

const renderEvidence = (row) => {
  const notes = Array.isArray(row.evidenceNotes)
    ? row.evidenceNotes.map((note) => `<div>${escapeHtml(note)}</div>`).join("")
    : "";
  const screenshots = Array.isArray(row.screenshotPaths)
    ? row.screenshotPaths
        .map((item, index) => `<a href="/report/${escapeHtml(item)}" target="_blank" rel="noreferrer">Shot ${index + 1}</a>`)
        .join("<br>")
    : "";
  return [notes, screenshots].filter(Boolean).join("<br>");
};

const renderRows = () => {
  const filter = stateEls.filter.value.trim().toLowerCase();
  const rows = latestRows.filter((row) => {
    if (!filter) return true;
    return [
      row.id,
      row.testingLevel,
      row.priority,
      row.status,
      row.moduleSuite,
      row.testCaseTitle,
      row.precondition,
      row.inputAction,
      row.testData,
      row.expectedResult,
      row.actualResult,
      row.proof,
      row.automationStatus
    ]
      .join(" ")
      .toLowerCase()
      .includes(filter);
  });

  if (rows.length === 0) {
    stateEls.casesBody.innerHTML = '<tr><td colspan="14" class="empty">No matching test cases.</td></tr>';
    return;
  }

  stateEls.casesBody.innerHTML = rows
    .map((row) => {
      return `<tr>
        <td>${escapeHtml(row.id)}</td>
        <td>${escapeHtml(row.testingLevel)}</td>
        <td>${escapeHtml(row.priority)}</td>
        <td class="status ${statusClass(row.status)}">${escapeHtml(row.status)}</td>
        <td>${escapeHtml(row.moduleSuite)}</td>
        <td>${escapeHtml(row.testCaseTitle)}</td>
        <td>${escapeHtml(row.precondition)}</td>
        <td>${escapeHtml(row.inputAction)}</td>
        <td>${escapeHtml(row.testData)}</td>
        <td>${escapeHtml(row.expectedResult)}</td>
        <td>${escapeHtml(row.actualResult)}</td>
        <td>${escapeHtml(row.proof)}</td>
        <td>${escapeHtml(row.automationStatus)}</td>
        <td class="evidence">${renderEvidence(row)}</td>
      </tr>`;
    })
    .join("");
};

const renderBugs = () => {
  const failedRows = latestRows.filter((row) => row.status === "FAIL");
  if (failedRows.length === 0) {
    stateEls.bugsBody.innerHTML = '<tr><td colspan="5" class="empty">No failed tests in the current report.</td></tr>';
    return;
  }

  stateEls.bugsBody.innerHTML = failedRows
    .map((row) => {
      return `<tr>
        <td>${escapeHtml(row.id)}</td>
        <td>${escapeHtml(row.surface)}</td>
        <td>${escapeHtml(row.featureArea)}</td>
        <td>${escapeHtml(row.bugReport || `Bug: ${row.scenario}`)}</td>
        <td class="evidence">${renderEvidence(row)}</td>
      </tr>`;
    })
    .join("");
};

const refreshStatus = async () => {
  const response = await fetch("/api/status", { cache: "no-store" });
  const status = await response.json();
  stateEls.runStatus.textContent = status.running ? "Running" : "Idle";
  stateEls.runSurface.textContent = status.surface || "-";
  stateEls.startedAt.textContent = formatDate(status.startedAt);
  stateEls.exitCode.textContent = status.exitCode === null || status.exitCode === undefined ? "-" : String(status.exitCode);
  stateEls.logs.textContent = Array.isArray(status.logs) && status.logs.length > 0 ? status.logs.join("\n") : "No run started.";
  stateEls.logs.scrollTop = stateEls.logs.scrollHeight;
  document.querySelectorAll("button[data-surface]").forEach((button) => {
    button.disabled = Boolean(status.running);
  });
  stateEls.stopRuns.forEach((button) => {
    button.disabled = !status.running || Boolean(status.stopRequested);
    button.textContent = status.stopRequested ? "Stopping..." : "Stop Run";
  });
};

const refreshResults = async () => {
  const response = await fetch("/api/results", { cache: "no-store" });
  const results = await response.json();
  latestRows = Array.isArray(results.rows) ? results.rows : [];
  const counts = results.counts || {};
  for (const key of Object.keys(stateEls.counts)) {
    stateEls.counts[key].textContent = String(counts[key] || 0);
  }
  stateEls.updatedAt.textContent = results.updatedAt
    ? `Updated ${formatDate(results.updatedAt)}. Run status: ${results.runStatus}.`
    : "Waiting for a generated test inventory.";
  renderRows();
  renderBugs();
};

const startRun = async (surface) => {
  const payload = {
    surface,
    reset: document.querySelector("#reset-db").checked,
    headed: document.querySelector("#headed").checked
  };
  const response = await fetch("/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unable to start run." }));
    alert(error.error || "Unable to start run.");
    return;
  }
  await refreshStatus();
  await refreshResults();
};

const stopRun = async () => {
  const response = await fetch("/api/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unable to stop run." }));
    alert(error.error || "Unable to stop run.");
    return;
  }
  await refreshStatus();
};

document.querySelectorAll("button[data-surface]").forEach((button) => {
  button.addEventListener("click", () => startRun(button.dataset.surface));
});

stateEls.filter.addEventListener("input", renderRows);
stateEls.stopRuns.forEach((button) => {
  button.addEventListener("click", stopRun);
});

const poll = async () => {
  await Promise.all([refreshStatus(), refreshResults()]).catch((error) => {
    stateEls.logs.textContent = `Dashboard refresh failed: ${error.message}`;
  });
};

poll();
setInterval(poll, 2500);
