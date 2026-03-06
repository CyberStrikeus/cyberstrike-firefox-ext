// ============================================================================
// CyberStrike Firefox Extension - Background Script
// Multi-Container Support with Header-Based Credential Tracking
// Response Capture with filterResponseData
// ============================================================================

// --- State ---
let isCapturing = false;
let sessionID = null;
let sessionInitPromise = null;
let serverUrl = "http://127.0.0.1:4096";
let scope = "";
let requestCount = 0;
let pendingBodies = new Map();

// Pending requests waiting for response
// { requestId: { rawRequest, containerId, requestHeaders, timestamp } }
let pendingRequests = new Map();

// Response data collected from filterResponseData
// { requestId: { status, headers, chunks, totalSize } }
let pendingResponses = new Map();

// Container → Credential mapping
let containerCredentials = {};

// Whether the server supports response capture (auto-detected)
let serverSupportsResponse = true;

// Common auth headers to track (lowercase for comparison)
const COMMON_AUTH_HEADERS = [
  "authorization",
  "cookie",
  "x-auth-token",
  "x-api-key",
  "x-access-token",
  "x-session-token",
  "x-csrf-token",
];

// File extensions to filter out
const FILTERED_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp",
  ".css", ".js", ".mjs",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".map",
  ".mp4", ".mp3", ".avi", ".mov", ".webm",
  ".pdf", ".zip", ".gz", ".br",
];

// Max response body to capture (before truncation on backend)
const MAX_RESPONSE_CAPTURE = 500 * 1024; // 500 KB

// Request timeout - if response doesn't arrive in this time, send without it
const REQUEST_TIMEOUT = 30000; // 30 seconds

// --- Utility Functions ---

function shouldFilter(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return FILTERED_EXTENSIONS.some((ext) => path.endsWith(ext));
  } catch {
    return false;
  }
}

