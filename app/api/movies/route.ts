import { createBrowseHandler } from "@/lib/catalogue-api.mjs";
import { getCatalogueSnapshot } from "@/lib/catalogue-server.mjs";

export const GET = createBrowseHandler(getCatalogueSnapshot);
