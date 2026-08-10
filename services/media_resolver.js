/**
 * Media resolver: turn the tutor's "search_query" specs into concrete,
 * client-ready URLs for YouTube videos and Google images.
 *
 * By default this is fully offline and deterministic — it builds search URLs
 * that always work without any API key. If YOUTUBE_API_KEY / GOOGLE_CSE_KEY +
 * GOOGLE_CSE_ID are configured, the async resolvers can be used to fetch a
 * specific top result instead. Network calls are best-effort and always fall
 * back to the deterministic URL, so the tutoring flow never breaks on media.
 */

function enc(q) {
  return encodeURIComponent(q.trim());
}

/** Deterministic YouTube search URL (no API key required). */
function youtubeSearchUrl(query) {
  return `https://www.youtube.com/results?search_query=${enc(query)}`;
}

/** Deterministic Google Images search URL (no API key required). */
function googleImageSearchUrl(query) {
  return `https://www.google.com/search?tbm=isch&q=${enc(query)}`;
}

/**
 * Attach a ready-to-open URL to a youtube spec.
 * @param {{search_query:string, title?:string, trigger?:string}} spec
 */
function youtube(spec) {
  return {
    type: "youtube",
    title: spec.title || "Related video",
    search_query: spec.search_query,
    trigger: spec.trigger || "teaching",
    url: youtubeSearchUrl(spec.search_query),
  };
}

/**
 * Attach a ready-to-open URL to a google image spec.
 * @param {{search_query:string, title?:string, trigger?:string}} spec
 */
function image(spec) {
  return {
    type: "google_image",
    title: spec.title || "Related image",
    search_query: spec.search_query,
    trigger: spec.trigger || "teaching",
    url: googleImageSearchUrl(spec.search_query),
  };
}

/** Deterministic Google web search URL (no API key required). */
function googleWebSearchUrl(query) {
  return `https://www.google.com/search?q=${enc(query)}`;
}

/**
 * Resolve a "further reading" internet link. If the spec carries an explicit
 * http(s) URL, pass it through; otherwise build a Google web-search URL from the
 * search_query so the link always opens to relevant material.
 * @param {{search_query?:string, url?:string, title?:string, trigger?:string}} spec
 */
function web(spec) {
  const explicit =
    typeof spec.url === "string" && /^https?:\/\//i.test(spec.url) ? spec.url : null;
  const query = spec.search_query || spec.title || "";
  return {
    type: "internet_link",
    title: spec.title || "Further reading",
    search_query: spec.search_query || null,
    trigger: spec.trigger || "extension",
    url: explicit || googleWebSearchUrl(query),
  };
}

/**
 * Optional: resolve a specific top YouTube video via the Data API if a key is
 * present. Falls back to the deterministic search URL on any error.
 * @param {{search_query:string, title?:string, trigger?:string}} spec
 * @returns {Promise<object>}
 */
async function youtubeTopResult(spec) {
  const key = process.env.YOUTUBE_API_KEY;
  const base = youtube(spec);
  if (!key || typeof fetch !== "function") return base;
  try {
    const url =
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1` +
      `&safeSearch=strict&q=${enc(spec.search_query)}&key=${key}`;
    const res = await fetch(url);
    if (!res.ok) return base;
    const data = await res.json();
    const item = data.items && data.items[0];
    const videoId = item?.id?.videoId;
    if (!videoId) return base;
    return {
      ...base,
      video_id: videoId,
      title: spec.title || item.snippet?.title || base.title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      embed_url: `https://www.youtube.com/embed/${videoId}`,
      thumbnail: item.snippet?.thumbnails?.medium?.url || null,
    };
  } catch {
    return base;
  }
}

const resolveMedia = {
  youtube,
  image,
  web,
  youtubeTopResult,
  youtubeSearchUrl,
  googleImageSearchUrl,
  googleWebSearchUrl,
};

module.exports = { resolveMedia };
