// Use deployment configuration, never request Host / forwarded headers, as trust.
const currentRenderOrigin = "https://studylight-gg38.onrender.com";
function parseOrigin(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.hostname.includes("*") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `Expected an HTTP(S) origin without credentials, path, query or fragment`,
    );
  }
  return url.origin;
}
export function createOriginPolicy(env = process.env) {
  const useDefaults = env.ALLOWED_ORIGINS === undefined;
  const entries = useDefaults
    ? [
        currentRenderOrigin,
        ...(env.RENDER_EXTERNAL_URL ? [env.RENDER_EXTERNAL_URL] : []),
      ]
    : env.ALLOWED_ORIGINS.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
  const allowed = new Set(entries.map(parseOrigin));
  return (origin) => {
    if (typeof origin !== "string") return false;
    try {
      const normalized = parseOrigin(origin);
      const url = new URL(normalized);
      return (
        allowed.has(normalized) ||
        (useDefaults &&
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      );
    } catch {
      return false;
    }
  };
}
