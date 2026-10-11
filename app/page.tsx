import Link from "next/link";
import { SearchExperience } from "@/components/search-experience";

export default function Home() {
  return (
    <div className="site-shell">
      <div className="site-glow" aria-hidden="true" />
      <a className="skip-link" href="#discover">Skip to search</a>
      <header className="site-header page-width">
        <Link href="/" className="brand" aria-label="MoodMatch home">
          <span className="brand__mark" aria-hidden="true"><span>✳</span></span>
          <span>Mood<span className="brand__accent">Match</span></span>
        </Link>
        <nav aria-label="Primary navigation">
          <a href="#discover">Discover</a>
          <a href="#how-it-works">How it works</a>
        </nav>
        <span className="catalogue-tag"><span aria-hidden="true" /> 1,100 films in the collection</span>
      </header>

      <main className="page-width">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero__copy">
            <span className="hero__eyebrow"><span aria-hidden="true">✦</span> MOVIE DISCOVERY, TUNED TO YOU</span>
            <h1 id="hero-title">Find a film for <em>the feeling.</em></h1>
            <p>Forget the endless scroll. Tell us the mood, the moment, or the story you’re after — and discover a film that fits.</p>
            <a className="hero__jump" href="#discover">Start exploring <span aria-hidden="true">↓</span></a>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="hero-art__halo" />
            <div className="hero-art__frame hero-art__frame--back" />
            <div className="hero-art__frame hero-art__frame--front">
              <span className="hero-art__frame-top">MM / 001 <span>✦</span></span>
              <span className="hero-art__orb" />
              <span className="hero-art__frame-bottom">EVERY MOOD<br />HAS A MOVIE.</span>
            </div>
            <span className="hero-art__caption">A NEW WAY TO FIND WHAT MOVES YOU</span>
          </div>
        </section>

        <SearchExperience />

        <section className="how-section" id="how-it-works" aria-labelledby="how-heading">
          <div className="how-section__intro">
            <span className="section-kicker"><span className="kicker-line" /> THE IDEA</span>
            <h2 id="how-heading">Less scrolling.<br /><em>More feeling.</em></h2>
          </div>
          <div className="how-steps">
            <div><span>01</span><h3>Describe your mood</h3><p>A thought, a feeling, or a scene is enough to begin.</p></div>
            <div><span>02</span><h3>Find a connection</h3><p>Local semantic search compares your words with real films in the collection.</p></div>
            <div><span>03</span><h3>Follow the story</h3><p>Explore results and open each film’s source page for more detail.</p></div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="page-width site-footer__inner">
          <span className="brand brand--footer"><span className="brand__mark" aria-hidden="true"><span>✳</span></span> Mood<span className="brand__accent">Match</span></span>
          <p>Made for the moments when you know how you want to feel, but not what to watch.</p>
          <small>Movie metadata links to source articles. Full plot text is withheld pending rights review.</small>
        </div>
      </footer>
    </div>
  );
}
