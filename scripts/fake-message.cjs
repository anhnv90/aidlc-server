const kind = process.argv[2] || "ask";
const fs = require("node:fs");
const path = require("node:path");

const samples = {
  ask: "@claude rule ask rule về browser-based definition of done đã có chưa?",
  add: `@claude rule add
rule_id: DOD-UI-01
target: aidlc-rules/.aidlc-rule-details/construction/build-and-test.md
title: Browser-based user journey is required before Done
content:
  A user-facing screen is not Done until browser-based user journey testing passes.
acceptance:
  - Add browser evidence requirement.
  - Create PR only; do not merge automatically.`,
  update: `@claude rule update
rule_id: NP-TST-01
content:
  For each unit, produce unit-test-design.md BEFORE test implementation.
  This demo update intentionally targets an existing rule on main so the PR flow can be tested.`,
  delete: `@claude rule delete
rule_id: NP-TST-01`
};

const message = samples[kind];
if (!message) {
  console.error(`Unknown sample: ${kind}`);
  process.exit(1);
}

const envPath = path.join(__dirname, "..", ".env");
const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const channelId =
  /^MATTERMOST_ALLOWED_CHANNEL_IDS=(.+)$/m.exec(envText)?.[1].split(",")[0].trim() || "fake-channel-id";

fetch("http://localhost:3003/dev/fake-message", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    userId: "fake-admin-user-id",
    username: "ThuyTT",
    channelId,
    message
  })
})
  .then(async (res) => {
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    console.log(text);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
