import { listLogSessions, cleanOldLogs } from "../../runtime/logger.js";

export async function logsCommand(args: string[], dataDir: string) {
  const action = args[0] || "list";

  if (action === "list") {
    const sessions = await listLogSessions(dataDir);
    if (sessions.length === 0) {
      console.log("No session logs found.");
      return;
    }
    console.log(`Found ${sessions.length} session logs:`);
    for (const s of sessions.slice(0, 20)) {
      console.log(`  ${s}`);
    }
    if (sessions.length > 20) {
      console.log(`  ... and ${sessions.length - 20} more`);
    }
  } else if (action === "clean") {
    const days = parseInt(args[1] || "7", 10);
    const deleted = await cleanOldLogs(dataDir, days);
    console.log(`Deleted ${deleted} session logs older than ${days} days.`);
  } else {
    console.log("Usage: autocrew logs [list|clean [days]]");
  }
}
