const versionPattern = /^0\.1\.(0|[1-9][0-9]*)(?:-rc\.(0|[1-9][0-9]*))?$/;

export function releaseVersion(value) {
  const match = versionPattern.exec(value ?? '');
  return match && { patch: Number(match[1]), rc: match[2] === undefined ? null : Number(match[2]) };
}

export function isReleaseVersion(value) {
  const version = releaseVersion(value);
  return !!version && Number.isSafeInteger(version.patch) && (version.rc === null || Number.isSafeInteger(version.rc));
}

export const isFinalVersion = value => isReleaseVersion(value) && releaseVersion(value).rc === null;
export const isRCTag = tag => typeof tag === 'string' && tag.startsWith('v') && isReleaseVersion(tag.slice(1)) && releaseVersion(tag.slice(1)).rc !== null;
export const candidateNpmTag = version => 'candidate-' + version;
