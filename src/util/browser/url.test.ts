import { isMixedScriptUrl } from './url';

describe('isMixedScriptUrl', () => {
  it.each([
    'https://example.com',
    'example.com',
    'https://почта.рф',
  ])('allows regular URL: %s', (url) => {
    expect(isMixedScriptUrl(url)).toBe(false);
  });

  it.each([
    'https://trusted.example@evil.example',
    'https://user:password@evil.example',
    'https://aррle.example',
    'https://',
  ])('requires confirmation for suspicious URL: %s', (url) => {
    expect(isMixedScriptUrl(url)).toBe(true);
  });
});