function normalizeScope(input) {
  let s = input.trim().toLowerCase();
  if (!s) return "";
  // Strip protocol prefix (http:// or https://)
  s = s.replace(/^https?:\/\//, "");
  // Strip path, query, hash
  s = s.split(/[/?#]/)[0];
  // Strip port number
  s = s.replace(/:\d+$/, "");
  // Strip trailing dots
  s = s.replace(/\.+$/, "");
  return s;
}

function matchesScope(url) {
  if (!scope) return false;
  try {
    let hostname = new URL(url).hostname;
    if (!hostname) return false;
    hostname = hostname.toLowerCase().replace(/\.+$/, "");

    // scope is pre-normalized via normalizeScope()
    if (scope.startsWith("*.")) {
      const domain = scope.slice(2);
      return hostname === domain || hostname.endsWith("." + domain);
    }
    return hostname === scope || hostname.endsWith("." + scope);
  } catch {
    return false;
  }
}

function buildRawRequest(details, headers) {
  const urlObj = new URL(details.url);
  const path = urlObj.pathname + urlObj.search + urlObj.hash;

  let raw = `${details.method} ${path} HTTP/1.1\r\n`;

  let hasHost = false;
  if (headers) {
    for (const header of headers) {
      raw += `${header.name}: ${header.value}\r\n`;
      if (header.name.toLowerCase() === "host") hasHost = true;
    }
  }
  if (!hasHost) {
    raw += `Host: ${urlObj.host}\r\n`;
  }

  const body = pendingBodies.get(details.requestId);
  if (body) {
    raw += `\r\n${body}`;
    pendingBodies.delete(details.requestId);
  }

  return raw;
}

function extractRequestBody(details) {
  if (!details.requestBody) return null;

  if (details.requestBody.raw && details.requestBody.raw.length > 0) {
    const parts = [];
    for (const part of details.requestBody.raw) {
      if (part.bytes) {
        parts.push(new TextDecoder("utf-8").decode(part.bytes));
      }
    }
    return parts.join("");
  }

  if (details.requestBody.formData) {
    const params = new URLSearchParams();
    for (const [key, values] of Object.entries(details.requestBody.formData)) {
      for (const val of values) {
        params.append(key, val);
      }
    }
    return params.toString();
  }

  return null;
}

// --- Header Extraction ---

function extractAuthHeaders(requestHeaders) {
  const headers = {};
  for (const header of requestHeaders || []) {
    const name = header.name.toLowerCase();
    if (COMMON_AUTH_HEADERS.includes(name)) {
      const canonicalName = getCanonicalHeaderName(name);
      headers[canonicalName] = header.value;
    }
  }
  return headers;
}

function getCanonicalHeaderName(lowercase) {
  const mapping = {
    "authorization": "Authorization",
    "cookie": "Cookie",
    "x-auth-token": "X-Auth-Token",
    "x-api-key": "X-API-Key",
    "x-access-token": "X-Access-Token",
    "x-session-token": "X-Session-Token",
    "x-csrf-token": "X-CSRF-Token",
  };
  return mapping[lowercase] || lowercase;
}

function headersChanged(oldHeaders, newHeaders) {
  const oldKeys = Object.keys(oldHeaders || {});
  const newKeys = Object.keys(newHeaders || {});
  
  if (oldKeys.length !== newKeys.length) return true;
  
  for (const key of newKeys) {
    if (oldHeaders[key] !== newHeaders[key]) return true;
  }
  
  return false;
}

function extractResponseHeaders(responseHeaders) {
  const headers = {};
  for (const h of responseHeaders || []) {
    headers[h.name.toLowerCase()] = h.value;
  }
  return headers;
}

// --- Header Sync ---

async function syncCredentialHeaders(credentialID, newHeaders) {
  if (!sessionID || !credentialID) return;
  
  try {
    await fetch(
      `${serverUrl}/session/${sessionID}/web/credentials/${credentialID}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headers: newHeaders }),
      }
    );
    console.log(`CyberStrike: Headers synced for credential ${credentialID}`);
  } catch (err) {
    console.error("CyberStrike: Failed to sync headers:", err);
  }
}

// --- Server Communication ---

async function sendToServer(rawRequest, containerId, response) {
  const mapping = containerCredentials[containerId];

  if (sessionID) {
    try {
      await sendIngest(rawRequest, sessionID, mapping?.credentialID, response);
    } catch (err) {
      console.error("CyberStrike: Failed to send request:", err.message);
    }
    return;
  }

  // First request - initialize session
  let createdSessionPromise = false;
  if (sessionInitPromise === null) {
    createdSessionPromise = true;
    sessionInitPromise = (async () => {
      try {
        await sendIngest(rawRequest, null, mapping?.credentialID, response);
        return sessionID;
      } catch (err) {
        sessionInitPromise = null;
        throw err;
      }
    })();
  }

  try {
    await sessionInitPromise;
    if (!createdSessionPromise && sessionID) {
      await sendIngest(rawRequest, sessionID, mapping?.credentialID, response);
    }
  } catch (err) {
    console.error("CyberStrike: Failed to send request:", err.message);
  }
}

async function sendIngest(rawRequest, sid, credentialID, response) {
  const payload = { text: rawRequest };

  if (sid) {
    payload.sessionID = sid;
  }

  if (credentialID) {
    payload.credential_id = credentialID;
  }

  if (response && serverSupportsResponse) {
    payload.response = response;
  }

  const payloadJSON = JSON.stringify(payload);
  console.log(`CyberStrike: [INGEST] sending ${(payloadJSON.length / 1024).toFixed(1)}KB to ${serverUrl}/session/ingest`);

  let fetchResponse = await fetch(`${serverUrl}/session/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payloadJSON,
  });

  // If server returned 500 and we sent response data, retry without it
  if (!fetchResponse.ok && response && serverSupportsResponse) {
    console.log("CyberStrike: [INGEST] server rejected response data, retrying without it");
    serverSupportsResponse = false;
    delete payload.response;
    fetchResponse = await fetch(`${serverUrl}/session/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  let data = null;
  if (fetchResponse.ok) {
    data = await fetchResponse.json();
    console.log(`CyberStrike: [INGEST] OK, sessionID=${data?.sessionID || sessionID}`);
  } else {
    const errBody = await fetchResponse.text().catch(() => "");
    console.error(`CyberStrike: [INGEST] server returned ${fetchResponse.status}: ${errBody.slice(0, 200)}`);
  }

  if (fetchResponse.ok && data) {
    if (data.sessionID && !sessionID) {
      sessionID = data.sessionID;
      await browser.storage.local.set({ activeSessionID: sessionID });
    }
    requestCount++;

    browser.runtime
      .sendMessage({
        type: "status",
        requestCount,
        sessionID,
        credentialID,
      })
      .catch(() => {});
  }

  if (!sid && !sessionID) {
    throw new Error(
      fetchResponse.ok ? "No sessionID in response" : `Server ${fetchResponse.status}`
    );
  }
}

// --- Complete Request with Response ---

function completeRequest(requestId) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;

  pendingRequests.delete(requestId);

  const responseData = pendingResponses.get(requestId);
  pendingResponses.delete(requestId);

  let response = null;
  if (responseData) {
    // Combine chunks into body
    const body = combineChunks(responseData.chunks);
    response = {
      status: responseData.status,
      headers: responseData.headers,
      body: body,
    };
  }

  // Send to server
  sendToServer(pending.rawRequest, pending.containerId, response).catch((err) => {
    console.error("CyberStrike: Send failed:", err.message);
  });
}

function combineChunks(chunks) {
  if (!chunks || chunks.length === 0) return "";
  
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  
  try {
    return new TextDecoder("utf-8").decode(combined);
  } catch {
    // Binary content, return empty string (will be detected by content-type)
    return "";
  }
}

// --- WebRequest Handlers ---

function onBeforeRequest(details) {
  if (!isCapturing) return;
  if (shouldFilter(details.url)) return;
  if (!matchesScope(details.url)) return;

  console.log(`CyberStrike: [MATCH] ${details.method} ${details.url}`);

  const body = extractRequestBody(details);
  if (body) {
    pendingBodies.set(details.requestId, body);
  }
}

function onBeforeSendHeaders(details) {
  if (!isCapturing) return;
  if (shouldFilter(details.url)) return;
  if (!matchesScope(details.url)) return;

  const containerId = details.cookieStoreId || "firefox-default";
  const mapping = containerCredentials[containerId];

  // Extract auth headers from this request
  const currentHeaders = extractAuthHeaders(details.requestHeaders);

  // If we have a credential for this container, check for header changes
  if (mapping && Object.keys(currentHeaders).length > 0) {
    if (headersChanged(mapping.lastHeaders, currentHeaders)) {
      syncCredentialHeaders(mapping.credentialID, currentHeaders);
      mapping.lastHeaders = currentHeaders;
      
      browser.runtime
        .sendMessage({
          type: "headersUpdated",
          credentialID: mapping.credentialID,
          label: mapping.label,
          headers: currentHeaders,
        })
        .catch(() => {});
    }
  }

  // Build raw request and store for later (wait for response)
  const rawRequest = buildRawRequest(details, details.requestHeaders);
  
  pendingRequests.set(details.requestId, {
    rawRequest,
    containerId,
    timestamp: Date.now(),
  });

  // Set timeout - if response doesn't arrive, send without it
  setTimeout(() => {
    if (pendingRequests.has(details.requestId)) {
      const timedOut = pendingRequests.get(details.requestId);
      // Disconnect stuck filter so the response can flow directly to the page
      if (timedOut.filter) {
        try { timedOut.filter.disconnect(); } catch (e) {}
      }
      console.log(`CyberStrike: Request ${details.requestId} timed out waiting for response`);
      completeRequest(details.requestId);
    }
  }, REQUEST_TIMEOUT);
}

function onHeadersReceived(details) {
  if (!isCapturing) return;
  if (!pendingRequests.has(details.requestId)) return;

  // Store response headers
  const headers = extractResponseHeaders(details.responseHeaders);

  pendingResponses.set(details.requestId, {
    status: details.statusCode,
    headers: headers,
    chunks: [],
    totalSize: 0,
    stopped: false,
  });

  // Start capturing response body
  try {
    const filter = browser.webRequest.filterResponseData(details.requestId);
    const responseData = pendingResponses.get(details.requestId);
    let filterDone = false;

    // Store filter ref so timeout can disconnect it
    const pending = pendingRequests.get(details.requestId);
    if (pending) pending.filter = filter;

    filter.ondata = (event) => {
      // Always pass through the data
      filter.write(event.data);

      // Capture if not stopped
      if (!responseData.stopped) {
        responseData.totalSize += event.data.byteLength;

        if (responseData.totalSize <= MAX_RESPONSE_CAPTURE) {
          responseData.chunks.push(new Uint8Array(event.data));
        } else {
          // Stop capturing but continue passing through
          responseData.stopped = true;
        }
      }
    };

    filter.onstop = () => {
      if (filterDone) return;
      filterDone = true;
      filter.close();
      // Response complete, send to server
      completeRequest(details.requestId);
    };

    filter.onerror = (e) => {
      if (filterDone) return;
      filterDone = true;
      console.error("CyberStrike: Filter error", e);
      try { filter.close(); } catch {}
      // Send without response body
      completeRequest(details.requestId);
    };
  } catch (err) {
    console.error("CyberStrike: Failed to create filter", err);
    // filterResponseData not available (e.g., cached response), send without body
    completeRequest(details.requestId);
  }

  // Return blocking to allow filterResponseData to work
  return {};
}

function onCompleted(details) {
  if (!isCapturing) return;

  // Fallback: if request is still pending (filter didn't complete), send without body
  if (pendingRequests.has(details.requestId)) {
    const pending = pendingRequests.get(details.requestId);
    console.log(`CyberStrike: [FALLBACK] onCompleted firing for pending request ${details.url}`);
    // Disconnect stuck filter so page doesn't hang
    if (pending.filter) {
      try { pending.filter.disconnect(); } catch (e) {}
    }
    completeRequest(details.requestId);
  }
}

function onErrorOccurred(details) {
  if (!isCapturing) return;

  // Request failed, send without response
  if (pendingRequests.has(details.requestId)) {
    console.log(`CyberStrike: Request ${details.requestId} failed: ${details.error}`);
    completeRequest(details.requestId);
  }
}

// --- Capture Control ---

function startCapture(options = {}) {
  if (isCapturing) return;

  console.log(`CyberStrike: START scope="${scope}" server="${serverUrl}" session=${options.sessionID || "new"}`);
  isCapturing = true;

  if (options.sessionID) {
    sessionID = options.sessionID;
  } else {
    sessionID = null;
    sessionInitPromise = null;
  }

  requestCount = 0;

  browser.webRequest.onBeforeRequest.addListener(
    onBeforeRequest,
    { urls: ["<all_urls>"] },
    ["requestBody"]
  );

  browser.webRequest.onBeforeSendHeaders.addListener(
    onBeforeSendHeaders,
    { urls: ["<all_urls>"] },
    ["requestHeaders"]
  );

  browser.webRequest.onHeadersReceived.addListener(
    onHeadersReceived,
    { urls: ["<all_urls>"] },
    ["responseHeaders", "blocking"]
  );

  browser.webRequest.onCompleted.addListener(
    onCompleted,
    { urls: ["<all_urls>"] }
  );

  browser.webRequest.onErrorOccurred.addListener(
    onErrorOccurred,
    { urls: ["<all_urls>"] }
  );

  // Save state
  browser.storage.local.set({
    isCapturing: true,
    scope,
    serverUrl,
    activeSessionID: sessionID,
    containerCredentials,
  });
}

function stopCapture(clearSession = true) {
  isCapturing = false;

  browser.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
  browser.webRequest.onBeforeSendHeaders.removeListener(onBeforeSendHeaders);
  browser.webRequest.onHeadersReceived.removeListener(onHeadersReceived);
  browser.webRequest.onCompleted.removeListener(onCompleted);
  browser.webRequest.onErrorOccurred.removeListener(onErrorOccurred);
  
  pendingBodies.clear();
  pendingRequests.clear();
  pendingResponses.clear();

  if (clearSession) {
    sessionID = null;
    sessionInitPromise = null;
    requestCount = 0;
    containerCredentials = {};
    serverSupportsResponse = true;
  }

  browser.storage.local.set({
    isCapturing: false,
    activeSessionID: null,
    containerCredentials: {},
  });
}

// --- Message Handling ---

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "start": {
      scope = normalizeScope(message.scope || "");
      serverUrl = message.serverUrl || "http://127.0.0.1:4096";
      const sid = message.sessionID;
      if (sid) {
        applySessionCredentials(sid)
          .then(() => {
            startCapture({ sessionID: sid });
            sendResponse({ ok: true, capturing: true });
          })
          .catch((err) => {
            console.error("CyberStrike: Start with session credentials load failed", err);
            containerCredentials = {};
            browser.storage.local.set({ containerCredentials }).catch(() => {});
            startCapture({ sessionID: sid });
            sendResponse({ ok: true, capturing: true });
          });
        return true;
      }
      startCapture({ sessionID: null });
      sendResponse({ ok: true, capturing: true });
      break;
    }

    case "stop":
      stopCapture();
      sendResponse({ ok: true, capturing: false });
      break;

    case "getStatus":
      sendResponse({
        capturing: isCapturing,
        requestCount,
        sessionID,
        scope,
        serverUrl,
        containerCredentials,
      });
      break;

    case "attachSession":
      sessionID = message.sessionID;
      serverUrl = message.serverUrl || serverUrl;
      scope = normalizeScope(message.scope) || scope;

      applySessionCredentials(message.sessionID)
        .then((creds) => {
          sendResponse({ ok: true, credentials: creds });
        })
        .catch((err) => {
          console.error("CyberStrike: Attach session credentials load failed", err);
          sendResponse({ ok: false, error: err.message });
        });
      return true;

    case "addCredential":
      createCredentialOnServer(message).then((cred) => {
        if (cred) {
          containerCredentials[message.containerId] = {
            credentialID: cred.id,
            label: message.label,
            lastHeaders: {},
          };
          browser.storage.local.set({ containerCredentials });
          sendResponse({ ok: true, credential: cred });
        } else {
          sendResponse({ ok: false, error: "Failed to create credential" });
        }
      });
      return true;

    case "removeCredential":
      const containerToRemove = Object.keys(containerCredentials).find(
        (k) => containerCredentials[k].credentialID === message.credentialID
      );
      if (containerToRemove) {
        delete containerCredentials[containerToRemove];
        browser.storage.local.set({ containerCredentials });
      }
      deleteCredentialOnServer(message.credentialID);
      sendResponse({ ok: true });
      break;

    case "getContainers":
      browser.contextualIdentities
        .query({})
        .then((containers) => {
          sendResponse({
            containers: [
              {
                cookieStoreId: "firefox-default",
                name: "Default (No Container)",
                color: "gray",
              },
              ...containers,
            ],
          });
        })
        .catch((err) => {
          sendResponse({
            containers: [
              {
                cookieStoreId: "firefox-default",
                name: "Default (No Container)",
                color: "gray",
              },
            ],
          });
        });
      return true;

    case "getContainerCredentials":
      sendResponse({ mappings: containerCredentials });
      break;

    case "clearCredentials":
      containerCredentials = {};
      browser.storage.local.set({ containerCredentials });
      sendResponse({ ok: true });
      break;
  }
});

// --- Server API Functions ---

/**
 * Load credentials for a session from the API.
 * @returns {{ ok: boolean, creds: Array }} ok false on network/response error; creds is the list from API or [].
 */
async function loadSessionCredentials(sid) {
  try {
    const response = await fetch(`${serverUrl}/session/${sid}/web/credentials`);
    if (response.ok) {
      const creds = await response.json();
      return { ok: true, creds: Array.isArray(creds) ? creds : [] };
    }
  } catch (err) {
    console.error("CyberStrike: Failed to load credentials:", err);
  }
  return { ok: false, creds: [] };
}

/**
 * Load session credentials from API and apply to containerCredentials + storage.
 * Server data is used only for mapping (container → credential_id) and lastHeaders (comparison baseline);
 * actual credential sync remains browser → server via onBeforeSendHeaders.
 * @param {string} sid - Session ID
 * @param {{ keepOnFailure?: boolean }} [options] - If keepOnFailure true, throws on load failure so caller can keep existing state (e.g. init offline).
 * @returns {Promise<Array>} Applied credentials list (for attachSession).
 */
async function applySessionCredentials(sid, options = {}) {
  const result = await loadSessionCredentials(sid);
  if (!result.ok) {
    if (options.keepOnFailure) {
      throw new Error("Failed to load session credentials");
    }
    containerCredentials = {};
    browser.storage.local.set({ containerCredentials }).catch(() => {});
    return [];
  }
  containerCredentials = {};
  for (const cred of result.creds) {
    if (cred.container_id) {
      containerCredentials[cred.container_id] = {
        credentialID: cred.id,
        label: cred.label || "",
        lastHeaders: cred.headers || {},
      };
    }
  }
  await browser.storage.local.set({ containerCredentials });
  return result.creds;
}

async function createCredentialOnServer(message) {
  if (!sessionID) return null;
  
  try {
    const response = await fetch(
      `${serverUrl}/session/${sessionID}/web/credentials`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: message.label,
          container_id: message.containerId,
          headers: {},
        }),
      }
    );
    if (response.ok) {
      return await response.json();
    }
  } catch (err) {
    console.error("CyberStrike: Failed to create credential:", err);
  }
  return null;
}

async function deleteCredentialOnServer(credentialID) {
  if (!sessionID) return;
  
  try {
    await fetch(
      `${serverUrl}/session/${sessionID}/web/credentials/${credentialID}`,
      { method: "DELETE" }
    );
  } catch (err) {
    console.error("CyberStrike: Failed to delete credential:", err);
  }
}

// --- Startup ---

async function init() {
  const data = await browser.storage.local.get([
    "isCapturing",
    "scope",
    "serverUrl",
    "activeSessionID",
    "containerCredentials",
  ]);

  if (data.scope) scope = normalizeScope(data.scope);
  if (data.serverUrl) serverUrl = data.serverUrl;
  if (data.containerCredentials) containerCredentials = data.containerCredentials;

  if (data.isCapturing && data.activeSessionID) {
    sessionID = data.activeSessionID;
    try {
      await applySessionCredentials(data.activeSessionID, { keepOnFailure: true });
    } catch (err) {
      console.error("CyberStrike: Init restore credentials load failed, using storage", err);
      containerCredentials = data.containerCredentials || {};
    }
    startCapture({ sessionID: data.activeSessionID });
  }
}

init();
