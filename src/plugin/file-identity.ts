// fileKey can be unavailable (or throw) for plugins without private API access.
// Document root IDs and file names are not unique across copied files.
export function readFileKey(api: { readonly fileKey?: string }): string | undefined {
  try {
    const key = api.fileKey;
    return typeof key === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(key) ? key : undefined;
  } catch {
    return undefined;
  }
}
