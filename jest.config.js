export default {
  moduleNameMapper: {
    '^@teact$': '<rootDir>/src/lib/teact/teact.ts',
    '^@teact/(.*)$': '<rootDir>/src/lib/teact/$1',
  },
  testPathIgnorePatterns: [
    '<rootDir>/tests/playwright/',
    '<rootDir>/node_modules/',
    '<rootDir>/legacy_notes_and_workbook/',
    '<rootDir>/client/src/stylesheets/',
  ],
  testEnvironment: 'jsdom',
  transform: {
    '\\.(jsx?|tsx?)$': 'babel-jest',
    '\\.txt$': '@glen/jest-raw-loader',
  },
  globals: {
    APP_REVISION: 'jest-test',
    APP_VERSION: '0.0.1',
  },
};
