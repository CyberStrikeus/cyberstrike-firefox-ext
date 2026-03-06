// ============================================================================
// CyberStrike Firefox Extension - Popup Script
// ============================================================================

// --- DOM Elements ---
const scopeInput = document.getElementById("scope");
const serverUrlInput = document.getElementById("serverUrl");
const toggleBtn = document.getElementById("toggleBtn");
const statusIndicator = document.getElementById("statusIndicator");
const statusText = document.getElementById("statusText");
const requestCountEl = document.getElementById("requestCount");
const sessionInfo = document.getElementById("sessionInfo");
const sessionIdEl = document.getElementById("sessionId");
const sessionSelect = document.getElementById("sessionSelect");
const refreshSessionsBtn = document.getElementById("refreshSessions");
const contextPanel = document.getElementById("contextPanel");
const refreshBtn = document.getElementById("refreshBtn");
const lastUpdateEl = document.getElementById("lastUpdate");
const credentialsSection = document.getElementById("credentialsSection");
const credentialList = document.getElementById("credentialList");
const addCredentialBtn = document.getElementById("addCredentialBtn");

// Modal elements
const credentialModal = document.getElementById("credentialModal");
const credName = document.getElementById("credName");
const credContainer = document.getElementById("credContainer");
const cancelCred = document.getElementById("cancelCred");
const saveCred = document.getElementById("saveCred");

// --- State ---
let capturing = false;
let currentSessionID = null;
let currentServerUrl = null;
let containerCredentials = {};

// --- Initialization ---

async function init() {
  await loadSavedSettings();
  await loadContainers();

  const status = await browser.runtime.sendMessage({ type: "getStatus" });

  // Load sessions and select current one if exists
  await loadSessions(status.sessionID);

  if (status.containerCredentials) {
    containerCredentials = status.containerCredentials;
  }

  updateUI(status);
}

async function loadSavedSettings() {
  const data = await browser.storage.local.get(["scope", "serverUrl"]);
  if (data.scope) scopeInput.value = data.scope;
  if (data.serverUrl) serverUrlInput.value = data.serverUrl;
  else serverUrlInput.value = "http://127.0.0.1:4096";
}

// --- Session Management ---

async function loadSessions(activeSessionID = null) {
  const serverUrl = serverUrlInput.value.trim() || "http://127.0.0.1:4096";

  try {
    const response = await fetch(`${serverUrl}/session?limit=20&roots=true`);
    if (!response.ok) throw new Error("Failed to fetch sessions");

    const sessions = await response.json();

    // Clear existing options except "New Session"
    sessionSelect.innerHTML = '<option value="">-- New Session --</option>';

    for (const session of sessions) {
      const option = document.createElement("option");
      option.value = session.id;

      const shortId = session.id.slice(0, 8);
      const title = session.title || "Untitled";
      const date = new Date(session.time.updated).toLocaleDateString();

      option.textContent = `${shortId} - ${title} (${date})`;

      // Select the active session if provided
      if (activeSessionID && session.id === activeSessionID) {
        option.selected = true;
      }

      sessionSelect.appendChild(option);
    }
  } catch (err) {
    console.error("Failed to load sessions:", err);
  }
}

async function loadContainers() {
  try {
    const response = await browser.runtime.sendMessage({
      type: "getContainers",
    });

    credContainer.innerHTML = "";

    for (const container of response.containers) {
      const option = document.createElement("option");
      option.value = container.cookieStoreId;
      option.textContent = container.name;
      if (container.color && container.color !== "gray") {
        option.style.color = container.color;
      }
      credContainer.appendChild(option);
    }
  } catch (err) {
    console.error("Failed to load containers:", err);
    credContainer.innerHTML =
      '<option value="firefox-default">Default (No Container)</option>';
  }
}

// --- UI Updates ---

