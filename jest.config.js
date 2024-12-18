module.exports = {
  preset: 'ts-jest',
  testEnvironment: './jest-env.js',
  testMatch: ['<rootDir>/src/__test__/*.+(ts|tsx|js)'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  watchPathIgnorePatterns: ['<rootDir>/test/', '<rootDir>/test copy/']
};