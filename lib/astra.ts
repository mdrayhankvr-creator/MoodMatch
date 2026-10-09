import "server-only";

import type { Db } from "@datastax/astra-db-ts";
import { getAstraDbRuntime } from "./astra-runtime.mjs";

export function getAstraDb(): Db {
  return getAstraDbRuntime() as Db;
}
