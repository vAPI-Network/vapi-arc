import "./env.js";
import { getAddress, isAddress } from "viem";
import { loadReviewServiceConfig } from "./review/config.js";
import { ReviewDatabase } from "./review/database.js";

function flags(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag?.startsWith("--")) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    result.set(flag.slice(2), value);
    index += 1;
  }
  return result;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function usage(): string {
  return [
    "Reviewer Council CLI",
    "",
    "pnpm -C core reviewer:add --telegram-user-id <id> --chat-id <id> --alias <name> --payout-address <0x...> [--skills security,content]",
    "pnpm -C core reviewer:list",
    "pnpm -C core reviewer:enable --id <reviewer-id>",
    "pnpm -C core reviewer:disable --id <reviewer-id>",
  ].join("\n");
}

function main(): void {
  const command = process.argv[2];
  const values = flags(process.argv.slice(3));
  const config = loadReviewServiceConfig();
  const database = new ReviewDatabase(config.databasePath);
  try {
    if (command === "add") {
      const address = required(values, "payout-address");
      if (!isAddress(address)) throw new Error("invalid --payout-address");
      const reviewer = database.upsertReviewer({
        telegramUserId: required(values, "telegram-user-id"),
        telegramChatId: required(values, "chat-id"),
        alias: required(values, "alias"),
        payoutAddress: getAddress(address),
        skills: (values.get("skills") ?? "")
          .split(",")
          .map((skill) => skill.trim())
          .filter(Boolean),
      });
      console.log(JSON.stringify(reviewer, null, 2));
      return;
    }
    if (command === "list") {
      console.log(JSON.stringify(database.listReviewers(), null, 2));
      return;
    }
    if (command === "enable" || command === "disable") {
      const id = required(values, "id");
      const reviewer = database.setReviewerActive(id, command === "enable");
      if (!reviewer) throw new Error(`reviewer ${id} was not found`);
      console.log(JSON.stringify(reviewer, null, 2));
      return;
    }
    console.log(usage());
    if (command) process.exitCode = 1;
  } finally {
    database.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exitCode = 1;
}
