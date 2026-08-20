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

type AppRoute = "dashboard" | "launcher" | "history" | "test";

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

function routeFromPath(pathname: string): AppRoute {
  if (pathname === "/test-page") return "test";
  if (pathname === "/mattermost") return "history";
  if (pathname === "/run-launcher") return "launcher";
  return "dashboard";
}

function pathForRoute(route: AppRoute) {
  switch (route) {
    case "test":
      return "/test-page";
    case "history":
      return "/mattermost";
    case "launcher":
      return "/run-launcher";
    case "dashboard":
    default:
      return "/";
  }
}

const app = createApp({
  setup() {
    const route = ref<AppRoute>(routeFromPath(window.location.pathname));
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
    const isDashboardPage = computed(() => route.value === "dashboard");
    const isLauncherPage = computed(() => route.value === "launcher");
    const isTestPage = computed(() => route.value === "test");
    const menuOpen = ref(false);
    const pageTitle = computed(() => {
      if (isDashboardPage.value) return "AI-DLC Operations Dashboard";
      if (isLauncherPage.value) return "Run Launcher";
      if (isTestPage.value) return "Mattermost Test Chat";
      return "Mattermost chat history";
    });
    const pageSubtitle = computed(() => {
      if (isDashboardPage.value) {
        return "Monitor AI-DLC v2 runs, gates, Claude sessions, source graph, PRs, token usage, and system health.";
      }
      if (isLauncherPage.value) {
        return "Step 2 will configure source, documents, branch policy, stage plan, and Claude prompt.";
      }
      return isTestPage.value
        ? "Fake Mattermost chat for rule ask/add/update/delete commands."
        : "Send Mattermost messages and review rule update history.";
    });
    const apiStatusLabel = computed(() => (runtimeConfig.value ? "API ready" : "Loading API"));
    const dashboardStats = computed(() => ({
      activeRuns: 4,
      approvalQueue: 7,
      claudeSessions: 3,
      openPrs: 5,
      tokenSpend: "$18.42",
      ruleUpdates: updates.value.length
    }));

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
      route.value = "dashboard";
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

    function navigate(nextRoute: AppRoute) {
      route.value = nextRoute;
      menuOpen.value = false;
      window.history.pushState(null, "", pathForRoute(nextRoute));
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
        route.value = routeFromPath(window.location.pathname);
      });
    });

    onUnmounted(() => {
      if (chatPollTimer) clearInterval(chatPollTimer);
    });

    return {
      route,
      isDashboardPage,
      isLauncherPage,
      isTestPage,
      menuOpen,
      pageTitle,
      pageSubtitle,
      apiStatusLabel,
      dashboardStats,
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

    <main v-else-if="authChecked && isDashboardPage" class="dashboard-console" :class="{ 'nav-open': menuOpen }">
      <aside class="side-nav" aria-label="AI-DLC navigation">
        <div class="brand">
          <button
            class="dash-menu-toggle"
            type="button"
            :aria-expanded="menuOpen ? 'true' : 'false'"
            :aria-label="menuOpen ? 'Close navigation' : 'Open navigation'"
            @click="toggleMenu"
          >
            <span aria-hidden="true"></span>
          </button>
          <div class="brand-mark">AD</div>
          <div class="brand-title">
            <strong>AI-DLC Ops</strong>
            <span>Control Tower</span>
          </div>
        </div>

        <nav class="nav-group">
          <div class="nav-heading">Operations</div>
          <button class="nav-item active" type="button"><span>Executive dashboard</span><span class="nav-count">24</span></button>
          <button class="nav-item" type="button"><span>Running tasks</span><span class="nav-count">18</span></button>
          <button class="nav-item" type="button"><span>Approval inbox</span><span class="nav-count">7</span></button>
          <button class="nav-item" type="button"><span>Workflow board</span><span class="nav-count">46</span></button>
          <button class="nav-item" type="button"><span>Logs explorer</span><span class="nav-count">12k</span></button>
        </nav>

        <nav class="nav-group">
          <div class="nav-heading">Intelligence</div>
          <button class="nav-item" type="button"><span>Source graph</span><span class="nav-count">9</span></button>
          <button class="nav-item" type="button"><span>Rule catalog</span><span class="nav-count">132</span></button>
          <button class="nav-item" type="button"><span>Cost analytics</span><span class="nav-count">$91</span></button>
          <button class="nav-item" type="button"><span>Artifacts</span><span class="nav-count">88</span></button>
        </nav>

        <nav class="nav-group">
          <div class="nav-heading">Administration</div>
          <button class="nav-item" type="button"><span>MCP tools</span><span class="nav-count">13</span></button>
          <button class="nav-item" type="button"><span>Mattermost</span><span class="nav-count">3</span></button>
          <button class="nav-item" type="button"><span>GitHub PRs</span><span class="nav-count">5</span></button>
          <button class="nav-item" type="button"><span>Settings</span><span class="nav-count">OK</span></button>
        </nav>

        <section class="side-status" aria-label="Runtime status">
          <h3>Runtime status</h3>
          <div class="status-row"><span>Server</span><strong>localhost:3003</strong></div>
          <div class="status-row"><span>MCP</span><strong>streamable-http</strong></div>
          <div class="status-row"><span>Claude</span><strong>sonnet</strong></div>
          <div class="status-row"><span>Graph DB</span><strong>ready</strong></div>
        </section>
      </aside>

      <section class="dash-main">
        <header class="topbar">
          <div class="breadcrumb">
            <span>AI-DLC</span><span>/</span><span>Operations</span><span>/</span><strong>Dashboard</strong>
          </div>
          <div class="search-box" aria-label="Search">
            <span>#</span>
            <span>Search runs, screens, classes, approvals, logs...</span>
          </div>
          <div class="top-actions">
            <div class="env-pill"><span class="dot"></span><strong>Production LAN</strong></div>
            <div class="time-pill">Last refresh: 14:08:31</div>
            <div class="user-pill"><strong>{{ authUsername || 'admin' }}</strong></div>
          </div>
        </header>

        <section class="dash-content">
          <div class="page-title">
            <div>
              <h1>AI-DLC Operations Dashboard</h1>
              <p>Unified control plane for Claude runs, human decisions, source graph intelligence, costs, logs, and Mattermost operations.</p>
            </div>
            <div class="button-row">
              <button class="btn" type="button">Export report</button>
              <button class="btn" type="button">Open graph scan</button>
              <button class="btn primary" type="button" @click="navigate('launcher')">New AI-DLC run</button>
            </div>
          </div>

          <div class="alert-strip">
            <div><strong>7 approval requests are waiting.</strong> Oldest blocker is 42 minutes old in Construction / Design Review for <code>uk.payroll-overtime</code>.</div>
            <button class="tiny-btn approve" type="button">Review inbox</button>
          </div>

          <section class="metric-grid" aria-label="Key metrics">
            <article class="metric">
              <div class="metric-label"><span>Active runs</span><span class="status-badge running">live</span></div>
              <div class="metric-value">18<span class="metric-unit">tasks</span></div>
              <div class="metric-foot"><span>4 new in 1h</span><span class="delta info">+12%</span></div>
            </article>
            <article class="metric">
              <div class="metric-label"><span>Pending approvals</span><span class="status-badge waiting">human</span></div>
              <div class="metric-value">7<span class="metric-unit">items</span></div>
              <div class="metric-foot"><span>Oldest 42m</span><span class="delta warn">SLA risk</span></div>
            </article>
            <article class="metric">
              <div class="metric-label"><span>Completed today</span><span class="status-badge completed">done</span></div>
              <div class="metric-value">29<span class="metric-unit">runs</span></div>
              <div class="metric-foot"><span>Build pass 86%</span><span class="delta good">+5%</span></div>
            </article>
            <article class="metric">
              <div class="metric-label"><span>Failed / blocked</span><span class="status-badge failed">watch</span></div>
              <div class="metric-value">3<span class="metric-unit">runs</span></div>
              <div class="metric-foot"><span>2 test failures</span><span class="delta bad">+1</span></div>
            </article>
            <article class="metric">
              <div class="metric-label"><span>Token usage</span><span class="status-badge cost">24h</span></div>
              <div class="metric-value">8.42M<span class="metric-unit">tok</span></div>
              <div class="metric-foot"><span>Cache read 41%</span><span class="delta good">efficient</span></div>
            </article>
            <article class="metric">
              <div class="metric-label"><span>Claude cost</span><span class="status-badge cost">budget</span></div>
              <div class="metric-value">$91.70</div>
              <div class="metric-foot"><span>Daily cap $150</span><span class="delta warn">61%</span></div>
            </article>
            <article class="metric">
              <div class="metric-label"><span>Graph coverage</span><span class="status-badge graph">AST</span></div>
              <div class="metric-value">94<span class="metric-unit">%</span></div>
              <div class="metric-foot"><span>9 projects scanned</span><span class="delta good">fresh</span></div>
            </article>
            <article class="metric">
              <div class="metric-label"><span>MCP calls</span><span class="status-badge running">tools</span></div>
              <div class="metric-value">1,284</div>
              <div class="metric-foot"><span>p95 188ms</span><span class="delta good">normal</span></div>
            </article>
          </section>

          <section class="dashboard-grid">
            <div class="left-stack span-2">
              <article class="panel">
                <div class="panel-header">
                  <h2>AI-DLC phase pipeline</h2>
                  <span class="panel-subtitle">46 open work items across 7 lifecycle phases</span>
                </div>
                <div class="panel-body">
                  <div class="phase-board">
                    <div class="phase">
                      <div class="phase-title"><span>Context</span><span class="phase-count">5</span></div>
                      <div class="work-card"><strong>UK HR reverse map</strong><span>graph evidence sync</span><div class="phase-bar"><div class="phase-fill fill-blue" style="width:82%"></div></div></div>
                      <div class="work-card"><strong>Payroll domain</strong><span>scope detection</span><div class="phase-bar"><div class="phase-fill fill-blue" style="width:46%"></div></div></div>
                    </div>
                    <div class="phase">
                      <div class="phase-title"><span>Reqs</span><span class="phase-count">8</span></div>
                      <div class="work-card"><strong>Overtime rules</strong><span>needs answers</span><div class="phase-bar"><div class="phase-fill fill-yellow" style="width:67%"></div></div></div>
                      <div class="work-card"><strong>Mobile flow</strong><span>story split</span><div class="phase-bar"><div class="phase-fill fill-cyan" style="width:54%"></div></div></div>
                    </div>
                    <div class="phase">
                      <div class="phase-title"><span>Design</span><span class="phase-count">7</span></div>
                      <div class="work-card"><strong>JAM001 trace</strong><span>human gate</span><div class="phase-bar"><div class="phase-fill fill-yellow" style="width:72%"></div></div></div>
                      <div class="work-card"><strong>API contract</strong><span>service split</span><div class="phase-bar"><div class="phase-fill fill-purple" style="width:38%"></div></div></div>
                    </div>
                    <div class="phase">
                      <div class="phase-title"><span>Tasks</span><span class="phase-count">6</span></div>
                      <div class="work-card"><strong>Unit backlog</strong><span>ready for impl</span><div class="phase-bar"><div class="phase-fill fill-teal" style="width:81%"></div></div></div>
                    </div>
                    <div class="phase">
                      <div class="phase-title"><span>Impl</span><span class="phase-count">11</span></div>
                      <div class="work-card"><strong>Remand handler</strong><span>Claude coding</span><div class="phase-bar"><div class="phase-fill fill-blue" style="width:61%"></div></div></div>
                      <div class="work-card"><strong>Rule DOD-UI</strong><span>PR draft</span><div class="phase-bar"><div class="phase-fill fill-green" style="width:88%"></div></div></div>
                    </div>
                    <div class="phase">
                      <div class="phase-title"><span>Build</span><span class="phase-count">6</span></div>
                      <div class="work-card"><strong>Gradle compile</strong><span>2 failures</span><div class="phase-bar"><div class="phase-fill fill-red" style="width:32%"></div></div></div>
                      <div class="work-card"><strong>Browser journey</strong><span>evidence pending</span><div class="phase-bar"><div class="phase-fill fill-yellow" style="width:53%"></div></div></div>
                    </div>
                    <div class="phase">
                      <div class="phase-title"><span>Deploy</span><span class="phase-count">3</span></div>
                      <div class="work-card"><strong>PR publish</strong><span>waiting CI</span><div class="phase-bar"><div class="phase-fill fill-green" style="width:73%"></div></div></div>
                    </div>
                  </div>
                </div>
              </article>

              <div class="split-grid">
                <article class="panel">
                  <div class="panel-header">
                    <h2>Token and cost trend</h2>
                    <span class="panel-subtitle">Last 12 hours</span>
                  </div>
                  <div class="panel-body">
                    <svg class="chart-svg" viewBox="0 0 560 260" role="img" aria-label="Token and cost trend chart">
                      <rect x="44" y="18" width="488" height="190" fill="#f8fffc" stroke="#cce8df"></rect>
                      <line class="chart-grid-line" x1="44" y1="65" x2="532" y2="65"></line>
                      <line class="chart-grid-line" x1="44" y1="112" x2="532" y2="112"></line>
                      <line class="chart-grid-line" x1="44" y1="159" x2="532" y2="159"></line>
                      <text class="axis-label" x="14" y="23">10M</text>
                      <text class="axis-label" x="20" y="69">7M</text>
                      <text class="axis-label" x="20" y="116">4M</text>
                      <text class="axis-label" x="20" y="163">1M</text>
                      <path d="M44 170 C88 150, 104 128, 140 136 S208 142, 240 102 S310 54, 352 82 S420 138, 462 94 S512 72, 532 52" fill="none" stroke="#01956A" stroke-width="4"></path>
                      <path d="M44 188 C92 184, 112 168, 150 170 S212 164, 246 148 S320 116, 354 126 S418 160, 468 132 S512 119, 532 110" fill="none" stroke="#36b37e" stroke-width="3"></path>
                      <path d="M44 198 C102 192, 142 187, 188 190 S260 188, 308 174 S378 160, 420 164 S494 150, 532 142" fill="none" stroke="#007a5a" stroke-width="3" stroke-dasharray="6 5"></path>
                      <g fill="#01956A">
                        <circle cx="140" cy="136" r="4"></circle>
                        <circle cx="240" cy="102" r="4"></circle>
                        <circle cx="352" cy="82" r="4"></circle>
                        <circle cx="532" cy="52" r="4"></circle>
                      </g>
                      <text class="chart-value" x="470" y="39">$14.8 / hour</text>
                      <text class="axis-label" x="44" y="230">02:00</text>
                      <text class="axis-label" x="170" y="230">06:00</text>
                      <text class="axis-label" x="300" y="230">10:00</text>
                      <text class="axis-label" x="490" y="230">14:00</text>
                    </svg>
                    <div class="legend">
                      <span class="legend-item"><span class="swatch" style="background:var(--blue)"></span>Input tokens</span>
                      <span class="legend-item"><span class="swatch" style="background:var(--purple)"></span>Output tokens</span>
                      <span class="legend-item"><span class="swatch" style="background:var(--green)"></span>Cache reads</span>
                    </div>
                  </div>
                </article>

                <article class="panel">
                  <div class="panel-header">
                    <h2>Model cost mix</h2>
                    <span class="panel-subtitle">$91.70 today</span>
                  </div>
                  <div class="panel-body">
                    <div class="donut-wrap">
                      <svg width="154" height="154" viewBox="0 0 154 154" role="img" aria-label="Model cost donut chart">
                        <circle cx="77" cy="77" r="58" fill="none" stroke="#e4f3ef" stroke-width="26"></circle>
                        <circle cx="77" cy="77" r="58" fill="none" stroke="#01956A" stroke-width="26" stroke-dasharray="215 365" stroke-dashoffset="-10" transform="rotate(-90 77 77)"></circle>
                        <circle cx="77" cy="77" r="58" fill="none" stroke="#36b37e" stroke-width="26" stroke-dasharray="82 365" stroke-dashoffset="-225" transform="rotate(-90 77 77)"></circle>
                        <circle cx="77" cy="77" r="58" fill="none" stroke="#007a5a" stroke-width="26" stroke-dasharray="46 365" stroke-dashoffset="-310" transform="rotate(-90 77 77)"></circle>
                        <circle class="donut-center" cx="77" cy="77" r="36"></circle>
                        <text class="donut-text" x="77" y="76">$91.7</text>
                        <text class="donut-sub" x="77" y="92">TODAY</text>
                      </svg>
                      <div class="budget-strip">
                        <div class="budget-row"><span>Sonnet</span><div class="progress"><span style="width:59%; background:var(--blue)"></span></div><strong>$54.1</strong></div>
                        <div class="budget-row"><span>Opus</span><div class="progress"><span style="width:23%; background:var(--purple)"></span></div><strong>$21.3</strong></div>
                        <div class="budget-row"><span>Haiku</span><div class="progress"><span style="width:13%; background:var(--green)"></span></div><strong>$12.0</strong></div>
                        <div class="budget-row"><span>Other</span><div class="progress"><span style="width:5%; background:var(--yellow)"></span></div><strong>$4.3</strong></div>
                      </div>
                    </div>
                  </div>
                </article>
              </div>

              <article class="panel">
                <div class="panel-header">
                  <h2>Running AI-DLC tasks</h2>
                  <span class="panel-subtitle">Sorted by risk and wait time</span>
                </div>
                <div class="panel-body table-body">
                  <table aria-label="Running AI-DLC task table">
                    <thead>
                      <tr>
                        <th>Run</th>
                        <th>Repo / branch</th>
                        <th>Phase</th>
                        <th>Status</th>
                        <th>Progress</th>
                        <th>Cost</th>
                        <th>Owner</th>
                        <th>Last event</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td><strong>RUN-2047</strong><span>JAM001 backend trace</span></td>
                        <td><strong>uk.workflow</strong><span>codex/jam001-trace</span></td>
                        <td>Design</td>
                        <td><span class="status-badge waiting">approval</span></td>
                        <td><div class="progress"><span style="width:72%; background:var(--yellow)"></span></div></td>
                        <td>$8.42</td>
                        <td>ThuyTT</td>
                        <td>42m wait</td>
                      </tr>
                      <tr>
                        <td><strong>RUN-2046</strong><span>RemandCommandHandler</span></td>
                        <td><strong>uk.request</strong><span>feature/remand-flow</span></td>
                        <td>Implement</td>
                        <td><span class="status-badge running">running</span></td>
                        <td><div class="progress"><span style="width:61%; background:var(--blue)"></span></div></td>
                        <td>$12.90</td>
                        <td>NamNV</td>
                        <td>tool call 18s</td>
                      </tr>
                      <tr>
                        <td><strong>RUN-2044</strong><span>DOD UI rule PR</span></td>
                        <td><strong>aidlc-rules</strong><span>add-dod-ui</span></td>
                        <td>Build</td>
                        <td><span class="status-badge completed">ci green</span></td>
                        <td><div class="progress"><span style="width:88%; background:var(--green)"></span></div></td>
                        <td>$3.18</td>
                        <td>ThuyTT</td>
                        <td>PR ready</td>
                      </tr>
                      <tr>
                        <td><strong>RUN-2041</strong><span>Graph rebuild</span></td>
                        <td><strong>hr.ast-graph</strong><span>scan/uk-root</span></td>
                        <td>Context</td>
                        <td><span class="status-badge graph">scanning</span></td>
                        <td><div class="progress"><span style="width:94%; background:var(--teal)"></span></div></td>
                        <td>$0.00</td>
                        <td>System</td>
                        <td>import sqlite</td>
                      </tr>
                      <tr>
                        <td><strong>RUN-2039</strong><span>Gradle verification</span></td>
                        <td><strong>nts.uk</strong><span>verify/compile</span></td>
                        <td>Build</td>
                        <td><span class="status-badge failed">failed</span></td>
                        <td><div class="progress"><span style="width:32%; background:var(--red)"></span></div></td>
                        <td>$6.04</td>
                        <td>System</td>
                        <td>2 errors</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </article>
            </div>

            <div class="right-stack">
              <article class="panel">
                <div class="panel-header">
                  <h2>Approval inbox</h2>
                  <span class="panel-subtitle">7 waiting</span>
                </div>
                <div class="panel-body">
                  <div class="approval-list">
                    <article class="approval">
                      <div class="approval-index">P1</div>
                      <div>
                        <strong>Confirm data ownership for JRQMT_APP_SETTING</strong>
                        <p>Claude found 3 repository candidates and needs a human decision before generating design docs.</p>
                      </div>
                      <div class="approval-actions">
                        <button class="tiny-btn approve" type="button">Answer</button>
                      </div>
                    </article>
                    <article class="approval">
                      <div class="approval-index" style="background:var(--purple)">P2</div>
                      <div>
                        <strong>Approve JAM001 endpoint trace boundary</strong>
                        <p>Should the design include common component calls or only direct screen actions?</p>
                      </div>
                      <div class="approval-actions">
                        <button class="tiny-btn approve" type="button">Answer</button>
                      </div>
                    </article>
                    <article class="approval">
                      <div class="approval-index" style="background:var(--red)">P1</div>
                      <div>
                        <strong>Build failure triage</strong>
                        <p>Gradle compile failed in <code>sc.app</code>; choose fix-forward or rollback worktree.</p>
                      </div>
                      <div class="approval-actions">
                        <button class="tiny-btn approve" type="button">Answer</button>
                      </div>
                    </article>
                    <article class="approval">
                      <div class="approval-index" style="background:var(--teal)">P3</div>
                      <div>
                        <strong>Confirm browser evidence rule</strong>
                        <p>Definition-of-Done update is ready, but needs product owner wording approval.</p>
                      </div>
                      <div class="approval-actions">
                        <button class="tiny-btn approve" type="button">Answer</button>
                      </div>
                    </article>
                  </div>
                </div>
              </article>

              <article class="panel">
                <div class="panel-header">
                  <h2>Source graph preview</h2>
                  <span class="panel-subtitle">JAM001 trace</span>
                </div>
                <div class="panel-body">
                  <div class="graph-preview" aria-label="Static graph preview">
                    <svg width="100%" height="276" viewBox="0 0 420 276" preserveAspectRatio="none" aria-hidden="true">
                      <defs>
                        <marker id="dash-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                          <path d="M 0 0 L 10 5 L 0 10 z" fill="#8ab5a8"></path>
                        </marker>
                      </defs>
                      <path d="M70 58 C120 48, 132 72, 176 83" fill="none" stroke="#8ab5a8" stroke-width="2" marker-end="url(#dash-arrow)"></path>
                      <path d="M176 86 C218 92, 232 116, 264 132" fill="none" stroke="#8ab5a8" stroke-width="2" marker-end="url(#dash-arrow)"></path>
                      <path d="M264 134 C286 156, 298 182, 330 196" fill="none" stroke="#8ab5a8" stroke-width="2" marker-end="url(#dash-arrow)"></path>
                      <path d="M264 134 C292 126, 310 98, 348 86" fill="none" stroke="#8ab5a8" stroke-width="2" marker-end="url(#dash-arrow)"></path>
                      <path d="M176 86 C160 130, 136 158, 118 200" fill="none" stroke="#8ab5a8" stroke-width="2" marker-end="url(#dash-arrow)"></path>
                    </svg>
                    <div class="node-label screen" style="left:17%; top:21%">Screen<br>JAM001</div>
                    <div class="node-label api" style="left:42%; top:31%">Endpoint<br>/get</div>
                    <div class="node-label svc" style="left:63%; top:49%">Handler<br>Remand</div>
                    <div class="node-label repo" style="left:79%; top:71%">Repository<br>Rqmt</div>
                    <div class="node-label table-node" style="left:83%; top:31%">Table<br>JRQMT</div>
                    <div class="node-label" style="left:28%; top:73%">Common<br>component</div>
                  </div>
                </div>
              </article>

              <article class="panel">
                <div class="panel-header">
                  <h2>System health</h2>
                  <span class="panel-subtitle">Integrations</span>
                </div>
                <div class="panel-body">
                  <div class="health-grid">
                    <div class="health-item">
                      <strong>Claude CLI <span class="status-badge completed">ok</span></strong>
                      <p>Headless runner available. Stream JSON recommended for cost capture.</p>
                    </div>
                    <div class="health-item">
                      <strong>Mattermost <span class="status-badge running">live</span></strong>
                      <p>WebSocket connected, 3 allowed channels, 0 send errors.</p>
                    </div>
                    <div class="health-item">
                      <strong>Graph DB <span class="status-badge graph">fresh</span></strong>
                      <p>1.2M nodes, 4.8M edges, last import 14 minutes ago.</p>
                    </div>
                    <div class="health-item">
                      <strong>GitHub <span class="status-badge waiting">rate 68%</span></strong>
                      <p>5 open PRs from rule updates and implementation tasks.</p>
                    </div>
                  </div>
                </div>
              </article>
            </div>

            <div class="middle-stack span-2">
              <article class="panel">
                <div class="panel-header">
                  <h2>Run duration lanes</h2>
                  <span class="panel-subtitle">Current active sessions</span>
                </div>
                <div class="panel-body">
                  <div class="timeline">
                    <div class="timeline-row">
                      <strong>RUN-2047</strong>
                      <div class="timeline-track">
                        <span class="timeline-seg" style="left:4%; width:22%; background:var(--blue)"></span>
                        <span class="timeline-seg" style="left:28%; width:28%; background:var(--purple)"></span>
                        <span class="timeline-seg" style="left:58%; width:22%; background:var(--yellow)"></span>
                      </div>
                      <span>1h 22m</span>
                    </div>
                    <div class="timeline-row">
                      <strong>RUN-2046</strong>
                      <div class="timeline-track">
                        <span class="timeline-seg" style="left:9%; width:18%; background:var(--cyan)"></span>
                        <span class="timeline-seg" style="left:31%; width:37%; background:var(--blue)"></span>
                        <span class="timeline-seg" style="left:71%; width:16%; background:var(--green)"></span>
                      </div>
                      <span>54m</span>
                    </div>
                    <div class="timeline-row">
                      <strong>RUN-2039</strong>
                      <div class="timeline-track">
                        <span class="timeline-seg" style="left:2%; width:20%; background:var(--teal)"></span>
                        <span class="timeline-seg" style="left:25%; width:21%; background:var(--blue)"></span>
                        <span class="timeline-seg" style="left:49%; width:11%; background:var(--red)"></span>
                      </div>
                      <span>37m</span>
                    </div>
                    <div class="timeline-row">
                      <strong>RUN-2041</strong>
                      <div class="timeline-track">
                        <span class="timeline-seg" style="left:7%; width:31%; background:var(--teal)"></span>
                        <span class="timeline-seg" style="left:41%; width:28%; background:var(--green)"></span>
                        <span class="timeline-seg" style="left:72%; width:17%; background:var(--cyan)"></span>
                      </div>
                      <span>2h 04m</span>
                    </div>
                  </div>
                  <div class="legend">
                    <span class="legend-item"><span class="swatch" style="background:var(--blue)"></span>Claude work</span>
                    <span class="legend-item"><span class="swatch" style="background:var(--yellow)"></span>Human wait</span>
                    <span class="legend-item"><span class="swatch" style="background:var(--green)"></span>Verification</span>
                    <span class="legend-item"><span class="swatch" style="background:var(--red)"></span>Failure</span>
                  </div>
                </div>
              </article>

              <article class="panel">
                <div class="panel-header">
                  <h2>Live log stream</h2>
                  <span class="panel-subtitle">Aggregated from runner, MCP, graph scan, Mattermost</span>
                </div>
                <div class="panel-body">
                  <div class="log-stream" aria-label="Static log stream preview">
                    <div class="log-row"><span>14:08:29</span><span class="info">MCP</span><span>tool request_approval created approval_id=APR-8831 run=RUN-2047</span></div>
                    <div class="log-row"><span>14:08:24</span><span class="ok">RUN</span><span>RUN-2046 Claude emitted tool_result Edit success duration=127ms</span></div>
                    <div class="log-row"><span>14:08:12</span><span class="info">AST</span><span>graph import complete nodes=1,204,882 edges=4,812,300 sqlite=graph.sqlite</span></div>
                    <div class="log-row"><span>14:07:58</span><span class="warn">WAIT</span><span>APR-8827 exceeded 30m wait threshold owner=ThuyTT phase=Design</span></div>
                    <div class="log-row"><span>14:07:31</span><span class="ok">MM</span><span>posted Mattermost thread reply channel=aidlc-ops root=abc91</span></div>
                    <div class="log-row"><span>14:06:55</span><span class="err">ERR</span><span>RUN-2039 Gradle compile failed module=hc.ctx.sc.sc.app error_count=2</span></div>
                    <div class="log-row"><span>14:06:10</span><span class="info">COST</span><span>usage run=RUN-2046 model=sonnet input=82k output=6k cost_usd=0.91</span></div>
                    <div class="log-row"><span>14:05:48</span><span class="ok">GIT</span><span>created branch add-DOD-UI-02-20260814140548</span></div>
                    <div class="log-row"><span>14:05:21</span><span class="info">MCP</span><span>trace_screen screen=jam/001 backend_limit=20 result endpoints=7</span></div>
                    <div class="log-row"><span>14:04:44</span><span class="ok">RUN</span><span>RUN-2044 completed build phase, awaiting PR publication</span></div>
                  </div>
                </div>
              </article>
            </div>

            <div class="right-stack">
              <article class="panel">
                <div class="panel-header">
                  <h2>Budget utilization</h2>
                  <span class="panel-subtitle">Daily cap $150</span>
                </div>
                <div class="panel-body">
                  <div class="budget-strip">
                    <div class="budget-row"><span>All runs</span><div class="progress"><span style="width:61%; background:var(--blue)"></span></div><strong>61%</strong></div>
                    <div class="budget-row"><span>Rules</span><div class="progress"><span style="width:24%; background:var(--green)"></span></div><strong>24%</strong></div>
                    <div class="budget-row"><span>Source Q&A</span><div class="progress"><span style="width:48%; background:var(--teal)"></span></div><strong>48%</strong></div>
                    <div class="budget-row"><span>Build fixes</span><div class="progress"><span style="width:78%; background:var(--yellow)"></span></div><strong>78%</strong></div>
                    <div class="budget-row"><span>Opus use</span><div class="progress"><span style="width:31%; background:var(--purple)"></span></div><strong>31%</strong></div>
                  </div>
                </div>
              </article>

              <article class="panel">
                <div class="panel-header">
                  <h2>Artifacts and PRs</h2>
                  <span class="panel-subtitle">Latest outputs</span>
                </div>
                <div class="panel-body">
                  <div class="artifact-list">
                    <div class="artifact"><div><strong>requirements.md</strong><span>RUN-2047, generated 8m ago</span></div><span class="status-badge completed">ready</span></div>
                    <div class="artifact"><div><strong>design-decision-log.md</strong><span>Needs approval APR-8831</span></div><span class="status-badge waiting">blocked</span></div>
                    <div class="artifact"><div><strong>unit-task-plan.md</strong><span>RUN-2046, implementation split</span></div><span class="status-badge running">draft</span></div>
                    <div class="artifact"><div><strong>PR #284</strong><span>DOD-UI rule update</span></div><span class="status-badge completed">open</span></div>
                    <div class="artifact"><div><strong>graph-summary.json</strong><span>1.2M nodes, 9 projects</span></div><span class="status-badge graph">fresh</span></div>
                  </div>
                </div>
              </article>

              <article class="panel">
                <div class="panel-header">
                  <h2>Mattermost activity</h2>
                  <span class="panel-subtitle">Bot command stream</span>
                </div>
                <div class="panel-body table-body">
                  <table aria-label="Mattermost activity table">
                    <thead>
                      <tr><th>Time</th><th>User</th><th>Intent</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      <tr><td>14:06</td><td>ThuyTT</td><td>mixed</td><td><span class="status-badge waiting">approval</span></td></tr>
                      <tr><td>14:02</td><td>NamNV</td><td>source_graph</td><td><span class="status-badge completed">answered</span></td></tr>
                      <tr><td>13:58</td><td>System</td><td>rule-update</td><td><span class="status-badge running">queued</span></td></tr>
                      <tr><td>13:44</td><td>AnhNV</td><td>general</td><td><span class="status-badge completed">posted</span></td></tr>
                    </tbody>
                  </table>
                </div>
              </article>
            </div>
          </section>

          <div class="footer-note">Static UI demo using representative data. Only New AI-DLC run is wired in phase 1.</div>
        </section>
      </section>
    </main>

    <main v-else-if="authChecked" class="ops-shell" :class="{ 'nav-open': menuOpen }">
      <aside class="ops-sidebar" aria-label="AI-DLC navigation">
        <div class="ops-brand">
          <button
            class="ops-hamburger"
            type="button"
            :aria-expanded="menuOpen ? 'true' : 'false'"
            :aria-label="menuOpen ? 'Close navigation' : 'Open navigation'"
            @click="toggleMenu"
          >
            <span aria-hidden="true"></span>
          </button>
          <div class="ops-brand-text">
            <strong>AI-DLC Ops</strong>
            <span>V2 control plane</span>
          </div>
        </div>

        <div class="ops-nav-title">Operate</div>
        <nav class="ops-nav" aria-label="Primary">
          <button class="ops-nav-item" :class="{ active: route === 'dashboard' }" @click="navigate('dashboard')">
            <span class="ops-nav-icon">D</span>
            <span class="ops-nav-label">Dashboard</span>
            <span class="ops-nav-badge">new</span>
          </button>
          <button class="ops-nav-item" :class="{ active: route === 'launcher' }" @click="navigate('launcher')">
            <span class="ops-nav-icon">+</span>
            <span class="ops-nav-label">New AI-DLC run</span>
          </button>
          <button class="ops-nav-item mock" type="button">
            <span class="ops-nav-icon">R</span>
            <span class="ops-nav-label">Running tasks</span>
            <span class="ops-nav-badge">18</span>
          </button>
          <button class="ops-nav-item mock" type="button">
            <span class="ops-nav-icon">?</span>
            <span class="ops-nav-label">Approval inbox</span>
            <span class="ops-nav-badge">7</span>
          </button>
          <button class="ops-nav-item mock" type="button">
            <span class="ops-nav-icon">$</span>
            <span class="ops-nav-label">Token cost</span>
          </button>
          <button class="ops-nav-item mock" type="button">
            <span class="ops-nav-icon">B</span>
            <span class="ops-nav-label">Team construction</span>
          </button>
        </nav>

        <div class="ops-nav-title">Admin</div>
        <nav class="ops-nav" aria-label="Admin">
          <button class="ops-nav-item" :class="{ active: route === 'history' }" @click="navigate('history')">
            <span class="ops-nav-icon">M</span>
            <span class="ops-nav-label">Mattermost history</span>
          </button>
          <button class="ops-nav-item" :class="{ active: route === 'test' }" @click="navigate('test')">
            <span class="ops-nav-icon">T</span>
            <span class="ops-nav-label">Mattermost test</span>
          </button>
          <a class="ops-nav-item" href="/scan.html">
            <span class="ops-nav-icon">S</span>
            <span class="ops-nav-label">Graph scan</span>
          </a>
          <a class="ops-nav-item" href="/graph-viewer.html">
            <span class="ops-nav-icon">G</span>
            <span class="ops-nav-label">Graph viewer</span>
          </a>
          <a class="ops-nav-item" href="/sensitive-scan.html">
            <span class="ops-nav-icon">X</span>
            <span class="ops-nav-label">Sensitive scan</span>
          </a>
        </nav>

        <div class="ops-side-note">
          <strong>Phase 1 scope</strong>
          <span>Only New AI-DLC run is wired. Other dashboard modules stay as mockups.</span>
        </div>
      </aside>

      <section class="ops-main">
        <header class="ops-topbar">
          <div class="ops-breadcrumbs">
            <span>AI-DLC</span>
            <span>/</span>
            <span>Operations</span>
            <span>/</span>
            <strong>{{ pageTitle }}</strong>
          </div>
          <div class="ops-search"><strong>#</strong><span>Search runs, approvals, PRs, source graph, logs...</span></div>
          <div class="ops-user">
            <span class="ops-api-state"><span class="dot ready"></span>{{ apiStatusLabel }}</span>
            <span>{{ authUsername || 'admin' }}</span>
            <button class="ops-logout" type="button" @click="logoutUser">Logout</button>
          </div>
        </header>

      <section v-if="isDashboardPage" class="ops-page-content dashboard-content">
        <section class="ops-hero">
          <div>
            <span class="ops-kicker">AI-DLC V2 CONTROL PLANE</span>
            <h2>Manage AI-DLC runs from shared Inception to team Construction.</h2>
            <p>
              This dashboard is the first phase shell. The only live workflow action is
              <strong>New AI-DLC run</strong>; other panels are realistic mockups for review.
            </p>
          </div>
          <button class="new-run-button" type="button" @click="navigate('launcher')">
            <span>+</span>
            New AI-DLC run
          </button>
        </section>

        <section class="ops-metrics" aria-label="AI-DLC dashboard metrics">
          <article class="metric-card primary">
            <div class="metric-label">Active runs</div>
            <div class="metric-value">{{ dashboardStats.activeRuns }}</div>
            <p>2 in Construction, 1 waiting Gate 2, 1 paused.</p>
          </article>
          <article class="metric-card">
            <div class="metric-label">Approval queue</div>
            <div class="metric-value">{{ dashboardStats.approvalQueue }}</div>
            <p>Questions parsed from Markdown answer gates.</p>
          </article>
          <article class="metric-card">
            <div class="metric-label">Claude sessions</div>
            <div class="metric-value">{{ dashboardStats.claudeSessions }}</div>
            <p>VS Code sessions reporting heartbeat.</p>
          </article>
          <article class="metric-card">
            <div class="metric-label">Pull requests</div>
            <div class="metric-value">{{ dashboardStats.openPrs }}</div>
            <p>Open PRs waiting for leader review.</p>
          </article>
          <article class="metric-card">
            <div class="metric-label">Token cost</div>
            <div class="metric-value">{{ dashboardStats.tokenSpend }}</div>
            <p>Current intent cost, cache included.</p>
          </article>
          <article class="metric-card">
            <div class="metric-label">Rule history</div>
            <div class="metric-value">{{ dashboardStats.ruleUpdates }}</div>
            <p>Existing Mattermost rule update records.</p>
          </article>
        </section>

        <section class="dashboard-grid">
          <article class="ops-panel wide">
            <div class="ops-panel-header">
              <h3>Workflow lanes</h3>
              <span class="mock-badge">mockup</span>
            </div>
            <div class="lane-board">
              <div class="lane-column">
                <strong>Inception</strong>
                <div class="run-card">
                  <span class="status-pill wait">Gate 2</span>
                  <h4>Payroll Overtime Policy</h4>
                  <p>Review unit DAG and contract design before Construction split.</p>
                </div>
              </div>
              <div class="lane-column">
                <strong>Construction</strong>
                <div class="run-card">
                  <span class="status-pill run">Running</span>
                  <h4>Customer Operations</h4>
                  <p>3 Bolt branches active, 2 PRs open, 1 answer gate pending.</p>
                </div>
              </div>
              <div class="lane-column">
                <strong>Leader review</strong>
                <div class="run-card">
                  <span class="status-pill info">PR #123</span>
                  <h4>Notification Worker</h4>
                  <p>Checks green. Waiting for project leader merge decision.</p>
                </div>
              </div>
              <div class="lane-column">
                <strong>Final test</strong>
                <div class="run-card">
                  <span class="status-pill idle">Queued</span>
                  <h4>Order API v2</h4>
                  <p>Ready for 3.6 after all required PRs are merged.</p>
                </div>
              </div>
            </div>
          </article>

          <article class="ops-panel">
            <div class="ops-panel-header">
              <h3>Approval questions</h3>
              <span class="mock-badge">mockup</span>
            </div>
            <div class="question-list">
              <div class="question-item">
                <strong>Q1 / BOLT-01</strong>
                <span>Choose A/B/C/D for overtime policy boundary.</span>
              </div>
              <div class="question-item">
                <strong>Q2 / PR #124</strong>
                <span>Confirm settlement table strategy before Claude continues.</span>
              </div>
              <div class="question-item">
                <strong>Gate 3</strong>
                <span>Approve final build/test handoff to Operation phase.</span>
              </div>
            </div>
          </article>

          <article class="ops-panel">
            <div class="ops-panel-header">
              <h3>Token usage</h3>
              <span class="mock-badge">mockup</span>
            </div>
            <div class="token-chart" aria-label="Mock token usage chart">
              <div style="height: 42%"></div>
              <div style="height: 74%"></div>
              <div style="height: 58%"></div>
              <div style="height: 86%"></div>
              <div style="height: 51%"></div>
              <div style="height: 67%"></div>
            </div>
            <p class="panel-caption">Input, output, cache reads, and per-Bolt budget will be wired in a later step.</p>
          </article>

          <article class="ops-panel wide">
            <div class="ops-panel-header">
              <h3>Team construction preview</h3>
              <span class="mock-badge">mockup</span>
            </div>
            <div class="construction-preview">
              <div class="bolt-preview done"><strong>Bolt 1</strong><span>Walking skeleton merged</span></div>
              <div class="bolt-preview run"><strong>Bolt 2</strong><span>billing-service / Alice / VS Code online</span></div>
              <div class="bolt-preview review"><strong>PR #123</strong><span>notifications-worker / leader review</span></div>
              <div class="bolt-preview wait"><strong>Bolt 4</strong><span>reporting-read-model available to claim</span></div>
            </div>
          </article>
        </section>
      </section>

      <section v-else-if="isLauncherPage" class="ops-page-content">
        <section class="ops-hero launcher-placeholder">
          <div>
            <span class="ops-kicker">STEP 2 PLACEHOLDER</span>
            <h2>Run Launcher will be implemented next.</h2>
            <p>
              The dashboard button now routes here. After you approve Step 1, this page will become the real launcher
              for source path, branch policy, documents, stage applicability, and Claude prompt.
            </p>
          </div>
          <button class="new-run-button secondary" type="button" @click="navigate('dashboard')">
            Back to dashboard
          </button>
        </section>
      </section>

      <section v-else-if="isTestPage" class="content ops-page-content legacy-content">
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

      <section v-else class="content ops-page-content legacy-content">
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
