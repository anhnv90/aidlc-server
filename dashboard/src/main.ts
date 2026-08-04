import { createApp, computed, onMounted, onUnmounted, ref } from "vue";
import "./styles.css";

type RuleUpdate = {
  id: number;
  mattermostPostId: string | null;
  mattermostChannelId: string;
  mattermostUserId: string;
  mattermostUsername: string | null;
  commandText: string;
  action: "add" | "update" | "delete";
  ruleId: string;
  title: string | null;
  targetFiles: string[];
  status: "received" | "running" | "pr_created" | "failed" | "rejected";
  gitBranch: string | null;
  githubPrUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

type FakeChatMessage = {
  id: string;
  channelId: string;
  userId: string;
  username: string;
  role: "user" | "bot";
  message: string;
  attachments?: Array<{
    fallback: string;
    color: string;
    title: string;
    text: string;
  }>;
  rootId?: string;
  createdAt: string;
};

type RuntimeConfig = {
  mattermostFakeMode: boolean;
  allowedChannelIds: string[];
  ruleUpdateDryRun: boolean;
  claudeFakeMode: boolean;
};

type AuthStatus = {
  authenticated: boolean;
  username: string | null;
};

const samples = {
  ask: "@claude rule về browser-based definition of done đã có chưa?",
  add: `@claude rule add
rule_id: DOD-UI-02
target: aidlc-rules/.aidlc-rule-details/construction/build-and-test.md
title: Test page sample rule
content:
  This is a sample rule created from the test page.
acceptance:
  - Create PR only; do not merge automatically.`,
  update: `@claude rule update
rule_id: NP-TST-01
content:
  For each unit, produce unit-test-design.md BEFORE test implementation.
  This demo update intentionally targets an existing rule on main so the PR flow can be tested.`,
  delete: `@claude rule delete
rule_id: NP-TST-01`
};

function renderMessage(value: string) {
  const markdownLinkPattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let output = "";
  let lastIndex = 0;

  for (const match of value.matchAll(markdownLinkPattern)) {
    const index = match.index ?? 0;
    output += linkifyBareUrls(value.slice(lastIndex, index));
    output += `<a href="${escapeHtml(match[2])}" target="_blank" rel="noreferrer">${escapeHtml(match[1])}</a>`;
    lastIndex = index + match[0].length;
  }

  output += linkifyBareUrls(value.slice(lastIndex));
  return output;
}

function linkifyBareUrls(value: string) {
  return escapeHtml(value).replace(/https?:\/\/[^\s<]+/g, (rawUrl) => {
    const match = /^(.*?)([.,;:!?)]*)$/.exec(rawUrl);
    const url = match?.[1] ?? rawUrl;
    const trailing = match?.[2] ?? "";
    return `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>${trailing}`;
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const app = createApp({
  setup() {
    const route = ref(window.location.pathname === "/test-page" ? "test" : "history");
    const authChecked = ref(false);
    const authenticated = ref(false);
    const authUsername = ref<string | null>(null);
    const loginUsername = ref("admin");
    const loginPassword = ref("");
    const loginLoading = ref(false);
    const loginError = ref("");

    const updates = ref<RuleUpdate[]>([]);
    const selected = ref<RuleUpdate | null>(null);
    const loading = ref(false);
    const error = ref("");
    const filters = ref({
      status: "",
      ruleId: "",
      user: "",
      q: ""
    });

    const runtimeConfig = ref<RuntimeConfig | null>(null);
    const chatMessages = ref<FakeChatMessage[]>([]);
    const chatInput = ref(samples.ask);
    const chatLoading = ref(false);
    const chatError = ref("");
    const directPostChannelId = ref("__all__");
    const directPostMessage = ref("");
    const directPostLoading = ref(false);
    const directPostStatus = ref("");
    const directPostError = ref("");
    let chatPollTimer: ReturnType<typeof setInterval> | null = null;

    const selectedId = computed(() => selected.value?.id ?? null);
    const isTestPage = computed(() => route.value === "test");
    const menuOpen = ref(false);
    const pageTitle = computed(() => (isTestPage.value ? "Mattermost Test Chat" : "Mattermost chat history"));
    const pageSubtitle = computed(() =>
      isTestPage.value
        ? "Fake Mattermost chat for rule ask/add/update/delete commands."
        : "Send Mattermost messages and review rule update history."
    );
    const apiStatusLabel = computed(() => (runtimeConfig.value ? "API ready" : "Loading API"));

    async function loadAuthStatus() {
      try {
        const res = await fetch("/api/auth/status");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as AuthStatus;
        authenticated.value = data.authenticated;
        authUsername.value = data.username;
      } catch {
        authenticated.value = false;
        authUsername.value = null;
      } finally {
        authChecked.value = true;
      }
    }

    async function loginUser() {
      loginLoading.value = true;
      loginError.value = "";
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: loginUsername.value,
            password: loginPassword.value
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        authenticated.value = true;
        authUsername.value = data.username ?? loginUsername.value;
        loginPassword.value = "";
        await loadInitialData();
      } catch (err) {
        loginError.value = err instanceof Error ? err.message : String(err);
      } finally {
        loginLoading.value = false;
      }
    }

    async function logoutUser() {
      await fetch("/api/auth/logout", { method: "POST" });
      authenticated.value = false;
      authUsername.value = null;
      runtimeConfig.value = null;
      updates.value = [];
      selected.value = null;
      chatMessages.value = [];
      window.history.pushState(null, "", "/");
      route.value = "history";
    }

    async function loadInitialData() {
      await loadRuntimeConfig();
      await loadUpdates();
      await loadChatMessages();
    }

    async function loadRuntimeConfig() {
      const res = await fetch("/api/runtime-config");
      if (!res.ok) return;
      const data = (await res.json()) as RuntimeConfig;
      runtimeConfig.value = data;
      if (data.allowedChannelIds.length === 1) {
        directPostChannelId.value = data.allowedChannelIds[0];
      }
    }

    async function loadUpdates() {
      loading.value = true;
      error.value = "";
      const params = new URLSearchParams();
      Object.entries(filters.value).forEach(([key, value]) => {
        if (value.trim()) params.set(key, value.trim());
      });

      try {
        const res = await fetch(`/api/rule-updates?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { items: RuleUpdate[] };
        updates.value = data.items;
        if (!selected.value && data.items.length > 0) {
          selected.value = data.items[0];
        } else if (selected.value) {
          selected.value = data.items.find((item) => item.id === selected.value?.id) ?? data.items[0] ?? null;
        }
      } catch (err) {
        error.value = err instanceof Error ? err.message : String(err);
      } finally {
        loading.value = false;
      }
    }

    async function loadChatMessages() {
      try {
        const res = await fetch("/api/test-chat/messages");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { items: FakeChatMessage[] };
        chatMessages.value = data.items;
      } catch (err) {
        chatError.value = err instanceof Error ? err.message : String(err);
      }
    }

    async function sendChatMessage() {
      const message = chatInput.value.trim();
      if (!message) return;
      chatLoading.value = true;
      chatError.value = "";
      try {
        const res = await fetch("/api/test-chat/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            userId: "fake-admin-user-id",
            username: "ThuyTT",
            channelId: runtimeConfig.value?.allowedChannelIds?.[0] ?? "fake-channel-id",
            message
          })
        });
        if (!res.ok) throw new Error(await res.text());
        await loadChatMessages();
        await loadUpdates();
      } catch (err) {
        chatError.value = err instanceof Error ? err.message : String(err);
      } finally {
        chatLoading.value = false;
      }
    }

    async function clearChat() {
      await fetch("/api/test-chat/messages", { method: "DELETE" });
      await loadChatMessages();
    }

    async function sendDirectPost() {
      const message = directPostMessage.value.trim();
      if (!message) return;

      directPostLoading.value = true;
      directPostStatus.value = "";
      directPostError.value = "";

      try {
        const res = await fetch("/api/mattermost/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channelId: directPostChannelId.value,
            message
          })
        });
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        const count = Array.isArray(data.results) ? data.results.length : 0;
        directPostStatus.value = `Posted to ${count} channel${count === 1 ? "" : "s"}.`;
        directPostMessage.value = "";
      } catch (err) {
        directPostError.value = err instanceof Error ? err.message : String(err);
      } finally {
        directPostLoading.value = false;
      }
    }

    function useSample(name: keyof typeof samples) {
      chatInput.value = samples[name];
    }

    function selectUpdate(update: RuleUpdate) {
      selected.value = update;
    }

    function formatDate(value: string) {
      return new Date(value).toLocaleString();
    }

    function navigate(nextRoute: "history" | "test") {
      route.value = nextRoute;
      menuOpen.value = false;
      window.history.pushState(null, "", nextRoute === "test" ? "/test-page" : "/");
    }

    function toggleMenu() {
      menuOpen.value = !menuOpen.value;
    }

    onMounted(() => {
      void loadAuthStatus().then(() => {
        if (authenticated.value) {
          void loadInitialData();
        }
      });
      chatPollTimer = setInterval(() => {
        if (authenticated.value && route.value === "test") {
          void loadChatMessages();
          void loadUpdates();
        }
      }, 2000);
      window.addEventListener("popstate", () => {
        route.value = window.location.pathname === "/test-page" ? "test" : "history";
      });
    });

    onUnmounted(() => {
      if (chatPollTimer) clearInterval(chatPollTimer);
    });

    return {
      route,
      isTestPage,
      menuOpen,
      pageTitle,
      pageSubtitle,
      apiStatusLabel,
      authChecked,
      authenticated,
      authUsername,
      loginUsername,
      loginPassword,
      loginLoading,
      loginError,
      updates,
      selected,
      selectedId,
      loading,
      error,
      filters,
      runtimeConfig,
      chatMessages,
      chatInput,
      chatLoading,
      chatError,
      directPostChannelId,
      directPostMessage,
      directPostLoading,
      directPostStatus,
      directPostError,
      loadUpdates,
      loginUser,
      logoutUser,
      toggleMenu,
      selectUpdate,
      formatDate,
      navigate,
      sendChatMessage,
      clearChat,
      sendDirectPost,
      useSample,
      renderMessage
    };
  },
  template: `
    <main v-if="authChecked && !authenticated" class="login-page">
      <form class="login-card" @submit.prevent="loginUser">
        <div>
          <h1>AI-DLC Server Management</h1>
          <p>Sign in to manage Mattermost, rules, and the source graph.</p>
        </div>
        <label>
          <span>Username</span>
          <input v-model="loginUsername" autocomplete="username" autofocus />
        </label>
        <label>
          <span>Password</span>
          <input v-model="loginPassword" type="password" autocomplete="current-password" />
        </label>
        <p v-if="loginError" class="login-error">{{ loginError }}</p>
        <button class="button" type="submit" :disabled="loginLoading">
          {{ loginLoading ? 'Signing in...' : 'Login' }}
        </button>
      </form>
    </main>

    <main v-else-if="authChecked" class="page">
      <header class="topbar">
        <div class="topbar-left">
          <button
            class="hamburger-button"
            type="button"
            :aria-expanded="menuOpen ? 'true' : 'false'"
            aria-label="Open navigation menu"
            @click="toggleMenu"
          >
            <span class="menu-icon" aria-hidden="true">&#9776;</span>
          </button>
          <h1>AI-DLC Server Management</h1>
          <nav class="hamburger-menu" :class="{ open: menuOpen }">
            <button class="menu-link" :class="{ active: route === 'history' }" @click="navigate('history')">Mattermost chat history</button>
            <a class="menu-link" href="/scan.html">Graph Scan</a>
            <a class="menu-link" href="/graph-viewer.html">Graph Viewer</a>
          </nav>
        </div>
        <div class="topbar-user">
          <span class="user-name">{{ authUsername || 'admin' }}</span>
          <button class="logout-button" type="button" @click="logoutUser">Logout</button>
        </div>
      </header>

      <section class="page-heading">
        <div>
          <h2>{{ pageTitle }}</h2>
          <p>{{ pageSubtitle }}</p>
        </div>
        <span class="page-status"><span class="dot ready"></span>{{ apiStatusLabel }}</span>
      </section>

      <section v-if="isTestPage" class="content">
        <div class="runtime-strip">
          <span>mattermost fake: <strong>{{ runtimeConfig?.mattermostFakeMode }}</strong></span>
          <span>test channel: <strong>{{ runtimeConfig?.allowedChannelIds?.[0] || 'fake-channel-id' }}</strong></span>
          <span>rule dry-run: <strong>{{ runtimeConfig?.ruleUpdateDryRun }}</strong></span>
          <span>claude fake: <strong>{{ runtimeConfig?.claudeFakeMode }}</strong></span>
        </div>

        <div class="test-layout">
          <aside class="panel">
            <div class="panel-header">
              <h2>Samples</h2>
            </div>
            <div class="sample-list">
              <button class="sample-button" @click="useSample('ask')">Ask/Search</button>
              <button class="sample-button" @click="useSample('add')">Add Rule</button>
              <button class="sample-button" @click="useSample('update')">Update Rule</button>
              <button class="sample-button danger" @click="useSample('delete')">Delete Rule</button>
            </div>
          </aside>

          <section class="panel chat-panel">
            <div class="panel-header">
              <h2>Fake Mattermost Channel</h2>
              <button class="link-button" @click="clearChat">Clear</button>
            </div>

            <div class="chat-messages">
              <div v-if="chatMessages.length === 0" class="empty">No messages yet.</div>
              <article
                v-for="item in chatMessages"
                :key="item.id"
                class="chat-message"
                :class="item.role"
              >
                <div class="avatar">{{ item.role === 'bot' ? 'C' : 'T' }}</div>
                <div class="bubble">
                  <div class="message-meta">
                    <strong>{{ item.role === 'bot' ? '@claude' : item.username }}</strong>
                    <span>{{ formatDate(item.createdAt) }}</span>
                  </div>
                  <div v-if="item.role === 'bot' && item.attachments?.length" class="attachment-list">
                    <div
                      v-for="attachment in item.attachments"
                      :key="attachment.fallback"
                      class="message-attachment"
                      :style="{ borderLeftColor: attachment.color || '#2e90fa' }"
                    >
                      <div v-if="attachment.title" class="attachment-title">{{ attachment.title }}</div>
                      <div class="attachment-text" v-html="renderMessage(attachment.text || item.message)"></div>
                    </div>
                  </div>
                  <div v-else class="message-body" v-html="renderMessage(item.message)"></div>
                </div>
              </article>
            </div>

            <form class="composer" @submit.prevent="sendChatMessage">
              <textarea v-model="chatInput" rows="8" spellcheck="false"></textarea>
              <div class="composer-actions">
                <span v-if="chatError" class="error-text">{{ chatError }}</span>
                <button class="button" type="submit" :disabled="chatLoading">{{ chatLoading ? 'Sending...' : 'Send' }}</button>
              </div>
            </form>
          </section>
        </div>
      </section>

      <section v-else class="content">
        <section class="panel direct-post-panel">
          <div class="panel-header">
            <h2>Mattermost Post</h2>
          </div>
          <form class="direct-post-form" @submit.prevent="sendDirectPost">
            <div class="field channel-field">
              <label>Channel</label>
              <select v-model="directPostChannelId">
                <option v-if="(runtimeConfig?.allowedChannelIds?.length || 0) > 1" value="__all__">All allowed channels</option>
                <option
                  v-for="channelId in runtimeConfig?.allowedChannelIds || []"
                  :key="channelId"
                  :value="channelId"
                >
                  {{ channelId }}
                </option>
              </select>
            </div>
            <div class="field direct-message-field">
              <label>Message</label>
              <textarea
                v-model="directPostMessage"
                rows="3"
                placeholder="Message to post as Claude Bot"
              ></textarea>
            </div>
            <button
              class="button direct-post-button"
              type="submit"
              :disabled="directPostLoading || !directPostMessage.trim() || !(runtimeConfig?.allowedChannelIds?.length)"
            >
              {{ directPostLoading ? 'Posting...' : 'Post' }}
            </button>
          </form>
          <div v-if="directPostStatus || directPostError" class="direct-post-feedback">
            <span v-if="directPostStatus" class="success-text">{{ directPostStatus }}</span>
            <span v-if="directPostError" class="error-text">{{ directPostError }}</span>
          </div>
        </section>

        <form class="filters" @submit.prevent="loadUpdates">
          <div class="field">
            <label>Status</label>
            <select v-model="filters.status">
              <option value="">All</option>
              <option value="received">received</option>
              <option value="running">running</option>
              <option value="pr_created">pr_created</option>
              <option value="failed">failed</option>
              <option value="rejected">rejected</option>
            </select>
          </div>
          <div class="field">
            <label>Rule ID</label>
            <input v-model="filters.ruleId" placeholder="DOD-UI-01" />
          </div>
          <div class="field">
            <label>User</label>
            <input v-model="filters.user" placeholder="username or user id" />
          </div>
          <div class="field">
            <label>Text</label>
            <input v-model="filters.q" placeholder="command text" />
          </div>
          <button class="button" type="submit">Refresh</button>
        </form>

        <p v-if="error" class="empty">Failed to load history: {{ error }}</p>

        <div class="layout">
          <section class="panel">
            <div class="panel-header">
              <h2>Updates</h2>
              <span class="muted">{{ loading ? 'Loading...' : updates.length + ' rows' }}</span>
            </div>
            <div v-if="updates.length === 0" class="empty">No rule updates yet.</div>
            <table v-else>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Rule</th>
                  <th>Action</th>
                  <th>Status</th>
                  <th>User</th>
                  <th>PR</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="item in updates"
                  :key="item.id"
                  :class="{ selected: item.id === selectedId }"
                  @click="selectUpdate(item)"
                >
                  <td>{{ formatDate(item.createdAt) }}</td>
                  <td>{{ item.ruleId }}</td>
                  <td>{{ item.action }}</td>
                  <td><span class="status" :class="item.status">{{ item.status }}</span></td>
                  <td>{{ item.mattermostUsername || item.mattermostUserId }}</td>
                  <td>
                    <a v-if="item.githubPrUrl" :href="item.githubPrUrl" target="_blank" rel="noreferrer">Open</a>
                    <span v-else class="muted">-</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <section class="panel">
            <div class="panel-header">
              <h2>Detail</h2>
            </div>
            <div v-if="!selected" class="empty">Select an update.</div>
            <div v-else class="detail">
              <dl class="detail-grid">
                <dt>ID</dt><dd>{{ selected.id }}</dd>
                <dt>Rule ID</dt><dd>{{ selected.ruleId }}</dd>
                <dt>Action</dt><dd>{{ selected.action }}</dd>
                <dt>Status</dt><dd><span class="status" :class="selected.status">{{ selected.status }}</span></dd>
                <dt>User</dt><dd>{{ selected.mattermostUsername || selected.mattermostUserId }}</dd>
                <dt>Channel</dt><dd>{{ selected.mattermostChannelId }}</dd>
                <dt>Post ID</dt><dd>{{ selected.mattermostPostId || '-' }}</dd>
                <dt>Branch</dt><dd>{{ selected.gitBranch || '-' }}</dd>
                <dt>PR</dt>
                <dd>
                  <a v-if="selected.githubPrUrl" :href="selected.githubPrUrl" target="_blank" rel="noreferrer">
                    {{ selected.githubPrUrl }}
                  </a>
                  <span v-else>-</span>
                </dd>
                <dt>Target files</dt><dd>{{ selected.targetFiles.join(', ') || '-' }}</dd>
                <dt>Created</dt><dd>{{ formatDate(selected.createdAt) }}</dd>
                <dt>Updated</dt><dd>{{ formatDate(selected.updatedAt) }}</dd>
                <dt>Error</dt><dd>{{ selected.errorMessage || '-' }}</dd>
              </dl>
              <pre>{{ selected.commandText }}</pre>
            </div>
          </section>
        </div>
      </section>
    </main>

    <main v-else class="login-page">
      <div class="login-card">
        <h1>AI-DLC Server Management</h1>
        <p>Loading...</p>
      </div>
    </main>
  `
});

app.mount("#app");
