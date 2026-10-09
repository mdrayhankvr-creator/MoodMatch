import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { load } from "cheerio";
import {
  MOVIE_COLUMNS,
  canonicalSourceUrl,
  csvField,
  movieId,
  normalizeWhitespace,
  validPlot,
} from "./movie-data.mjs";

const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const USER_AGENT = "MoodMatchRecentMovies/0.1 (https://github.com/mdrayhankvr-creator/MoodMatch)";
const CACHE_DIR = resolve("data/cache/wikimedia");
const OUTPUT_PATH = resolve("data/recent-movies.csv");
const FIRST_YEAR = 2019;
const LAST_YEAR = 2026;
const REQUEST_INTERVAL_MS = 500;
const MAX_RETRIES = 6;
const PLOT_HEADINGS = [/^plot$/iu, /^plot summary$/iu, /^synopsis$/iu, /^story$/iu];
const RIGHTS_WARNING = /\{\{\s*(?:copyvio|copyright|non[- ]?free|copypaste|copied|attribution)\b|<blockquote\b/iu;

function options() {
  const { values } = parseArgs({
    options: {
      max: { type: "string", default: "100" },
      "candidate-limit": { type: "string", default: "1000" },
      "as-of": { type: "string", default: new Date().toISOString().slice(0, 10) },
      refresh: { type: "boolean", default: false },
    },
  });
  const max = Number(values.max);
  const candidateLimit = Number(values["candidate-limit"]);
  const asOf = values["as-of"];
  if (!Number.isInteger(max) || max < 1 || max > 1000) throw new Error("--max must be an integer from 1 to 1000.");
  if (!Number.isInteger(candidateLimit) || candidateLimit < 100 || candidateLimit > 5000) {
    throw new Error("--candidate-limit must be an integer from 100 to 5000.");
  }
  const parsedDate = new Date(`${asOf}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(asOf) || Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== asOf) {
    throw new Error("--as-of must be a valid YYYY-MM-DD date.");
  }
  return { max, candidateLimit, asOf, refresh: values.refresh };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function chunks(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

function score(value) {
  return createHash("sha256").update(value).digest("hex");
}

class WikimediaClient {
  constructor(refresh) {
    this.refresh = refresh;
    this.nextRequestAt = 0;
    this.stats = { apiRequests: 0, cacheHits: 0, retries: 0 };
  }

  async get(endpoint, parameters) {
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries({
      ...parameters,
      format: "json",
      formatversion: "2",
      maxlag: "10",
    }).sort(([a], [b]) => compareText(a, b))) {
      url.searchParams.set(key, String(value));
    }
    const cachePath = resolve(CACHE_DIR, `${score(url.href)}.json`);
    if (!this.refresh) {
      try {
        const cached = JSON.parse(await readFile(cachePath, "utf8"));
        this.stats.cacheHits += 1;
        return cached;
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const delay = this.nextRequestAt - Date.now();
      if (delay > 0) await sleep(delay);
      this.nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;

      let response;
      let data;
      try {
        response = await fetch(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          signal: AbortSignal.timeout(45_000),
        });
        this.stats.apiRequests += 1;
        if (response.ok) data = await response.json();
      } catch (error) {
        if (attempt === MAX_RETRIES) throw new Error(`Wikimedia request failed after retries: ${error.cause?.code ?? error.name}.`);
        this.stats.retries += 1;
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }

      if ([429, 500, 502, 503, 504].includes(response.status)) {
        if (attempt === MAX_RETRIES) throw new Error(`Wikimedia API returned HTTP ${response.status} after retries.`);
        this.stats.retries += 1;
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(60_000, retryAfter * 1000)
          : Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }
      if (!response.ok) throw new Error(`Wikimedia API returned HTTP ${response.status}.`);

      if (data.error) {
        if (["maxlag", "ratelimited", "readonly"].includes(data.error.code) && attempt < MAX_RETRIES) {
          this.stats.retries += 1;
          const retryAfter = Number(response.headers.get("retry-after"));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(60_000, retryAfter * 1000)
            : Math.min(30_000, 1000 * 2 ** attempt));
          continue;
        }
        throw new Error(`Wikimedia API error from ${url.hostname}: ${data.error.code}.`);
      }

      await mkdir(CACHE_DIR, { recursive: true });
      const temporaryPath = `${cachePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(data), "utf8");
      await rename(temporaryPath, cachePath);
      return data;
    }
    throw new Error("Wikimedia API retry limit reached.");
  }
}

async function discoverYear(client, year, limit) {
  const pages = [];
  let continuation;
  do {
    const data = await client.get(WIKIPEDIA_API, {
      action: "query",
      list: "categorymembers",
      cmtitle: `Category:${year} films`,
      cmtype: "page",
      cmnamespace: "0",
      cmlimit: "500",
      ...(continuation ? { cmcontinue: continuation } : {}),
    });
    pages.push(...(data.query?.categorymembers ?? []));
    continuation = data.continue?.cmcontinue;
  } while (continuation && pages.length < limit);
  return pages.slice(0, limit);
}

async function enrichPages(client, year, pages) {
  const enriched = [];
  for (const batch of chunks(pages, 50)) {
    const data = await client.get(WIKIPEDIA_API, {
      action: "query",
      prop: "pageprops|info",
      pageids: batch.map((page) => page.pageid).join("|"),
      ppprop: "wikibase_item|disambiguation",
      inprop: "url",
      redirects: "1",
    });
    for (const page of data.query?.pages ?? []) {
      if (page.missing || page.pageprops?.disambiguation !== undefined) continue;
      const qid = page.pageprops?.wikibase_item;
      const source_url = canonicalSourceUrl(page.fullurl);
      if (/^Q\d+$/u.test(qid ?? "") && source_url) {
        enriched.push({ year, qid, pageid: page.pageid, pageTitle: page.title, source_url });
      }
    }
  }
  return enriched;
}

function claimValues(entity, property) {
  return (entity.claims?.[property] ?? [])
    .filter((statement) => statement.rank !== "deprecated")
    .map((statement) => statement.mainsnak?.datavalue?.value)
    .filter(Boolean);
}

function confirmsReleaseYear(entity, year, asOf) {
  return claimValues(entity, "P577").some((value) => {
    const match = /^\+(\d{4})-(\d{2})-(\d{2})T/u.exec(value.time ?? "");
    if (!match || Number(match[1]) !== year || value.precision < 9) return false;
    if (value.precision >= 11) return `${match[1]}-${match[2]}-${match[3]}` <= asOf;
    if (value.precision === 10) return `${match[1]}-${match[2]}-01` <= asOf;
    return year <= Number(asOf.slice(0, 4));
  });
}

async function verifiedCandidates(client, candidates, asOf, counts) {
  const byQid = new Map();
  for (const candidate of candidates) {
    const group = byQid.get(candidate.qid) ?? [];
    group.push(candidate);
    byQid.set(candidate.qid, group);
  }
  const verified = [];
  for (const batch of chunks([...byQid.keys()], 50)) {
    const data = await client.get(WIKIDATA_API, {
      action: "wbgetentities",
      ids: batch.join("|"),
      props: "claims|labels",
      languages: "en",
    });
    for (const qid of batch) {
      const group = byQid.get(qid);
      const entity = data.entities?.[qid];
      if (!entity || entity.missing) {
        counts.missingWikidata += 1;
        continue;
      }
      if (!claimValues(entity, "P31").some((value) => value.id === "Q11424")) {
        counts.notFilm += 1;
        continue;
      }
      const candidate = group.find((item) => confirmsReleaseYear(entity, item.year, asOf));
      if (!candidate) {
        if (claimValues(entity, "P577").length === 0) counts.missingReleaseDate += 1;
        else counts.yearMismatch += 1;
        continue;
      }
      counts.duplicates += group.length - 1;
      const genreIds = [...new Set(claimValues(entity, "P136").map((value) => value.id).filter(Boolean))];
      if (genreIds.length === 0) {
        counts.missingGenre += 1;
        continue;
      }
      verified.push({
        ...candidate,
        title: normalizeWhitespace(entity.labels?.en?.value ?? candidate.pageTitle),
        genreIds,
      });
    }
  }
  return verified;
}

async function genreLabels(client, candidates) {
  const ids = [...new Set(candidates.flatMap((candidate) => candidate.genreIds))].sort(compareText);
  const labels = new Map();
  for (const batch of chunks(ids, 50)) {
    const data = await client.get(WIKIDATA_API, {
      action: "wbgetentities",
      ids: batch.join("|"),
      props: "labels",
      languages: "en",
    });
    for (const id of batch) {
      const value = normalizeWhitespace(data.entities?.[id]?.labels?.en?.value);
      if (value) labels.set(id, value);
    }
  }
  return labels;
}

function plotSection(sections) {
  const headings = sections
    .filter((section) => section.index && /^\d+$/u.test(section.index))
    .map((section) => ({
      ...section,
      heading: normalizeWhitespace(load(section.line ?? "").text()),
    }));
  for (const pattern of PLOT_HEADINGS) {
    const found = headings.find((section) => pattern.test(section.heading));
    if (found) return found;
  }
  return null;
}

function plotFromHtml(html) {
  const $ = load(html);
  $("sup.reference, .mw-editsection, .reference, .error, .noprint, .hatnote, .ambox, .mw-references-wrap, table, figure, .thumb, style, script, blockquote").remove();
  const paragraphs = $(".mw-parser-output p").toArray()
    .map((element) => normalizeWhitespace($(element).text()))
    .filter(Boolean);
  return normalizeWhitespace(paragraphs.join(" "));
}

async function fetchPlot(client, candidate, counts) {
  const outline = await client.get(WIKIPEDIA_API, {
    action: "parse",
    pageid: candidate.pageid,
    prop: "tocdata|revid",
  });
  const section = plotSection(outline.parse?.tocdata?.sections ?? []);
  if (!section) {
    counts.missingPlotSection += 1;
    return null;
  }
  const content = await client.get(WIKIPEDIA_API, {
    action: "parse",
    pageid: candidate.pageid,
    prop: "text|wikitext",
    section: section.index,
  });
  const rawWikitext = content.parse?.wikitext ?? "";
  if (RIGHTS_WARNING.test(rawWikitext)) {
    counts.rightsWarnings += 1;
    return null;
  }
  const plot = plotFromHtml(content.parse?.text ?? "");
  if (!validPlot(plot)) {
    counts.shortPlot += 1;
    return null;
  }
  const lead = await client.get(WIKIPEDIA_API, {
    action: "parse",
    pageid: candidate.pageid,
    prop: "wikitext",
    section: "0",
  });
  const leadWikitext = lead.parse?.wikitext;
  if (typeof leadWikitext !== "string") {
    counts.missingLicenseCheck += 1;
    return null;
  }
  if (RIGHTS_WARNING.test(leadWikitext)) {
    counts.rightsWarnings += 1;
    return null;
  }
  return plot;
}

async function collect(client, max, candidateLimit, asOf) {
  const years = Array.from({ length: LAST_YEAR - FIRST_YEAR + 1 }, (_, index) => FIRST_YEAR + index)
    .filter((year) => year <= Number(asOf.slice(0, 4)));
  const perYearSample = Math.max(100, Math.ceil(max * 1.5));
  const counts = {
    discovered: 0,
    sampled: 0,
    missingPageOrItem: 0,
    missingWikidata: 0,
    notFilm: 0,
    missingReleaseDate: 0,
    yearMismatch: 0,
    missingGenre: 0,
    missingGenreLabel: 0,
    missingPlotSection: 0,
    shortPlot: 0,
    missingLicenseCheck: 0,
    rightsWarnings: 0,
    duplicates: 0,
    collected: 0,
  };
  const pagesByYear = new Map();
  for (const year of years) {
    const pages = await discoverYear(client, year, candidateLimit);
    counts.discovered += pages.length;
    pages.sort((a, b) =>
      compareText(score(`${year}:page:${a.pageid}`), score(`${year}:page:${b.pageid}`))
    );
    const sampled = pages.slice(0, perYearSample);
    counts.sampled += sampled.length;
    pagesByYear.set(year, sampled);
    console.log(`Discovered ${pages.length} category pages for ${year}; sampled ${sampled.length}.`);
  }

  const enriched = [];
  for (const year of years) enriched.push(...await enrichPages(client, year, pagesByYear.get(year)));
  counts.missingPageOrItem = counts.sampled - enriched.length;

  // A film may appear in multiple year categories; keep the earliest year
  // that is supported by its release-date claims.
  enriched.sort((a, b) => a.year - b.year || compareText(a.qid, b.qid));
  const verified = await verifiedCandidates(client, enriched, asOf, counts);
  const labels = await genreLabels(client, verified);
  const eligible = verified.flatMap((candidate) => {
    const genre = [...new Set(candidate.genreIds.map((id) => labels.get(id)).filter(Boolean))].sort(compareText).join(", ");
    if (!genre || !candidate.title) {
      counts.missingGenreLabel += 1;
      return [];
    }
    return [{ ...candidate, genre }];
  });
  eligible.sort((a, b) =>
    compareText(score(`movie:${a.qid}`), score(`movie:${b.qid}`))
  );

  const movies = [];
  const yearCounts = new Map();
  const seenUrls = new Set();
  const seenIds = new Set();
  const yearLimit = Math.max(1, Math.ceil(max * 0.25));
  for (const candidate of eligible) {
    if (movies.length === max) break;
    if ((yearCounts.get(candidate.year) ?? 0) >= yearLimit) continue;
    if (seenUrls.has(candidate.source_url)) {
      counts.duplicates += 1;
      continue;
    }
    const plot = await fetchPlot(client, candidate, counts);
    if (!plot) continue;
    const movie = {
      title: candidate.title,
      year: String(candidate.year),
      genre: candidate.genre,
      plot,
      source_url: candidate.source_url,
    };
    movie.id = movieId(movie);
    if (seenIds.has(movie.id)) {
      counts.duplicates += 1;
      continue;
    }
    seenUrls.add(movie.source_url);
    seenIds.add(movie.id);
    yearCounts.set(candidate.year, (yearCounts.get(candidate.year) ?? 0) + 1);
    movies.push(movie);
    if (movies.length % 20 === 0) console.log(`Collected ${movies.length} verified movies.`);
  }
  movies.sort((a, b) => Number(a.year) - Number(b.year) || compareText(a.title, b.title) || compareText(a.id, b.id));
  counts.collected = movies.length;
  return { movies, counts, yearCounts: Object.fromEntries([...yearCounts].sort(([a], [b]) => a - b)) };
}

async function main() {
  const { max, candidateLimit, asOf, refresh } = options();
  const client = new WikimediaClient(refresh);
  const { movies, counts, yearCounts } = await collect(client, max, candidateLimit, asOf);
  if (movies.length === 0) throw new Error("No verified recent movies with usable plot sections were found.");

  const lines = [
    MOVIE_COLUMNS.join(","),
    ...movies.map((movie) => MOVIE_COLUMNS.map((column) => csvField(movie[column])).join(",")),
  ];
  await mkdir(resolve("data"), { recursive: true });
  const temporaryPath = resolve("data", `.recent-movies.csv.tmp-${process.pid}`);
  await writeFile(temporaryPath, `${lines.join("\n")}\n`, "utf8");
  await rename(temporaryPath, OUTPUT_PATH);
  console.log(JSON.stringify({ asOf, target: max, ...counts, byYear: yearCounts, ...client.stats }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(`Recent movie acquisition failed: ${error.message}`);
  process.exitCode = 1;
}
