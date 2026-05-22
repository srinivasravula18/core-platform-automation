const stateEls = {
  runStatus: document.querySelector("#run-status"),
  runSurface: document.querySelector("#run-surface"),
  runScenario: document.querySelector("#run-scenario"),
  startedAt: document.querySelector("#started-at"),
  exitCode: document.querySelector("#exit-code"),
  logs: document.querySelector("#logs"),
  casesBody: document.querySelector("#cases-body"),
  inventoryBody: document.querySelector("#inventory-body"),
  inventoryUpdatedAt: document.querySelector("#inventory-updated-at"),
  inventoryFilter: document.querySelector("#inventory-filter"),
  refreshInventory: document.querySelector("#refresh-inventory"),
  selectVisibleTests: document.querySelector("#select-visible-tests"),
  clearSelectedTests: document.querySelector("#clear-selected-tests"),
  runSelectedTests: document.querySelector("#run-selected-tests"),
  selectedTestCount: document.querySelector("#selected-test-count"),
  bugsBody: document.querySelector("#bugs-body"),
  stopRuns: document.querySelectorAll("[data-stop-run]"),
  updatedAt: document.querySelector("#updated-at"),
  filter: document.querySelector("#case-filter"),
  clearScenarios: document.querySelector("#clear-scenarios"),
  counts: {
    PENDING: document.querySelector("#count-pending"),
    RUNNING: document.querySelector("#count-running"),
    PASS: document.querySelector("#count-pass"),
    FAIL: document.querySelector("#count-fail"),
    SKIP: document.querySelector("#count-skip")
  }
};

let latestRows = [];
let inventoryRows = [];
let selectedTests = new Set();

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

const selectedInventoryRows = () => inventoryRows.filter((row) => selectedTests.has(row.title));

const updateSelectedCount = () => {
  stateEls.selectedTestCount.textContent = String(selectedTests.size);
  stateEls.runSelectedTests.disabled = selectedTests.size === 0;
};

const filteredInventoryRows = () => {
  const filter = stateEls.inventoryFilter.value.trim().toLowerCase();
  if (!filter) return inventoryRows;
  return inventoryRows.filter((row) =>
    [
      row.id,
      row.surface,
      row.feature,
      row.displayTitle,
      row.precondition,
      row.input,
      row.expected,
      row.proof
    ]
      .join(" ")
      .toLowerCase()
      .includes(filter)
  );
};

const renderInventory = () => {
  const rows = filteredInventoryRows();
  updateSelectedCount();
  if (rows.length === 0) {
    stateEls.inventoryBody.innerHTML = '<tr><td colspan="9" class="empty">No matching test cases.</td></tr>';
    return;
  }
  stateEls.inventoryBody.innerHTML = rows
    .map((row) => {
      const checked = selectedTests.has(row.title) ? "checked" : "";
      return `<tr>
        <td><input type="checkbox" class="test-select" data-test-title="${escapeHtml(row.title)}" ${checked} /></td>
        <td>${escapeHtml(row.id)}</td>
        <td>${escapeHtml(row.surface)}</td>
        <td>${escapeHtml(row.feature)}</td>
        <td>${escapeHtml(row.displayTitle)}</td>
        <td>${escapeHtml(row.precondition)}</td>
        <td>${escapeHtml(row.input)}</td>
        <td>${escapeHtml(row.expected)}</td>
        <td>${escapeHtml(row.proof)}</td>
      </tr>`;
    })
    .join("");
  document.querySelectorAll(".test-select").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedTests.add(checkbox.dataset.testTitle);
      } else {
        selectedTests.delete(checkbox.dataset.testTitle);
      }
      updateSelectedCount();
    });
  });
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
  stateEls.runScenario.textContent = status.scenario || "-";
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
  stateEls.runSelectedTests.disabled = Boolean(status.running) || selectedTests.size === 0;
};

const inferSurfaceForSelected = () => {
  const surfaces = new Set(selectedInventoryRows().map((row) => String(row.surface || "").toLowerCase()));
  if (surfaces.size === 1) {
    const [surface] = Array.from(surfaces);
    if (["admin", "keystone", "api"].includes(surface)) return surface;
  }
  return "all";
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
    headed: document.querySelector("#headed").checked,
    scenario: Array.from(document.querySelectorAll("input[name='scenario']:checked"))
      .map((input) => input.value)
      .filter(Boolean)
      .join("|")
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

const startSelectedRun = async () => {
  if (selectedTests.size === 0) {
    alert("Select at least one test case.");
    return;
  }
  const payload = {
    surface: inferSurfaceForSelected(),
    reset: document.querySelector("#reset-db").checked,
    headed: document.querySelector("#headed").checked,
    tests: Array.from(selectedTests)
  };
  const response = await fetch("/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unable to start selected run." }));
    alert(error.error || "Unable to start selected run.");
    return;
  }
  await refreshStatus();
  await refreshResults();
};

const loadInventory = async (refresh = false) => {
  stateEls.inventoryUpdatedAt.textContent = "Loading test cases.";
  const response = await fetch(`/api/inventory${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
  const inventory = await response.json();
  if (!response.ok) {
    stateEls.inventoryBody.innerHTML = `<tr><td colspan="9" class="empty">${escapeHtml(inventory.error || "Unable to load inventory.")}</td></tr>`;
    return;
  }
  inventoryRows = Array.isArray(inventory.rows) ? inventory.rows : [];
  selectedTests = new Set(Array.from(selectedTests).filter((title) => inventoryRows.some((row) => row.title === title)));
  stateEls.inventoryUpdatedAt.textContent = `Loaded ${inventoryRows.length} test cases${inventory.updatedAt ? ` at ${formatDate(inventory.updatedAt)}` : ""}.`;
  if (inventory.error) {
    stateEls.inventoryUpdatedAt.textContent += " Inventory warning: see live output if a case is missing.";
  }
  renderInventory();
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
stateEls.inventoryFilter.addEventListener("input", renderInventory);
stateEls.refreshInventory.addEventListener("click", () => loadInventory(true));
stateEls.selectVisibleTests.addEventListener("click", () => {
  filteredInventoryRows().forEach((row) => selectedTests.add(row.title));
  renderInventory();
});
stateEls.clearSelectedTests.addEventListener("click", () => {
  selectedTests.clear();
  renderInventory();
});
stateEls.runSelectedTests.addEventListener("click", startSelectedRun);
stateEls.stopRuns.forEach((button) => {
  button.addEventListener("click", stopRun);
});
stateEls.clearScenarios.addEventListener("click", () => {
  document.querySelectorAll("input[name='scenario']").forEach((input) => {
    input.checked = false;
  });
});

const poll = async () => {
  await Promise.all([refreshStatus(), refreshResults()]).catch((error) => {
    stateEls.logs.textContent = `Dashboard refresh failed: ${error.message}`;
  });
};

loadInventory().catch((error) => {
  stateEls.inventoryBody.innerHTML = `<tr><td colspan="9" class="empty">Inventory load failed: ${escapeHtml(error.message)}</td></tr>`;
});
poll();
setInterval(poll, 2500);
