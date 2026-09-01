import process from "node:process";

const configuredOrigin = process.argv[2]
  || process.env.NONSTOPTALK_PRODUCTION_ORIGIN
  || "https://dontstoptalking.org";
const origin = new URL(configuredOrigin);
const WEB_ANALYTICS_ORIGIN = "https://static.cloudflareinsights.com";
if (!/^https:$/.test(origin.protocol) || origin.pathname !== "/") {
  throw new Error("NONSTOPTALK_PRODUCTION_ORIGIN must be an HTTPS origin without a path.");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function contentSecurityPolicySources(policy, directiveName) {
  const directive = String(policy)
    .split(";")
    .map((item) => item.trim().split(/\s+/u))
    .find(([name]) => name === directiveName);
  return directive ? directive.slice(1) : [];
}

function hasScriptFromOrigin(html, documentURL, expectedOrigin) {
  const sources = [...String(html).matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/giu)]
    .map((match) => match[1]);
  return sources.some((source) => {
    try {
      return new URL(source, documentURL).origin === expectedOrigin;
    } catch {
      return false;
    }
  });
}

async function get(pathname, accept) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(new URL(pathname, origin), {
        headers: { Accept: accept },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return response;
      await response.body?.cancel().catch(() => undefined);
      lastError = new Error(`${pathname} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
  throw lastError instanceof Error ? lastError : new Error(`${pathname} did not respond.`);
}

for (const pathname of ["/", "/practice", "/progress"]) {
  const response = await get(pathname, "text/html");
  assert(response.headers.get("content-type")?.startsWith("text/html"), `${pathname} did not return HTML`);
  const html = await response.text();
  assert(html.includes("<title>NonStopTalk</title>"), `${pathname} did not return the NonStopTalk shell`);
  assert(response.headers.get("x-content-type-options") === "nosniff", `${pathname} is missing security headers`);
  assert(response.headers.get("strict-transport-security")?.includes("max-age=31536000"),
    `${pathname} is missing the production HSTS policy`);
  const contentSecurityPolicy = response.headers.get("content-security-policy") || "";
  assert(contentSecurityPolicy.includes("default-src 'self'"),
    `${pathname} is missing the Content Security Policy`);
  const connectSources = contentSecurityPolicySources(contentSecurityPolicy, "connect-src");
  assert(connectSources.length === 1 && connectSources[0] === "'self'",
    `${pathname} must permit only same-origin browser connections`);
  const scriptSources = contentSecurityPolicySources(contentSecurityPolicy, "script-src");
  assert(scriptSources.length === 2
    && scriptSources[0] === "'self'"
    && scriptSources[1] === WEB_ANALYTICS_ORIGIN,
    `${pathname} must permit only same-origin scripts and the configured Cloudflare Web Analytics beacon origin`);
}

const adminDocumentResponse = await get("/admin/analytics", "text/html");
assert(adminDocumentResponse.headers.get("content-type")?.startsWith("text/html"),
  "/admin/analytics did not return HTML");
const adminDocument = await adminDocumentResponse.text();
assert(adminDocument.includes("<title>Operator analytics · NonStopTalk</title>"),
  "/admin/analytics did not return its dedicated document");
assert(adminDocument.includes("/admin-analytics-page.js") && !adminDocument.includes('src="/app.js"'),
  "/admin/analytics is not isolated from the public SPA");
assert(!hasScriptFromOrigin(adminDocument, new URL("/admin/analytics", origin), WEB_ANALYTICS_ORIGIN),
  "/admin/analytics contains an injected Web Analytics beacon");
assert(adminDocumentResponse.headers.get("cache-control") === "public, max-age=0, must-revalidate, no-transform",
  "/admin/analytics must disable edge payload transforms");
const adminCsp = adminDocumentResponse.headers.get("content-security-policy") || "";
for (const directive of [
  "default-src 'none'", "script-src 'self'", "script-src-attr 'none'", "style-src 'self'",
  "style-src-attr 'none'", "connect-src 'self'", "form-action 'none'", "frame-ancestors 'none'", "worker-src 'none'",
]) {
  assert(adminCsp.includes(directive), `/admin/analytics CSP is missing ${directive}`);
}
const adminScriptSources = contentSecurityPolicySources(adminCsp, "script-src");
assert(adminScriptSources.length === 1 && adminScriptSources[0] === "'self'",
  "/admin/analytics CSP must permit only same-origin scripts");
assert(adminDocumentResponse.headers.get("referrer-policy") === "no-referrer",
  "/admin/analytics must not send referrers");
assert(adminDocumentResponse.headers.get("x-robots-tag") === "noindex, nofollow, noarchive",
  "/admin/analytics must be excluded from indexing");
const directAdminAsset = await get("/admin/analytics/index.html", "text/html");
assert(directAdminAsset.headers.get("content-security-policy") === adminCsp,
  "the direct admin asset path bypasses the isolated document policy");
assert(!hasScriptFromOrigin(
  await directAdminAsset.text(),
  new URL("/admin/analytics/index.html", origin),
  WEB_ANALYTICS_ORIGIN,
),
  "the direct admin asset path contains an injected Web Analytics beacon");

const statusResponse = await get("/api/v1/platform/status", "application/json");
const status = await statusResponse.json();
assert(status.status === "ok", `platform status is ${String(status.status || "unavailable")}`);
assert(status.apiVersion === "v1", "production API version is not v1");
assert(status.schemaVersion === 5, "production schema version is not the cleanup-heartbeat schema");
assert(Array.isArray(status.degradedCapabilities) && status.degradedCapabilities.length === 0,
  `production reports degraded capabilities: ${JSON.stringify(status.degradedCapabilities)}`);
assert(status.capabilities?.cloudProgress?.status === "ready", "cloud progress is not ready");
assert(status.capabilities?.retentionCleanup?.status === "ready", "retention cleanup is not ready");
assert(status.capabilities?.roomFacts?.status === "ready", "room facts are not ready");
assert(status.capabilities?.aggregateAnalytics?.status === "ready", "aggregate analytics is not ready");
assert(statusResponse.headers.get("cache-control") === "no-store", "platform status must not be cached");
assert(Boolean(statusResponse.headers.get("x-request-id")), "platform status is missing its request ID");

console.log(JSON.stringify({
  status: "ok",
  origin: origin.origin,
  apiVersion: status.apiVersion,
  schemaVersion: status.schemaVersion,
  checkedRoutes: ["/", "/practice", "/progress", "/admin/analytics", "/api/v1/platform/status"],
}));
