import type { SkillFn, SkillFnFactory, TechniqueRegistry } from './interfaces/ISkill.js';

interface TechniqueEntry {
  description: string;
  factory: SkillFnFactory;
  paramNames: string[];
  pattern: RegExp;
}

/**
 * Parses a technique title template (e.g. `'fetch work item {id}'`) into a
 * regex that can match concrete titles and a list of parameter names.
 * Literal parts are regex-escaped; each `{name}` becomes a `(.+)` capture group.
 */
function parseTemplate(template: string): { paramNames: string[]; pattern: RegExp } {
  const paramNames: string[] = [];
  const parts = template.split(/\{([^}]+)\}/g);
  let regexStr = '';

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      regexStr += parts[i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else {
      paramNames.push(parts[i]!);
      regexStr += '(.+)';
    }
  }

  return { paramNames, pattern: new RegExp(`^${regexStr}$`) };
}

export interface SkillGroup {
  skillName: string;
  techniques: string[];
}

/**
 * Scoped registrar passed to a skill's registration callback.
 * Binds each technique title to its description and implementation,
 * and records the title in the parent skill group for introspection.
 */
class ScopedTechniqueRegistry implements TechniqueRegistry {
  constructor(
    private readonly map: Map<string, TechniqueEntry>,
    private readonly group: SkillGroup,
  ) {}

  register(techniqueTitle: string, techniqueDescription: string, factory: SkillFnFactory): void {
    if (this.map.has(techniqueTitle)) {
      throw new Error(`Technique '${techniqueTitle}' is already registered.`);
    }
    const { paramNames, pattern } = parseTemplate(techniqueTitle);
    this.map.set(techniqueTitle, { description: techniqueDescription, factory, paramNames, pattern });
    this.group.techniques.push(techniqueTitle);
  }
}

/**
 * Holds the global map of natural-language technique titles → implementation functions.
 * Skills register techniques via the fluent `skill(name, callback)` API.
 * The WorkflowEngine resolves techniques by title during job execution.
 */
export class SkillRegistry {
  private readonly registry = new Map<string, TechniqueEntry>();
  private readonly skillGroups: SkillGroup[] = [];

  /**
   * Register all techniques belonging to a named skill.
   * The callback receives a scoped `TechniqueRegistry` to avoid typo-prone
   * skill-name duplication at each registration call site.
   */
  skill(skillName: string, callback: (r: TechniqueRegistry) => void): void {
    const group: SkillGroup = { skillName, techniques: [] };
    this.skillGroups.push(group);
    callback(new ScopedTechniqueRegistry(this.registry, group));
  }

  /**
   * Retrieve a bound technique function for a concrete title.
   * For non-parameterised titles, performs an exact map lookup.
   * For parameterised titles, matches against all registered templates,
   * extracts placeholder values, and invokes the factory with them.
   * Throws if no template matches or if more than one template matches.
   */
  resolve(concreteTitle: string): SkillFn {
    const exact = this.registry.get(concreteTitle);
    if (exact) {
      return exact.factory({});
    }

    const matches: Array<{ template: string; entry: TechniqueEntry; params: Record<string, string> }> = [];

    for (const [template, entry] of this.registry) {
      if (entry.paramNames.length === 0) continue;
      const match = concreteTitle.match(entry.pattern);
      if (match) {
        const params: Record<string, string> = {};
        entry.paramNames.forEach((name, i) => { params[name] = match[i + 1]!; });
        matches.push({ template, entry, params });
      }
    }

    if (matches.length === 1) {
      const { entry, params } = matches[0]!;
      return entry.factory(params);
    }

    if (matches.length > 1) {
      const templates = matches.map((m) => `'${m.template}'`).join(', ');
      throw new Error(
        `Technique '${concreteTitle}' is ambiguous — matches multiple templates: [${templates}]`,
      );
    }

    throw new Error(
      `Technique '${concreteTitle}' is not registered. Available: [${[...this.registry.keys()].join(', ')}]`,
    );
  }

  /** List all registered technique titles (useful for diagnostics). */
  list(): string[] {
    return [...this.registry.keys()];
  }

  /**
   * Return all skills with their technique titles, grouped by skill name.
   * Optionally filter to a single skill by name (case-insensitive).
   * Returns undefined when a specific skill name is requested but not found.
   */
  listBySkill(skillName?: string): SkillGroup[] | undefined {
    if (skillName === undefined) return [...this.skillGroups];

    const match = this.skillGroups.find(
      (g) => g.skillName.toLowerCase() === skillName.toLowerCase(),
    );
    return match ? [match] : undefined;
  }
}

