import Link from "next/link";
import { CatalogueExplorer } from "@/components/catalogue-explorer";
import { PosterArt } from "@/components/poster-art";
import { SearchExperience } from "@/components/search-experience";
import { browseCatalogue } from "@/lib/catalogue.mjs";
import { getCatalogueSnapshot } from "@/lib/catalogue-server.mjs";

export default async function Home() {
  const catalogue = await getCatalogueSnapshot();
  const initial = browseCatalogue(catalogue);
  const featured = catalogue[0];
  return <div className="site-shell">
    <a className="skip-link" href="#browse">Skip to movies</a>
    <header className="site-header page-width">
      <Link href="/" className="brand" aria-label="MoodMatch home"><span className="brand__mark" aria-hidden="true">✳</span><span>Mood<span className="brand__accent">Match</span></span></Link>
      <nav aria-label="Primary navigation"><a href="#browse">Browse movies</a><a href="#discover">AI mood search</a><a href="#how-it-works">The idea</a></nav>
      <span className="catalogue-tag">1,100 FILMS <span aria-hidden="true">✦</span></span>
    </header>
    <main>
      <section className="hero page-width" aria-labelledby="hero-title">
        <div className="hero__copy"><span className="hero__eyebrow">A DIFFERENT WAY TO DISCOVER FILM <span aria-hidden="true">✦</span></span>
          <h1 id="hero-title">Every mood has <em>a movie.</em></h1>
          <p>Find the film that fits the moment. Wander through the collection, or describe a feeling and let local AI search connect you with a story.</p>
          <div className="hero__actions"><a className="hero__primary" href="#browse">Explore the collection <span aria-hidden="true">↗</span></a><a className="hero__secondary" href="#discover">Search by mood <span aria-hidden="true">↓</span></a></div>
          <div className="hero__meta"><span>01 / 1,100</span><span>ACTUAL MOVIE METADATA · NO INVENTED RANKINGS</span></div>
        </div>
        <div className="hero__visual"><div className="hero__poster"><PosterArt title={featured.title} featured artwork={featured.artwork} /></div>
          <div className="hero__caption"><span>FROM THE CATALOGUE</span><strong>{featured.title}</strong><small>{featured.year ?? "Year unknown"} · {featured.genres[0] ?? "Genre not listed"}</small>{featured.artwork && <small>Art: <a href={featured.artwork.filePage} target="_blank" rel="noopener noreferrer">{featured.artwork.creator}</a> · <a href={featured.artwork.licenseUrl} target="_blank" rel="noopener noreferrer">{featured.artwork.license}</a></small>}<Link href={`/movie/${featured.id}`}>Explore this film ↗</Link></div></div>
      </section>
      <div className="page-width"><CatalogueExplorer initial={initial} />
        <div className="search-intro"><span className="section-kicker">BEYOND THE FILTERS</span><h2>Describe the feeling.<br /><em>Find the film.</em></h2><p>No ratings or invented recommendations. Your words become a local semantic search across real movie records.</p></div>
        <SearchExperience />
        <section className="how-section" id="how-it-works" aria-labelledby="how-heading"><div className="how-section__intro"><span className="section-kicker">THE IDEA</span><h2 id="how-heading">A little less scrolling.<br /><em>A little more discovery.</em></h2></div><div className="how-steps"><div><span>01</span><h3>Browse what exists</h3><p>Explore 1,100 validated films by genre, one catalogue page at a time.</p></div><div><span>02</span><h3>Describe a mood</h3><p>Local semantic search connects your words to stories in the collection.</p></div><div><span>03</span><h3>Follow the source</h3><p>Open a film’s detail and its original source article for context.</p></div></div></section>
      </div>
    </main>
    <footer className="site-footer"><div className="page-width site-footer__inner"><span className="brand brand--footer">Mood<span className="brand__accent">Match</span></span><p>Movie discovery for the moment you are in.</p><small>Catalogue metadata links to source articles. Full plot text and third-party posters are withheld pending rights review.</small></div></footer>
  </div>;
}
