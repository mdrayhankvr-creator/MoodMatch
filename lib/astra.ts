import "server-only";

import { DataAPIClient, type Db } from "@datastax/astra-db-ts";

let cachedDb: Db | undefined;

function requiredSetting(name: "ASTRA_DB_APPLICATION_TOKEN" | "ASTRA_DB_API_ENDPOINT") {
  const value = process.env[name]?.trim();

  if (!value || /^(?:<|your[_ -]|replace[_ -]|placeholder|changeme|example|dummy|test(?:[_ -]|$))/i.test(value)) {
    throw new Error(`${name} is missing or contains a placeholder.`);
  }

  return value;
}

function databaseEndpoint() {
  const value = requiredSetting("ASTRA_DB_API_ENDPOINT");

  try {
    const url = new URL(value);

    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      /(?:^|\.)example(?:\.|$)|placeholder|^your[-_.]/i.test(url.hostname) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }

    return url.origin;
  } catch {
    throw new Error("ASTRA_DB_API_ENDPOINT must be a valid HTTPS database endpoint.");
  }
}

export function getAstraDb(): Db {
  if (cachedDb) {
    return cachedDb;
  }

  const token = requiredSetting("ASTRA_DB_APPLICATION_TOKEN");
  const endpoint = databaseEndpoint();

  try {
    cachedDb = new DataAPIClient().db(endpoint, { token });
    return cachedDb;
  } catch {
    throw new Error("Could not initialize the Astra DB client. Check the Astra DB configuration.");
  }
}
