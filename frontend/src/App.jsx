import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwiseIcon, BinocularsIcon, LockSimpleIcon, SignOutIcon } from "@phosphor-icons/react";
import { UNAUTHORIZED_EVENT, auth, coversApi, realApi, showcaseApi, sorterApi } from "./api";
import { hydrate, loadFindings, loadRejected, saveFindings, saveRejected } from "./coverState";
import { scanLibrary } from "./coverScan";
import { demoApi } from "./demo/demoApi";
import AlbumSorter from "./components/AlbumSorter";
import CoverReview from "./components/CoverReview";
import Login from "./components/Login";
import Showcase from "./components/Showcase";
import ToolCard from "./components/ToolCard";
import Wordmark from "./components/Wordmark";

// Everyone sees the demo. The real tools are behind the owner login; this flag
// only says "this browser signed in before", so visitors never poll the server.
const HINT = "mh-owner";
function hint(on) {
  try {
    if (on === undefined) return localStorage.getItem(HINT) === "1";
    if (on) localStorage.setItem(HINT, "1");
    else localStorage.removeItem(HINT);
  } catch {
    // storage blocked: the owner just signs in again next visit
  }
  return false;
}

// The Hall (the showcase) is public and always first. Purgatory (the album sorter) only shows while some ranks
// are shared by several albums, and Cover art (owner only) while some album needs a cover or title fix; Scan
// library checks both again. Purgatory runs on sample albums until the owner signs in. Tools has every tool,
// filtered by category inside the tab.
const SHOWCASE = "hall";
const COVERS = "covers";
const SORTER = "purgatory";
const TOOLS = "tools";
const ALL = "All";
const LABELS = { [SHOWCASE]: "The Hall", [SORTER]: "Purgatory", [COVERS]: "Cover art", [TOOLS]: "Tools" };
const TAB = "mh-tab";
const TOOL_FILTER = "mh-tools-filter";
// tabs used to be saved by label, and every tool category was a tab of its own
const OLD_TABS = { Showcase: SHOWCASE, "Album sorter": SORTER, "Cover art": COVERS };
// the open tab is in the URL hash (#hall, #purgatory...) so a tab can be linked, and in localStorage for next visit
const fromHash = () => {
  const id = window.location.hash.slice(1);
  return LABELS[id] ? id : null;
};
function savedTab() {
  const linked = fromHash();
  if (linked) return linked;
  try {
    const saved = localStorage.getItem(TAB);
    if (!saved) return SHOWCASE;
    if (LABELS[saved]) return saved;
    return OLD_TABS[saved] || TOOLS;
  } catch {
    return SHOWCASE;
  }
}
function savedFilter() {
  try {
    const old = localStorage.getItem(TAB);
    return localStorage.getItem(TOOL_FILTER) || (old && !LABELS[old] && !OLD_TABS[old] ? old : ALL);
  } catch {
    return ALL;
  }
}
function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked: it just resets next visit
  }
}

