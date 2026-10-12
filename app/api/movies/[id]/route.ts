import { createDetailHandler } from "@/lib/catalogue-api.mjs";
import { getCatalogueSnapshot } from "@/lib/catalogue-server.mjs";

export const GET = createDetailHandler(getCatalogueSnapshot);
