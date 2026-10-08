import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DataAPIClient,
  DataAPIHttpError,
  DataAPITimeoutError,
} from "@datastax/astra-db-ts";
import { parse } from "dotenv";

class ConfigurationError extends Error {}

function requiredSetting(settings, name) {
  const value = settings[name]?.trim();

  if (!value) {
    throw new ConfigurationError(`${name} is missing in .env.local.`);
  }

  if (/^(?:<|your[_ -]|replace[_ -]|placeholder|changeme|example|dummy|test(?:[_ -]|$))/i.test(value)) {
    throw new ConfigurationError(`${name} contains a placeholder in .env.local.`);
  }

  return value;
}

function loadSettings() {
  let settings;

  try {
    settings = parse(readFileSync(resolve(process.cwd(), ".env.local")));
  } catch {
    throw new ConfigurationError(".env.local is missing or unreadable.");
  }

  const token = requiredSetting(settings, "ASTRA_DB_APPLICATION_TOKEN");
  const endpoint = requiredSetting(settings, "ASTRA_DB_API_ENDPOINT");
  requiredSetting(settings, "ASTRA_DB_COLLECTION");

  try {
    const url = new URL(endpoint);

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

    return { token, endpoint: url.origin };
  } catch {
    throw new ConfigurationError("ASTRA_DB_API_ENDPOINT must be a valid HTTPS database endpoint.");
  }
}

function failureMessage(error) {
  if (error instanceof ConfigurationError) {
    return error.message;
  }

  if (error instanceof DataAPIHttpError) {
    if (error.status === 401 || error.status === 403) {
      return "Astra DB authentication failed. Check the application token.";
    }

    if (error.status === 404) {
      return "Astra DB endpoint was not found. Check the API endpoint.";
    }

    if (error.status >= 500) {
      return "Astra DB is unavailable. Check that the database is Active.";
    }

    return "Astra DB rejected the read-only connection check.";
  }

  if (error instanceof DataAPITimeoutError || error instanceof TypeError) {
    return "Could not reach Astra DB. Check network access and database status.";
  }

  return "Astra DB connection check failed. Check the database status and configuration.";
}

async function main() {
  const { token, endpoint } = loadSettings();
  const db = new DataAPIClient().db(endpoint, { token });
  const collections = await db.listCollections({ nameOnly: true });

  console.log("Astra DB connection successful.");
  for (const name of collections) {
    console.log(name);
  }
}

try {
  await main();
} catch (error) {
  console.error(failureMessage(error));
  process.exitCode = 1;
}
