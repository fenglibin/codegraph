/**
 * Cache Warmup Tests
 *
 * Tests for the cache pre-warming functionality that loads high-connectivity
 * nodes into the LRU cache during CodeGraph.open() / openSync().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

describe('Cache Warmup', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-warmup-'));

    // Create a sample codebase with multiple files to produce nodes and edges
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    // A service with several methods (produces many nodes)
    fs.writeFileSync(
      path.join(srcDir, 'service.ts'),
      `export class UserService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async getUser(id: string): Promise<User> {
    return this.db.findById(id);
  }

  async createUser(data: UserInput): Promise<User> {
    const validated = this.validate(data);
    return this.db.insert(validated);
  }

  async deleteUser(id: string): Promise<void> {
    await this.db.delete(id);
  }

  private validate(data: UserInput): UserInput {
    if (!data.name) throw new Error('Name required');
    return data;
  }
}

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface UserInput {
  name: string;
  email: string;
}

export interface Database {
  findById(id: string): Promise<User>;
  insert(data: UserInput): Promise<User>;
  delete(id: string): Promise<void>;
}
`
    );

    // A controller that uses the service (produces call edges)
    fs.writeFileSync(
      path.join(srcDir, 'controller.ts'),
      `import { UserService, User, UserInput } from './service';

export class UserController {
  private service: UserService;

  constructor(service: UserService) {
    this.service = service;
  }

  async handleGet(id: string): Promise<User> {
    return this.service.getUser(id);
  }

  async handleCreate(data: UserInput): Promise<User> {
    return this.service.createUser(data);
  }

  async handleDelete(id: string): Promise<void> {
    return this.service.deleteUser(id);
  }
}
`
    );

    // A utils file that other files reference
    fs.writeFileSync(
      path.join(srcDir, 'utils.ts'),
      `export function formatName(first: string, last: string): string {
  return first + ' ' + last;
}

export function validateEmail(email: string): boolean {
  return email.includes('@');
}

export function generateId(): string {
  return Math.random().toString(36).substring(2);
}
`
    );
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('warmCache() pre-loads nodes into cache', async () => {
    // Init and index
    const cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    cg.destroy();

    // Open and check that cache was populated
    const cg2 = CodeGraph.openSync(testDir);
    try {
      const stats = cg2.getCacheStats();
      expect(stats.size).toBeGreaterThan(0);
    } finally {
      cg2.destroy();
    }
  });

  it('getNodeById hits cache after warmup', async () => {
    // Init and index
    const cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();

    // Get a known node ID
    const nodes = cg.getNodesByKind('class');
    expect(nodes.length).toBeGreaterThan(0);
    const knownId = nodes[0].id;
    cg.destroy();

    // Open fresh (warmup fires automatically)
    const cg2 = CodeGraph.openSync(testDir);
    try {
      // Reset counter state by getting initial stats
      const before = cg2.getCacheStats();
      const initialHits = before.hits;

      // Access the node — should hit the warm cache
      const node = cg2.getNode(knownId);
      expect(node).not.toBeNull();

      const after = cg2.getCacheStats();
      expect(after.hits).toBeGreaterThan(initialHits);
    } finally {
      cg2.destroy();
    }
  });

  it('warmCache respects limit for large projects', async () => {
    // Initialize and index the project so it has real nodes
    const cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();

    // Verify there are enough nodes for a meaningful test
    const stats = cg.getStats();
    expect(stats.nodeCount).toBeGreaterThan(3);
    cg.destroy();

    // Open the DB directly to test the QueryBuilder limit behavior
    const dbPath = path.join(testDir, '.codegraph', 'codegraph.db');
    const conn = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(conn.getDb());

    try {
      // Call warmCache with an explicit limit smaller than total nodes
      const warmed = queries.warmCache(3);
      const cacheStats = queries.getCacheStats();

      expect(warmed).toBe(3);
      expect(cacheStats.size).toBe(3);
    } finally {
      conn.close();
    }
  });

  it('warmCache loads all nodes for small projects', async () => {
    // Create a minimal project with just a few nodes
    const smallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-small-'));
    try {
      fs.writeFileSync(
        path.join(smallDir, 'index.ts'),
        `export function hello(): string { return "hi"; }
export function bye(): string { return "bye"; }
`
      );

      const cg = CodeGraph.initSync(smallDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      // Get total node count
      const stats = cg.getStats();
      const totalNodes = stats.nodeCount;
      expect(totalNodes).toBeLessThanOrEqual(500); // confirms it's a "small" project
      cg.destroy();

      // Reopen — warmup should load all nodes
      const cg2 = CodeGraph.openSync(smallDir);
      try {
        const cacheStats = cg2.getCacheStats();
        expect(cacheStats.size).toBe(totalNodes);
      } finally {
        cg2.destroy();
      }
    } finally {
      fs.rmSync(smallDir, { recursive: true, force: true });
    }
  });

  it('open() pre-warms cache automatically', async () => {
    // Init and index
    const cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    cg.destroy();

    // Use async open
    const cg2 = await CodeGraph.open(testDir);
    try {
      const stats = cg2.getCacheStats();
      expect(stats.size).toBeGreaterThan(0);
    } finally {
      cg2.destroy();
    }
  });

  it('warmCache failure does not break open()', () => {
    // Initialize with an empty project (no files indexed = no nodes)
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-empty-'));
    try {
      const cg = CodeGraph.initSync(emptyDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      cg.destroy();

      // Open should succeed even though there are 0 nodes to warm
      const cg2 = CodeGraph.openSync(emptyDir);
      try {
        const stats = cg2.getCacheStats();
        expect(stats.size).toBe(0);
        // The important thing is that open() didn't throw
      } finally {
        cg2.destroy();
      }
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
