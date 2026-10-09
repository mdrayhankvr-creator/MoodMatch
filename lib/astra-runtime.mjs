import { DataAPIClient, DataAPIHttpError, DataAPITimeoutError } from "@datastax/astra-db-ts";

let cachedDb;

export function validateAstraSettings(settings = process.env) {
  function required(name) {
    const value = settings[name]?.trim();
    if (!value || /^(?:<|your[_ -]|replace[_ -]|placeholder|changeme|example|dummy|test(?:[_ -]|$))/i.test(value)) {
      throw new Error(`${name} is missing or contains a placeholder.`);
    }
    return value;
  }
  const token = required("ASTRA_DB_APPLICATION_TOKEN");
  const endpoint = required("ASTRA_DB_API_ENDPOINT");
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password ||
      /(?:^|\.)example(?:\.|$)|placeholder|^your[-_.]/i.test(url.hostname) ||
      url.pathname !== "/" || url.search || url.hash) throw new Error();
    return { token, endpoint: url.origin };
  } catch {
    throw new Error("ASTRA_DB_API_ENDPOINT must be a valid HTTPS database endpoint.");
  }
}

export function getAstraDbRuntime(settings = process.env) {
  if (cachedDb) return cachedDb;
  const { token, endpoint } = validateAstraSettings(settings);
  try {
    cachedDb = new DataAPIClient().db(endpoint, { token });
    return cachedDb;
  } catch {
    throw new Error("Could not initialize the Astra DB client. Check the Astra DB configuration.");
  }
}

export function safeAstraError(error) {
  if (error?.name === "CollectionConfigurationError") return error.message;
  if (error instanceof DataAPIHttpError) {
    if ([401, 403].includes(error.status)) return "Astra DB authentication or authorization failed.";
    if (error.status === 404) return "Astra DB endpoint or collection was not found.";
    if (error.status >= 500) return "Astra DB is unavailable or not Active.";
    return `Astra DB rejected the operation (HTTP ${error.status}).`;
  }
  if (error instanceof DataAPITimeoutError || error instanceof TypeError ||
    ["EACCES", "EPERM", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"].includes(error?.code)) {
    return "Could not reach Astra DB. Check network access and database status.";
  }
  return "Astra DB operation failed. Check configuration and database status.";
}
