import { describe, it, expect, vi } from 'vitest';
import { WorkflowEngine } from '../../src/core/WorkflowEngine.js';
import { SkillRegistry } from '../../src/core/SkillRegistry.js';
import { makeMockLogger } from '../helpers/mocks.js';

const makeEngine = () => {
  const registry = new SkillRegistry();
  const logger = makeMockLogger();
  const engine = new WorkflowEngine(registry, logger, {});
  return { registry, logger, engine };
};

describe('WorkflowEngine.parseJobContent', () => {
  it('parses JOB name and action lines', () => {
    const content = 'JOB my-job\ndo something\ndo another thing\n';
    const job = WorkflowEngine.parseJobContent(content);

    expect(job.name).toBe('my-job');
    expect(job.loop).toBe(false);
    expect(job.techniques).toEqual(['do something', 'do another thing']);
  });

  it('detects LOOP flag', () => {
    const content = 'JOB repeating\nLOOP\nping the server\n';
    const job = WorkflowEngine.parseJobContent(content);

    expect(job.loop).toBe(true);
    expect(job.techniques).toEqual(['ping the server']);
  });

  it('ignores comment lines starting with #', () => {
    const content = 'JOB clean\n# this is a comment\ndo real work\n';
    const job = WorkflowEngine.parseJobContent(content);

    expect(job.techniques).toEqual(['do real work']);
  });

  it('ignores blank lines', () => {
    const content = 'JOB sparse\n\ndo work\n\n';
    const job = WorkflowEngine.parseJobContent(content);

    expect(job.techniques).toHaveLength(1);
  });

  it('parses VAR line and populates varNames', () => {
    const content = 'JOB mission\nVAR id,priority\nfetch work item {id}\n';
    const job = WorkflowEngine.parseJobContent(content);

    expect(job.varNames).toEqual(['id', 'priority']);
    expect(job.techniques).toEqual(['fetch work item {id}']);
  });

  it('returns empty varNames when no VAR line is present', () => {
    const content = 'JOB simple\ndo work\n';
    const job = WorkflowEngine.parseJobContent(content);

    expect(job.varNames).toEqual([]);
  });

  it('does not include the VAR line in techniques', () => {
    const content = 'JOB mission\nVAR id,name\nstep one\nstep two\n';
    const job = WorkflowEngine.parseJobContent(content);

    expect(job.techniques).toEqual(['step one', 'step two']);
  });
});

