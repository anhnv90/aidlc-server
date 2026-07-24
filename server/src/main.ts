import { config, validateConfig } from "./config";
import { openDatabase } from "./db/database";
import { RuleUpdateHistoryStore } from "./db/ruleUpdateHistoryStore";
import { MattermostClient } from "./mattermost/client";
import { MattermostWebSocketListener } from "./mattermost/websocket";
import { CommandHandler } from "./commands/handler";
import { startHttpServer } from "./http/server";
import { log } from "./log";

async function main() {
  validateConfig();

  const db = openDatabase();
  const history = new RuleUpdateHistoryStore(db);
  const mattermost = new MattermostClient();
  const commandHandler = new CommandHandler(mattermost, history);

  startHttpServer(history, commandHandler, mattermost);

  const listener = new MattermostWebSocketListener((message) => commandHandler.handle(message));
  listener.start();

  log.info("aidlc-server started", {
    port: config.serverPort,
    mattermostFakeMode: config.mattermost.fakeMode,
    dryRun: config.ruleUpdateDryRun,
    claudeFakeMode: config.claude.fakeMode
  });

  process.on("SIGINT", () => {
    log.info("Stopping aidlc-server");
    listener.stop();
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error("aidlc-server failed to start", {
    error: err instanceof Error ? err.message : String(err)
  });
  process.exit(1);
});
