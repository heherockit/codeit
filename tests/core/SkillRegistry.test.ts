import { describe, it, expect, vi } from 'vitest';
import { SkillRegistry } from '../../src/core/SkillRegistry.js';
import type { TechniqueRegistry } from '../../src/core/interfaces/ISkill.js';

// stubFn is the inner context function; stubFactory wraps it so resolve() returns stubFn directly.
const stubFn = vi.fn().mockResolvedValue(undefined);
const stubFactory = () => stubFn;

const registerTechniques = (registry: SkillRegistry, ...titles: string[]): void => {
  registry.skill('test', (r: TechniqueRegistry) => {
    for (const title of titles) {
      r.register(title, `Description for ${title}`, stubFactory);
    }
  });
};

describe('SkillRegistry', () => {
  it('registers and resolves a technique by title', () => {
    const registry = new SkillRegistry();
    registerTechniques(registry, 'my-technique');

    const resolved = registry.resolve('my-technique');

    expect(resolved).toBe(stubFn);
  });

  it('registers multiple techniques under one skill', () => {
    const registry = new SkillRegistry();
    registerTechniques(registry, 'technique-a', 'technique-b');

    expect(registry.list()).toEqual(expect.arrayContaining(['technique-a', 'technique-b']));
    expect(registry.list()).toHaveLength(2);
  });

  it('throws when registering a duplicate technique title', () => {
    const registry = new SkillRegistry();
    registerTechniques(registry, 'duplicate');

    expect(() => registerTechniques(registry, 'duplicate')).toThrow(
      "Technique 'duplicate' is already registered.",
    );
  });

  it('throws a helpful error when resolving an unknown technique', () => {
    const registry = new SkillRegistry();
    registerTechniques(registry, 'known-technique');

    expect(() => registry.resolve('unknown')).toThrow(
      "Technique 'unknown' is not registered.",
    );
  });

  it('lists all registered technique titles', () => {
    const registry = new SkillRegistry();
    registerTechniques(registry, 'alpha', 'beta');

    expect(registry.list()).toEqual(expect.arrayContaining(['alpha', 'beta']));
    expect(registry.list()).toHaveLength(2);
  });

  describe('listBySkill', () => {
    it('returns all skill groups when called with no argument', () => {
      const registry = new SkillRegistry();
      registry.skill('git', (r) => {
        r.register('create branches', 'desc', stubFactory);
        r.register('push changes', 'desc', stubFactory);
      });
      registry.skill('ado', (r) => {
        r.register('fetch items', 'desc', stubFactory);
      });

      const groups = registry.listBySkill();

      expect(groups).toHaveLength(2);
      expect(groups![0]).toEqual({ skillName: 'git', techniques: ['create branches', 'push changes'] });
      expect(groups![1]).toEqual({ skillName: 'ado', techniques: ['fetch items'] });
    });

    it('returns only the matching skill group when a name is provided (case-insensitive)', () => {
      const registry = new SkillRegistry();
      registry.skill('Git', (r) => r.register('create branches', 'desc', stubFactory));
      registry.skill('ado', (r) => r.register('fetch items', 'desc', stubFactory));

      const groups = registry.listBySkill('git');

      expect(groups).toHaveLength(1);
      expect(groups![0]!.skillName).toBe('Git');
      expect(groups![0]!.techniques).toEqual(['create branches']);
    });

    it('returns undefined when the skill name is not found', () => {
      const registry = new SkillRegistry();
      registry.skill('git', (r) => r.register('create branches', 'desc', stubFactory));

      expect(registry.listBySkill('unknown-skill')).toBeUndefined();
    });

    it('returns an empty array when no skills are registered', () => {
      const registry = new SkillRegistry();
      expect(registry.listBySkill()).toEqual([]);
    });
  });

  describe('parameterised title resolution', () => {
    it('resolves a single-param title and extracts the value', () => {
      const registry = new SkillRegistry();
      let capturedParams: Record<string, string> | undefined;

      registry.skill('test', (r) => {
        r.register('fetch work item {id}', 'desc', (params) => {
          capturedParams = params;
          return stubFn;
        });
      });

      const fn = registry.resolve('fetch work item 42');

      expect(capturedParams).toEqual({ id: '42' });
      expect(fn).toBe(stubFn);
    });

    it('resolves a multi-param title and extracts all values', () => {
      const registry = new SkillRegistry();
      let capturedParams: Record<string, string> | undefined;

      registry.skill('test', (r) => {
        r.register('create branch {branchName} in {repoName}', 'desc', (params) => {
          capturedParams = params;
          return stubFn;
        });
      });

      registry.resolve('create branch feature/42 in my-repo');

      expect(capturedParams).toEqual({ branchName: 'feature/42', repoName: 'my-repo' });
    });

    it('throws when a concrete title matches multiple templates (ambiguous)', () => {
      const registry = new SkillRegistry();
      registry.skill('test', (r) => {
        r.register('fetch item {id}', 'desc', stubFactory);
        r.register('fetch {type} {id}', 'desc', stubFactory);
      });

      expect(() => registry.resolve('fetch item 42')).toThrow(/ambiguous/i);
    });

    it('throws when a concrete title matches no template', () => {
      const registry = new SkillRegistry();
      registerTechniques(registry, 'known-technique');

      expect(() => registry.resolve('fetch item 99')).toThrow("Technique 'fetch item 99' is not registered.");
    });

    it('list() returns the raw template string, not a concrete example', () => {
      const registry = new SkillRegistry();
      registry.skill('test', (r) => {
        r.register('fetch work item {id}', 'desc', stubFactory);
      });

      expect(registry.list()).toEqual(['fetch work item {id}']);
    });
  });
});