function updateUI(state) {
  capturing = state.capturing;
  requestCountEl.textContent = state.requestCount || 0;
  currentServerUrl = serverUrlInput.value.trim() || "http://127.0.0.1:4096";

  if (capturing) {
    toggleBtn.textContent = "Stop";
    toggleBtn.className = "btn btn-stop";
    statusIndicator.className = "indicator on";
    statusText.textContent = "Capturing...";
    scopeInput.disabled = true;
    serverUrlInput.disabled = true;
    sessionSelect.disabled = true;
  } else {
    toggleBtn.textContent = "Start Capture";
    toggleBtn.className = "btn btn-start";
    statusIndicator.className = "indicator off";
    statusText.textContent = "Stopped";
    scopeInput.disabled = false;
    serverUrlInput.disabled = false;
    sessionSelect.disabled = false;
  }

  if (state.sessionID) {
    sessionInfo.classList.remove("hidden");
    sessionIdEl.textContent = state.sessionID;
    contextPanel.classList.remove("hidden");
    credentialsSection.classList.remove("hidden");
    currentSessionID = state.sessionID;

    // Update container credentials from state
    if (state.containerCredentials) {
      containerCredentials = state.containerCredentials;
    }

    fetchWebContext();
    renderCredentialMappings();
  } else {
    // Session stopped - clear everything
    sessionInfo.classList.add("hidden");
    contextPanel.classList.add("hidden");
    credentialsSection.classList.add("hidden");
    currentSessionID = null;
    containerCredentials = {};

    // Clear context panel lists
    clearContextLists();

    // Clear credential list display
    credentialList.innerHTML =
      '<div class="list-empty">No credentials configured</div>';
  }
}

function clearContextLists() {
  ["credentials", "roles", "objects", "functions"].forEach((type) => {
    const list = document.getElementById(`list-${type}`);
    const empty = list.previousElementSibling;
    list.innerHTML = "";
    empty.style.display = "block";
  });
  lastUpdateEl.textContent = "";
}

// --- Credential Management ---

function renderCredentialMappings() {
  const mappings = Object.entries(containerCredentials);

  if (mappings.length === 0) {
    credentialList.innerHTML =
      '<div class="list-empty">No credentials configured</div>';
    return;
  }

  credentialList.innerHTML = "";

  for (const [containerId, cred] of mappings) {
    const item = document.createElement("div");
    item.className = "credential-item";

    const containerName = getContainerName(containerId);
    const hasHeaders = cred.lastHeaders && Object.keys(cred.lastHeaders).length > 0;
    const statusDot = hasHeaders ? "active" : "pending";
    const headerCount = hasHeaders ? Object.keys(cred.lastHeaders).length : 0;

    item.innerHTML = `
      <div class="cred-status ${statusDot}"></div>
      <div class="cred-info">
        <div class="cred-name">${cred.label}</div>
        <div class="cred-meta">${containerName} ${hasHeaders ? `(${headerCount} headers)` : "(waiting for login)"}</div>
      </div>
      <button class="btn-icon btn-remove" data-cred-id="${cred.credentialID}" title="Remove">&#10005;</button>
    `;

    credentialList.appendChild(item);
  }

  // Add remove handlers
  credentialList.querySelectorAll(".btn-remove").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const credId = e.currentTarget.dataset.credId;
      await removeCredential(credId);
    });
  });
}

function getContainerName(containerId) {
  const option = credContainer.querySelector(`option[value="${containerId}"]`);
  return option ? option.textContent : containerId;
}

async function removeCredential(credentialID) {
  if (!currentSessionID || !currentServerUrl) return;

  // Remove from backend
  try {
    await fetch(
      `${currentServerUrl}/session/${currentSessionID}/web/credentials/${credentialID}`,
      {
        method: "DELETE",
      },
    );
  } catch (err) {
    console.error("Failed to delete credential:", err);
  }

  // Remove from background
  await browser.runtime.sendMessage({
    type: "removeCredential",
    credentialID,
  });

  // Update local state
  for (const [containerId, cred] of Object.entries(containerCredentials)) {
    if (cred.credentialID === credentialID) {
      delete containerCredentials[containerId];
      break;
    }
  }

  renderCredentialMappings();
  fetchWebContext();
}

// --- Modal Handling ---

function openModal() {
  if (!currentSessionID) {
    alert("Please start a session first before adding credentials.");
    return;
  }

  credName.value = "";
  credentialModal.classList.remove("hidden");
  credName.focus();
}

function closeModal() {
  credentialModal.classList.add("hidden");
}

