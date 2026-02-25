import React, { useEffect, useMemo, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);

const SEGMENTS = ["FRIEND", "KNOWN", "STRANGER", "VIP"];
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "messages", label: "Message Config" },
  { id: "contacts", label: "Contact Classification" },
  { id: "account", label: "Instagram Connection" },
  { id: "settings", label: "Settings" }
];

const STORAGE_KEYS = {
  settings: "instareply.consoleSettings.v2",
  activeTab: "instareply.consoleTab.v2"
};

const DEFAULT_SETTINGS = {
  theme: "light",
  fontScale: 100
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadStoredValue(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

function saveStoredValue(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (_error) {
    // Ignore write failures.
  }
}

async function requestJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json"
    },
    ...options
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }

  return payload;
}

function formatTimestamp(iso) {
  if (!iso) return "n/a";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toLocaleString();
}

function formatElapsed(iso) {
  if (!iso) return "never";
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return "n/a";

  const diffMs = Date.now() - timestamp;
  if (diffMs <= 0) return "just now";

  const minutes = Math.floor(diffMs / (60 * 1000));
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  if (days > 0) return `${days}d ${hours % 24}h ago`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

function connectionTone(status) {
  if (status === "CONNECTED") return "ok";
  if (status === "DISCONNECTED") return "err";
  return "warn";
}

function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [draftReplies, setDraftReplies] = useState({});
  const [activeTab, setActiveTab] = useState(() => {
    const saved = loadStoredValue(STORAGE_KEYS.activeTab, "overview");
    return TABS.some((tab) => tab.id === saved) ? saved : "overview";
  });
  const [settings, setSettings] = useState(() => {
    const saved = loadStoredValue(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
    const theme = saved?.theme === "dark" ? "dark" : "light";
    const fontScale = clamp(Number(saved?.fontScale) || 100, 85, 130);
    return { theme, fontScale };
  });

  const refresh = async () => {
    setLoading(true);
    try {
      const state = await requestJSON("/api/app/state");
      setData(state);
      setDraftReplies((current) => {
        const next = { ...current };
        for (const message of state.messages || []) {
          if (next[message.id] == null) {
            next[message.id] = message.suggestedReply || "";
          }
        }
        return next;
      });
    } catch (error) {
      setNotice(String(error instanceof Error ? error.message : error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    saveStoredValue(STORAGE_KEYS.activeTab, activeTab);
  }, [activeTab]);

  useEffect(() => {
    saveStoredValue(STORAGE_KEYS.settings, settings);
    document.documentElement.setAttribute("data-theme", settings.theme);
    document.documentElement.style.setProperty("--font-scale", String(settings.fontScale / 100));
  }, [settings]);

  const doAction = async (task, successMessage) => {
    setBusy(true);
    setNotice("");
    try {
      await task();
      setNotice(successMessage);
      await refresh();
    } catch (error) {
      setNotice(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  };

  const senderSegmentLookup = useMemo(() => {
    const map = new Map();
    for (const contact of data?.contacts || []) {
      map.set(contact.senderIgId, contact.segment);
    }
    return map;
  }, [data]);

  if (loading || !data) {
    return html`
      <main className="shell">
        <section className="hero">
          <h1>InstaReply React Console</h1>
          <p>Loading app...</p>
        </section>
      </main>
    `;
  }

  const latestMessage = data.messages?.[0] || null;
  const connected = data.connection?.status === "CONNECTED";
  const statusTone = connectionTone(data.connection?.status);

  const overviewTab = html`
    <section className="overview-grid">
      <article className="card stat">
        <h3>Connection</h3>
        <p className=${`status-pill ${statusTone}`}>${data.connection.status}</p>
      </article>
      <article className="card stat">
        <h3>Policies</h3>
        <p>${data.policies.length}</p>
      </article>
      <article className="card stat">
        <h3>Contacts</h3>
        <p>${data.contacts.length}</p>
      </article>
      <article className="card stat">
        <h3>Inbox</h3>
        <p>${data.messages.length}</p>
      </article>
    </section>

    <section className="card">
      <h2>Latest Message</h2>
      ${latestMessage
        ? html`
            <div className="stack">
              <p><strong>Sender:</strong> ${latestMessage.senderIgId}</p>
              <p><strong>Segment:</strong> ${latestMessage.segment}</p>
              <p><strong>Received:</strong> ${formatTimestamp(latestMessage.receivedAt)}</p>
              <p><strong>Text:</strong> ${latestMessage.text}</p>
            </div>
          `
        : html`<p className="muted">No messages yet.</p>`}
    </section>

    <section className="card">
      <h2>Account Interaction Overview</h2>
      <p className="muted">Past interactions grouped by sender account.</p>
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>Segment</th>
            <th>Inbound Count</th>
            <th>Last Inbound</th>
            <th>Last Automated Reply</th>
            <th>Since Auto Reply</th>
          </tr>
        </thead>
        <tbody>
          ${data.accountSummaries.length === 0
            ? html`<tr><td colspan="6">No interaction history yet.</td></tr>`
            : data.accountSummaries.map(
                (summary) => html`
                  <tr key=${summary.senderIgId}>
                    <td>${summary.senderIgId}</td>
                    <td>${summary.segment}</td>
                    <td>${summary.inboundCount}</td>
                    <td>
                      ${formatTimestamp(summary.lastInboundAt)}
                      <div className="muted">${summary.lastInboundText || "No text"}</div>
                    </td>
                    <td>${formatTimestamp(summary.lastAutomatedReplyAt)}</td>
                    <td>${formatElapsed(summary.lastAutomatedReplyAt)}</td>
                  </tr>
                `
              )}
        </tbody>
      </table>
    </section>
  `;

  const messageConfigTab = html`
    <section className="card">
      <h2>Segment Auto-Reply Policies</h2>
      <table>
        <thead>
          <tr>
            <th>Segment</th>
            <th>Config</th>
          </tr>
        </thead>
        <tbody>
          ${data.policies.map(
            (policy) => html`
              <tr key=${policy.segment}>
                <td>${policy.segment}</td>
                <td>
                  <form
                    className="stack"
                    onSubmit=${(event) => {
                      event.preventDefault();
                      const form = new FormData(event.currentTarget);
                      void doAction(
                        () =>
                          requestJSON("/api/app/policy", {
                            method: "POST",
                            body: JSON.stringify({
                              segment: policy.segment,
                              autoSend: Boolean(form.get("autoSend")),
                              requireHumanApproval: Boolean(form.get("requireHumanApproval")),
                              template: String(form.get("template") || "")
                            })
                          }),
                        `${policy.segment} policy updated.`
                      );
                    }}
                  >
                    <div className="row">
                      <label>
                        <input type="checkbox" name="autoSend" defaultChecked=${policy.autoSend} />
                        Auto send
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          name="requireHumanApproval"
                          defaultChecked=${policy.requireHumanApproval}
                        />
                        Require human approval
                      </label>
                    </div>
                    <textarea
                      name="template"
                      defaultValue=${policy.template || ""}
                      placeholder="Optional template"
                    ></textarea>
                    <button className="btn secondary" type="submit" disabled=${busy}>Save Policy</button>
                  </form>
                </td>
              </tr>
            `
          )}
        </tbody>
      </table>
    </section>

    <section className="card">
      <h2>Inbound Inbox</h2>
      <p className="muted">Edit suggested drafts and manually send replies.</p>
      <table>
        <thead>
          <tr>
            <th>Sender</th>
            <th>Segment</th>
            <th>Inbound</th>
            <th>Intent / Confidence</th>
            <th>Reply</th>
          </tr>
        </thead>
        <tbody>
          ${data.messages.length === 0
            ? html`<tr><td colspan="5">No inbound messages yet.</td></tr>`
            : data.messages.map(
                (message) => html`
                  <tr key=${message.id}>
                    <td>${message.senderIgId}</td>
                    <td>${senderSegmentLookup.get(message.senderIgId) || "STRANGER"}</td>
                    <td>${message.text}</td>
                    <td>
                      ${message.intent || "n/a"} (${typeof message.confidence === "number"
                        ? message.confidence.toFixed(2)
                        : "n/a"})
                    </td>
                    <td>
                      <form
                        className="stack"
                        onSubmit=${(event) => {
                          event.preventDefault();
                          const reply = String(draftReplies[message.id] || "").trim();
                          if (!reply) {
                            setNotice("Reply text cannot be empty.");
                            return;
                          }
                          void doAction(
                            () =>
                              requestJSON("/api/app/send", {
                                method: "POST",
                                body: JSON.stringify({
                                  messageId: message.id,
                                  reply
                                })
                              }),
                            "Reply sent."
                          );
                        }}
                      >
                        <textarea
                          value=${draftReplies[message.id] || ""}
                          onInput=${(event) =>
                            setDraftReplies((current) => ({
                              ...current,
                              [message.id]: event.target.value
                            }))}
                        ></textarea>
                        <button className="btn secondary" type="submit" disabled=${busy || !connected}>
                          ${connected ? "Send Reply" : "Connect Instagram First"}
                        </button>
                      </form>
                    </td>
                  </tr>
                `
              )}
        </tbody>
      </table>
    </section>
  `;

  const contactsTab = html`
    <section className="card">
      <h2>Contact Grouping / Classification</h2>
      <form
        className="inline-grid"
        onSubmit=${(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void doAction(
            () =>
              requestJSON("/api/app/contact-segment", {
                method: "POST",
                body: JSON.stringify({
                  senderIgId: String(form.get("senderIgId") || ""),
                  segment: String(form.get("segment") || "")
                })
              }),
            "Contact segment updated."
          );
        }}
      >
        <input name="senderIgId" placeholder="Instagram sender ID" required />
        <select name="segment">
          ${SEGMENTS.map((segment) => html`<option value=${segment}>${segment}</option>`)}
        </select>
        <button className="btn secondary" type="submit" disabled=${busy}>Save</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Sender</th>
            <th>Segment</th>
          </tr>
        </thead>
        <tbody>
          ${data.contacts.length === 0
            ? html`<tr><td colspan="2">No contacts yet.</td></tr>`
            : data.contacts.map(
                (contact) => html`
                  <tr key=${contact.senderIgId}>
                    <td>${contact.senderIgId}</td>
                    <td>
                      <form
                        className="row"
                        onSubmit=${(event) => {
                          event.preventDefault();
                          const form = new FormData(event.currentTarget);
                          void doAction(
                            () =>
                              requestJSON("/api/app/contact-segment", {
                                method: "POST",
                                body: JSON.stringify({
                                  senderIgId: contact.senderIgId,
                                  segment: String(form.get("segment") || "")
                                })
                              }),
                            "Contact segment saved."
                          );
                        }}
                      >
                        <select name="segment" defaultValue=${contact.segment}>
                          ${SEGMENTS.map((segment) => html`<option value=${segment}>${segment}</option>`)}
                        </select>
                        <button className="btn secondary" type="submit" disabled=${busy}>Update</button>
                      </form>
                    </td>
                  </tr>
                `
              )}
        </tbody>
      </table>
    </section>
  `;

  const accountTab = html`
    <section className="card">
      <h2>Instagram Account Connection</h2>
      <div className="stack">
        <p>
          <strong>Status:</strong>
          <span className=${`status-pill ${statusTone}`}>${data.connection.status}</span>
        </p>
        <p><strong>IG Business ID:</strong> ${data.connection.igBusinessAccountId || "Not set"}</p>
        <p><strong>Page:</strong> ${data.connection.pageName || "Not set"} (${data.connection.pageId || "n/a"})</p>
        <p><strong>Connected At:</strong> ${formatTimestamp(data.connection.connectedAt)}</p>
        <p><strong>OAuth Redirect:</strong> ${data.oauth.configuredRedirect || "Inferred from host"}</p>
        <p><strong>Last Error:</strong> ${data.connection.lastError || "None"}</p>
      </div>

      <div className="actions">
        <a className="btn primary" href=${data.oauth.startUrl}>Connect with Meta OAuth</a>
        <button
          className="btn danger"
          disabled=${busy}
          onClick=${() =>
            doAction(
              () =>
                requestJSON("/api/app/connection/disconnect", {
                  method: "POST",
                  body: "{}"
                }),
              "Connection cleared."
            )}
        >
          Disconnect
        </button>
      </div>

      ${data.oauth.ready
        ? null
        : html`<p className="muted">OAuth requires META_APP_ID and META_APP_SECRET in your environment.</p>`}

      <h3>Manual Connection (Local Demo)</h3>
      <form
        className="stack"
        onSubmit=${(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void doAction(
            () =>
              requestJSON("/api/app/connection/manual", {
                method: "POST",
                body: JSON.stringify({
                  accessToken: String(form.get("accessToken") || ""),
                  igBusinessAccountId: String(form.get("igBusinessAccountId") || ""),
                  pageId: String(form.get("pageId") || ""),
                  pageName: String(form.get("pageName") || "")
                })
              }),
            "Manual connection saved."
          );
        }}
      >
        <div className="inline-grid">
          <input name="accessToken" placeholder="Access token" required />
          <input name="igBusinessAccountId" placeholder="IG business account ID" required />
          <input name="pageId" placeholder="Page ID (optional)" />
          <input name="pageName" placeholder="Page name (optional)" />
        </div>
        <button className="btn secondary" type="submit" disabled=${busy}>Save Manual Connection</button>
      </form>
    </section>
  `;

  const settingsTab = html`
    <section className="card">
      <h2>Settings</h2>
      <div className="setting-group">
        <h3>Theme</h3>
        <div className="row">
          <label>
            <input
              type="radio"
              name="theme"
              checked=${settings.theme === "light"}
              onChange=${() => setSettings((current) => ({ ...current, theme: "light" }))}
            />
            Light
          </label>
          <label>
            <input
              type="radio"
              name="theme"
              checked=${settings.theme === "dark"}
              onChange=${() => setSettings((current) => ({ ...current, theme: "dark" }))}
            />
            Dark
          </label>
        </div>
      </div>

      <div className="setting-group">
        <h3>Font Size</h3>
        <div className="row">
          <input
            type="range"
            min="85"
            max="130"
            step="1"
            value=${settings.fontScale}
            onInput=${(event) =>
              setSettings((current) => ({
                ...current,
                fontScale: clamp(Number(event.target.value), 85, 130)
              }))}
          />
          <span>${settings.fontScale}%</span>
        </div>
      </div>

      <div className="actions">
        <button className="btn secondary" onClick=${() => setSettings(DEFAULT_SETTINGS)}>
          Reset UI Settings
        </button>
      </div>
    </section>
  `;

  let tabContent = overviewTab;
  if (activeTab === "messages") tabContent = messageConfigTab;
  if (activeTab === "contacts") tabContent = contactsTab;
  if (activeTab === "account") tabContent = accountTab;
  if (activeTab === "settings") tabContent = settingsTab;

  return html`
    <style>
      :root {
        --font-scale: 1;
      }

      [data-theme="light"] {
        --ink: #21243a;
        --muted: #626783;
        --card: rgba(255, 255, 255, 0.9);
        --line: rgba(43, 46, 73, 0.14);
        --surface: rgba(255, 255, 255, 0.7);
        --surface-2: rgba(255, 255, 255, 0.9);
        --shadow: rgba(30, 20, 68, 0.08);
      }

      [data-theme="dark"] {
        --ink: #eff1ff;
        --muted: #bcc0dd;
        --card: rgba(24, 23, 39, 0.88);
        --line: rgba(151, 157, 203, 0.2);
        --surface: rgba(34, 33, 55, 0.68);
        --surface-2: rgba(32, 31, 54, 0.9);
        --shadow: rgba(0, 0, 0, 0.35);
      }

      #root {
        font-size: calc(16px * var(--font-scale));
      }

      .shell {
        max-width: 1320px;
        margin: 0 auto;
        display: grid;
        gap: 14px;
        color: var(--ink);
      }

      .hero {
        border-radius: 20px;
        border: 1px solid var(--line);
        padding: 16px;
        background:
          linear-gradient(130deg, var(--surface-2), var(--surface)),
          linear-gradient(120deg, rgba(246, 55, 149, 0.2), rgba(123, 47, 247, 0.22));
        box-shadow: 0 10px 26px var(--shadow);
      }

      .hero h1 {
        margin: 0;
        font-size: clamp(1.44rem, 3vw, 2rem);
        font-weight: 700;
      }

      .hero p {
        margin: 8px 0 0;
        color: var(--muted);
      }

      .top-actions {
        margin-top: 10px;
        display: flex;
        gap: 8px;
      }

      .notice {
        margin-top: 10px;
        border-radius: 10px;
        padding: 9px 11px;
        font-size: 0.92rem;
        border: 1px solid rgba(66, 109, 201, 0.3);
        background: rgba(66, 109, 201, 0.12);
      }

      .tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .tab {
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--surface-2);
        color: var(--ink);
        padding: 8px 12px;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }

      .tab.active {
        border-color: rgba(123, 47, 247, 0.5);
        background: linear-gradient(140deg, rgba(246, 55, 149, 0.2), rgba(123, 47, 247, 0.26));
      }

      .overview-grid {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }

      .card {
        border-radius: 16px;
        border: 1px solid var(--line);
        background: var(--card);
        box-shadow: 0 8px 18px var(--shadow);
        padding: 12px;
      }

      .card h2 {
        margin: 0 0 8px;
        font-size: 1.05rem;
        font-weight: 650;
      }

      .card h3 {
        margin: 0 0 8px;
        font-size: 0.95rem;
        font-weight: 640;
      }

      .stat p {
        margin: 0;
        font-size: 1.48rem;
        font-weight: 600;
        letter-spacing: 0.01em;
      }

      .status-pill {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 4px 9px;
        font-size: 0.84rem;
        font-weight: 620;
        border: 1px solid transparent;
      }

      .status-pill.ok {
        color: #0f8d4f;
        border-color: rgba(15, 141, 79, 0.3);
        background: rgba(15, 141, 79, 0.12);
      }

      .status-pill.err {
        color: #c63a4d;
        border-color: rgba(198, 58, 77, 0.3);
        background: rgba(198, 58, 77, 0.12);
      }

      .status-pill.warn {
        color: #b17500;
        border-color: rgba(177, 117, 0, 0.3);
        background: rgba(177, 117, 0, 0.12);
      }

      .muted {
        color: var(--muted);
      }

      .stack {
        display: grid;
        gap: 8px;
      }

      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .inline-grid {
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        align-items: center;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 8px;
        font-size: 0.92rem;
      }

      th,
      td {
        border: 1px solid var(--line);
        padding: 8px;
        text-align: left;
        vertical-align: top;
        font-weight: 450;
      }

      th {
        background: var(--surface);
        font-weight: 600;
      }

      input,
      select,
      textarea {
        width: 100%;
        border-radius: 10px;
        border: 1px solid var(--line);
        background: var(--surface-2);
        color: var(--ink);
        padding: 8px 10px;
        font: inherit;
      }

      textarea {
        min-height: 74px;
        resize: vertical;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .btn {
        border-radius: 10px;
        border: 1px solid transparent;
        padding: 8px 12px;
        font: inherit;
        font-weight: 560;
        cursor: pointer;
      }

      .btn.primary {
        color: white;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg, #f63795, #7b2ff7);
        box-shadow: 0 4px 12px rgba(123, 47, 247, 0.3);
      }

      .btn.secondary {
        color: var(--ink);
        border-color: rgba(123, 47, 247, 0.3);
        background: rgba(123, 47, 247, 0.11);
      }

      .btn.danger {
        color: #c63a4d;
        border-color: rgba(198, 58, 77, 0.3);
        background: rgba(198, 58, 77, 0.1);
      }

      .btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      .setting-group {
        margin-bottom: 14px;
      }

      .setting-group h3 {
        margin: 0 0 7px;
      }

      @media (max-width: 1024px) {
        #root {
          padding: 12px;
        }

        .overview-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .inline-grid {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 640px) {
        .overview-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>

    <main className="shell">
      <section className="hero">
        <h1>InstaReply React Console</h1>
        <p>App-style interface for Instagram connection, message automation, and audience control.</p>
        <div className="top-actions">
          <a className="btn secondary" href="/app">Legacy View</a>
        </div>
        ${notice ? html`<div className="notice">${notice}</div>` : null}
      </section>

      <nav className="tabs">
        ${TABS.map(
          (tab) => html`
            <button
              key=${tab.id}
              className=${`tab ${activeTab === tab.id ? "active" : ""}`}
              onClick=${() => setActiveTab(tab.id)}
            >
              ${tab.label}
            </button>
          `
        )}
      </nav>

      ${tabContent}
    </main>
  `;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
