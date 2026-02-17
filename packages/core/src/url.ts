export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const params = new URLSearchParams(parsed.search);
    for (const key of Array.from(params.keys())) {
      if (key.startsWith("utm_")) params.delete(key);
    }
    parsed.search = params.toString() ? `?${params.toString()}` : "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