async function saveCredential() {
  const label = credName.value.trim();
  const containerId = credContainer.value;

  if (!label) {
    credName.style.borderColor = "#ff4757";
    setTimeout(() => {
      credName.style.borderColor = "";
    }, 1500);
    return;
  }

  // Check if container already has a credential
  if (containerCredentials[containerId]) {
    alert(
      `Container "${getContainerName(containerId)}" already has a credential assigned. Remove it first.`,
    );
    return;
  }

  try {
    // Create credential via background script (which will call backend)
    const response = await browser.runtime.sendMessage({
      type: "addCredential",
      label: label,
      containerId: containerId,
    });

    if (!response.ok) {
      throw new Error(response.error || "Failed to create credential");
    }

    // Update local state
    containerCredentials[containerId] = {
      credentialID: response.credential.id,
      label: label,
      lastHeaders: {},
    };

    closeModal();
    renderCredentialMappings();
    fetchWebContext();
  } catch (err) {
    console.error("Failed to save credential:", err);
    alert("Failed to save credential. Check console for details.");
  }
}

// --- Web Context ---

async function fetchWebContext() {
  if (!currentSessionID || !currentServerUrl) {
    console.log("fetchWebContext: No session or server URL");
    return;
  }

  try {
    const [credentials, roles, objects, functions] = await Promise.all([
      fetch(
        `${currentServerUrl}/session/${currentSessionID}/web/credentials`,
      ).then((r) => (r.ok ? r.json() : [])),
      fetch(`${currentServerUrl}/session/${currentSessionID}/web/roles`).then(
        (r) => (r.ok ? r.json() : []),
      ),
      fetch(`${currentServerUrl}/session/${currentSessionID}/web/objects`).then(
        (r) => (r.ok ? r.json() : []),
      ),
      fetch(
        `${currentServerUrl}/session/${currentSessionID}/web/functions`,
      ).then((r) => (r.ok ? r.json() : [])),
    ]);

    renderList("credentials", credentials, renderCredential);
    renderList("roles", roles, renderRole);
    renderList("objects", objects, renderObject);
    renderList("functions", functions, renderFunction);

    lastUpdateEl.textContent = new Date().toLocaleTimeString();
  } catch (err) {
    console.error("Failed to fetch web context:", err);
  }
}

function renderList(type, items, renderer) {
  const list = document.getElementById(`list-${type}`);
  const empty = list.previousElementSibling;

  list.innerHTML = "";

  if (!items || items.length === 0) {
    empty.style.display = "block";
    return;
  }

  empty.style.display = "none";
  items.forEach((item) => {
    const li = document.createElement("li");
    li.innerHTML = renderer(item);
    list.appendChild(li);
  });
}

function renderCredential(c) {
  const roleInfo = c.role_id ? `<span class="tag">${c.role_id}</span>` : "";
  const hasHeaders = c.headers && Object.keys(c.headers).length > 0;
  const status = hasHeaders ? "active" : "pending";
  const headerKeys = hasHeaders ? Object.keys(c.headers).join(", ") : "No headers";
  return `
    <div class="item-row">
      <span class="cred-dot ${status}"></span>
      <div class="item-header">${c.label}</div>
    </div>
    <div class="item-meta">${headerKeys}${roleInfo}</div>
  `;
}

function renderRole(r) {
  return `<div class="item-header">${r.name}</div>
    <div class="item-meta">${r.permissions || "No permissions defined"}</div>`;
}

function renderObject(o) {
  let fields = "";
  if (o.fields) {
    try {
      fields = JSON.parse(o.fields).join(", ");
    } catch {
      fields = o.fields;
    }
  }
  return `<div class="item-header">${o.name}</div>
    <div class="item-meta">${fields || "No fields"}</div>`;
}

function renderFunction(f) {
  const method = f.method
    ? `<span class="tag tag-method">${f.method}</span>`
    : "";
  return `<div class="item-header">${f.name}</div>
    <div class="item-meta">${method} ${f.endpoint || ""}</div>`;
}

// --- Event Handlers ---

