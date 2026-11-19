const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-rc\.(0|[1-9][0-9]*))?$/;

export const initialVersion = '0.1.0';

export function releaseVersion(value) {
  const match = typeof value === 'string' && versionPattern.exec(value);
  if (!match || match[0] !== value) return null;
  const [major, minor, patch, rc] = match.slice(1).filter(part => part !== undefined).map(Number);
  return [major, minor, patch, rc ?? 0].every(Number.isSafeInteger) ? { major, minor, patch, rc: rc ?? null } : null;
}

export function baseVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

export function compareVersions(left, right) {
  const a = releaseVersion(left), b = releaseVersion(right);
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function isNextStable(version, prior) {
  if (!isFinalVersion(version)) return false;
  if (!prior && version === initialVersion) return true;
  const next = releaseVersion(version), base = releaseVersion(prior ?? initialVersion);
  return (next.major === base.major && next.minor === base.minor && next.patch === base.patch + 1) ||
    (next.major === base.major && next.minor === base.minor + 1 && next.patch === 0) ||
    (next.major === base.major + 1 && next.minor === 0 && next.patch === 0);
}

export const isReleaseVersion = value => releaseVersion(value) !== null;
export const isFinalVersion = value => releaseVersion(value)?.rc === null;
export const isRCTag = tag => typeof tag === 'string' && tag.startsWith('v') && Number.isSafeInteger(releaseVersion(tag.slice(1))?.rc);
export const candidateNpmTag = version => 'candidate-' + version;
