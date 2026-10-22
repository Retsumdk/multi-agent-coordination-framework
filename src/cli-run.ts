#!/usr/bin/env node
import { runDemo, runScript, parseScriptFile } from "./cli.js";
import { CoordinationError, describeError, errorExitCode } from "./errors.js";
import { USAGE } from "./usage.js";

export function main(argv: string[]): number {
  const args = argv.slice(2);
  const command = args[0] ?? "demo";

  if (command === "-h" || command === "--help" || command === "help") {
    console.log(USAGE);
    return 0;
  }

  if (command === "demo") {
    console.log(JSON.stringify(runDemo(), null, 2));
    return 0;
  }

  if (command === "run") {
    const scriptIndex = args.indexOf("--script");
    const scriptPath = scriptIndex >= 0 ? args[scriptIndex + 1] : undefined;
    if (!scriptPath) {
      console.error("run requires --script <path-to-json-ops-file>");
      return 2;
    }
    try {
      const ops = parseScriptFile(scriptPath);
      console.log(JSON.stringify(runScript(ops), null, 2));
      return 0;
    } catch (error) {
      console.error(describeError(error));
      return error instanceof CoordinationError ? errorExitCode(error.code) : 1;
    }
  }

  console.error(USAGE);
  return 2;
}

const invoked = import.meta.main;
if (invoked) {
  process.exit(main(process.argv));
}