export default function App() {
  const [phase, setPhase] = useState(() => (hint() ? "checking" : "public")); // checking | public | owner
  const [authRequired, setAuthRequired] = useState(true); // false only in password-less local dev
  const [login, setLogin] = useState(null); // null, or { message? } while the dialog is open
  const [tools, setTools] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState(savedTab);
  const [toolFilter, setToolFilter] = useState(savedFilter);
  const [covers, setCovers] = useState(null); // owner only: { issues, albums, can_suggest }
  const [ranks, setRanks] = useState(null); // { ties, open } from the album sorter: ranks shared by several albums
  const [refresh, setRefresh] = useState(0); // bumped by a scan, Live or a rank/pick so the Hall and the sorter load again
  const [stay, setStay] = useState(null); // the tab I'm on keeps showing even once its last problem is fixed
  const [findings, setFindings] = useState(loadFindings); // what the last scan found
  const [rejected, setRejected] = useState(loadRejected); // albums whose correction I swiped away
  const [scan, setScan] = useState(null); // { done, total } while scanning
  const [scanNote, setScanNote] = useState(null);
  const scanCtl = useRef(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");

  const enter = useCallback((required) => {
    setAuthRequired(required);
    hint(true);
    setLogin(null);
    setPhase("owner");
  }, []);

  useEffect(() => {
    if (phase !== "checking") return;
    auth
      .me()
      .then(({ authenticated, required }) => {
        if (authenticated) return enter(required);
        hint(false);
        setPhase("public");
      })
      .catch(() => setPhase("public"));
  }, [phase, enter]);

  useEffect(() => {
    const onExpired = () => {
      hint(false);
      setPhase("public");
      setLogin({ message: "Your session ended. Sign in again." });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onExpired);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onExpired);
  }, []);

  const api = phase === "owner" ? realApi : demoApi;
  useEffect(() => {
    if (phase === "checking") return;
    setTools(null);
    setRanks(null); // the sorter remounts with the other data set and reports again
    setError("");
    api.tools().then(setTools).catch((e) => setError(e.message));
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setCovers(null);
    if (phase !== "owner") return;
    coversApi.queue().then(setCovers).catch(() => setCovers(null)); // no Notion access: no tab
  }, [phase]);
  // an applied change: forget the issue and the finding, and update our copy of the album
  const resolveCover = useCallback((id, applied) => {
    setCovers((c) =>
      c && {
        ...c,
        issues: c.issues.filter((i) => i.id !== id),
        albums: c.albums.map((a) =>
          a.id !== id ? a : { ...a, current: applied.cover || a.current, name: applied.title || a.name, has_icon: a.has_icon || Boolean(applied.icon) },
        ),
      },
    );
    setFindings((f) => {
      const kept = f.filter((x) => x.id !== id);
      saveFindings(kept);
      return kept;
    });
  }, []);
  const rejectCover = useCallback((id) => {
    setRejected((r) => {
      const next = new Set(r).add(id);
      saveRejected(next);
      return next;
    });
  }, []);
  const bringBackRejected = () => {
    setRejected(new Set());
    saveRejected(new Set());
  };

  const reviewItems = useMemo(() => {
    if (!covers) return [];
    const inQueue = new Set(covers.issues.map((i) => i.id));
    return [...covers.issues, ...hydrate(findings, covers.albums).filter((i) => !inQueue.has(i.id))];
  }, [covers, findings]);
  const pending = reviewItems.filter((i) => !rejected.has(i.id)).length;

  const storeFindings = (list) => {
    setFindings(list);
    saveFindings(list);
  };
  // A scan re-reads the library: cover problems and shared ranks from Notion, then (with Spotify set up) every
  // album's cover and title against Spotify. Cover art and Purgatory only show while it finds something.
  // "Live": read Notion again right now (the server keeps its own copy for 20 minutes), then reload what shows ranks
  const refreshFromNotion = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError("");
    try {
      await showcaseApi.refresh();
      setRefresh((n) => n + 1); // the Hall and Purgatory load again
      coversApi.queue().then(setCovers).catch(() => {}); // keep the queue we have if it can't be read
    } catch (e) {
      setRefreshError(e.message);
    } finally {
      setRefreshing(false);
    }
  };

  const startScan = async () => {
    if (scan || !covers) return;
    const ctl = new AbortController();
    scanCtl.current = ctl;
    setScanNote(null);
    setScan({ done: 0, total: 0 });
    setRefresh((n) => n + 1);
    try {
      let queue = covers;
      try {
        queue = await coversApi.queue();
        setCovers(queue);
      } catch {
        // keep the queue we have
      }
      let result = { findings: [], failed: 0, scanned: 0 };
      if (queue.can_suggest) {
        const exclude = new Set([...queue.issues.map((i) => i.id), ...rejected]);
        result = await scanLibrary(queue.albums, {
          exclude,
          signal: ctl.signal,
          onProgress: (done, total) => setScan({ done, total }),
        });
        const fresh = new Set(result.findings.map((f) => f.id));
        storeFindings([...findings.filter((f) => !fresh.has(f.id)), ...result.findings]);
      }
      setScanNote({ ...result, issues: queue.issues.length, spotify: queue.can_suggest, stopped: ctl.signal.aborted });
    } finally {
      setScan(null);
    }
  };

  const categories = [...new Set((tools || []).map((t) => t.category || "Other"))];
  // the tab stays while you are on it, so finishing the last card doesn't throw you off the page
  const showCovers = Boolean(covers) && (reviewItems.length > 0 || stay === COVERS);
  const showSorter = Boolean(ranks) && (ranks.ties > 0 || stay === SORTER);
  const activeTab =
    [SHOWCASE, TOOLS].includes(tab) || (tab === COVERS && showCovers) || (tab === SORTER && showSorter) ? tab : SHOWCASE;
  const onShowcase = activeTab === SHOWCASE;
  const onCovers = activeTab === COVERS;
  const onSorter = activeTab === SORTER;
  const onTools = activeTab === TOOLS;
  const activeFilter = toolFilter === ALL || categories.includes(toolFilter) ? toolFilter : ALL;
  const pickTab = (name) => {
    setTab(name);
    remember(TAB, name);
  };
  useEffect(() => {
    const onHash = () => {
      const id = fromHash();
      if (id) pickTab(id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setStay(activeTab), [activeTab]);
  // once we know a linked or saved tab isn't offered (nothing to fix), forget it, so a later scan doesn't jump there
  const tabKnown = tab === SORTER ? ranks !== null : tab === COVERS ? phase === "public" || covers !== null : true;
  useEffect(() => {
    if (phase !== "checking" && tabKnown && tab !== activeTab) pickTab(activeTab);
  }, [phase, tabKnown, tab, activeTab]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (phase !== "checking" && window.location.hash !== `#${activeTab}`) {
      window.history.replaceState(null, "", `#${activeTab}`);
    }
  }, [activeTab, phase, tab]); // `tab` too: a link to a tab that isn't offered right now shows the Hall's address
  const pickFilter = (name) => {
    setToolFilter(name);
    remember(TOOL_FILTER, name);
  };
  const owner = phase === "owner";
  const intro = {
    [SHOWCASE]: "My album library, ranked.",
    [SORTER]: owner
      ? "Albums that share a rank wait here. Pick the better one of each pair to break the tie."
      : "Albums that share a rank wait here. Pick the better one of each pair to break the tie. This demo is a copy of my real albums: nothing you pick is saved.",
    [COVERS]: "Fix covers and titles from Spotify, one album at a time.",
    [TOOLS]: owner
      ? "My music tools: Notion album library, Spotify, streaming charts, setlists and lyrics."
      : "My music tools: Notion album library, Spotify, streaming charts, setlists and lyrics. Here they run on sample data, so press Run on any of them.",
  }[activeTab];

  const openOwner = async () => {
    try {
      const me = await auth.me();
      if (me.authenticated) return enter(me.required);
      setLogin({});
    } catch {
      setLogin({ message: "Couldn’t reach the API. If you’re running locally, start it with DEV.bat." });
    }
  };

  const signOut = async () => {
    try {
      await auth.logout();
    } catch {
      // the cookie may already be gone
    }
    hint(false);
    setPhase("public");
  };

  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <Wordmark />
        {phase !== "checking" && (
          <nav className="tabs" aria-label="Sections">
            {[SHOWCASE, ...(showSorter ? [SORTER] : []), ...(showCovers ? [COVERS] : []), TOOLS].map((id) => (
              <a
                key={id}
                href={`#${id}`}
                className="tab"
                aria-current={id === activeTab ? "page" : undefined}
                onClick={() => pickTab(id)}
              >
                {LABELS[id]}
                {id === COVERS && pending > 0 && (
                  <span className="tab-count" aria-label={`, ${pending} to review`}>
                    {pending}
                  </span>
                )}
                {id === SORTER && ranks.open > 0 && (
                  <span className="tab-count" aria-label={`, ${ranks.open} ${ranks.open === 1 ? "tie" : "ties"} to break`}>
                    {ranks.open}
                  </span>
                )}
              </a>
            ))}
          </nav>
        )}
        <div className="top-actions">
          {owner ? (
            <button
              className={`ghost live${refreshing ? " busy" : ""}`}
              onClick={refreshFromNotion}
              disabled={refreshing}
              title="Live: you see the real library. Press to read Notion again now (changes made in Notion show up without the usual wait)"
              aria-label={refreshing ? "Reading Notion again" : "Live. Read Notion again"}
            >
              <ArrowsClockwiseIcon aria-hidden="true" />
              <span className="btn-label">{refreshing ? "Refreshing…" : "Live"}</span>
            </button>
          ) : (
            <span className="badge">Public view</span>
          )}
          {owner ? (
            <>
              {covers && (
                <button
                  className="ghost"
                  onClick={startScan}
                  disabled={Boolean(scan)}
                  title="Look for shared ranks and for covers or titles that need fixing"
                >
                  <BinocularsIcon aria-hidden="true" />
                  <span className="btn-label">Scan library</span>
                </button>
              )}
              <button
                className="ghost"
                onClick={signOut}
                title={authRequired ? "End the owner session" : "Login is off locally (no OWNER_PASSWORD); this goes back to the demo"}
              >
                <SignOutIcon aria-hidden="true" />
                <span className="btn-label">{authRequired ? "Log out" : "Back to demo"}</span>
              </button>
            </>
          ) : (
            <button className="ghost" onClick={openOwner} title="Owner sign-in">
              <LockSimpleIcon aria-hidden="true" />
              Sign in
            </button>
          )}
        </div>
      </header>

      {owner && refreshError && (
        <div className="scan-banner" role="alert">
          <span>{refreshError}</span>
          <button className="ghost" onClick={() => setRefreshError("")}>
            Dismiss
          </button>
        </div>
      )}

      {owner && (scan || scanNote) && (
        <div className="scan-banner" role="status">
          {scan ? (
            <>
              <span>
                Checking albums against Spotify… {scan.done} of {scan.total}
              </span>
              <progress value={scan.done} max={scan.total || 1} aria-label="Scan progress" />
              <button className="ghost" onClick={() => scanCtl.current?.abort()}>
                Stop
              </button>
            </>
          ) : (
            <>
              <span>
                {scanNote.stopped ? "Scan stopped. " : "Scan finished. "}
                {pending > 0
                  ? `${pending} album${pending === 1 ? "" : "s"} to fix in Cover art. `
                  : "No covers or titles to fix. "}
                {ranks &&
                  (ranks.ties > 0
                    ? `${ranks.ties} rank${ranks.ties === 1 ? " is" : "s are"} shared by several albums: break the ties in Purgatory. `
                    : "No shared ranks. ")}
                {scanNote.failed > 0 && `${scanNote.failed} couldn’t be checked (Spotify didn’t answer). `}
                {!scanNote.spotify && "Spotify isn’t set up, so covers were only checked in Notion."}
              </span>
              <button className="ghost" onClick={() => setScanNote(null)}>
                Dismiss
              </button>
            </>
          )}
        </div>
      )}

      <main id="main" tabIndex={-1}>
        {phase === "checking" ? (
          <p className="note page-note" role="status">
            Checking your session…
          </p>
        ) : (
          <div className="page-head">
            <h1>{LABELS[activeTab]}</h1>
            <p>{intro}</p>
          </div>
        )}

        {/* the showcase, the sorter and every card stay mounted (just hidden) so state survives switching tabs */}
        {phase !== "checking" && <Showcase hidden={!onShowcase} owner={owner} refresh={refresh} onLibraryChanged={() => setRefresh((n) => n + 1)} />}
        {phase !== "checking" && (
          <AlbumSorter
            key={phase}
            api={owner ? sorterApi : demoApi.sorter}
            live={owner}
            hidden={!onSorter}
            refresh={refresh}
            onStatus={setRanks}
          />
        )}
        {onCovers && (
          <CoverReview
            items={reviewItems}
            canSuggest={covers.can_suggest}
            rejected={rejected}
            onReject={rejectCover}
            onBringBack={bringBackRejected}
            onResolved={resolveCover}
          />
        )}

        {onTools && categories.length > 1 && (
          <div className="seg tool-filter" role="group" aria-label="Tool category">
            {[ALL, ...categories].map((name) => (
              <button key={name} aria-pressed={name === activeFilter} onClick={() => pickFilter(name)}>
                {name}
              </button>
            ))}
          </div>
        )}
        {error && onTools && <p className="error">{error}</p>}
        {!tools && !error && onTools && <p className="note">Loading tools…</p>}
        <div className="bench">
          {tools?.map((tool) => (
            <ToolCard
              key={`${phase}-${tool.id}`}
              tool={tool}
              api={api}
              live={owner}
              hidden={!onTools || (activeFilter !== ALL && (tool.category || "Other") !== activeFilter)}
            />
          ))}
        </div>
      </main>

      {login && <Login message={login.message} onClose={() => setLogin(null)} onDone={() => enter(true)} />}
    </div>
  );
}
