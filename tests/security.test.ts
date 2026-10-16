import { expect, it } from 'vitest';
import { isTrustedDocument } from '../apps/desktop/src/main/ipc';

it('rejects non-local origins, alternate files and about:blank even when origins are null', () => {
  expect(isTrustedDocument('nexus://app/index.html', 'nexus://app/index.html')).toBe(true);
  expect(isTrustedDocument('nexus://evil/index.html', 'nexus://app/index.html')).toBe(false);
  expect(isTrustedDocument('file:///C:/secrets.html', 'nexus://app/index.html')).toBe(false);
  expect(isTrustedDocument('about:blank', 'nexus://app/index.html')).toBe(false);
  expect(isTrustedDocument('http://localhost:5173/index.html', 'http://localhost:5173/index.html')).toBe(true);
  expect(isTrustedDocument('http://localhost:5174/index.html', 'http://localhost:5173/index.html')).toBe(false);
  expect(isTrustedDocument('http://localhost:5173/other.html', 'http://localhost:5173/index.html')).toBe(false);
  expect(isTrustedDocument('invalid url', 'nexus://app/index.html')).toBe(false);
});
