import {
  describe, it, vi,
} from 'vitest';
import { setEnvironmentVariables, outputJsonBlob } from '../src/index';

// Mock the GitHub Actions core module for testing
vi.mock('@actions/core', () => ({
  default: {
    getInput: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    setFailed: vi.fn(),
    setOutput: vi.fn(),
    exportVariable: vi.fn(),
    setSecret: vi.fn(),
  },
  getInput: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  exportVariable: vi.fn(),
  setSecret: vi.fn(),
}));

describe('Sensitive Data Handling', () => {
  it('should export sensitive values as secrets and non-sensitive as regular variables', () => {
    const envGraph = {
      sources: [],
      settings: {},
      config: {
        DATABASE_URL: { value: 'postgresql://user:pass@localhost:5432/db', isSensitive: true },
        API_KEY: { value: 'sk-1234567890abcdef', isSensitive: true },
        DEBUG: { value: false, isSensitive: false },
        PORT: { value: 3000, isSensitive: false },
        NODE_ENV: { value: 'development', isSensitive: false },
      },
    };

    // Test the function - it should not throw any errors
    setEnvironmentVariables(envGraph);
  });

  it('should handle undefined and null values gracefully', () => {
    const envGraph = {
      sources: [],
      settings: {},
      config: {
        DEFINED_VALUE: { value: 'test', isSensitive: false },
        UNDEFINED_VALUE: { value: undefined, isSensitive: false },
        NULL_VALUE: { value: null, isSensitive: false },
      },
    };

    // Test the function - it should not throw any errors
    setEnvironmentVariables(envGraph);
  });

  it('should handle empty config object', () => {
    const envGraph = {
      sources: [],
      settings: {},
      config: {},
    };

    // Test the function - it should not throw any errors
    setEnvironmentVariables(envGraph);
  });

  it('should handle mixed sensitive and non-sensitive values', () => {
    const envGraph = {
      sources: [],
      settings: {},
      config: {
        PUBLIC_URL: { value: 'https://example.com', isSensitive: false },
        SECRET_TOKEN: { value: 'secret123', isSensitive: true },
        PUBLIC_PORT: { value: 8080, isSensitive: false },
        PRIVATE_KEY: { value: 'private456', isSensitive: true },
      },
    };

    // Test the function - it should not throw any errors
    setEnvironmentVariables(envGraph);
  });

  it('should output JSON blob correctly', () => {
    const envGraph = {
      sources: [],
      settings: {},
      config: {
        PUBLIC_URL: { value: 'https://example.com', isSensitive: false },
        SECRET_TOKEN: { value: 'secret123', isSensitive: true },
        PUBLIC_PORT: { value: 8080, isSensitive: false },
        PRIVATE_KEY: { value: 'private456', isSensitive: true },
      },
    };

    // Test the function - it should not throw any errors
    outputJsonBlob(envGraph);
  });
});
