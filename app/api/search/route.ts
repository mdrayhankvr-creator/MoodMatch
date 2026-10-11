import { createSearchPostHandler } from "@/lib/search-api.mjs";

// With Cache Components enabled, Node.js is the default runtime and
// route segment config exports are rejected by this Next.js version.

const searchPost = createSearchPostHandler();

export async function POST(request: Request): Promise<Response> {
  return searchPost(request);
}