toggleBtn.addEventListener("click", async () => {
  if (!capturing) {
    const scopeVal = scopeInput.value.trim();
    if (!scopeVal) {
      scopeInput.focus();
      scopeInput.style.borderColor = "#ff4757";
      setTimeout(() => {
        scopeInput.style.borderColor = "";
      }, 1500);
      return;
    }

    const serverVal = serverUrlInput.value.trim() || "http://127.0.0.1:4096";
    let selectedSessionID = sessionSelect.value || null;

    await browser.storage.local.set({ scope: scopeVal, serverUrl: serverVal });

    // If no session selected, create one immediately so credentials can be added
    if (!selectedSessionID) {
      try {
        const createResp = await fetch(`${serverVal}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (createResp.ok) {
          const newSession = await createResp.json();
          selectedSessionID = newSession.id;
        }
      } catch (err) {
        console.error("Failed to create session:", err);
        alert("Failed to create session. Is the server running?");
        return;
      }
    }

    const response = await browser.runtime.sendMessage({
      type: "start",
      scope: scopeVal,
      serverUrl: serverVal,
      sessionID: selectedSessionID,
    });

    if (response.ok) {
      // Get fresh status from background
      const status = await browser.runtime.sendMessage({ type: "getStatus" });
      if (status.containerCredentials) {
        containerCredentials = status.containerCredentials;
      }
      
      // Update current state
      currentSessionID = selectedSessionID;
      currentServerUrl = serverVal;
      
      updateUI({
        capturing: true,
        requestCount: 0,
        sessionID: selectedSessionID,
        containerCredentials: status.containerCredentials || {},
      });
      
      // Refresh session list to include new session
      await loadSessions(selectedSessionID);
    }
  } else {
    const response = await browser.runtime.sendMessage({ type: "stop" });
    if (response.ok) {
      // Clear local state
      containerCredentials = {};
      updateUI({ capturing: false, requestCount: 0, sessionID: null });

      // Refresh session list
      await loadSessions();
    }
  }
});

sessionSelect.addEventListener("change", async () => {
  const selectedId = sessionSelect.value;

  if (selectedId && !capturing) {
    // Pre-select the session, show its context
    currentSessionID = selectedId;
    currentServerUrl = serverUrlInput.value.trim() || "http://127.0.0.1:4096";

    // Show context panel for selected session
    sessionInfo.classList.remove("hidden");
    sessionIdEl.textContent = selectedId;
    contextPanel.classList.remove("hidden");
    credentialsSection.classList.remove("hidden");

    // Fetch context for this session
    fetchWebContext();
  } else if (!selectedId && !capturing) {
    // New session selected, hide context
    sessionInfo.classList.add("hidden");
    contextPanel.classList.add("hidden");
    credentialsSection.classList.add("hidden");
    currentSessionID = null;
    clearContextLists();
  }
});

refreshSessionsBtn.addEventListener("click", async () => {
  await loadSessions(currentSessionID);
});

addCredentialBtn.addEventListener("click", openModal);
cancelCred.addEventListener("click", closeModal);
saveCred.addEventListener("click", saveCredential);

credentialModal
  .querySelector(".modal-backdrop")
  .addEventListener("click", closeModal);

// Tab switching
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document
      .querySelectorAll(".tab")
      .forEach((t) => t.classList.remove("active"));
    document
      .querySelectorAll(".tab-content")
      .forEach((c) => c.classList.add("hidden"));

    tab.classList.add("active");
    document
      .getElementById(`tab-${tab.dataset.tab}`)
      .classList.remove("hidden");
  });
});

// Refresh button - works if session is selected (even when not capturing)
refreshBtn.addEventListener("click", () => {
  if (currentSessionID) {
    fetchWebContext();
  } else {
    console.log("No session selected to refresh");
  }
});

// Listen for status updates from background
browser.runtime.onMessage.addListener((message) => {
  if (message.type === "status") {
    requestCountEl.textContent = message.requestCount || 0;
    if (message.sessionID && !currentSessionID) {
      // New session created
      currentSessionID = message.sessionID;
      sessionInfo.classList.remove("hidden");
      sessionIdEl.textContent = message.sessionID;
      contextPanel.classList.remove("hidden");
      credentialsSection.classList.remove("hidden");

      // Refresh session list to include new session
      loadSessions(message.sessionID);
    }
  } else if (message.type === "headersUpdated") {
    // Headers were auto-captured, update UI
    for (const [containerId, cred] of Object.entries(containerCredentials)) {
      if (cred.credentialID === message.credentialID) {
        cred.lastHeaders = message.headers;
        break;
      }
    }
    renderCredentialMappings();
    fetchWebContext();
  }
});

// --- Initialize ---
init();