describe('WorkflowEngine.run', () => {
  it('executes all actions in order', async () => {
    const { registry, engine } = makeEngine();
    const callOrder: string[] = [];

    registry.skill('test', (r) => {
      r.register('step one', 'desc', () => vi.fn().mockImplementation(async () => { callOrder.push('one'); }));
      r.register('step two', 'desc', () => vi.fn().mockImplementation(async () => { callOrder.push('two'); }));
    });

    await engine.run({ name: 'test', loop: false, techniques: ['step one', 'step two'] });

    expect(callOrder).toEqual(['one', 'two']);
  });

  it('passes shared state between actions', async () => {
    const { registry, engine } = makeEngine();
    let captured: unknown;

    registry.skill('test', (r) => {
      r.register('produce value', 'desc', () => vi.fn().mockImplementation(async (ctx) => { ctx.state['val'] = 42; }));
      r.register('read value', 'desc', () => vi.fn().mockImplementation(async (ctx) => { captured = ctx.state['val']; }));
    });

    await engine.run({ name: 'pipe', loop: false, techniques: ['produce value', 'read value'] });

    expect(captured).toBe(42);
  });

  it('throws and halts when an action fails', async () => {
    const { registry, engine } = makeEngine();
    registry.skill('test', (r) => {
      r.register('broken action', 'desc', () => vi.fn().mockRejectedValue(new Error('Boom')));
    });

    await expect(
      engine.run({ name: 'fail-task', loop: false, techniques: ['broken action'] }),
    ).rejects.toThrow("Job 'fail-task' aborted at technique 'broken action': Boom");
  });

  it('throws when an action is not registered', async () => {
    const { engine } = makeEngine();

    await expect(
      engine.run({ name: 'missing', loop: false, techniques: ['nonexistent action'] }),
    ).rejects.toThrow("Technique 'nonexistent action' is not registered");
  });

  it('stores lastTechnique in state after each technique executes', async () => {
    const { registry, engine } = makeEngine();
    const captured: string[] = [];

    registry.skill('test', (r) => {
      r.register('step alpha', 'desc', () => vi.fn().mockImplementation(async (ctx) => {
        captured.push(ctx.state['lastTechnique'] as string ?? 'none');
      }));
      r.register('step beta', 'desc', () => vi.fn().mockImplementation(async (ctx) => {
        captured.push(ctx.state['lastTechnique'] as string ?? 'none');
      }));
    });

    await engine.run({ name: 'track', loop: false, techniques: ['step alpha', 'step beta'] });

    // lastTechnique reflects the previously completed technique when the next one runs
    expect(captured).toEqual(['none', 'step alpha']);
    // and is set to the last technique after the job completes
    const state: Record<string, unknown> = {};
    await engine.run({ name: 'track2', loop: false, techniques: ['step alpha', 'step beta'] }, state);
    expect(state['lastTechnique']).toBe('step beta');
  });

  it('executes a parameterised technique and passes extracted params to the factory', async () => {
    const { registry, engine } = makeEngine();
    let capturedParams: Record<string, string> | undefined;

    registry.skill('test', (r) => {
      r.register('fetch item {id} from {source}', 'desc', (params) => async (_ctx) => {
        capturedParams = params;
      });
    });

    await engine.run({ name: 'param-test', loop: false, techniques: ['fetch item 42 from azure'] });

    expect(capturedParams).toEqual({ id: '42', source: 'azure' });
  });

  it('stores the concrete title (not the template) in lastTechnique for parameterised techniques', async () => {
    const { registry, engine } = makeEngine();

    registry.skill('test', (r) => {
      r.register('process item {id}', 'desc', () => async (_ctx) => { /* no-op */ });
    });

    const state: Record<string, unknown> = {};
    await engine.run({ name: 'concrete-title-test', loop: false, techniques: ['process item 99'] }, state);

    expect(state['lastTechnique']).toBe('process item 99');
  });

  it('substitutes VAR values into technique titles before resolving', async () => {
    const { registry, engine } = makeEngine();
    let capturedParams: Record<string, string> | undefined;

    registry.skill('test', (r) => {
      r.register('fetch work item {id} details', 'desc', (params) => async (_ctx) => {
        capturedParams = params;
      });
    });

    const job = { name: 'var-test', loop: false, techniques: ['fetch work item {id} details'], varNames: ['id'] };
    await engine.run(job, undefined, { id: '42' });

    expect(capturedParams).toEqual({ id: '42' });
  });

  it('leaves unresolved placeholders that are not in vars for the registry to handle', async () => {
    const { registry, engine } = makeEngine();
    let capturedParams: Record<string, string> | undefined;

    registry.skill('test', (r) => {
      r.register('process {id} in {source}', 'desc', (params) => async (_ctx) => {
        capturedParams = params;
      });
    });

    // Only 'source' is a VAR; 'id' comes from the template
    const job = { name: 'mixed', loop: false, techniques: ['process {id} in {source}'], varNames: ['source'] };
    await engine.run(job, undefined, { source: 'azure' });

    expect(capturedParams).toEqual({ id: '{id}', source: 'azure' });
  });
});

describe('WorkflowEngine.buildVars', () => {
  const baseJob = { name: 'mission', loop: false, techniques: [] };

  it('returns empty object when job has no varNames', () => {
    expect(WorkflowEngine.buildVars({ ...baseJob, varNames: [] }, undefined)).toEqual({});
    expect(WorkflowEngine.buildVars({ ...baseJob }, undefined)).toEqual({});
  });

  it('maps --var values positionally to varNames', () => {
    const job = { ...baseJob, varNames: ['id', 'priority'] };
    expect(WorkflowEngine.buildVars(job, '147575,2')).toEqual({ id: '147575', priority: '2' });
  });

  it('throws when VAR is declared but --var is not supplied', () => {
    const job = { ...baseJob, varNames: ['id', 'priority'] };
    expect(() => WorkflowEngine.buildVars(job, undefined)).toThrow(
      "Job 'mission' declares VAR [id, priority] but no --var argument was supplied.",
    );
  });

  it('throws when --var value count does not match varNames count', () => {
    const job = { ...baseJob, varNames: ['id', 'priority'] };
    expect(() => WorkflowEngine.buildVars(job, '147575')).toThrow(
      "Job 'mission': VAR declares 2 variable(s) but --var supplied 1 value(s).",
    );
  });
});

