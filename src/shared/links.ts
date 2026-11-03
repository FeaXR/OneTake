import pkg from '../../package.json' with { type: 'json' };

// The same repository electron-builder publishes to, so a fork only changes it in package.json.
const { owner, repo } = pkg.build.publish[0];
export const REPO = `${owner}/${repo}`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
export const DEVELOPER_PAGE = `https://github.com/${owner}`;
export const REPOSITORY_PAGE = `https://github.com/${REPO}`;
export const APP_VERSION: string = pkg.version;
