import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { validateRuntimeConfiguration } from '../lib/runtimeConfig';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
describe('isolated recovery staging topology', () => {
 it('boots the actual backend validator with local HTTP configuration', () => {
  const c = YAML.parse(fs.readFileSync(path.join(root,'compose.staging.yml'),'utf8'));
  const env = Object.fromEntries(Object.entries(c.services.backend.environment).map(([key,value]) => [key,
   String(value).replace(/\$\{([A-Z_]+)(?::[^}]*)?\}/g, (_match, name: string) =>
    name === 'STAGING_PUBLIC_URL' ? 'http://127.0.0.1:54329' : 'synthetic-local-only-value-'.repeat(3))
  ]));
  expect(() => validateRuntimeConfiguration(env)).not.toThrow();
  expect(env.API_PUBLIC_URL).toBe('http://127.0.0.1:54329/api');
  expect(() => validateRuntimeConfiguration({...env, NODE_ENV:'production'})).toThrow('must use https in production');
 });
 it('isolates application egress, preserves DB and S3 bytes, and uses current bootstrap/BFF', () => {
  const c = YAML.parse(fs.readFileSync(path.join(root,'compose.staging.yml'),'utf8'));
  expect(c.networks.default.internal).toBe(true);
  expect(c.networks.edge.internal).toBe(false);
  for(const [name,s] of Object.entries(c.services) as [string,Record<string, any>][]) {
   expect(s.restart).toBe('no'); expect(s.privileged).toBeUndefined();
   expect(s.env_file).toBeUndefined(); expect(s.network_mode).toBeUndefined();
   expect(s.labels['com.litt.recovery.owner']).toBe('${STAGING_OWNER:?required}');
   if(name!=='proxy') {expect(s.ports).toBeUndefined();expect(s.networks).toBeUndefined();}
  }
  expect(c.services.proxy.ports).toEqual(['127.0.0.1:${STAGING_PROXY_PORT:?required}:8000']);
  expect(c.services['db-init'].command).toEqual(['fresh']);
  expect(c.services['db-init'].entrypoint).toEqual(['bash','/staging/db-init.sh']);
  expect(c.services['db-init'].volumes).toContain('./backend/schema.sql:/staging/schema.sql:ro');
  expect(c.services.frontend.environment.API_BASE_URL).toBe('http://backend:3001');
  expect(c.services.backend.environment.R2_ENDPOINT_URL).toBe('http://storage:9000');
  expect(c.services.storage.volumes).toContain('staging_storage_data:/data');
  expect(c.services.db.volumes).toContain('staging_db_data:/var/lib/postgresql/data');
  for(const v of Object.values(c.volumes) as any[]) expect(v.labels['com.litt.recovery.owner']).toBe('${STAGING_OWNER:?required}');
  for(const n of Object.values(c.networks) as any[]) expect(n.labels['com.litt.recovery.owner']).toBe('${STAGING_OWNER:?required}');
  const proxy=fs.readFileSync(path.join(root,'docker/staging/proxy.conf'),'utf8');
  expect(proxy).toContain('set $frontend frontend:3000;');
  expect(proxy).toContain('proxy_pass http://$frontend;');
  expect(proxy).not.toContain('Access-Control-Allow-Origin $http_origin');
  expect(c.services.auth.environment.GOTRUE_EXTERNAL_GOOGLE_ENABLED).toBe('false');
 });
});
