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

const samples = {
  ask: "@claude rule ask rule về browser-based definition of done đã có chưa?",
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
    let chatPollTimer: ReturnType<typeof setInterval> | null = null;

    const selectedId = computed(() => selected.value?.id ?? null);
    const isTestPage = computed(() => route.value === "test");

    async function loadRuntimeConfig() {
      const res = await fetch("/api/runtime-config");
      if (!res.ok) return;
      runtimeConfig.value = (await res.json()) as RuntimeConfig;
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
      window.history.pushState(null, "", nextRoute === "test" ? "/test-page" : "/");
    }

    onMounted(() => {
      void loadRuntimeConfig();
      void loadUpdates();
      void loadChatMessages();
      chatPollTimer = setInterval(() => {
        if (route.value === "test") {
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
      loadUpdates,
      selectUpdate,
      formatDate,
      navigate,
      sendChatMessage,
      clearChat,
      useSample,
      renderMessage
    };
  },
  template: `
    <main class="page">
      <header class="topbar">
        <div>
          <h1>{{ isTestPage ? 'Mattermost Test Page' : 'AI-DLC Rule Update History' }}</h1>
          <p>{{ isTestPage ? 'Fake Mattermost chat for rule ask/add/update/delete commands.' : 'Read-only dashboard for Mattermost-triggered rule changes.' }}</p>
        </div>
        <nav class="nav">
          <button class="nav-button" :class="{ active: route === 'history' }" @click="navigate('history')">History</button>
          <button class="nav-button" :class="{ active: route === 'test' }" @click="navigate('test')">Test Page</button>
        </nav>
      </header>

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
  `
});

app.mount("#app");
