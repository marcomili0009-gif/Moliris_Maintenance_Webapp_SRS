export function normalizeClientPath(raw: string): string {
  let p = (raw || "").trim().replace(/\\/g, "/");
  if (!p) return "/";
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/\.(?=\/|$)/g, "").replace(/\/+/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

export function isPathAllowedForOperator(
  candidatePath: string,
  allowedPaths?: string[] | null
): boolean {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    return false;
  }
  const normCandidate = normalizeClientPath(candidatePath);
  const candSegs = normCandidate.split("/").filter(Boolean);
  return allowedPaths.some((root) => {
    if (!root || !root.trim()) return false;
    const normRoot = normalizeClientPath(root);
    const rootSegs = normRoot.split("/").filter(Boolean);
    if (rootSegs.length === 0) return true;
    if (candSegs.length < rootSegs.length) return false;
    return rootSegs.every((seg, i) => candSegs[i] === seg);
  });
}

export function isPathOrAncestorAllowedForOperator(
  candidatePath: string,
  allowedPaths?: string[] | null
): boolean {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    return false;
  }
  if (isPathAllowedForOperator(candidatePath, allowedPaths)) {
    return true;
  }
  const normCandidate = normalizeClientPath(candidatePath);
  const prefix = normCandidate === "/" ? "/" : normCandidate + "/";
  return allowedPaths.some((root) => {
    if (!root || !root.trim()) return false;
    const normRoot = normalizeClientPath(root);
    return normRoot.startsWith(prefix);
  });
}

export function canPerformOperatorPathAction(
  targetPath: string,
  isOperator: boolean,
  allowedPaths?: string[] | null
): boolean {
  if (!isOperator) return true;
  return isPathAllowedForOperator(targetPath, allowedPaths);
}

export function joinClientPath(basePath: string, entryName: string): string {
  const normBase = normalizeClientPath(basePath);
  const cleanName = (entryName || "").replace(/^[/\\]+/, "");
  if (!cleanName) return normBase;
  return normBase === "/" ? `/${cleanName}` : `${normBase}/${cleanName}`;
}
