import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JournalLogger } from '../../src/core/Logger.js';

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { appendFileSync, mkdirSync } from 'node:fs';

const mockAppend = vi.mocked(appendFileSync);
const mockMkdir = vi.mocked(mkdirSync);

describe('JournalLogger', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes info messages to stdout', () => {
    const logger = new JournalLogger('info');
    logger.info('hello world');
    expect(writeSpy).toHaveBeenCalledOnce();
    expect(String(writeSpy.mock.calls[0]![0])).toContain('hello world');
    expect(String(writeSpy.mock.calls[0]![0])).toContain('INFO');
  });

  it('writes error messages to stderr', () => {
    const logger = new JournalLogger('info');
    logger.error('something broke');
    expect(errSpy).toHaveBeenCalledOnce();
    expect(String(errSpy.mock.calls[0]![0])).toContain('something broke');
  });

  it('suppresses messages below the configured log level', () => {
    const logger = new JournalLogger('warn');
    logger.debug('this should be suppressed');
    logger.info('this too');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('includes serialized meta when provided', () => {
    const logger = new JournalLogger('debug');
    logger.debug('with meta', { userId: 42 });
    const output = String(writeSpy.mock.calls[0]![0]);
    expect(output).toContain('"userId":42');
  });

  it('exposes the configured log level', () => {
    const logger = new JournalLogger('warn');
    expect(logger.level).toBe('warn');
  });

  describe('file logging', () => {
    it('creates the log directory on construction when logFilePath is provided', () => {
      new JournalLogger('info', '/logs/codit.log');
      expect(mockMkdir).toHaveBeenCalledWith('/logs', { recursive: true });
    });

    it('appends each log line to the file', () => {
      const logger = new JournalLogger('info', '/logs/codit.log');
      logger.info('persisted message');
      expect(mockAppend).toHaveBeenCalledOnce();
      const written = String(mockAppend.mock.calls[0]![1]);
      expect(written).toContain('persisted message');
      expect(written).toContain('INFO');
    });

    it('appends warn and error lines to the file as well as stderr', () => {
      const logger = new JournalLogger('debug', '/logs/codit.log');
      logger.warn('a warning');
      logger.error('an error');
      expect(mockAppend).toHaveBeenCalledTimes(2);
      expect(errSpy).toHaveBeenCalledTimes(2);
    });

    it('does not call appendFileSync when no logFilePath is given', () => {
      const logger = new JournalLogger('info');
      logger.info('console only');
      expect(mockAppend).not.toHaveBeenCalled();
    });

    it('suppresses file writes for messages below the log level', () => {
      const logger = new JournalLogger('warn', '/logs/codit.log');
      logger.debug('suppressed');
      logger.info('also suppressed');
      expect(mockAppend).not.toHaveBeenCalled();
    });
  });
});

