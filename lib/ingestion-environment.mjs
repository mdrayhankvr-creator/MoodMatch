import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { validateAstraSettings } from "./astra-runtime.mjs";

export function loadIngestionEnvironment() {
  let local;
  try { local = parse(readFileSync(resolve(".env.local"))); }
  catch { throw new Error(".env.local is missing or unreadable."); }
  const settings = { ...local, ...process.env };
  validateAstraSettings(settings);
  return settings;
}
